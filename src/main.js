// US Solar & Battery Installer Leads: Apify Actor entry point.
//
// 1. Read the input (states, area, date range, filters).
// 2. Stream every solar and battery install in range from the public state
//    program and utility datasets (California, New York, Massachusetts,
//    Connecticut, Oregon), keeping only installs in the chosen area.
// 3. Merge the installs into one profile per installer company, rank the
//    companies by real installation volume, and push one row per company,
//    charging the "installer" pay-per-event event.

import { pathToFileURL } from 'node:url';
import { Actor, log } from 'apify';
import { US_STATES, zip5 } from './normalize.js';
import { zipCentroid, isKnownZip, distanceMiles, statesWithinRadius } from './geo.js';
import { Tally, mergeTallies, toProfile } from './aggregate.js';
import { loadCalifornia, CA_SOURCE } from './sources/california.js';
import { loadNy, NY_SOURCE } from './sources/ny.js';
import { loadMassachusetts, MA_SOURCE } from './sources/massachusetts.js';
import { loadCt, CT_SOURCE } from './sources/ct.js';
import { loadOregon, OR_SOURCE } from './sources/oregon.js';

export const CHARGE_EVENT = 'installer';

/** States with install-level public data, and where it comes from. */
export const SOURCES = {
    CA: { id: CA_SOURCE, load: loadCalifornia, label: 'California utility interconnections (CPUC DG Stats)' },
    NY: { id: NY_SOURCE, load: loadNy, label: 'NYSERDA solar and storage programs' },
    MA: { id: MA_SOURCE, load: loadMassachusetts, label: 'MassCEC Production Tracking System' },
    CT: { id: CT_SOURCE, load: loadCt, label: 'Connecticut Green Bank (RSIP and Energy Storage Solutions)' },
    OR: { id: OR_SOURCE, load: loadOregon, label: 'Oregon Department of Energy Solar + Storage Rebates' },
};
export const SUPPORTED_STATES = Object.keys(SOURCES);

export const SECTORS = ['residential', 'commercial'];
export const TECHNOLOGIES = ['any', 'solar', 'storage', 'solar_and_storage'];
export const SORTS = ['installs', 'total_kw_dc', 'storage_installs', 'last_install_date', 'pipeline_projects'];

/** When Apify will stop the run, minus a margin for saving. Null locally. */
export function runDeadline(env = process.env, marginMs = 60_000) {
    const at = Date.parse(env.ACTOR_TIMEOUT_AT ?? env.APIFY_TIMEOUT_AT ?? '');
    return Number.isFinite(at) ? at - marginMs : null;
}

const clampInt = (v, def, lo, hi) => {
    const n = Number(v ?? def);
    return Number.isFinite(n) ? Math.max(lo, Math.min(Math.round(n), hi)) : def;
};

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** Normalises a county name for matching: "Suffolk County" -> "suffolk". */
export const countyKey = (v) => String(v ?? '').toLowerCase().replace(/\bcounty\b/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Validates and fills defaults. Throws a plain-language message on bad input. */
export function parseInput(raw = {}) {
    let states = [...new Set((raw.states ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    const unknown = states.filter((s) => !US_STATES[s]);
    if (unknown.length) throw new Error(`Unknown state code: ${unknown.join(', ')}. Use two-letter codes such as CA.`);
    const unsupported = states.filter((s) => !SOURCES[s]);
    if (unsupported.length) {
        throw new Error(`No install-level public data for ${unsupported.join(', ')} yet. Supported states: ${SUPPORTED_STATES.join(', ')}.`);
    }

    const zipCode = raw.zipCode ? String(raw.zipCode).trim().slice(0, 5) : null;
    if (zipCode && !isKnownZip(zipCode)) throw new Error(`ZIP code ${zipCode} was not found. Use a 5-digit US ZIP code.`);
    const radiusMiles = Number(raw.radiusMiles ?? 25);
    if (zipCode && !(radiusMiles > 0 && radiusMiles <= 300)) throw new Error('Radius must be between 1 and 300 miles.');
    if (zipCode) {
        const near = statesWithinRadius(zipCentroid(zipCode), radiusMiles).filter((s) => SOURCES[s]);
        if (!near.length) throw new Error(`No supported state lies within ${radiusMiles} miles of ${zipCode}. Supported states: ${SUPPORTED_STATES.join(', ')}.`);
        states = states.length ? states.filter((s) => near.includes(s)) : near;
        if (!states.length) throw new Error(`None of the picked states lies within ${radiusMiles} miles of ${zipCode}.`);
    }
    if (!states.length) states = [...SUPPORTED_STATES];

    const installedFrom = raw.installedFrom ? String(raw.installedFrom).slice(0, 10) : '2024-01-01';
    if (!isDate(installedFrom)) throw new Error('installedFrom must be a date like 2024-01-01.');
    const installedTo = raw.installedTo ? String(raw.installedTo).slice(0, 10) : null;
    if (installedTo && !isDate(installedTo)) throw new Error('installedTo must be a date like 2025-12-31.');
    if (installedTo && installedTo < installedFrom) throw new Error('installedTo is before installedFrom.');

    const sectors = [...new Set((raw.sectors ?? []).filter(Boolean))];
    const badSectors = sectors.filter((s) => !SECTORS.includes(s));
    if (badSectors.length) throw new Error(`Unknown sector: ${badSectors.join(', ')}. Use residential or commercial.`);

    const technology = raw.technology ?? 'any';
    if (!TECHNOLOGIES.includes(technology)) throw new Error(`Unknown technology: ${technology}. Use one of ${TECHNOLOGIES.join(', ')}.`);
    const sortBy = raw.sortBy ?? 'installs';
    if (!SORTS.includes(sortBy)) throw new Error(`Unknown sortBy: ${sortBy}. Use one of ${SORTS.join(', ')}.`);

    const counties = [...new Set((raw.counties ?? []).map(countyKey).filter(Boolean))];

    return {
        states,
        counties,
        zipCode,
        radiusMiles,
        installedFrom,
        installedTo,
        sectors,
        technology,
        minInstalls: clampInt(raw.minInstalls, 5, 1, 1_000_000),
        requirePhone: raw.requirePhone === true,
        sortBy,
        maxResults: clampInt(raw.maxResults, 1000, 1, 100_000),
    };
}

/** Install-level filter for an input: rec => boolean. */
export function installFilter(input) {
    const states = new Set(input.states);
    const counties = new Set(input.counties);
    const centre = input.zipCode ? zipCentroid(input.zipCode) : null;
    const sectors = new Set(input.sectors);
    const zipCache = new Map();
    const nearZip = (zip) => {
        const z = zip5(zip);
        if (!z) return false;
        let ok = zipCache.get(z);
        if (ok === undefined) {
            const p = zipCentroid(z);
            ok = Boolean(p) && distanceMiles(centre, p) <= input.radiusMiles;
            zipCache.set(z, ok);
        }
        return ok;
    };
    return (rec) => {
        if (!states.has(rec.state)) return false;
        if (counties.size && !counties.has(countyKey(rec.county))) return false;
        if (centre && !nearZip(rec.zip)) return false;
        if (sectors.size && !(rec.sector && sectors.has(rec.sector))) return false;
        if (input.technology === 'solar' && !rec.solar) return false;
        if (input.technology === 'storage' && !rec.storage) return false;
        if (input.technology === 'solar_and_storage' && !(rec.solar && rec.storage)) return false;
        return true;
    };
}

/** Sorts profiles for the chosen ranking and numbers them. */
export function rank(rows, sortBy = 'installs') {
    const val = (r) => {
        const v = r[sortBy];
        return v == null ? -Infinity : typeof v === 'string' ? Date.parse(v) : v;
    };
    rows.sort((a, b) => val(b) - val(a) || b.installs - a.installs || a.installer_name.localeCompare(b.installer_name));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
}

/** Puts rank and the area share next to the name, in a fixed field order. */
function orderFields(r, areaInstalls) {
    const { installer_name: name, rank: position, ...rest } = r;
    return {
        rank: position,
        installer_name: name,
        share_of_area_installs: areaInstalls ? Math.round((r.installs / areaInstalls) * 10_000) / 10_000 : null,
        ...rest,
    };
}

export async function collect(input, { log: logger = log, deadline = runDeadline(), loaders = {} } = {}) {
    const outOfTime = () => deadline != null && Date.now() > deadline;
    const scrapedAt = new Date().toISOString();
    const keep = installFilter(input);
    const tally = new Tally();
    const stats = {};
    let areaInstalls = 0;

    const onInstall = (rec) => {
        if (!keep(rec)) return;
        if (rec.status !== 'pipeline' && !rec.self_install) areaInstalls++;
        tally.add(rec);
    };

    // California is a big download, so run it alongside the small sources.
    await Promise.all(input.states.map(async (state) => {
        const src = SOURCES[state];
        const s = { state, label: src.label, rows_in_range: 0, data_through: null, error: null, seconds: 0 };
        stats[src.id] = s;
        const t0 = Date.now();
        try {
            const load = loaders[state] ?? src.load;
            let latest = null;
            const res = await load({ from: input.installedFrom, to: input.installedTo, log: logger, shouldStop: outOfTime }, (rec) => {
                if (rec.status !== 'pipeline' && rec.date && (!latest || rec.date > latest)) latest = rec.date;
                onInstall(rec);
            });
            s.rows_in_range = res.rows;
            s.data_through = res.latest ?? latest ?? (res.latestYear ? String(res.latestYear) : null);
            if (res.dataUrl) s.data_url = res.dataUrl;
        } catch (err) {
            s.error = err.message;
            logger.warning(`${src.label} failed: ${err.message}`);
        }
        s.seconds = Math.round((Date.now() - t0) / 100) / 10;
        logger.info(`${src.label}: ${s.rows_in_range} install records in range (${s.seconds}s)`);
    }));
    if (outOfTime()) logger.warning('The run ran out of time while reading data; results may be incomplete. Raise the run timeout to get everything.');

    const groups = mergeTallies(tally.tallies);
    let rows = groups.filter((g) => g.installs >= input.minInstalls).map((g) => toProfile(g, { scrapedAt }));
    if (input.requirePhone) rows = rows.filter((r) => r.phone);
    rows = rank(rows, input.sortBy).map((r) => orderFields(r, areaInstalls));
    return { rows, stats, areaInstalls, companies: groups.length, skipped: tally.skipped };
}

async function run() {
    await Actor.init();
    const input = parseInput((await Actor.getInput()) ?? {});
    log.info('Input', input);

    const { rows, stats, areaInstalls, companies, skipped } = await collect(input);
    const all = Object.values(stats);
    if (all.length && all.every((s) => s.error)) throw new Error('Every data source failed. See the log for details.');

    // Respect both maxResults and the spending limit the user set for the run.
    const charging = Actor.getChargingManager();
    const affordable = charging.calculateMaxEventChargeCountWithinLimit(CHARGE_EVENT);
    const limit = Math.min(input.maxResults, Number.isFinite(affordable) ? affordable : Infinity);
    const out = rows.slice(0, limit);
    for (let i = 0; i < out.length; i += 200) {
        const res = await Actor.pushData(out.slice(i, i + 200), CHARGE_EVENT);
        if (res?.eventChargeLimitReached) {
            log.info('Reached the spending limit for this run.');
            break;
        }
    }

    const summary = {
        installs_in_area: areaInstalls,
        installer_companies_in_area: companies,
        companies_meeting_min_installs: rows.length,
        returned: out.length,
        with_phone: out.filter((r) => r.phone).length,
        skipped_records: skipped,
        sources: stats,
    };
    await Actor.setValue('RUN_SUMMARY', summary);
    log.info('Done', summary);
    await Actor.setStatusMessage(`Ranked ${rows.length} installers from ${areaInstalls.toLocaleString('en-US')} installs; returned ${out.length}.`, { isStatusMessageTerminal: true });
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch(async (err) => {
        log.error(err.message);
        await Actor.fail(err.message);
    });
}
