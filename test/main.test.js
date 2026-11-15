import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseInput, installFilter, collect, rank, countyKey } from '../src/main.js';
import { loadCalifornia } from '../src/sources/california.js';

const quiet = { info() {}, warning() {}, debug() {} };

test('input defaults and validation', () => {
    const d = parseInput({});
    assert.deepEqual(d.states, ['CA', 'NY', 'MA', 'CT', 'OR']);
    assert.equal(d.installedFrom, '2024-01-01');
    assert.equal(d.minInstalls, 5);
    assert.equal(d.maxResults, 1000);
    assert.throws(() => parseInput({ states: ['TX'] }), /No install-level public data for TX/);
    assert.throws(() => parseInput({ states: ['XX'] }), /Unknown state/);
    assert.throws(() => parseInput({ installedFrom: '2024-13-45' }), /installedFrom/);
    assert.throws(() => parseInput({ installedFrom: '2025-01-01', installedTo: '2024-01-01' }), /before/);
    assert.throws(() => parseInput({ technology: 'wind' }), /technology/);
    assert.throws(() => parseInput({ zipCode: '75201' }), /No supported state/);
    assert.deepEqual(parseInput({ zipCode: '92101', radiusMiles: 30 }).states, ['CA']);
    assert.deepEqual(parseInput({ counties: ['San Diego County', ' los angeles '] }).counties, ['san diego', 'los angeles']);
});

test('county keys', () => {
    assert.equal(countyKey('SAN DIEGO'), 'san diego');
    assert.equal(countyKey('New London County'), 'new london');
});

test('install filter: county, ZIP radius, sector and technology', () => {
    const base = { state: 'CA', county: 'SAN DIEGO', zip: '92101', sector: 'residential', solar: true, storage: false };
    assert.ok(installFilter(parseInput({ states: ['CA'], counties: ['San Diego'] }))(base));
    assert.ok(!installFilter(parseInput({ states: ['CA'], counties: ['Orange'] }))(base));
    assert.ok(installFilter(parseInput({ zipCode: '92103', radiusMiles: 10 }))(base));
    assert.ok(!installFilter(parseInput({ zipCode: '90012', radiusMiles: 10 }))(base));
    assert.ok(!installFilter(parseInput({ sectors: ['commercial'] }))(base));
    assert.ok(!installFilter(parseInput({ technology: 'storage' }))(base));
    assert.ok(installFilter(parseInput({ technology: 'solar' }))(base));
    assert.ok(!installFilter(parseInput({ states: ['NY'] }))(base));
});

test('collect: end to end on the California sample', async () => {
    const zipPath = fileURLToPath(new URL('./fixtures/ca-sample.zip', import.meta.url));
    const input = parseInput({ states: ['CA'], minInstalls: 1, installedFrom: '2024-01-01' });
    const { rows, stats, areaInstalls } = await collect(input, {
        log: quiet,
        deadline: null,
        loaders: { CA: (o, cb) => loadCalifornia({ ...o, zipPath }, cb) },
    });
    assert.equal(areaInstalls, 3); // the self install does not count
    assert.equal(stats.ca_dgstats.rows_in_range, 4);
    assert.equal(stats.ca_dgstats.data_through, '2025-07-15');
    assert.equal(rows.length, 2);
    const [first, second] = rows;
    assert.equal(first.rank, 1);
    assert.equal(first.installer_name, 'Baker Electric, Inc.'); // Baker Home Energy merged in by license + phone
    assert.equal(first.installs, 2);
    assert.equal(first.share_of_area_installs, 0.6667);
    assert.equal(first.phone, '(760) 546-6000');
    assert.equal(second.installer_name, 'Sunrun Inc.');
    assert.deepEqual(Object.keys(first).slice(0, 4), ['rank', 'installer_name', 'share_of_area_installs', 'other_names']);
});

test('a failing source is reported, others still run', async () => {
    const input = parseInput({ states: ['CA', 'NY'], minInstalls: 1 });
    const { rows, stats } = await collect(input, {
        log: quiet,
        deadline: null,
        loaders: {
            CA: async () => { throw new Error('boom'); },
            NY: async (o, cb) => {
                cb({ source: 'nyserda', installer: 'Empire Solar', status: 'installed', state: 'NY', solar: true, date: '2025-01-01' });
                return { rows: 1 };
            },
        },
    });
    assert.equal(stats.ca_dgstats.error, 'boom');
    assert.equal(rows.length, 1);
    assert.equal(stats.nyserda.data_through, '2025-01-01');
});

test('rank by other fields', () => {
    const rows = rank([
        { installer_name: 'A', installs: 5, total_kw_dc: 100, last_install_date: '2025-01-01' },
        { installer_name: 'B', installs: 9, total_kw_dc: 50, last_install_date: '2026-01-01' },
    ], 'total_kw_dc');
    assert.deepEqual(rows.map((r) => [r.installer_name, r.rank]), [['A', 1], ['B', 2]]);
    assert.equal(rank(rows, 'last_install_date')[0].installer_name, 'B');
});

test('ZIP radius: installs without a ZIP are placed by the main county', async () => {
    const input = parseInput({ zipCode: '92101', radiusMiles: 10, minInstalls: 1 });
    const recs = [
        { installer: 'Acme Solar', zip: '92103', county: 'SAN DIEGO' },
        { installer: 'Acme Solar', zip: '92104', county: 'SAN DIEGO' },
        { installer: 'Acme Solar', zip: null, county: 'SAN DIEGO', storage: true },
        { installer: 'Far Away Solar', zip: null, county: 'ALAMEDA', storage: true },
        { installer: 'Far Away Solar', zip: '94501', county: 'ALAMEDA' },
    ].map((r) => ({ source: 'ca_dgstats', status: 'installed', state: 'CA', solar: !r.storage, storage: false, date: '2025-01-01', ...r }));
    const { rows, areaInstalls } = await collect(input, {
        log: quiet,
        deadline: null,
        loaders: { CA: async (o, cb) => { recs.forEach(cb); return { rows: recs.length }; } },
    });
    assert.equal(areaInstalls, 3);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].installs, 3);
    assert.equal(rows[0].storage_installs, 1);
});
