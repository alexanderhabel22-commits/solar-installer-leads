import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCalifornia, fileNeeded, cleanLicense } from '../src/sources/california.js';
import { loadMassachusetts, findReportLink } from '../src/sources/massachusetts.js';
import { mapNySolar, mapNyStorage } from '../src/sources/ny.js';
import { mapCtSolar, mapCtStorage } from '../src/sources/ct.js';
import { mapOregon } from '../src/sources/oregon.js';
import { excelDate, parseRow, columnNumber } from '../src/xlsx.js';

const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

test('California: reads the zip, applies the date range, skips old files', async () => {
    const recs = [];
    const res = await loadCalifornia({ from: '2024-01-01', zipPath: fixture('ca-sample.zip') }, (r) => recs.push(r));
    assert.equal(res.rows, 4); // the 2019 row and the historical file are left out
    assert.equal(res.latest, '2025-07-15');
    const sunrun = recs.find((r) => r.installer === 'Sunrun Inc.');
    assert.equal(sunrun.license, '750184');
    assert.equal(sunrun.storage, true);
    assert.equal(sunrun.storage_kwh, 13.5);
    assert.equal(sunrun.tpo, true);
    assert.equal(sunrun.financier, 'Sunrun');
    assert.equal(sunrun.module, 'REC Group');
    assert.equal(sunrun.inverter, 'Enphase Energy');
    const baker = recs.find((r) => r.installer === 'Baker Electric, Inc.');
    assert.equal(baker.inverter, 'SolarEdge, "HD-Wave"');
    assert.equal(recs.find((r) => r.installer === 'Self Installer').self_install, true);
});

test('California: file selection by date', () => {
    assert.equal(fileNeeded('PGE_Interconnected_Project_Sites_Historical-Jan2020.csv', '2024-01-01'), false);
    assert.equal(fileNeeded('PGE_Interconnected_Project_Sites_Historical-Jan2020.csv', '2019-01-01'), true);
    assert.equal(fileNeeded('PGE_Interconnected_Project_Sites_Jan2020-Aug2026.csv', '2024-01-01'), true);
    assert.equal(fileNeeded('PGE_Interconnected_Project_Sites_Jan2020-Aug2026.csv', '2010-01-01', '2015-12-31'), false);
    assert.equal(fileNeeded('SDGE_Interconnected_Project_Sites_Historical-Aug2026.csv', '2024-01-01'), true);
    assert.equal(cleanLicense('858088.0'), '858088');
    assert.equal(cleanLicense('n/a'), null);
});

test('Massachusetts: reads the xlsx report', async () => {
    const recs = [];
    const res = await loadMassachusetts({ from: '2024-01-01', filePath: fixture('ma-sample.xlsx') }, (r) => recs.push(r));
    assert.equal(res.rows, 2);
    assert.equal(recs[0].installer, 'SmartRoof Capital');
    assert.equal(recs[0].date, '2024-12-06');
    assert.equal(recs[0].zip, '02067');
    assert.equal(recs[0].sector, 'residential');
    assert.equal(recs[1].city, 'Boston & <Back Bay>');
    assert.equal(recs[1].county, 'Suffolk');
    assert.equal(recs[1].tpo, true);
});

test('Massachusetts: finds the report link on the page', () => {
    const html = '<a href="/sites/default/files/documents/Solar-PV-Systems-in-MA-as-of-Oct-2026.xlsx">PV</a>';
    assert.equal(findReportLink(html), 'https://www.masscec.com/sites/default/files/documents/Solar-PV-Systems-in-MA-as-of-Oct-2026.xlsx');
    assert.equal(findReportLink('<a href="/other.xlsx">'), null);
});

test('xlsx helpers', () => {
    assert.equal(columnNumber('A'), 0);
    assert.equal(columnNumber('Q'), 16);
    assert.equal(columnNumber('AA'), 26);
    assert.equal(excelDate(45632), '2024-12-06');
    const row = parseRow('<c r="A5" t="s"><v>1</v></c><c r="C5"><v>2.5</v></c><c r="D5" t="inlineStr"><is><t>a &amp; b</t></is></c><c r="E5" s="3"/>', ['x', 'y']);
    assert.equal(row[0], 'y');
    assert.equal(row[1], undefined);
    assert.equal(row[2], '2.5');
    assert.equal(row[3], 'a & b');
    assert.equal(row.length, 4);
});

test('New York rows', () => {
    const s = mapNySolar({ project_status: 'Complete', date_install: '2025-09-23T00:00:00.000', contractor: 'Empire Solar Solutions, LLC', county: 'Dutchess', zip_code: '12540', sector: 'Residential', purchase_type: 'Lease', project_cost: '98000.00', totalnameplatekwdc: '31.74' });
    assert.equal(s.date, '2025-09-23');
    assert.equal(s.status, 'installed');
    assert.equal(s.tpo, true);
    assert.equal(s.financing, 'lease');
    assert.equal(s.kw, 31.74);
    const p = mapNySolar({ project_status: 'Pipeline', date_application_received: '2026-10-01T00:00:00.000', contractor: 'X', sector: 'Non-Residential' });
    assert.equal(p.status, 'pipeline');
    assert.equal(p.sector, 'commercial');
    const b = mapNyStorage({ project_status: 'Completed', date_completed: '2025-01-02T00:00:00.000', contractor: 'Y', program_type: 'Residential', installed_energy_storage_kwhac: '27' });
    assert.equal(b.storage, true);
    assert.equal(b.storage_kwh, 27);
});

test('Connecticut and Oregon rows', () => {
    const c = mapCtSolar({ completed_date: '2012-12-06T00:00:00.000', contractor: 'Waldo Renewable Electric', kw_stc: '5.76', total_system_cost: '32251.88', system_owner: 'Does Not Apply', system_financing_type: 'Other Homeowner Purchase', county: 'New London County' });
    assert.equal(c.county, 'New London');
    assert.equal(c.tpo, false);
    const e = mapCtStorage({ stage: 'Project Complete', completed_date: '2025-11-04T00:00:00.000', contractor_name: 'Aegis Solar Energy', sector: 'Residential', third_party_owner: 'Home Owner', total_system_energy_capacity: '19.4', paired_pv_system_size: '38.0', combined_bess_models: 'SolarEdge Technologies Ltd. BAT-10K1P [9.7 kWh] [9.7 kWh];SolarEdge SE7600H-US [240V]' });
    assert.equal(e.solar, true);
    assert.equal(e.tpo, false);
    assert.equal(e.battery, 'SolarEdge Technologies Ltd. BAT-10K1P');
    const o = mapOregon({ funding_year_issued: '2024', rebate_recipient_contractor: 'E2 Solar Inc', pv_system_specification_1: '24.75', total_storage_rebates: '0', final_total_system_costs: '52076', project_city: 'Bend', project_zip: '97703' });
    assert.equal(o.year, 2024);
    assert.equal(o.date, null);
    assert.equal(o.kw, 24.75);
    assert.equal(o.storage, false);
});
