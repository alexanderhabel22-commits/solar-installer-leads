// Oregon Department of Energy, Solar + Storage Rebate Program multi-year
// report (data.oregon.gov fbqx-su36). Paid rebates since 2023 with the
// contractor that received them. Dates are given as a funding year only.

import { forEachSocrataRow, num } from './socrata.js';

export const OR_SOURCE = 'oregon_odoe';
export const OR_URL = 'https://data.oregon.gov/d/fbqx-su36';

export function mapOregon(r) {
    const year = Number(r.funding_year_issued) || null;
    const storageCost = num(r.final_storage_system_costs);
    const solarCost = num(r.final_solar_system_costs);
    const kw = num(r.pv_system_specification_1);
    const hasStorage = num(r.total_storage_rebates) > 0 || storageCost > 0;
    const total = num(r.final_total_system_costs);
    return {
        source: OR_SOURCE,
        url: OR_URL,
        installer: r.rebate_recipient_contractor,
        status: 'installed',
        date: null,
        year,
        state: 'OR',
        county: null,
        city: r.project_city ?? null,
        zip: r.project_zip ?? null,
        sector: 'residential',
        solar: kw > 0 || solarCost > 0,
        storage: hasStorage,
        kw: kw > 0 ? kw : null,
        storage_kwh: null,
        tpo: null,
        financing: null,
        cost: total > 0 ? total : null,
        module: null,
        inverter: null,
        battery: null,
    };
}

export async function loadOregon({ from, to, log, shouldStop }, onInstall) {
    const fromYear = Number(from.slice(0, 4));
    const toYear = to ? Number(to.slice(0, 4)) : 9999;
    const rows = await forEachSocrataRow('data.oregon.gov', 'fbqx-su36', {
        where: `rebate_recipient_contractor IS NOT NULL AND current_status_group = 'Paid'`,
        log,
        shouldStop,
    }, (r) => {
        const rec = mapOregon(r);
        if (rec.year && rec.year >= fromYear && rec.year <= toYear) onInstall(rec);
    });
    return { rows };
}
