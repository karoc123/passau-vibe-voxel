// The rule of web/src/core/ (docs/adr/0001-world-layers.md): no three.js, no DOM, so the viewer, the node tools and a
// Node server share it. The same for the world sim (docs/adr/0006-world-sim-seam.md): all of src/sim/ (the traffic,
// trains and river boats, the rivers' water, and in sim/craft/ the player's vehicles' cores a server would step or
// check) and src/physics/ (the Rapier bodies: the traffic's, the player's car); their presentation lives in view/ and
// nav/. A static scan of every module under src/core/, src/sim/ and src/physics/, and everything they import,
// transitively (relative imports, type-only ones included):
//   - no import of three (or three/...), util.ts (three.js helpers and the DOM) or voxelMaterial.ts (the shaders);
//   - no DOM global in the code (comments and strings left out): window, document, location, navigator, localStorage,
//     sessionStorage, requestAnimationFrame, HTML...Element, ... and no fetch (core takes its loader injected).
// And for all of src/ (the shipped app): no import from web/checks/ (the check harnesses the tools run).
// And the layer rules of docs/plans/architecture-review.md section 3 (package A1), over every module of src/:
//   R1 layer table: LAYERS maps today's files to a layer, ALLOWED says which layers each may import (every import
//      statement, type-only ones included);
//   R2 no value-import cycle (hard), and the type cycles (cycles through type-only imports) are the baseline's;
//   R3 determinism words in layers 0-3 (data, contract, shared, domain): no Math.random, Date.now, new Date,
//      setTimeout, setInterval; performance.now only in PERF_NOW_OK (stats) until a stats clock is injected;
//   R4 window.__ assigned only in HOOKS_OWNER.
// R1-R4 are a ratchet: today's violations are BASELINE below. A violation not in it fails; a baseline entry that no
// longer occurs fails too (delete it, so the list stays true). After a fix or a move, `node tools/core-deps.mjs
// --baseline` prints the list as it is now, to paste over BASELINE; it may only get shorter (review the diff).
// usage (in web/): node tools/core-deps.mjs [-v] [--baseline]; prints PASS and the modules scanned (-v: and the
// baseline), or each violation and exit 1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(web, 'src'), checks = path.join(web, 'checks'), verbose = process.argv.includes('-v');
const rel = (f) => path.relative(web, f);

const BANNED_MODULES = [
  [(spec) => spec === 'three' || spec.startsWith('three/'), 'three.js'],
  [(spec, file) => file === path.join(src, 'util.ts'), 'util.ts (three.js, DOM)'],
  [(spec, file) => file === path.join(src, 'voxelMaterial.ts'), 'voxelMaterial.ts (shaders, three.js)'],
];
const DOM_GLOBALS = ['window', 'document', 'location', 'navigator', 'localStorage', 'sessionStorage', 'indexedDB',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'getComputedStyle', 'matchMedia', 'alert',
  'fetch', 'XMLHttpRequest', 'Image', 'ImageData', 'OffscreenCanvas', 'WebGLRenderingContext', 'WebGL2RenderingContext',
  'Worker', 'self', 'globalThis', 'addEventListener', 'removeEventListener', 'devicePixelRatio', 'innerWidth', 'innerHeight'];
const DOM_RE = new RegExp(`(?<![\\w$.])(?:${DOM_GLOBALS.join('|')}|HTML\\w*Element|SVG\\w*Element|\\w*Event)(?![\\w$])(?!\\s*:(?!:))`, 'g');

// the source with comments blanked (code), and with strings blanked too (bare); line breaks kept
function lex(text) {
  let code = '', bare = '';
  const n = text.length;
  const put = (c, keepInCode, keepInBare) => {
    const blank = c === '\n' ? '\n' : ' ';
    code += keepInCode ? c : blank; bare += keepInBare ? c : blank;
  };
  // template literals: their ${ } expressions are code (a stack of brace depths)
  const tpl = [];
  let depth = 0;
  for (let i = 0; i < n; i++) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') put(text[i++], false, false); i--; continue; }
    if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2), end = e < 0 ? n : e + 2; while (i < end) put(text[i++], false, false); i--; continue; }
    if (c === '\'' || c === '"') {
      put(c, true, false);
      for (i++; i < n && text[i] !== c && text[i] !== '\n'; i++) { if (text[i] === '\\') { put(text[i++], true, false); } put(text[i], true, false); }
      if (i < n) put(text[i], true, false);
      continue;
    }
    if (c === '`' || (c === '}' && tpl.length && tpl[tpl.length - 1] === depth)) {
      if (c === '}') tpl.pop();
      put(c, true, false);
      for (i++; i < n && text[i] !== '`'; i++) {
        if (text[i] === '\\') { put(text[i++], true, false); put(text[i], true, false); continue; }
        if (text[i] === '$' && text[i + 1] === '{') { put(text[i++], true, false); put(text[i], true, true); tpl.push(depth); break; }
        put(text[i], true, false);
      }
      if (i < n && text[i] === '`') put(text[i], true, false);
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    put(c, true, true);
  }
  return { code, bare };
}

function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const f of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts')]) if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  return base;
}

// imports and re-exports: static, side-effect, dynamic
const IMPORT_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?(['"])([^'"\n]+)\1|\bimport\s*\(\s*(['"])([^'"\n]+)\3\s*\)/g;
const lineOf = (s, at) => s.slice(0, at).split('\n').length;
const bad = [], seen = new Set(), queue = [];
const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, out); else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(f); } return out; };
// the headless directories, whole
for (const d of ['core', 'sim', 'physics']) for (const f of walk(path.join(src, d), [])) queue.push([f, null]);
while (queue.length) {
  const [file, via] = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const where = (at) => `${rel(file)}:${at}${via ? ` (imported by ${rel(via)})` : ''}`;
  if (!fs.existsSync(file)) { bad.push(`${where('?')}: unresolved module`); continue; }
  const text = fs.readFileSync(file, 'utf8'), { code, bare } = lex(text);
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? m[4], target = resolve(file, spec);
    for (const [test, what] of BANNED_MODULES) if (test(spec, target)) bad.push(`${where(lineOf(code, m.index))}: imports ${spec}: ${what}`);
    if (target && !seen.has(target)) queue.push([target, file]);
  }
  // (a name the module declares or imports is its own, not the DOM's: a core's PlaneEvent, CarEvent)
  const own = new Set([...bare.matchAll(/\b(?:type|interface|class|enum)\s+([\w$]+)/g)].map((m) => m[1]));
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, ''); if (k) own.add(k); }
  for (const m of bare.matchAll(DOM_RE)) if (!own.has(m[0])) bad.push(`${where(lineOf(bare, m.index))}: DOM global ${m[0]}`);
}

// nothing in src/ imports from checks/ (it would ship a test harness)
const apps = walk(src, []);
for (const file of apps) {
  const { code } = lex(fs.readFileSync(file, 'utf8'));
  for (const m of code.matchAll(IMPORT_RE)) {
    const target = resolve(file, m[2] ?? m[4]);
    if (target && !path.relative(checks, target).startsWith('..')) bad.push(`${rel(file)}:${lineOf(code, m.index)}: imports ${m[2] ?? m[4]}: checks/ is not part of the app`);
  }
}

// ---- the layer rules (R1-R4) ----

// Layer of a module (path relative to src/), first match wins: 'dir/' a folder, else one file. Today's layout, no moves
// yet (A2-A4 move files; this table follows them). A mixed module is placed where its main code goes in section 3.
const LAYERS = [
  ['core/', 'data'],
  ['sim/commands.ts', 'contract'],
  ['sim/craft/', 'shared'], ['sim/path.ts', 'shared'], ['sim/vehicles.ts', 'shared'], ['sim/river.ts', 'shared'],
  ['sim/tuning.ts', 'shared'], ['sim/types.ts', 'shared'], ['sim/traffic-pack.ts', 'shared'], ['sim/walk-bounds.ts', 'shared'],
  // (snapshot.ts: takeSnapshot; A3 takes its types to the contract, A4 TrafficMirror to the client)
  ['sim/sim-server.ts', 'server'], ['sim/snapshot.ts', 'server'],
  ['sim/sim-client.ts', 'client'],
  ['sim/', 'domain'], ['physics/', 'domain'],
  // (host/; fetch.ts and viewer-tiles.ts, which A4 also names, stay with the root: the mesher, util.ts and stream.ts
  // load through them, and presentation may not import the server)
  ['sim-host.ts', 'server'], ['sim.worker.ts', 'server'],
  ['sim-worker-link.ts', 'client'],
  ['view/', 'presentation'], ['nav/', 'presentation'],
  ['main.ts', 'app'],
  ['*', 'presentation'], // the rest of the root: render modules, UI, and the headless data modules A2 moves to core/
];
const ALLOWED = {
  data: ['data'],
  contract: ['data', 'contract'],
  shared: ['data', 'contract', 'shared'],
  domain: ['data', 'contract', 'shared', 'domain'],
  server: ['data', 'contract', 'shared', 'domain', 'server'],
  client: ['data', 'contract', 'shared', 'client'],
  presentation: ['data', 'contract', 'shared', 'client', 'presentation'],
  app: ['data', 'contract', 'shared', 'domain', 'server', 'client', 'presentation', 'app'],
};
const HEADLESS = new Set(['data', 'contract', 'shared', 'domain']); // R3
const PERF_NOW_OK = new Set(['physics/rapier/life-phys.ts', 'physics/rapier/terrain.ts']);
const HOOKS_OWNER = 'main.ts';

// Today's violations (docs/plans/architecture-review.md section 1). Only shrinks: A2 takes the headless -> root ones,
// A3 the contract's and nav's, A4 the client <-> server ones.
const BASELINE = [
  "R1 core/columns.ts (data) -> tile-data.ts (presentation) type",
  "R1 core/live-edits.ts (data) -> tile-data.ts (presentation) type",
  "R1 core/tile-cache.ts (data) -> tile-data.ts (presentation)",
  "R1 nav/craft.ts (presentation) -> sim/world-sim.ts (domain) type",
  "R1 nav/crafts-view.ts (presentation) -> sim/world-sim.ts (domain) type",
  "R1 nav/drive.ts (presentation) -> physics/rapier/car.ts (domain) type",
  "R1 nav/drive.ts (presentation) -> physics/rapier/player-car.ts (domain)",
  "R1 nav/player.ts (presentation) -> sim/world-sim.ts (domain) type",
  "R1 sim-host.ts (server) -> fetch.ts (presentation)",
  "R1 sim-worker-link.ts (client) -> sim-host.ts (server) type",
  "R1 sim-worker-link.ts (client) -> sim.worker.ts (server) type",
  "R1 sim-worker-link.ts (client) -> sim/snapshot.ts (server) type",
  "R1 sim-worker-link.ts (client) -> sim/world-sim.ts (domain) type",
  "R1 sim.worker.ts (server) -> fetch.ts (presentation)",
  "R1 sim.worker.ts (server) -> sim/sim-client.ts (client) type",
  "R1 sim.worker.ts (server) -> tile-world.ts (presentation)",
  "R1 sim.worker.ts (server) -> viewer-tiles.ts (presentation)",
  "R1 sim/commands.ts (contract) -> physics/rapier/car.ts (domain) type",
  "R1 sim/commands.ts (contract) -> sim/entities.ts (domain) type",
  "R1 sim/commands.ts (contract) -> sim/mode.ts (domain) type",
  "R1 sim/commands.ts (contract) -> sim/types.ts (shared) type",
  "R1 sim/commands.ts (contract) -> sim/vehicles.ts (shared) type",
  "R1 sim/commands.ts (contract) -> sim/world-sim.ts (domain) type",
  "R1 sim/craft/voxel-collision.ts (shared) -> tile-data.ts (presentation) type",
  "R1 sim/edit-keeper.ts (domain) -> tile-data.ts (presentation)",
  "R1 sim/sim-client.ts (client) -> physics/rapier/player-car.ts (domain) type",
  "R1 sim/sim-client.ts (client) -> sim/boat-traffic.ts (domain) type",
  "R1 sim/sim-client.ts (client) -> sim/entities.ts (domain) type",
  "R1 sim/sim-client.ts (client) -> sim/sim-server.ts (server) type",
  "R1 sim/sim-client.ts (client) -> sim/snapshot.ts (server)",
  "R1 sim/sim-client.ts (client) -> sim/traffic.ts (domain)",
  "R1 sim/sim-client.ts (client) -> sim/traffic.ts (domain) type",
  "R1 sim/sim-client.ts (client) -> sim/world-sim.ts (domain)",
  "R1 sim/sim-server.ts (server) -> sim/sim-client.ts (client) type",
  "R1 sim/snapshot.ts (server) -> sim/sim-client.ts (client) type",
  "R1 sim/tuning.ts (shared) -> sim/edit-keeper.ts (domain)",
  "R1 view/boats.ts (presentation) -> sim/boat-traffic.ts (domain)",
  "R1 view/life.ts (presentation) -> sim/traffic.ts (domain)",
  "R1 view/life.ts (presentation) -> sim/traffic.ts (domain)",
  "R1 view/meshes.ts (presentation) -> sim/traffic.ts (domain)",
  "R1 view/trains.ts (presentation) -> sim/train-traffic.ts (domain)",
  "R2 type cycle: foliage.ts, voxelMaterial.ts",
  "R2 type cycle: nav/craft.ts, nav/foot.ts, nav/nav.ts, nav/orbit.ts, nav/ride.ts",
  "R2 type cycle: sim/commands.ts, sim/mode.ts, sim/world-sim.ts",
  "R2 type cycle: sim/sim-client.ts, sim/sim-server.ts, sim/snapshot.ts",
];

const srcRel = (f) => path.relative(src, f).split(path.sep).join('/');
function layerOf(r) {
  for (const [pat, layer] of LAYERS) if (pat === '*' ? !r.includes('/') : pat.endsWith('/') ? r.startsWith(pat) : r === pat) return layer;
  return null;
}
// every import statement of a module: its target in src/ and whether it is type-only (import type, export type, or
// braces with only `type` names; a dynamic import() is a value import)
const STMT_RE = /\b(import|export)\s+(type\s+)?(?:([\w$*{},\s]+?)\s+from\s+)?(['"])([^'"\n]+)\4|\bimport\s*\(\s*(['"])([^'"\n]+)\6\s*\)/g;
const typeOnly = (m) => {
  if (m[7]) return false;
  if (m[2]) return true;
  const c = (m[3] ?? '').trim(), names = c.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
  return c.startsWith('{') && c.endsWith('}') && names.length > 0 && names.every((x) => /^type\s/.test(x));
};
const found = [], edges = new Map(); // found: [key, line]; edges: module -> [{ to, type }]
for (const file of apps) {
  const r = srcRel(file), layer = layerOf(r);
  if (!layer) { bad.push(`${rel(file)}: in no layer (tools/core-deps.mjs LAYERS)`); continue; }
  const { code, bare } = lex(fs.readFileSync(file, 'utf8')), out = [];
  edges.set(r, out);
  for (const m of code.matchAll(STMT_RE)) {
    const target = resolve(file, m[5] ?? m[7]);
    if (!target || path.relative(src, target).startsWith('..') || !fs.existsSync(target)) continue;
    const to = srcRel(target), type = typeOnly(m), tl = layerOf(to);
    out.push({ to, type });
    if (tl && !ALLOWED[layer].includes(tl)) found.push([`R1 ${r} (${layer}) -> ${to} (${tl})${type ? ' type' : ''}`, lineOf(code, m.index)]);
  }
  if (HEADLESS.has(layer)) {
    for (const m of bare.matchAll(/(?<![\w$.])(?:Math\s*\.\s*random|Date\s*\.\s*now|new\s+Date|setTimeout|setInterval|performance\s*\.\s*now)(?![\w$])/g)) {
      const word = m[0].startsWith('new') ? 'new Date' : m[0].replace(/\s+/g, '');
      if (word === 'performance.now' && PERF_NOW_OK.has(r)) continue;
      found.push([`R3 ${r}: ${word}`, lineOf(bare, m.index)]);
    }
  }
  if (r !== HOOKS_OWNER) for (const m of code.matchAll(/\bwindow(?:\s+as\s+[^)]*\))?\s*\.\s*(__[\w$]+)\s*=(?![=>])/g)) found.push([`R4 ${r}: window.${m[1]}`, lineOf(code, m.index)]);
}

// strongly connected components (Tarjan) over value imports (R2: none allowed) and over all imports (the type cycles)
function cycles(withTypes) {
  let n = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = (v) => {
    idx.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const { to, type } of edges.get(v) ?? []) {
      if (type && !withTypes) continue;
      if (!idx.has(to)) { visit(to); low.set(v, Math.min(low.get(v), low.get(to))); } else if (on.has(to)) low.set(v, Math.min(low.get(v), idx.get(to)));
    }
    if (low.get(v) !== idx.get(v)) return;
    const c = [];
    for (let w; w !== v; ) { w = stack.pop(); on.delete(w); c.push(w); }
    if (c.length > 1 || (edges.get(v) ?? []).some((e) => e.to === v && (withTypes || !e.type))) out.push(c.sort());
  };
  for (const v of edges.keys()) if (!idx.has(v)) visit(v);
  return out;
}
const valueCycles = cycles(false).map((c) => c.join(', '));
for (const c of valueCycles) bad.push(`R2 value-import cycle: ${c}`);
for (const c of cycles(true)) if (!valueCycles.includes(c.join(', '))) found.push([`R2 type cycle: ${c.join(', ')}`, null]);

// the ratchet: what is found against BASELINE, as multisets (keys carry no line numbers, so edits elsewhere keep them)
const have = new Map(), base = new Map();
for (const [k] of found) have.set(k, (have.get(k) ?? 0) + 1);
for (const k of BASELINE) base.set(k, (base.get(k) ?? 0) + 1);
if (process.argv.includes('--baseline')) {
  console.log('const BASELINE = [');
  for (const k of [...have.keys()].sort()) for (let i = 0; i < have.get(k); i++) console.log(`  ${JSON.stringify(k)},`);
  console.log('];');
  process.exit(0);
}
for (const [k, at] of found) {
  if (base.get(k) > 0) { base.set(k, base.get(k) - 1); continue; }
  bad.push(`${k}${at ? ` (line ${at})` : ''}: new layer violation (docs/plans/architecture-review.md section 3; LAYERS, ALLOWED here)`);
}
for (const [k, left] of base) for (let i = 0; i < left; i++) bad.push(`${k}: in BASELINE but no longer found; delete it there (node tools/core-deps.mjs --baseline)`);

const scanned = [...seen].map(rel).sort();
if (verbose || bad.length) console.log(`scanned: ${scanned.join(', ')}`);
if (verbose) { console.log(`baseline (${BASELINE.length}):`); for (const k of BASELINE) console.log(`  ${k}`); }
if (bad.length) { for (const b of bad) console.log(`  FAIL ${b}`); console.log(`FAIL core-deps: ${bad.length} violation(s)`); process.exit(1); }
const of = (r) => BASELINE.filter((k) => k.startsWith(r)).length;
console.log(`PASS core-deps: ${scanned.length} modules (src/core/, src/sim/, src/physics/ and what they import) free of three.js, util.ts, voxelMaterial.ts and DOM globals; ${apps.length} modules of src/ import nothing from checks/`);
console.log(`PASS core-deps layers: ${edges.size} modules, ${[...edges.values()].reduce((s, e) => s + e.length, 0)} imports in src/, no value-import cycle; baseline: R1 ${of('R1')} imports, R2 ${of('R2')} type cycles, R3 ${of('R3')}, R4 ${of('R4')}; none new, none gone`);
