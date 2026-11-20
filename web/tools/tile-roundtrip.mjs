// The node file's format end to end: scripts/tile_roundtrip.py writes a synthetic node (tiles.column_runs,
// tilefile.write) and what it holds, src/tile-data.ts decodeTile reads it back; every column's ground and runs, the
// planes, buildings, fields and room spans compared (roomOffsets: each column's), and the two sides' N (tilefile.N,
// TILE_N); the same node without its room section decodes to the same, rooms null; with sections decodeTile does not
// interpret (two unknown tags, the reserved brik) to the same plus those, raw, in extra; and the registries
// (tilefile.SECTIONS, core/tile-sections.ts TILE_SECTIONS) list the same tags in the same order, the same reserved.
// Files in a temp dir, removed unless a check fails.
// usage: node tools/tile-roundtrip.mjs [SEED]; exit code 1 on a mismatch
import { runnerImport } from 'vite';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url)), repo = path.resolve(root, '..');
const { module: TD } = await runnerImport(`${root}src/tile-data.ts`, { root, logLevel: 'error' });
const { module: TS } = await runnerImport(`${root}src/core/tile-sections.ts`, { root, logLevel: 'error' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-roundtrip-'));
execFileSync('uv', ['run', '--quiet', 'python', 'scripts/tile_roundtrip.py', dir, process.argv[2] ?? '1'], { cwd: repo, stdio: 'inherit' });

const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const decode = (f) => { const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, f))); return TD.decodeTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), exp.N); };
const bad = [];
const fail = (what) => { if (bad.length < 20) console.log(`  FAIL ${what}`); bad.push(what); };
if (exp.N !== TD.TILE_N) fail(`N: tilefile.py ${exp.N}, tile-data.ts ${TD.TILE_N}`);
const S = exp.N + 2;
const regPy = JSON.stringify(exp.registry), regTs = JSON.stringify(TS.TILE_SECTIONS.map((x) => [x.tag, !!x.reserved]));
if (regPy !== regTs) fail(`registry: tilefile.py ${regPy}, core/tile-sections.ts ${regTs}`);
const same = (name, got, want) => {
  if (!got) return fail(`${name}: missing`);
  if (got.length !== want.length) return fail(`${name}: ${got.length} values, not ${want.length}`);
  const i = want.findIndex((v, k) => got[k] !== v);
  if (i >= 0) fail(`${name}[${i}]: ${got[i]} != ${want[i]}`);
};
let nruns = 0;
for (const [file, withRooms, withExtra] of [['tile.bin', true, false], ['tile_noroom.bin', false, false], ['tile_extra.bin', true, true]]) {
  const t = decode(file), F = (what) => `${file} ${what}`;
  const wantExtra = withExtra ? Object.keys(exp.extra).sort() : [], gotExtra = [...(t.extra?.keys() ?? [])].sort();
  if (JSON.stringify(gotExtra) !== JSON.stringify(wantExtra)) fail(F(`extra: ${JSON.stringify(gotExtra)}, not ${JSON.stringify(wantExtra)}`));
  for (const tag of wantExtra) same(F(`extra ${tag}`), t.extra?.get(tag), exp.extra[tag]);
  if (t.counts.length !== S * S) fail(F(`counts: ${t.counts.length} columns, not ${S * S}`));
  let at = 0;
  for (let c = 0; c < S * S; c++) {
    const want = exp.columns[c], got = [];
    for (let k = 0; k < t.counts[c]; k++, at += 3) got.push([t.runs[at], t.runs[at + 1], t.runs[at + 2]]);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(F(`column ${c} (row ${Math.floor(c / S)}, col ${c % S}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`));
  }
  if (at !== t.runs.length) fail(F(`runs: ${t.runs.length / 3}, the counts say ${at / 3}`));
  nruns = t.runs.length / 3;
  same(F('ground'), t.ground, exp.ground);
  same(F('planes'), t.planes, exp.planes);
  same(F('bld'), t.bld, exp.bld);
  same(F('fields.cell'), t.fields?.cell, exp.cell);
  same(F('fields.spill'), t.fields?.spill, exp.spill);
  if (!withRooms) { if (t.rooms !== null) fail(F(`rooms: ${t.rooms.length / 4} spans, not none`)); continue; }
  same(F('rooms'), t.rooms, exp.rooms);
  if (!exp.rooms.length) fail(F('no room spans to test'));
  // each column's spans through roomOffsets: the expected ones of that column, in order
  if (t.rooms) {
    const off = TD.roomOffsets(t.rooms, S * S);
    let n = 0;
    for (let c = 0; c < S * S; c++) for (let k = off[c]; k < off[c + 1]; k++, n++) if (t.rooms[4 * k] !== c) { fail(F(`roomOffsets: span ${k} not column ${c}'s`)); break; }
    if (n !== t.rooms.length / 4 || off[S * S] !== n) fail(F(`roomOffsets: ${n} spans, not ${t.rooms.length / 4}`));
  }
}

if (bad.length) {
  console.log(`tile round trip: ${bad.length} mismatches (files kept in ${dir})`);
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`tile round trip: ok (${S * S} columns, ${nruns} runs, ${exp.rooms.length / 4} room spans; without the room section; with extra sections ${Object.keys(exp.extra).sort().join(' ')}; registries agree)`);
