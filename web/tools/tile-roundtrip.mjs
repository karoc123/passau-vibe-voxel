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
const { module: SF } = await runnerImport(`${root}src/core/surface.ts`, { root, logLevel: 'error' });
const { module: RF } = await runnerImport(`${root}src/roofs.ts`, { root, logLevel: 'error' });
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
  same(F('caps'), t.caps, exp.caps);
  if (t.caps) same(F('caps records'), SF.decodeCaps(t.caps), exp.capRecords);
  same(F('roof'), t.roofCaps, exp.roof);
  if (t.roofCaps) same(F('roof records'), RF.decodeRoofs(t.roofCaps), exp.roofRecords);
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

// The caps' liveness (core/surface.ts capField; the edit rule): a node of 2 x 2 columns (S 4), a cap on each of
// columns 0..6 -- [runs, ground, caps [ztop, corners], the slots that must come out live]
{
  const cases = [
    [[[0, 10, 1]], 10, [[10, [600, 640, 680, 650]]], [0]], // live, slot 0
    [[[0, 10, 1], [10, 1, 2]], 10, [[10, [600, 640, 680, 650]]], []], // a voxel put on it: dead
    [[[0, 5, 1], [5, 5, 2]], 10, [[10, [590, 640, 640, 640]]], [0]], // solid through touching runs: live
    [[[0, 10, 1], [20, 2, 3]], 10, [[10, [620, 640, 640, 660]], [22, [1400, 1408, 1420, 1408]]], [0, 1]], // ground and deck
    [[[0, 8, 1]], 8, [[10, [600, 640, 680, 650]]], []], // dug: the run ends lower, dead
    [[[9, 1, 1]], 10, [[10, [540, 640, 640, 640]]], []], // not solid down to its lowest corner: dead
    [[[0, 10, 1], [10, 2, 4]], 12, [[10, [600, 640, 680, 650]]], []], // built on: dead
  ];
  const S = 4, counts = new Uint16Array(S * S), ground = new Uint8Array(S * S), runs = [], recs = [];
  cases.forEach(([rs, g, cs], c) => { counts[c] = rs.length; ground[c] = g; for (const r of rs) runs.push(...r); for (const [z, q] of cs) recs.push([c, z, ...q]); });
  const n = recs.length, zz = (v) => ((v << 1) ^ (v >> 15)) & 0xffff, caps = new Uint16Array(6 * n);
  recs.forEach((r, i) => { caps[i] = r[0] - (i ? recs[i - 1][0] : 0); caps[n + i] = zz(r[1] - (i ? recs[i - 1][1] : 0)); for (let k = 0; k < 4; k++) caps[(2 + k) * n + i] = zz(r[2 + k] - r[1] * 64); });
  const f = SF.capField(2, { counts, runs: new Uint16Array(runs), ground, caps });
  cases.forEach(([, , cs, live], c) => {
    const got = [0, 1].filter((s) => f.z[2 * c + s] > 0);
    if (JSON.stringify(got) !== JSON.stringify(live)) fail(`capField liveness, column ${c}: slots ${JSON.stringify(got)}, not ${JSON.stringify(live)}`);
    for (const s of got) { const [z, q] = cs[s === 0 ? 0 : cs.length - 1]; if (SF.surfaceAt(f, c, z, 0, 0) !== q[0] / 64 || SF.cornerQ(f, c, s, 2) !== q[2]) fail(`capField column ${c}: corners`); }
  });
  if (SF.capField(2, { counts, runs: new Uint16Array(runs), ground, caps: null }) !== null) fail('capField without a section: not null');
}

// the roofs' liveness (roofs.ts roofField): 2 x 2 columns, a roof record on each of columns 0..3 -- column 0 its last
// run ends at the record's top (live), 1 a run on it (dead), 2 its top a metre lower (dead), 3 no runs (dead)
{
  const counts = new Uint16Array(16), runs = [];
  const put = (c, rs) => { counts[c] = rs.length; for (const r of rs) runs.push(...r); };
  put(0, [[0, 10, 7]]); put(1, [[0, 10, 7], [10, 2, 8]]); put(2, [[0, 9, 7]]);
  const recs = [[0, 10, 640, 700, 660, 600], [1, 10, 600, 610, 620, 630], [2, 10, 640, 640, 650, 640], [3, 10, 641, 640, 640, 640]];
  const n = recs.length, zz = (v) => ((v << 1) ^ (v >> 15)) & 0xffff, roof = new Uint16Array(6 * n);
  recs.forEach((r, i) => { roof[i] = r[0] - (i ? recs[i - 1][0] : 0); roof[n + i] = zz(r[1] - (i ? recs[i - 1][1] : 0)); roof[2 * n + i] = zz(r[2] - (i && roof[i] === 1 ? recs[i - 1][3] : r[1] * 64)); roof[3 * n + i] = zz(r[3] - r[2]); roof[4 * n + i] = zz(r[4] - r[3]); roof[5 * n + i] = zz(r[5] - r[2]); });
  if (JSON.stringify([...RF.decodeRoofs(roof)]) !== JSON.stringify(recs.flat())) fail('decodeRoofs');
  const f = RF.roofField(2, { counts, runs: new Uint16Array(runs), roofCaps: roof });
  const live = f ? [0, 1, 2, 3].filter((c) => f.z[c]) : [];
  if (JSON.stringify(live) !== '[0]' || f.q[1] !== 700) fail(`roofField liveness: live ${JSON.stringify(live)}`);
  if (RF.roofField(2, { counts, runs: new Uint16Array(runs), roofCaps: null }) !== null) fail('roofField without a section: not null');
}

// the paved ground in two languages: the ids scripts/caps.py caps (paved_ids) are those core/semantics.ts calls PAVED
{
  const { module: SE } = await runnerImport(`${root}src/core/semantics.ts`, { root, logLevel: 'error' });
  const pal = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/palette.json'), 'utf8')).palette;
  const py = JSON.parse(execFileSync('uv', ['run', '--quiet', 'python', 'scripts/caps.py', '--paved-ids'], { cwd: repo }).toString());
  const ts = [...SE.semanticTable(pal)].flatMap((f, i) => (f & SE.SEM.PAVED ? [i] : []));
  if (JSON.stringify(py) !== JSON.stringify(ts)) fail(`paved ids: caps.py ${py.length} (${py.slice(0, 8)}...), semantics.ts ${ts.length} (${ts.slice(0, 8)}...)`);
}

if (bad.length) {
  console.log(`tile round trip: ${bad.length} mismatches (files kept in ${dir})`);
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`tile round trip: ok (${S * S} columns, ${nruns} runs, ${exp.rooms.length / 4} room spans; without the room section; with extra sections ${Object.keys(exp.extra).sort().join(' ')}; caps and their liveness; roof; registries agree; paved ids agree)`);
