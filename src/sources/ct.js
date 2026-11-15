// Connecticut Green Bank public datasets on data.ct.gov:
//  - Residential Solar Investment Program (RSIP) Enrollment (fvw8-89kt),
//    2005 to early 2024 (the program has closed).
//  - Energy Storage Solutions (ESS) Enrollment (uy2c-bbdw), 2022 onward,
//    residential and commercial batteries.
// Project rows only; no customer names are published.

import { forEachSocrataRow, sodaDate, soqlDate, num } from './socrata.js';

export const CT_SOURCE = 'ct_green_bank';
export const CT_SOLAR_URL = 'https://data.ct.gov/d/fvw8-89kt';
export const CT_STORAGE_URL = 'https://data.ct.gov/d/uy2c-bbdw';

const county = (v) => (v ? String(v).replace(/\s+county$/i, '').trim() : null);
const cost = (v) => {
    const n = num(v);
    return n && n > 0 ? n : null;
};

export function mapCtSolar(r) {
    const installed = Boolean(r.completed_date);
    const owner = r.system_owner && !/does not apply/i.test(r.system_owner) ? r.system_owner : null;
    const fin = r.system_financing_type ?? '';
    const tpo = owner != null || /lease|ppa|power purchase/i.test(fin);
    return {
        source: CT_SOURCE,
        url: CT_SOLAR_URL,
        installer: r.contractor,
        status: installed ? 'installed' : 'pipeline',
        date: installed ? sodaDate(r.completed_date) : sodaDate(r.approved_date),
        state: 'CT',
        county: county(r.county),
        city: r.host_customer_city ?? r.municipality ?? null,
        zip: r.host_customer_zip_code ?? null,
        sector: 'residential',
        solar: true,
        storage: false,
        kw: num(r.kw_stc),
        storage_kwh: null,
        tpo,
        financing: /lease/i.test(fin) ? 'lease' : /ppa|power purchase/i.test(fin) ? 'ppa' : tpo ? 'third_party' : fin ? 'purchase' : null,
        financier: owner,
        cost: cost(r.total_system_cost),
        module: null,
        inverter: null,
        battery: null,
    };
}

export function mapCtStorage(r) {
    const installed = /complete/i.test(r.stage ?? '');
    const owner = r.third_party_owner && !/home owner|customer|none|n\/a/i.test(r.third_party_owner) ? r.third_party_owner : null;
    const bess = String(r.combined_bess_models ?? '').split(';')[0];
    return {
        source: CT_SOURCE,
        url: CT_STORAGE_URL,
        installer: r.contractor_name,
        status: installed ? 'installed' : 'pipeline',
        date: installed ? sodaDate(r.completed_date) : sodaDate(r.approval_date ?? r.submitted_date),
        state: 'CT',
        county: county(r.county),
        city: r.host_city ?? null,
        zip: r.host_zip ?? null,
        sector: /residential/i.test(r.sector ?? '') ? 'residential' : 'commercial',
        solar: num(r.paired_pv_system_size) > 0,
        storage: true,
        kw: num(r.paired_pv_system_size) > 0 ? num(r.paired_pv_system_size) : null,
        storage_kwh: num(r.total_system_energy_capacity),
        tpo: owner != null,
        financing: owner ? 'third_party' : null,
        financier: owner,
        cost: cost(r.gross_cost),
        module: null,
        inverter: null,
        battery: bess ? bess.replace(/\s*\[.*$/, '').trim() || null : null,
    };
}

const BAD_STAGES = "('Unenrolled','Completion Rejected')";

export async function loadCt({ from, to, log, shouldStop }, onInstall) {
    const range = (field) => [`${field} >= ${soqlDate(from)}`, to ? `${field} <= ${soqlDate(to)}` : null].filter(Boolean).join(' AND ');
    const solar = await forEachSocrataRow('data.ct.gov', 'fvw8-89kt', {
        select: 'completed_date,approved_date,contractor,kw_stc,total_system_cost,system_owner,system_financing_type,host_customer_zip_code,host_customer_city,municipality,county',
        where: `contractor IS NOT NULL AND ((completed_date IS NOT NULL AND ${range('completed_date')}) OR (completed_date IS NULL AND ${range('approved_date')}))`,
        log,
        shouldStop,
    }, (r) => onInstall(mapCtSolar(r)));
    const storage = await forEachSocrataRow('data.ct.gov', 'uy2c-bbdw', {
        select: 'stage,completed_date,approval_date,submitted_date,contractor_name,host_city,host_zip,county,sector,third_party_owner,total_system_energy_capacity,paired_pv_system_size,gross_cost,combined_bess_models',
        where: `contractor_name IS NOT NULL AND stage NOT IN ${BAD_STAGES} AND ((completed_date IS NOT NULL AND ${range('completed_date')}) OR (completed_date IS NULL AND ${range('submitted_date')}))`,
        log,
        shouldStop,
    }, (r) => onInstall(mapCtStorage(r)));
    return { rows: solar + storage };
}
