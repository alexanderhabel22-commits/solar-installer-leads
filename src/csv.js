// A small, fast streaming CSV reader.
//
// The California interconnection files are over 1 GB of CSV with ~400
// columns, almost all empty. Building a full array per row would be slow, so
// the reader only keeps the first `maxColumns` fields of each row and skips
// over the rest (still honouring quotes, so commas or newlines inside quoted
// text never break a row).

/**
 * Returns a push-style parser. Call feed(chunk) with text chunks and end()
 * at the end. onRow(fields) gets an array with at most maxColumns strings.
 *
 * Optional early check: once a row has `opts.earlyColumns` fields,
 * `opts.keepRow(fields)` is called; when it returns false the rest of the
 * row is skipped without parsing and onRow is not called. Both are read
 * live, so they can be set after the header row is seen.
 */
export function createCsvParser(onRow, opts = {}) {
    const maxColumns = opts.maxColumns ?? Infinity;
    let rest = '';

    // Parses complete rows out of `text`. Returns the index where an
    // unfinished row starts (or text.length when all rows were complete).
    function parse(text, final) {
        const n = text.length;
        let i = 0;
        while (i < n) {
            const rowStart = i;
            const fields = [];
            let done = false;
            while (!done) {
                if (i >= n) {
                    if (!final) return rowStart;
                    fields.push('');
                    break;
                }
                let value;
                if (text.charCodeAt(i) === 34 /* " */) {
                    // Quoted field: find the closing quote ("" is an escaped quote).
                    let j = i + 1;
                    let out = '';
                    let segStart = j;
                    for (;;) {
                        const q = text.indexOf('"', j);
                        if (q === -1) {
                            if (!final) return rowStart;
                            out += text.slice(segStart);
                            j = n;
                            break;
                        }
                        if (text.charCodeAt(q + 1) === 34) {
                            out += text.slice(segStart, q + 1);
                            j = q + 2;
                            segStart = j;
                            continue;
                        }
                        if (q + 1 >= n && !final) return rowStart; // can't tell yet if "" follows
                        out += text.slice(segStart, q);
                        j = q + 1;
                        break;
                    }
                    value = out;
                    i = j;
                    // Skip any junk up to the delimiter.
                    while (i < n && text.charCodeAt(i) !== 44 && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
                } else {
                    let j = i;
                    while (j < n) {
                        const c = text.charCodeAt(j);
                        if (c === 44 || c === 10 || c === 13) break;
                        j++;
                    }
                    if (j >= n && !final) return rowStart;
                    value = text.slice(i, j);
                    i = j;
                }
                if (fields.length < maxColumns) fields.push(value);
                if (i >= n) {
                    if (!final) return rowStart;
                    done = true;
                    break;
                }
                const c = text.charCodeAt(i);
                if (c === 44) {
                    i++;
                    let skip = fields.length >= maxColumns;
                    let drop = false;
                    if (!skip && fields.length === opts.earlyColumns && opts.keepRow && !opts.keepRow(fields)) {
                        skip = true;
                        drop = true;
                    }
                    // Past the columns we need (or a row we don't want): skip to the end of the row.
                    if (skip) {
                        if (drop) fields.dropped = true;
                        const end = skipToRowEnd(text, i);
                        if (end === -1) {
                            if (!final) return rowStart;
                            i = n;
                        } else {
                            i = end;
                        }
                        done = true;
                    }
                } else {
                    done = true;
                }
            }
            // Consume the line break.
            if (i < n && text.charCodeAt(i) === 13) i++;
            if (i < n && text.charCodeAt(i) === 10) i++;
            if (!fields.dropped && (fields.length > 1 || fields[0] !== '')) onRow(fields);
        }
        return n;
    }

    return {
        feed(chunk) {
            const text = rest ? rest + chunk : chunk;
            const at = parse(text, false);
            rest = text.slice(at);
        },
        end() {
            if (rest) parse(rest, true);
            rest = '';
        },
    };
}

/** Index just past the end of the current row (after \n), honouring quotes. -1 when not found. */
function skipToRowEnd(text, from) {
    let i = from;
    const n = text.length;
    for (;;) {
        const nl = text.indexOf('\n', i);
        const q = text.indexOf('"', i);
        if (nl === -1) return -1;
        if (q === -1 || q > nl) return nl + 1;
        // A quoted section starts before the newline: jump past it.
        let j = q + 1;
        for (;;) {
            const e = text.indexOf('"', j);
            if (e === -1) return -1;
            if (text.charCodeAt(e + 1) === 34) {
                j = e + 2;
                continue;
            }
            i = e + 1;
            break;
        }
    }
}

/** Parses a whole CSV string into rows (for small files and tests). */
export function parseCsv(text, opts) {
    const rows = [];
    const p = createCsvParser((r) => rows.push(r), opts);
    p.feed(text);
    p.end();
    return rows;
}
