// Massachusetts Clean Energy Center (MassCEC) Production Tracking System:
// "Solar PV Systems in MA" report, every registered system with its
// installer, published as an Excel file on masscec.com. The report is
// refreshed a few times a year; this source finds the newest link on the
// public records page.

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BROWSER_UA, fetchText } from '../http.js';
import { readLargestSheet, excelDate } from '../xlsx.js';

export const MA_SOURCE = 'masscec_pts';
export const MA_PAGE = 'https://www.masscec.com/public-records-requests';
const FALLBACK = 'https://www.masscec.com/sites/default/files/documents/Solar-PV-Systems-in-MA-as-of-Jan-2025.xlsx';

/** Newest "Solar-PV-Systems-in-MA" xlsx link on the page, or null. */
export function findReportLink(html, base = MA_PAGE) {
    const links = [...String(html).matchAll(/href="([^"]*Solar[-_ %20]*PV[-_ %20]*Systems[^"]*\.xlsx)"/gi)].map((m) => new URL(m[1].replace(/&amp;/g, '&'), base).href);
    return links[0] ?? null;
}

const HEADERS = {
    kw: /^capacity/i,
    date: /^date in service/i,
    cost: /^total cost/i,
    city: /^city$/i,
    zip: /^zip$/i,
    county: /^county$/i,
    facility: /^facility type/i,
    installer: /^installer$/i,
    module: /^module manufacturer/i,
    inverter: /^inverter manufacturer/i,
    tpo: /^3rd party owner/i,
};

/** Header cells -> column positions, or null when this is not the header row. */
export function headerIndex(cells) {
    const at = {};
    for (const [k, re] of Object.entries(HEADERS)) {
        at[k] = cells.findIndex((c) => typeof c === 'string' && re.test(c.trim()));
    }
    return at.installer >= 0 && at.date >= 0 && at.kw >= 0 ? at : null;
}

const numOrNull = (v) => {
    const n = Number(v);
    return v === '' || v == null || !Number.isFinite(n) ? null : n;
};

export function mapMaRow(cells, at) {
    const get = (k) => (at[k] >= 0 ? cells[at[k]] : undefined);
    const raw = get('date');
    const date = /^\d{4}-\d{2}-\d{2}/.test(String(raw ?? '')) ? String(raw).slice(0, 10) : excelDate(raw);
    const zipRaw = String(get('zip') ?? '').replace(/\.0+$/, '').trim();
    const zip = /^\d{3,5}$/.test(zipRaw) ? zipRaw.padStart(5, '0') : null;
    const facility = String(get('facility') ?? '');
    const tpo = String(get('tpo') ?? '').trim();
    const kw = numOrNull(get('kw'));
    const cost = numOrNull(get('cost'));
    return {
        source: MA_SOURCE,
        url: MA_PAGE,
        installer: String(get('installer') ?? '').trim(),
        status: 'installed',
        date,
        state: 'MA',
        county: get('county') ? String(get('county')).replace(/\s+county$/i, '').trim() : null,
        city: get('city') ? String(get('city')).trim() : null,
        zip,
        sector: /^residential/i.test(facility) ? 'residential' : facility && !/^other$/i.test(facility) ? 'commercial' : null,
        solar: true,
        storage: false,
        kw: kw > 0 ? kw : null,
        storage_kwh: null,
        tpo: /^y/i.test(tpo) ? true : /^n/i.test(tpo) ? false : null,
        financing: /^y/i.test(tpo) ? 'third_party' : /^n/i.test(tpo) ? 'purchase' : null,
        cost: cost > 0 ? cost : null,
        module: get('module') ? String(get('module')).trim() : null,
        inverter: get('inverter') ? String(get('inverter')).trim() : null,
        battery: null,
    };
}

async function download(url, path) {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
}

export async function loadMassachusetts({ from, to, log, filePath }, onInstall) {
    let path = filePath;
    let dir = null;
    let reportUrl = null;
    if (!path) {
        try {
            const { text } = await fetchText(MA_PAGE, { log, retries: 1 });
            reportUrl = findReportLink(text);
        } catch (err) {
            log?.warning?.(`MassCEC page failed (${err.message}); using the last known report link`);
        }
        reportUrl ??= FALLBACK;
        dir = await mkdtemp(join(tmpdir(), 'masscec-'));
        path = join(dir, 'report.xlsx');
        log?.info?.(`Massachusetts: downloading ${reportUrl}`);
        await download(reportUrl, path);
    }
    let at = null;
    let rows = 0;
    let latest = null;
    try {
        await readLargestSheet(path, (cells) => {
            if (!at) {
                at = headerIndex(cells);
                return;
            }
            const rec = mapMaRow(cells, at);
            if (!rec.installer || !rec.date || rec.date < from || (to && rec.date > to)) return;
            rows++;
            if (!latest || rec.date > latest) latest = rec.date;
            onInstall(rec);
        });
        if (!at) throw new Error('Massachusetts report layout changed: header row not found');
    } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
    }
    return { rows, latest, dataUrl: reportUrl };
}
