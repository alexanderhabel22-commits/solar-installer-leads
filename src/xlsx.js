// Minimal streaming reader for large .xlsx files (one big worksheet of plain
// values). Shared strings are loaded first; the sheet XML is then streamed
// row by row so a 100 MB sheet never sits in memory as one string.

import yauzl from 'yauzl';

const unescapeXml = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** "A" -> 0, "Q" -> 16, "AA" -> 26. */
export function columnNumber(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/** Text of every <si> entry in sharedStrings.xml. */
export function parseSharedStrings(xml) {
    const out = [];
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) {
        const parts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
        out.push(unescapeXml(parts.join('')));
    }
    return out;
}

/** Values of one <row> element, as a sparse array indexed by column. */
export function parseRow(rowXml, strings) {
    const cells = [];
    const re = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let m;
    while ((m = re.exec(rowXml))) {
        const attrs = m[1];
        const ref = attrs.match(/\br="([A-Z]+)\d+"/);
        if (!ref || m[2] == null) continue;
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        let value;
        if (type === 'inlineStr') {
            value = unescapeXml([...m[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
        } else {
            const v = m[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
            if (v == null) continue;
            value = type === 's' ? strings[Number(v)] ?? '' : unescapeXml(v);
        }
        cells[columnNumber(ref[1])] = value;
    }
    return cells;
}

/** Excel serial day number -> "YYYY-MM-DD". */
export function excelDate(serial) {
    const n = Number(serial);
    if (!Number.isFinite(n) || n < 1) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000).toISOString().slice(0, 10);
}

function readEntryText(zip, entry, onChunk) {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (err, stream) => {
            if (err) return reject(err);
            stream.setEncoding('utf8');
            stream.on('data', onChunk);
            stream.on('end', resolve);
            stream.on('error', reject);
        });
    });
}

/**
 * Calls onRow(cells) for every row of the largest worksheet in the file.
 */
export function readLargestSheet(path, onRow) {
    return new Promise((resolve, reject) => {
        yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
            if (err) return reject(err);
            const entries = [];
            zip.on('entry', (e) => {
                entries.push(e);
                zip.readEntry();
            });
            zip.on('error', reject);
            zip.on('end', async () => {
                try {
                    const sst = entries.find((e) => e.fileName === 'xl/sharedStrings.xml');
                    let sstXml = '';
                    if (sst) await readEntryText(zip, sst, (c) => { sstXml += c; });
                    const strings = parseSharedStrings(sstXml);
                    sstXml = '';
                    const sheet = entries
                        .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.fileName))
                        .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
                    if (!sheet) throw new Error('No worksheet in file');
                    let buf = '';
                    let rows = 0;
                    await readEntryText(zip, sheet, (chunk) => {
                        buf += chunk;
                        let pos = 0;
                        let start = -1;
                        for (;;) {
                            start = buf.indexOf('<row', pos);
                            if (start === -1) break;
                            const gt = buf.indexOf('>', start);
                            if (gt === -1) break;
                            if (buf.charCodeAt(gt - 1) === 47 /* / */) { // empty <row .../>
                                pos = gt + 1;
                                continue;
                            }
                            const end = buf.indexOf('</row>', gt);
                            if (end === -1) break;
                            onRow(parseRow(buf.slice(gt + 1, end), strings));
                            rows++;
                            pos = end + 6;
                        }
                        // Keep the unfinished row, or a short tail that may hold a split "<row" tag.
                        buf = start === -1 ? buf.slice(Math.max(pos, buf.length - 8)) : buf.slice(start);
                    });
                    zip.close();
                    resolve(rows);
                } catch (e) {
                    zip.close();
                    reject(e);
                }
            });
            zip.readEntry();
        });
    });
}
