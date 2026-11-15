// Turns a stream of install records into one profile per installer company.
//
// Pass 1 (Tally): records are counted per source and raw installer name, so
// even millions of California rows only keep a few thousand small tallies.
// Pass 2 (mergeTallies): tallies that describe the same company are merged
// across sources and name spellings, using the California license number,
// the phone number, or the cleaned-up company name.

import { US_STATES, nameKey, prettyName, formatPhone, phoneDigits, zip5 } from './normalize.js';

// Big national installers whose names vary a lot between states and years.
const ALIASES = [
    [/\b(tesla|solar ?city)\b/i, 'tesla energy'],
    [/^sunrun\b/i, 'sunrun'],
    [/^sun ?power\b/i, 'sunpower'],
    [/^freedom forever\b/i, 'freedom forever'],
    [/^sunnova\b/i, 'sunnova'],
    [/^trinity (solar|heating)\b/i, 'trinity solar'],
    [/^momentum solar\b/i, 'momentum solar'],
    [/^vivint solar\b/i, 'vivint solar'],
    [/^(adt solar|sunpro solar)\b/i, 'adt solar'],
    [/^palmetto\b/i, 'palmetto'],
    [/^posigen\b/i, 'posigen'],
    [/^semper solaris\b/i, 'semper solaris'],
];

const ALIAS_KEYS = new Set(ALIASES.map(([, k]) => k));

// Display names for brands whose old and new names both appear in the data.
const ALIAS_DISPLAY = { 'tesla energy': 'Tesla Energy (SolarCity)' };

const STATE_WORDS = Object.values(US_STATES).map((s) => s.toLowerCase()).sort((a, b) => b.length - a.length);

/**
 * Matching key for an installer name: aliases first, then the cleaned name
 * without a trailing state ("Freedom Forever Massachusetts LLC" ->
 * "freedom forever"). Empty for junk names.
 */
export function installerKey(name) {
    const raw = String(name ?? '').trim();
    if (!raw) return '';
    for (const [re, key] of ALIASES) if (re.test(raw)) return key;
    // "Foo Solar LLC dba Bar Energy": the trading name is what people know.
    const dba = raw.split(/\s+(?:d\/?b\/?a|doing business as)\s+/i);
    let key = nameKey(dba.length > 1 && dba[1].trim() ? dba[1] : raw)
        // "G A F Energy" -> "gaf energy", "N R G Clean Power" -> "nrg clean power".
        .replace(/\b([a-z0-9])(?: ([a-z0-9]))+\b/g, (m) => m.replace(/ /g, ''));
    for (const st of STATE_WORDS) {
        const re = new RegExp(`\\s+(?:of\\s+)?${st}$`);
        if (re.test(key)) {
            const cut = key.replace(re, '').trim();
            if (cut.split(' ').length >= 2) key = cut;
            break;
        }
    }
    return key;
}

const JUNK_NAME = /^(none|n\/?a|na|unknown|self|self[ -]?install(ed|er)?|homeowner|home owner|owner|customer|test|tbd|other|-+|\.+|0+)$/i;

/** True for names that are not a real installer company. */
export function isJunkInstaller(name) {
    const v = String(name ?? '').trim();
    return !v || v.length < 3 || JUNK_NAME.test(v) || /^self[ -]?install/i.test(v) || /^(home ?owner|owner[ -]builder)/i.test(v);
}

class Counter extends Map {
    add(k, n = 1) {
        if (k == null || k === '') return;
        this.set(k, (this.get(k) ?? 0) + n);
    }
    top(n = 5) {
        return [...this].sort((a, b) => b[1] - a[1]).slice(0, n);
    }
    first() {
        return this.top(1)[0]?.[0] ?? null;
    }
    mergeFrom(other) {
        for (const [k, v] of other) this.add(k, v);
    }
}

function newTally(source) {
    return {
        sources: new Counter(),
        sourceUrls: new Map(),
        names: new Counter(),
        phones: new Counter(),
        hq: new Counter(),
        licenses: new Counter(),
        installs: 0,
        pipeline: 0,
        solar: 0,
        storage: 0,
        kwSum: 0,
        kwN: 0,
        storageKwhSum: 0,
        residential: 0,
        commercial: 0,
        sectorKnown: 0,
        tpo: 0,
        tpoKnown: 0,
        financiers: new Counter(),
        costSum: 0,
        costWatts: 0,
        modules: new Counter(),
        inverters: new Counter(),
        batteries: new Counter(),
        counties: new Counter(),
        cities: new Counter(),
        states: new Counter(),
        years: new Counter(),
        first: null,
        last: null,
        _source: source,
    };
}

const cleanBrand = (v) => {
    const s = String(v ?? '').trim();
    if (!s || /^(none|n\/?a|other|unknown|0)$/i.test(s)) return null;
    return s.replace(/\s+/g, ' ');
};

const placeCache = new Map();
/** "SAN DIEGO", "CA" -> "San Diego|CA" (cached: the same few thousand places repeat). */
function placeKey(name, state) {
    const raw = `${name}|${state}`;
    let v = placeCache.get(raw);
    if (v === undefined) {
        v = `${prettyName(String(name).trim())}|${state}`;
        if (placeCache.size < 200_000) placeCache.set(raw, v);
    }
    return v;
}

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
/** Tidies a raw installer name: HTML entities some utilities leave in, extra spaces. */
export function cleanName(v) {
    return String(v ?? '').replace(/&(amp|quot|#39|apos|lt|gt);/g, (m) => ENTITIES[m]).trim().replace(/\s+/g, ' ');
}

/** Adds one install record to a tally. */
export function addToTally(t, rec) {
    t.sources.add(rec.source);
    if (rec.url) t.sourceUrls.set(rec.source, rec.url);
    t.names.add(cleanName(rec.installer));
    const pd = phoneDigits(rec.phone);
    if (pd) t.phones.add(pd);
    if (rec.hq_city && rec.hq_state) t.hq.add(`${rec.hq_city.trim()}|${rec.hq_state}|${zip5(rec.hq_zip) ?? ''}`);
    if (rec.license) t.licenses.add(rec.license);
    if (rec.status === 'pipeline') {
        t.pipeline++;
        return;
    }
    t.installs++;
    if (rec.solar) t.solar++;
    if (rec.storage) t.storage++;
    if (rec.kw > 0 && rec.kw < 100_000) {
        t.kwSum += rec.kw;
        t.kwN++;
    }
    if (rec.storage_kwh > 0 && rec.storage_kwh < 1_000_000) t.storageKwhSum += rec.storage_kwh;
    if (rec.sector) {
        t.sectorKnown++;
        if (rec.sector === 'residential') t.residential++;
        else t.commercial++;
    }
    if (rec.tpo != null) {
        t.tpoKnown++;
        if (rec.tpo) t.tpo++;
    }
    if (rec.financier && rec.tpo) t.financiers.add(rec.financier.trim());
    // Cost per watt only for solar-only jobs, where the price is comparable.
    if (rec.cost > 0 && rec.kw > 0 && rec.solar && !rec.storage) {
        const perW = rec.cost / (rec.kw * 1000);
        if (perW > 0.5 && perW < 15) {
            t.costSum += rec.cost;
            t.costWatts += rec.kw * 1000;
        }
    }
    t.modules.add(cleanBrand(rec.module));
    t.inverters.add(cleanBrand(rec.inverter));
    t.batteries.add(cleanBrand(rec.battery));
    if (rec.county) t.counties.add(placeKey(rec.county, rec.state));
    if (rec.city) t.cities.add(placeKey(rec.city, rec.state));
    t.states.add(rec.state);
    const year = rec.date ? Number(rec.date.slice(0, 4)) : rec.year;
    if (year) t.years.add(String(year));
    if (rec.date) {
        if (!t.first || rec.date < t.first) t.first = rec.date;
        if (!t.last || rec.date > t.last) t.last = rec.date;
    }
}

function mergeTally(into, from) {
    for (const k of ['sources', 'names', 'phones', 'hq', 'licenses', 'financiers', 'modules', 'inverters', 'batteries', 'counties', 'cities', 'states', 'years']) {
        into[k].mergeFrom(from[k]);
    }
    for (const [k, v] of from.sourceUrls) into.sourceUrls.set(k, v);
    for (const k of ['installs', 'pipeline', 'solar', 'storage', 'kwSum', 'kwN', 'storageKwhSum', 'residential', 'commercial', 'sectorKnown', 'tpo', 'tpoKnown', 'costSum', 'costWatts']) {
        into[k] += from[k];
    }
    if (from.first && (!into.first || from.first < into.first)) into.first = from.first;
    if (from.last && (!into.last || from.last > into.last)) into.last = from.last;
}

/** Collects install records into per-(source, name) tallies. */
export class Tally {
    constructor() {
        this.map = new Map();
        this.keys = new Map();
        this.skipped = { self_install: 0, junk_name: 0 };
    }

    add(rec) {
        if (rec.self_install) {
            this.skipped.self_install++;
            return;
        }
        // Names repeat millions of times in California, so keys are cached.
        let key = this.keys.get(rec.installer);
        if (key === undefined) {
            const name = cleanName(rec.installer);
            key = isJunkInstaller(name) ? '' : installerKey(name);
            this.keys.set(rec.installer, key);
        }
        if (!key) {
            this.skipped.junk_name++;
            return;
        }
        const id = `${rec.source}|${key}`;
        let t = this.map.get(id);
        if (!t) {
            t = newTally(rec.source);
            t._key = key;
            t._state = rec.state;
            this.map.set(id, t);
        }
        addToTally(t, rec);
    }

    get tallies() {
        return [...this.map.values()];
    }
}

/**
 * Merges tallies for the same company. Keys: name key, CA license number,
 * and phone number. A phone or license links names only when the names
 * also share a distinctive word, so a shared call centre number or a
 * partner's license cannot glue two unrelated companies together.
 */
export function mergeTallies(tallies) {
    const STOP = new Set(['solar', 'energy', 'power', 'electric', 'electrical', 'and', 'the', 'systems', 'system', 'services', 'service', 'home', 'homes', 'group', 'construction', 'roofing', 'llc', 'inc', 'advanced', 'solutions', 'solution', 'renewable', 'renewables', 'green', 'clean', 'sun', 'pro', 'american', 'america', 'national', 'premier', 'smart', 'best', 'quality', 'custom', 'design', 'designs', 'tech', 'technology', 'technologies', 'installation', 'installations', 'installers', 'contractors', 'contracting', 'sunpower', 'pbc', 'usa', 'enterprises', 'company', 'development', 'one', 'new']);
    const words = tallies.map((t) => new Set(t._key.split(' ').filter((w) => w.length > 2 && !STOP.has(w))));
    const sharesWord = (i, j) => [...words[i]].some((w) => words[j].has(w));
    const parent = tallies.map((_, i) => i);
    const find = (i) => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    // Only each tally's main license and main phone link it to others: a
    // dealer that sometimes files under a partner's license stays separate.
    const owners = new Map();
    tallies.forEach((t, i) => {
        const link = (key, needWord) => {
            if (!key) return;
            const list = owners.get(key);
            if (!list) {
                owners.set(key, [i]);
                return;
            }
            for (const j of list) if (!needWord || sharesWord(i, j)) union(i, j);
            list.push(i);
        };
        // Same name in the same state: same company. Across states only when
        // the name is distinctive (two or more non-generic words, or a known
        // national brand), so "Empower Solar" in NY and CA stay apart.
        link(`n:${t._state}|${t._key}`, false);
        if (words[i].size >= 2 || ALIAS_KEYS.has(t._key)) link(`n:${t._key}`, false);
        const lic = t.licenses.first();
        const ph = t.phones.first();
        if (lic) link(`l:${lic}`, true);
        if (ph) link(`p:${ph}`, true);
    });
    const groups = new Map();
    tallies.forEach((t, i) => {
        const r = find(i);
        let g = groups.get(r);
        if (!g) {
            g = newTally(t._source);
            g._key = tallies[r]._key;
            groups.set(r, g);
        }
        mergeTally(g, t);
    });
    return [...groups.values()];
}

const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const share = (a, b) => (b > 0 ? round(a / b, 3) : null);
const splitKey = (k) => k.split('|');

/**
 * Trading name for display: "Powur PBC DBA Powur Home Construction" ->
 * "Powur Home Construction", "Momentum Solar (dba for Pro Custom Solar LLC)"
 * -> "Momentum Solar".
 */
export function tradingName(name) {
    let v = String(name ?? '').trim().replace(/\s+/g, ' ');
    v = v.replace(/\s*\((?:d\/?b\/?a|doing business as)\b[^)]*\)\s*/i, ' ').trim();
    const parts = v.split(/\s+(?:d\/?b\/?a:?|doing business as)\s+/i);
    if (parts.length > 1 && parts[1].trim().length >= 3) v = parts[1].trim();
    v = v.replace(/\s+which will do business in california as\s+/i, ' / ');
    return v.replace(/[,\s]+$/, '');
}

/** Picks a display name: the most common spelling, tidied. */
export function displayName(names) {
    const spaced = /\b[A-Za-z] [A-Za-z]\b/; // "G A F Energy"
    const all = names.top(10);
    if (!all.length) return null;
    const top = all.filter(([n]) => !spaced.test(n)).length ? all.filter(([n]) => !spaced.test(n)) : all;
    // Prefer a mixed-case spelling when it is nearly as common as an all-caps one.
    const best = top[0][0];
    const mixed = top.find(([n, c]) => n !== n.toUpperCase() && c >= top[0][1] * 0.5);
    return prettyName(tradingName(mixed ? mixed[0] : best));
}

/** Output row for a merged group. */
export function toProfile(g, { scrapedAt } = {}) {
    const name = ALIAS_DISPLAY[g._key] ?? displayName(g.names);
    const hqTop = g.hq.first();
    const [hqCity, hqState, hqZip] = hqTop ? splitKey(hqTop) : [null, null, null];
    const years = Object.fromEntries([...g.years].sort((a, b) => a[0].localeCompare(b[0])));
    const others = [...new Set(g.names.top(8).map(([n]) => prettyName(n)))].filter((n) => n !== name).slice(0, 5);
    return {
        installer_name: name,
        other_names: others,
        installs: g.installs,
        solar_installs: g.solar,
        storage_installs: g.storage,
        storage_share: share(g.storage, g.installs),
        pipeline_projects: g.pipeline,
        total_kw_dc: round(g.kwSum, 1),
        avg_system_kw: g.kwN ? round(g.kwSum / g.kwN, 2) : null,
        total_storage_kwh: g.storageKwhSum ? round(g.storageKwhSum, 1) : null,
        residential_share: share(g.residential, g.sectorKnown),
        commercial_installs: g.commercial,
        third_party_owned_share: share(g.tpo, g.tpoKnown),
        top_financiers: g.financiers.top(3).map(([n, c]) => ({ name: n, installs: c })),
        avg_cost_per_watt: g.costWatts ? round(g.costSum / g.costWatts, 2) : null,
        first_install_date: g.first,
        last_install_date: g.last,
        installs_by_year: years,
        states: g.states.top(60).map(([s]) => s),
        top_counties: g.counties.top(5).map(([k, c]) => {
            const [county, state] = splitKey(k);
            return { county, state, installs: c };
        }),
        top_cities: g.cities.top(5).map(([k, c]) => {
            const [city, state] = splitKey(k);
            return { city, state, installs: c };
        }),
        top_module_brands: g.modules.top(3).map(([n, c]) => ({ brand: n, installs: c })),
        top_inverter_brands: g.inverters.top(3).map(([n, c]) => ({ brand: n, installs: c })),
        top_battery_brands: g.batteries.top(3).map(([n, c]) => ({ brand: n, installs: c })),
        phone: formatPhone(g.phones.first()),
        hq_city: hqCity ? prettyName(hqCity) : null,
        hq_state: hqState || null,
        hq_zip: hqZip || null,
        cslb_license: g.licenses.first(),
        cslb_license_url: g.licenses.first() ? `https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=${g.licenses.first()}` : null,
        sources: [...g.sources].map(([source, installs]) => ({ source, records: installs, url: g.sourceUrls.get(source) ?? null })),
        scraped_at: scrapedAt ?? new Date().toISOString(),
    };
}
