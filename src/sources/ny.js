// NYSERDA (New York State Energy Research and Development Authority) public
// datasets on data.ny.gov:
//  - Solar Electric Programs Reported by NYSERDA (3x8r-34rs): every solar
//    project NYSERDA has supported since 2000, with the contractor's name.
//  - Residential, Retail and Bulk Energy Storage Incentive Programs (ugya-enpy).
// Updated monthly. The rows describe projects, not people: no customer names.

import { forEachSocrataRow, sodaDate, soqlDate, num } from './socrata.js';

export const NY_SOURCE = 'nyserda';
export const NY_SOLAR_URL = 'https://data.ny.gov/d/3x8r-34rs';
export const NY_STORAGE_URL = 'https://data.ny.gov/d/ugya-enpy';

const sector = (v) => (/^residential/i.test(v ?? '') ? 'residential' : v ? 'commercial' : null);

export function mapNySolar(r) {
    const installed = /complete/i.test(r.project_status ?? '');
    const date = installed ? sodaDate(r.date_install) : sodaDate(r.date_application_received);
    const purchase = r.purchase_type ?? '';
    return {
        source: NY_SOURCE,
        url: NY_SOLAR_URL,
        installer: r.contractor,
        status: installed ? 'installed' : 'pipeline',
        date,
        state: 'NY',
        county: r.county ?? null,
        city: r.city ?? null,
        zip: r.zip_code ?? null,
        sector: sector(r.sector),
        solar: true,
        storage: false,
        kw: num(r.totalnameplatekwdc),
        storage_kwh: null,
        tpo: purchase ? /lease|power purchase/i.test(purchase) : null,
        financing: /lease/i.test(purchase) ? 'lease' : /power purchase/i.test(purchase) ? 'ppa' : purchase ? 'purchase' : null,
        cost: num(r.project_cost),
        module: r.pv_module_manufacturer ?? null,
        inverter: r.inverter_manufacturer ?? null,
        battery: null,
    };
}

export function mapNyStorage(r) {
    const installed = /completed/i.test(r.project_status ?? '');
    return {
        source: NY_SOURCE,
        url: NY_STORAGE_URL,
        installer: r.contractor,
        status: installed ? 'installed' : 'pipeline',
        date: installed ? sodaDate(r.date_completed) : sodaDate(r.date_project_approved),
        state: 'NY',
        county: r.county ?? null,
        city: r.city ?? null,
        zip: r.zip_code ?? null,
        sector: /residential/i.test(r.program_type ?? '') ? 'residential' : 'commercial',
        solar: false,
        storage: true,
        kw: null,
        storage_kwh: num(r.installed_energy_storage_kwhac),
        tpo: null,
        financing: null,
        cost: num(r.total_project_cost),
        module: null,
        inverter: null,
        battery: r.battery_cell_manufacturer ?? null,
    };
}

export async function loadNy({ from, to, log, shouldStop }, onInstall) {
    const range = (field) => [`${field} >= ${soqlDate(from)}`, to ? `${field} <= ${soqlDate(to)}` : null].filter(Boolean).join(' AND ');
    const solarWhere = `contractor IS NOT NULL AND ((project_status = 'Complete' AND ${range('date_install')}) OR (project_status = 'Pipeline' AND ${range('date_application_received')}))`;
    const solar = await forEachSocrataRow('data.ny.gov', '3x8r-34rs', {
        select: 'project_status,date_install,date_application_received,contractor,county,city,zip_code,sector,purchase_type,project_cost,totalnameplatekwdc,pv_module_manufacturer,inverter_manufacturer',
        where: solarWhere,
        log,
        shouldStop,
    }, (r) => onInstall(mapNySolar(r)));
    const storageWhere = `contractor IS NOT NULL AND ((project_status = 'Completed' AND ${range('date_completed')}) OR (project_status = 'Approved' AND ${range('date_project_approved')}))`;
    const storage = await forEachSocrataRow('data.ny.gov', 'ugya-enpy', {
        select: 'project_status,date_completed,date_project_approved,contractor,county,city,zip_code,program_type,installed_energy_storage_kwhac,total_project_cost,battery_cell_manufacturer',
        where: storageWhere,
        log,
        shouldStop,
    }, (r) => onInstall(mapNyStorage(r)));
    return { rows: solar + storage };
}
