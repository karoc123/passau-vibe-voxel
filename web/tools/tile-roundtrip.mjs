// The node file's format end to end: scripts/tile_roundtrip.py writes a synthetic node (tiles.column_runs,
// tilefile.write) and what it holds, src/tile-data.ts decodeTile reads it back; every column's ground and runs, the
// planes, buildings and fields compared, and the two sides' N (tilefile.N, TILE_N). Files in a temp dir, removed
// unless a check fails.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-roundtrip-'));
execFileSync('uv', ['run', '--quiet', 'python', 'scripts/tile_roundtrip.py', dir, process.argv[2] ?? '1'], { cwd: repo, stdio: 'inherit' });

const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const buf = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'tile.bin')));
const t = TD.decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), exp.N);
const bad = [];
const fail = (what) => { if (bad.length < 20) console.log(`  FAIL ${what}`); bad.push(what); };
if (exp.N !== TD.TILE_N) fail(`N: tilefile.py ${exp.N}, tile-data.ts ${TD.TILE_N}`);
const S = exp.N + 2;
if (t.counts.length !== S * S) fail(`counts: ${t.counts.length} columns, not ${S * S}`);
let at = 0;
for (let c = 0; c < S * S; c++) {
  const want = exp.columns[c], got = [];
  for (let k = 0; k < t.counts[c]; k++, at += 3) got.push([t.runs[at], t.runs[at + 1], t.runs[at + 2]]);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`column ${c} (row ${Math.floor(c / S)}, col ${c % S}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
}
if (at !== t.runs.length) fail(`runs: ${t.runs.length / 3}, the counts say ${at / 3}`);
const same = (name, got, want) => {
  if (!got) return fail(`${name}: missing`);
  if (got.length !== want.length) return fail(`${name}: ${got.length} values, not ${want.length}`);
  const i = want.findIndex((v, k) => got[k] !== v);
  if (i >= 0) fail(`${name}[${i}]: ${got[i]} != ${want[i]}`);
};
same('ground', t.ground, exp.ground);
same('planes', t.planes, exp.planes);
same('bld', t.bld, exp.bld);
same('fields.cell', t.fields?.cell, exp.cell);
same('fields.spill', t.fields?.spill, exp.spill);

if (bad.length) {
  console.log(`tile round trip: ${bad.length} mismatches (files kept in ${dir})`);
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`tile round trip: ok (${S * S} columns, ${t.runs.length / 3} runs)`);
