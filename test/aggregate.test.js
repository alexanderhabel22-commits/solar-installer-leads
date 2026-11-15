import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, installerKey, isJunkInstaller, tradingName, Tally, mergeTallies, toProfile } from '../src/aggregate.js';

const rec = (o) => ({ source: 'ca_dgstats', status: 'installed', state: 'CA', solar: true, storage: false, ...o });

test('installer keys group spellings and national brands', () => {
    assert.equal(installerKey('Sunrun Installation Services Inc'), 'sunrun');
    assert.equal(installerKey('SolarCity DBA Tesla Energy'), 'tesla energy');
    assert.equal(installerKey('Freedom Forever Massachusetts, LLC'), 'freedom forever');
    assert.equal(installerKey('California Solar Electric'), 'california solar electric'); // state at the start stays
    assert.equal(installerKey('Solar New York'), 'solar new york'); // too short to cut
    assert.equal(installerKey('J2RM Professional Solutions Inc DBA Freedom Solar'), 'freedom solar');
    assert.equal(installerKey('G A F Energy LLC'), installerKey('GAF Energy'));
    assert.equal(installerKey('N R G Clean Power Inc'), 'nrg clean power');
    assert.equal(cleanName('SOLAR OPTIMUM DESIGN &amp; ELECTRICAL'), 'SOLAR OPTIMUM DESIGN & ELECTRICAL');
});

test('junk installer names', () => {
    for (const n of ['', 'None', 'N/A', 'Self Installer', 'self-installed', 'Homeowner', 'Owner']) assert.ok(isJunkInstaller(n), n);
    assert.ok(!isJunkInstaller('Sunrun Inc.'));
});

test('trading names for display', () => {
    assert.equal(tradingName('Powur PBC DBA Powur Home Construction'), 'Powur Home Construction');
    assert.equal(tradingName('Momentum Solar (dba for Pro Custom Solar LLC)'), 'Momentum Solar');
    assert.equal(tradingName('Baker Electric, Inc.'), 'Baker Electric, Inc.');
});

test('license links names only when they share a distinctive word', () => {
    const t = new Tally();
    t.add(rec({ installer: 'BRIGHT ENERGY GROUP LLC', license: '1080822', phone: '435-619-1304' }));
    t.add(rec({ installer: 'Bright Energy', license: '1080822', phone: '435-817-3217' }));
    t.add(rec({ installer: 'Totally Different Roofing', license: '1080822' }));
    const groups = mergeTallies(t.tallies);
    assert.equal(groups.length, 2);
});

test('a partner license used on some jobs does not merge companies', () => {
    const t = new Tally();
    for (let i = 0; i < 5; i++) t.add(rec({ installer: 'Freedom Forever LLC', license: '1029644', phone: '800-885-9450' }));
    for (let i = 0; i < 3; i++) t.add(rec({ installer: 'Freedom Solar Co', license: '1124448', phone: '951-321-0855' }));
    for (let i = 0; i < 2; i++) t.add(rec({ installer: 'Freedom Solar Co', license: '1029644', phone: '951-321-0855' }));
    assert.equal(mergeTallies(t.tallies).length, 2);
});

test('generic one-word names do not merge across states', () => {
    const t = new Tally();
    t.add(rec({ installer: 'Empower Solar', state: 'CA' }));
    t.add(rec({ installer: 'EmPower Solar', state: 'NY', source: 'nyserda' }));
    t.add(rec({ installer: 'Sunrun Inc.', state: 'CA' }));
    t.add(rec({ installer: 'SunRun Inc.', state: 'NY', source: 'nyserda' }));
    t.add(rec({ installer: 'Trinity Solar Inc.', state: 'NY', source: 'nyserda' }));
    t.add(rec({ installer: 'Trinity Solar, Inc.', state: 'CT', source: 'ct_green_bank' }));
    const groups = mergeTallies(t.tallies);
    assert.equal(groups.length, 4); // Empower x2, Sunrun, Trinity
});

test('profiles add up installs, storage, cost per watt and areas', () => {
    const t = new Tally();
    t.add(rec({ installer: 'Acme Solar Inc', kw: 10, cost: 30000, date: '2025-01-05', county: 'SAN DIEGO', city: 'SAN DIEGO', zip: '92101', sector: 'residential', tpo: false, phone: '6195551234', hq_city: 'San Diego', hq_state: 'CA', hq_zip: '92101', license: '123456', module: 'REC' }));
    t.add(rec({ installer: 'ACME SOLAR INC', kw: 5, storage: true, storage_kwh: 13.5, cost: 40000, date: '2025-06-01', county: 'San Diego', sector: 'commercial', tpo: true, financier: 'GoodLeap' }));
    t.add(rec({ installer: 'Acme Solar', status: 'pipeline', date: '2025-09-01' }));
    t.add(rec({ installer: 'Acme Solar', self_install: true }));
    const [g] = mergeTallies(t.tallies);
    const p = toProfile(g, { scrapedAt: 'x' });
    assert.equal(p.installer_name, 'Acme Solar Inc');
    assert.equal(p.installs, 2);
    assert.equal(p.pipeline_projects, 1);
    assert.equal(p.storage_installs, 1);
    assert.equal(p.storage_share, 0.5);
    assert.equal(p.total_kw_dc, 15);
    assert.equal(p.avg_system_kw, 7.5);
    assert.equal(p.avg_cost_per_watt, 3); // the battery job is left out
    assert.equal(p.third_party_owned_share, 0.5);
    assert.deepEqual(p.top_financiers, [{ name: 'GoodLeap', installs: 1 }]);
    assert.deepEqual(p.top_counties, [{ county: 'San Diego', state: 'CA', installs: 2 }]);
    assert.equal(p.first_install_date, '2025-01-05');
    assert.equal(p.last_install_date, '2025-06-01');
    assert.deepEqual(p.installs_by_year, { 2025: 2 });
    assert.equal(p.phone, '(619) 555-1234');
    assert.equal(p.cslb_license, '123456');
    assert.match(p.cslb_license_url, /LicNum=123456$/);
    assert.equal(t.skipped.self_install, 1);
});
