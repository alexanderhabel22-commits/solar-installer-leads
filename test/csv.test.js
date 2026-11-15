import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, createCsvParser } from '../src/csv.js';

test('parses quotes, escaped quotes, empty fields and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n1,"x, ""y""",\r\n"multi\nline",2,3\n');
    assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, "y"', ''], ['multi\nline', '2', '3']]);
});

test('maxColumns keeps the first columns and skips the rest, even quoted', () => {
    const rows = parseCsv('a,b,"c,\nd",e\n1,2,3,4\n', { maxColumns: 2 });
    assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('rows split across chunks at every position come out the same', () => {
    const text = 'h1,h2,h3\n"q,1",plain,"a""b"\nx,,z\nlast,"row\nwith newline",end';
    const expected = parseCsv(text);
    for (let cut = 1; cut < text.length; cut++) {
        const rows = [];
        const p = createCsvParser((r) => rows.push(r));
        p.feed(text.slice(0, cut));
        p.feed(text.slice(cut));
        p.end();
        assert.deepEqual(rows, expected, `cut at ${cut}`);
    }
});

test('maxColumns with chunk splits', () => {
    const text = 'a,b,c,d\n1,"2",3,"4,4"\n5,6,"7\n7",8\n';
    const expected = parseCsv(text, { maxColumns: 2 });
    assert.deepEqual(expected, [['a', 'b'], ['1', '2'], ['5', '6']]);
    for (let cut = 1; cut < text.length; cut++) {
        const rows = [];
        const p = createCsvParser((r) => rows.push(r), { maxColumns: 2 });
        p.feed(text.slice(0, cut));
        p.feed(text.slice(cut));
        p.end();
        assert.deepEqual(rows, expected, `cut at ${cut}`);
    }
});
