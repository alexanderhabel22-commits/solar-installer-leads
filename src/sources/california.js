// California Distributed Generation Statistics (californiadgstats.ca.gov):
// every solar and battery system interconnected to the PG&E, SCE and SDG&E
// grids, published monthly by the California Public Utilities Commission.
// Each row names the installer with its phone, city and CSLB license number.
//
// The download is one ~150 MB zip holding ~1.3 GB of CSV, so the files are
// streamed and only the first ~80 columns of each row are read.

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { BROWSER_UA } from '../http.js';
import { createCsvParser } from '../csv.js';

export const CA_SOURCE = 'ca_dgstats';
export const CA_URL = 'https://www.californiadgstats.ca.gov/downloads/';
const DOWNLOAD = 'https://www.californiadgstats.ca.gov/download/interconnection_rule21_projects/';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Last date covered by a file, from names like
 * "PGE_Interconnected_Project_Sites_Historical-Jan2020.csv" or
 * "..._Jan2020-Aug2026.csv". Null when the name has no date.
 */
export function fileEndDate(name) {
    const m = String(name).match(/-([A-Za-z]{3})(\d{4})\.csv$/i);
    if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
    const end = new Date(Date.UTC(Number(m[2]), MONTHS[m[1].toLowerCase()] + 1, 0));
    return end.toISOString().slice(0, 10);
}

/** First date covered, from "..._Jan2020-Aug2026.csv". Null for "Historical" files. */
export function fileStartDate(name) {
    const m = String(name).match(/_([A-Za-z]{3})(\d{4})-[A-Za-z]{3}\d{4}\.csv$/i);
    if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
    return new Date(Date.UTC(Number(m[2]), MONTHS[m[1].toLowerCase()], 1)).toISOString().slice(0, 10);
}

/** True when a file can hold installs between from and to. */
export function fileNeeded(name, from, to) {
    const end = fileEndDate(name);
    const start = fileStartDate(name);
    // Historical files end a day or two into the month named; pad by 3 days.
    if (end && /historical-jan2020/i.test(name) && from > '2020-01-03') return false;
    if (end && !/historical/i.test(name) && end < from) return false;
    if (start && to && start > to) return false;
    return true;
}

const COLUMNS = {
    status: 'Application Status',
    city: 'Service City',
    zip: 'Service Zip',
    county: 'Service County',
    tech: 'Technology Type',
    kwDc: 'System Size DC',
    storageKwh: 'Storage Capacity (kWh)',
    sector: 'Customer Sector',
    approved: 'App Approved Date',
    self: 'Self Installer',
    installer: 'Installer Name',
    phone: 'Installer Phone',
    hqCity: 'Installer City',
    hqState: 'Installer State',
    hqZip: 'Installer Zip',
    license: 'CSLB Number',
    tpo: 'Third Party Owned',
    tpoName: 'Third Party Name',
    cost: 'Total System Cost',
    module: 'Generator Manufacturer 1',
    inverter: 'Inverter Manufacturer 1',
};

/** Column positions for a header row. Throws when the layout changed. */
export function columnIndex(header) {
    const at = {};
    for (const [k, name] of Object.entries(COLUMNS)) {
        const i = header.indexOf(name);
        if (i === -1 && !['module', 'inverter', 'tpoName', 'cost'].includes(k)) {
            throw new Error(`California data layout changed: column "${name}" is missing`);
        }
        at[k] = i;
    }
    return at;
}

const SECTORS = { residential: 'residential' };

/** "858088.0" -> "858088". Junk -> null. */
export function cleanLicense(v) {
    const m = String(v ?? '').trim().match(/^(\d{3,7})(?:\.0+)?$/);
    return m ? m[1] : null;
}

const numOrNull = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** One CSV row (array) -> install record, or null for rows we skip. */
export function mapCaRow(f, at) {
    const get = (k) => (at[k] >= 0 ? f[at[k]] ?? '' : '');
    const name = get('installer').trim();
    const selfInstall = /^yes$/i.test(get('self')) || /^self[ -]?install/i.test(name);
    const tech = get('tech');
    const storageKwh = numOrNull(get('storageKwh'));
    const solar = /photovoltaic/i.test(tech);
    const storage = /battery|storage/i.test(tech) || storageKwh > 0;
    const sector = get('sector');
    const tpo = get('tpo');
    const kw = numOrNull(get('kwDc'));
    const cost = numOrNull(get('cost'));
    const hqState = get('hqState').trim().toUpperCase();
    return {
        source: CA_SOURCE,
        url: CA_URL,
        installer: name,
        self_install: selfInstall,
        phone: get('phone') || null,
        hq_city: get('hqCity') || null,
        hq_state: /^[A-Z]{2}$/.test(hqState) ? hqState : null,
        hq_zip: get('hqZip') || null,
        license: cleanLicense(get('license')),
        status: 'installed',
        date: get('approved') || null,
        state: 'CA',
        county: get('county') || null,
        city: get('city') || null,
        zip: get('zip') || null,
        sector: SECTORS[sector.toLowerCase()] ?? (sector ? 'commercial' : null),
        solar,
        storage,
        kw: solar && kw > 0 ? kw : null,
        storage_kwh: storageKwh > 0 ? storageKwh : null,
        tpo: /^yes$/i.test(tpo) ? true : /^no$/i.test(tpo) ? false : null,
        financing: /^yes$/i.test(tpo) ? 'third_party' : /^no$/i.test(tpo) ? 'purchase' : null,
        financier: get('tpoName') || null,
        cost: cost > 0 ? cost : null,
        module: get('module') || null,
        inverter: get('inverter') || null,
        battery: null,
    };
}

function openZip(path) {
    return new Promise((resolve, reject) => {
        yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
    });
}

function listEntries(zip) {
    return new Promise((resolve, reject) => {
        const entries = [];
        zip.on('entry', (e) => {
            entries.push(e);
            zip.readEntry();
        });
        zip.on('end', () => resolve(entries));
        zip.on('error', reject);
        zip.readEntry();
    });
}

function readEntryRows(zip, entry, onRow) {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (err, stream) => {
            if (err) return reject(err);
            const parser = createCsvParser(onRow, { maxColumns: 90 });
            stream.setEncoding('utf8');
            stream.on('data', (c) => parser.feed(c));
            stream.on('end', () => {
                try {
                    parser.end();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
            stream.on('error', reject);
        });
    });
}

/** Downloads the current zip. Returns { path, cleanup, url }. */
export async function downloadCaZip({ log } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'cadg-'));
    const path = join(dir, 'projects.zip');
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(DOWNLOAD, { headers: { 'User-Agent': BROWSER_UA }, redirect: 'follow', signal: AbortSignal.timeout(600_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status} from California DG Stats`);
            await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
            return { path, url: res.url, cleanup: () => rm(dir, { recursive: true, force: true }) };
        } catch (err) {
            lastErr = err;
            log?.warning?.(`California download failed (${err.message}); retrying`);
            await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        }
    }
    await rm(dir, { recursive: true, force: true });
    throw lastErr;
}

/** Streams every install in the date range to onInstall. `zipPath` skips the download (tests). */
export async function loadCalifornia({ from, to, log, shouldStop, zipPath }, onInstall) {
    let cleanup = async () => {};
    let path = zipPath;
    let dataUrl = null;
    if (!path) {
        log?.info?.('California: downloading the utility interconnection file (~150 MB)');
        const dl = await downloadCaZip({ log });
        path = dl.path;
        cleanup = dl.cleanup;
        dataUrl = dl.url;
    }
    let rows = 0;
    let latest = null;
    try {
        const zip = await openZip(path);
        try {
            const entries = (await listEntries(zip)).filter((e) => /\.csv$/i.test(e.fileName) && fileNeeded(e.fileName, from, to));
            for (const entry of entries) {
                if (shouldStop?.()) break;
                log?.info?.(`California: reading ${entry.fileName}`);
                let at = null;
                await readEntryRows(zip, entry, (f) => {
                    if (!at) {
                        at = columnIndex(f.map((h) => h.replace(/^﻿/, '').trim()));
                        return;
                    }
                    const date = f[at.approved];
                    if (!date || date < from || (to && date > to)) return;
                    if (at.status >= 0 && f[at.status] && !/interconnected/i.test(f[at.status])) return;
                    rows++;
                    if (!latest || date > latest) latest = date;
                    onInstall(mapCaRow(f, at));
                });
            }
        } finally {
            zip.close();
        }
    } finally {
        await cleanup();
    }
    return { rows, latest, dataUrl };
}
