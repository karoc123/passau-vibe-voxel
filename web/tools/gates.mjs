// The web gates in one run (docs/plans/code-health.md item 1): tsc and the headless checks of web/tools/, in parallel,
// with a PASS / FAIL table and their times. Which gate guards which files is the table GATES below: run the gates
// before a commit, or at least those whose `guards` cover what you changed.
//   fast set (default, under a minute on 20 cores): tsc and every check that runs in seconds;
//   full set (--full): also section-check, popin-check, caps-check --all, surface-gap --check against
//     docs/plans/surface-gap-baseline.json, and mesh-golden check if a golden file is given (--golden FILE, recorded
//     before the change with `node tools/mesh-golden.mjs write FILE`).
// A gate passes when its command exits 0 and, where `expect` is set, it printed at least that many PASS lines and no
// FAIL line (a scenario dropped from a check would otherwise go unnoticed; the counts include the real-data checks
// those tools run when the data is there, so they apply only then). Gates on the real data (`data`) are
// SKIP without public/data/meta.json (or VOXEL_DATA, tools/data-dir.mjs). Nothing is written; the output of a failed
// gate is printed after the table (-v: every gate's).
// usage (in web/): node tools/gates.mjs [--full] [--golden FILE] [-j N] [-v] [--list] [gate ...]
//   gate ...: only those (by name, from either set); --list: the table, nothing run; -j: gates at once (default: half
//   the cores, at most 8); exit code 1 if a gate fails
// pnpm gates / pnpm gates:full run the same.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { web, dataDir } from './data-dir.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const FULL = args.includes('--full'), VERBOSE = args.includes('-v'), LIST = args.includes('--list');
const golden = opt('--golden');
const jobs = Math.max(1, +(opt('-j') ?? Math.min(8, Math.floor(os.availableParallelism() / 2))));
const named = args.filter((a, i) => !a.startsWith('-') && !['--golden', '-j'].includes(args[i - 1]));

// name, the command (run in web/ with this node), set, real data needed, PASS lines expected (at least), seconds as
// measured (WSL, 20 cores, alone; for the order: longest first), what it guards
const tsc = path.join(web, 'node_modules/typescript/bin/tsc');
const GATES = [
  { name: 'tsc', cmd: [tsc, '--noEmit'], set: 'fast', secs: 0.7, guards: 'all of src/ and checks/ (types)' },
  { name: 'core-deps', cmd: ['tools/core-deps.mjs'], set: 'fast', secs: 0.1, guards: 'src/core/, src/sim/ (with sim/craft/), src/physics/ and their imports: no three.js, no DOM; nothing in src/ imports checks/' },
  { name: 'bld-ids', cmd: ['tools/bld-ids.mjs'], set: 'fast', secs: 0.4, guards: 'mesher.worker.ts greedy merge, building ids' },
  { name: 'layers', cmd: ['tools/layers.mjs'], set: 'fast', secs: 0.4, guards: 'core/layers.ts (L0/L1/L2, routeOps, deltas)' },
  { name: 'edit-roundtrip', cmd: ['tools/edit-roundtrip.mjs'], set: 'fast', data: true, secs: 0.6, guards: 'core/columns.ts (edits, encode)' },
  { name: 'tile-roundtrip', cmd: ['tools/tile-roundtrip.mjs'], set: 'fast', secs: 2, guards: 'node file format: scripts/tilefile.py, tiles.py column_runs, tile-data.ts, core/tile-sections.ts (needs uv)' },
  { name: 'boat', cmd: ['tools/boat.mjs'], set: 'fast', expect: 20, secs: 1.7, guards: 'sim/craft/boat-motion.ts, sim/river.ts, core/safe-trail.ts; checks/boat-checks.ts, world.ts' },
  { name: 'collision', cmd: ['tools/collision.mjs'], set: 'fast', expect: 16, secs: 2.7, guards: 'nav/voxel-collision.ts, the tile format; checks/collision-checks.ts, world.ts' },
  { name: 'craft-motion', cmd: ['tools/craft-motion.mjs'], set: 'fast', expect: 19, secs: 1.2, guards: 'sim/craft/craft-motion.ts and nav/craft-collision.ts; checks/world.ts' },
  { name: 'world-smoke', cmd: ['tools/world-smoke.mjs'], set: 'fast', data: true, secs: 2.5, guards: 'core/ stack, layers, mesher from columns, rapier terrain.ts' },
  { name: 'rapier-car', cmd: ['tools/rapier-car.mjs'], set: 'fast', expect: 45, secs: 3.1, guards: 'physics/rapier/ (car.ts, life-phys.ts, player-car.ts, terrain.ts); checks/scenarios.ts, drive-scenarios.ts, world.ts' },
  { name: 'vehicles', cmd: ['tools/vehicles.mjs'], set: 'fast', expect: 35, secs: 3.2, guards: 'sim/vehicles.ts, physics/rapier/car.ts, physics/rapier/player-car.ts' },
  { name: 'caps-check', cmd: ['tools/caps-check.mjs'], set: 'fast', data: true, secs: 6, guards: 'core/surface.ts, mesher caps, roofs.ts (20 nodes)' },
  { name: 'plane', cmd: ['tools/plane.mjs'], set: 'fast', expect: 32, secs: 12.5, guards: 'sim/craft/plane-flight.ts, core/safe-trail.ts; checks/plane-checks.ts, jet-checks.ts, plane-real.ts, world.ts' },
  { name: 'life-edit', cmd: ['tools/life-edit.mjs'], set: 'fast', data: true, secs: 15, guards: 'sim/traffic.ts, train-traffic.ts, boat-traffic.ts, physics/rapier/life-phys.ts, core/live-edits.ts, car.ts' },
  { name: 'section-check', cmd: ['tools/section-check.mjs'], set: 'full', data: true, secs: 56, guards: 'sections.ts, mesher.worker.ts meshSections' },
  { name: 'popin-check', cmd: ['tools/popin-check.mjs'], set: 'full', data: true, secs: 59, guards: 'view/life.ts, sim/train-traffic.ts, sim/boat-traffic.ts' },
  { name: 'caps-check-all', cmd: ['tools/caps-check.mjs', '--all'], set: 'full', data: true, secs: 85, guards: 'as caps-check, every node with caps' },
  { name: 'surface-gap', cmd: ['tools/surface-gap.mjs', '--check', '../docs/plans/surface-gap-baseline.json'], set: 'full', data: true, secs: 12, guards: 'physics/rapier/terrain.ts and car.ts against core/surface.ts (the baseline)' },
  { name: 'mesh-golden', cmd: golden ? ['tools/mesh-golden.mjs', 'check', path.resolve(golden)] : null, set: 'full', data: true, secs: 11, guards: 'mesher.worker.ts byte for byte (only with --golden FILE)' },
];

const hasData = fs.existsSync(path.join(dataDir, 'meta.json'));
let gates;
if (named.length) {
  const unknown = named.filter((n) => !GATES.some((g) => g.name === n));
  if (unknown.length) { console.error(`no gate ${unknown.join(', ')}; gates: ${GATES.map((g) => g.name).join(' ')}`); process.exit(2); }
  gates = GATES.filter((g) => named.includes(g.name));
} else gates = GATES.filter((g) => g.set === 'fast' || FULL);

if (LIST) {
  for (const g of GATES) console.log(`${g.name.padEnd(15)} ${g.set.padEnd(5)} ${g.data ? 'data' : '    '} ~${String(g.secs).padStart(4)} s  ${g.guards}`);
  process.exit(0);
}

const fmt = (s) => `${s.toFixed(1)} s`;
function run(g) {
  return new Promise((resolve) => {
    if (!g.cmd) return resolve({ g, status: 'SKIP', note: 'no --golden FILE', secs: 0, out: '' });
    if (g.data && !hasData) return resolve({ g, status: 'SKIP', note: `no ${path.relative(web, dataDir)}/meta.json`, secs: 0, out: '' });
    const t0 = performance.now();
    const p = spawn(process.execPath, g.cmd, { cwd: web, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    // a hung gate fails instead of hanging the run: 10 x its usual time, at least 2 min
    const timer = setTimeout(() => { out += `\n(killed after ${fmt((performance.now() - t0) / 1000)})`; p.kill('SIGKILL'); }, Math.max(120, g.secs * 10) * 1000);
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      const secs = (performance.now() - t0) / 1000;
      const pass = out.match(/^\s*PASS\b/gm)?.length ?? 0, fail = out.match(/^\s*FAIL\b/gm)?.length ?? 0;
      let status = code === 0 ? 'PASS' : 'FAIL', note = signal ? `killed (${signal})` : code ? `exit ${code}` : '';
      if (g.expect != null && hasData) { // the counts are with the real data's checks (skipped without it)
        note = [note, `${pass}/${g.expect} checks`].filter(Boolean).join(', ');
        if (pass < g.expect || fail) { status = 'FAIL'; if (pass < g.expect && code === 0) note += ' (fewer than expected)'; }
      }
      resolve({ g, status, note, secs, out });
    });
  });
}

// longest first, `jobs` at a time
const queue = [...gates].sort((a, b) => b.secs - a.secs);
const results = new Map();
const t0 = performance.now();
console.log(`gates (${FULL ? 'full' : named.length ? 'named' : 'fast'}): ${gates.length}, ${jobs} at a time`);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let g; (g = queue.shift()); ) {
    const r = await run(g);
    results.set(g.name, r);
    console.log(`  ${r.status.padEnd(4)} ${g.name} (${fmt(r.secs)})`);
  }
}));
const wall = (performance.now() - t0) / 1000;

const rows = gates.map((g) => results.get(g.name));
for (const r of rows) if (r.g.cmd && r.status !== 'SKIP' && (VERBOSE || r.status === 'FAIL')) {
  console.log(`\n---- ${r.g.name}: node ${r.g.cmd.map((a) => path.relative(web, a) || a).join(' ')}`);
  const lines = r.out.trimEnd().split('\n');
  console.log((VERBOSE ? lines : lines.slice(-60)).join('\n'));
}
const w = Math.max(...rows.map((r) => r.g.name.length));
console.log(`\n${'gate'.padEnd(w)}  result  ${'time'.padStart(7)}  note`);
for (const r of rows) console.log(`${r.g.name.padEnd(w)}  ${r.status.padEnd(6)}  ${fmt(r.secs).padStart(7)}  ${r.note}`);
const failed = rows.filter((r) => r.status === 'FAIL'), skipped = rows.filter((r) => r.status === 'SKIP');
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${rows.length - failed.length - skipped.length} passed, ${failed.length} failed` +
  `${skipped.length ? `, ${skipped.length} skipped` : ''} in ${fmt(wall)}${failed.length ? ` (${failed.map((r) => r.g.name).join(', ')})` : ''}`);
process.exit(failed.length ? 1 : 0);
