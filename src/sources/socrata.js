// Pages through a public Socrata open-data table (data.ny.gov, data.ct.gov,
// data.oregon.gov). No login or app token is needed for these volumes.

import { fetchJson } from '../http.js';

const PAGE = 50_000;

/**
 * Calls onRow for every row matching `where`. Returns the number of rows.
 * `select` limits the columns, which keeps responses small.
 */
export async function forEachSocrataRow(domain, id, { select, where, log, shouldStop } = {}, onRow) {
    let offset = 0;
    let total = 0;
    for (;;) {
        if (shouldStop?.()) break;
        const params = new URLSearchParams({ $limit: String(PAGE), $offset: String(offset), $order: ':id' });
        if (select) params.set('$select', select);
        if (where) params.set('$where', where);
        const rows = await fetchJson(`https://${domain}/resource/${id}.json?${params}`, { log, timeoutMs: 120_000 });
        if (!Array.isArray(rows)) throw new Error(`Unexpected response from ${domain}`);
        for (const r of rows) onRow(r);
        total += rows.length;
        if (rows.length < PAGE) break;
        offset += PAGE;
    }
    return total;
}

/** Socrata date "2025-09-23T00:00:00.000" -> "2025-09-23". */
export const sodaDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** SoQL date literal for a YYYY-MM-DD string. */
export const soqlDate = (d) => `'${d}T00:00:00'`;

export const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
