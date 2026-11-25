// The rule of web/src/core/ (docs/adr/0001-world-layers.md): no three.js, no DOM, so the viewer, the node tools and a
// Node server share it. The same for the world sim (docs/adr/0006-world-sim-seam.md): all of src/sim/ (the traffic,
// trains and river boats, the rivers' water, and in sim/craft/ the player's vehicles' cores a server would step or
// check) and src/physics/ (the Rapier bodies: the traffic's, the player's car); their presentation lives in view/ and
// nav/. And the client (src/client/sim-client.ts: SimClient, the mirror, the links but the worker's), which a Node
// client would share. A static scan of every module under src/core/, src/sim/ and src/physics/, of
// src/client/sim-client.ts and src/host/sim-host.ts, and everything they import, transitively (relative imports,
// type-only ones included):
//   - no import of three (or three/...), util.ts (three.js helpers and the DOM) or voxelMaterial.ts (the shaders);
//   - no DOM global in the code (comments and strings left out): window, document, location, navigator, localStorage,
//     sessionStorage, requestAnimationFrame, HTML...Element, ... and no fetch (core takes its loader injected).
// And src/host/sim-host.ts (the one host's wiring, A12) likewise, with no clock, console or process: ports.
// And for all of src/ (the shipped app): no import from web/checks/ (the check harnesses the tools run).
// And the layer rules of docs/plans/architecture-review.md section 3 (package A1), over every module of src/:
//   R1 layer table: LAYERS maps today's files to a layer, ALLOWED says which layers each may import (every import
//      statement, type-only ones included);
//   R2 no value-import cycle (hard), and the type cycles (cycles through type-only imports) are the baseline's;
//   R3 determinism words in layers 0-3 (data, contract, shared, domain): no Math.random, Date.now, new Date,
//      setTimeout, setInterval; performance.now only in PERF_NOW_OK (stats) until a stats clock is injected;
//   R4 window.__ assigned only in HOOKS_OWNER;
//   R5 the contract is types: a module of the contract layer (sim/contract/) declares no class and no function body
//      (function or arrow) but a type guard's (its return type `x is T`); its constants are data.
// R1-R5 are a ratchet: today's violations are BASELINE below. A violation not in it fails; a baseline entry that no
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
const PORTS_ONLY = ['host/sim-host.ts'];
const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, out); else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(f); } return out; };
// the headless directories, whole, and the headless client (A4 moved it out of sim/)
for (const d of ['core', 'sim', 'physics']) for (const f of walk(path.join(src, d), [])) queue.push([f, null]);
queue.push([path.join(src, 'client', 'sim-client.ts'), null]);
// the one host's wiring (A12): headless, and its clock, log and loaders are ports (PORTS_ONLY below)
queue.push([path.join(src, 'host', 'sim-host.ts'), null]);
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

// the host's wiring takes its clock, its log and its loaders as ports (A12: host/sim-host.ts HostPorts): no
// performance, console, Date or process in it (fetch and the DOM: the scan above)
for (const f of PORTS_ONLY) {
  const { bare } = lex(fs.readFileSync(path.join(src, f), 'utf8'));
  for (const m of bare.matchAll(/(?<![\w$.])(?:performance|console|Date|process)(?![\w$])/g)) bad.push(`src/${f}:${lineOf(bare, m.index)}: ${m[0]}: a port's (HostPorts), not the host's`);
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

// ---- the layer rules (R1-R5) ----

// Layer of a module (path relative to src/), first match wins: 'dir/' a folder, else one file. Today's layout (A2-A4
// move files; this table follows them). A mixed module is placed where its main code goes in section 3.
const LAYERS = [
  ['core/', 'data'],
  ['sim/contract/', 'contract'],
  ['sim/craft/', 'shared'], ['sim/path.ts', 'shared'], ['sim/vehicles.ts', 'shared'], ['sim/river.ts', 'shared'],
  ['sim/tuning.ts', 'shared'], ['sim/types.ts', 'shared'], ['sim/traffic-pack.ts', 'shared'], ['sim/walk-bounds.ts', 'shared'],
  ['sim/seat-reads.ts', 'shared'], // (a reader's reads of the event log: a session's, a mirror client's; A7)
  ['sim/server/', 'server'], // (sim-server.ts: SimServer, Session; snapshot.ts: takeSnapshot)
  ['sim/', 'domain'], ['physics/', 'domain'],
  ['client/', 'client'], // (SimClient, LocalSimClient, MirrorSimClient, TrafficMirror, the links)
  // (sim-host.ts: the wiring of a world, its loaders and clock as ports; browser.ts, node.ts: the ports; sim.worker.ts:
  // the worker's entry. The page's own loaders, fetch.ts and viewer-tiles.ts, are the root's: presentation, A12)
  ['host/', 'server'],
  ['view/', 'presentation'], ['nav/', 'presentation'],
  ['main.ts', 'app'],
  ['*', 'presentation'], // the rest of the root: render modules, UI (A2 moved the headless data modules to core/)
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
const TYPES_ONLY = 'contract'; // R5

// R5: where a module (bare: comments and strings blanked) has code rather than types and data: a class, a function
// body (function or arrow) that is not a type guard's (its return type `x is T`). Type and interface declarations are
// blanked first (to their `;` or closing brace at bracket depth 0), so a function type in them is no body.
function codeOf(bare) {
  let code = bare;
  for (const m of bare.matchAll(/\b(type\s+[\w$]+\b[^=;{]*=|interface\s+[\w$]+[^{]*\{)/g)) {
    let i = m.index + m[0].length, d = m[1].startsWith('interface') ? 1 : 0;
    for (; i < bare.length && d >= 0; i++) {
      const c = bare[i];
      if ('{(['.includes(c)) d++;
      else if ('})]'.includes(c)) { d--; if (d === 0 && m[1].startsWith('interface')) { i++; break; } }
      else if (c === ';' && d === 0) break;
    }
    code = code.slice(0, m.index) + code.slice(m.index, i).replace(/[^\n]/g, ' ') + code.slice(i);
  }
  const out = [];
  for (const m of code.matchAll(/\bclass\b/g)) out.push(['class', m.index]);
  const GUARD = /\)\s*:\s*[\w$]+\s+is\s+[^{=;]+$/;
  for (const m of code.matchAll(/\bfunction\b[^{;]*\{/g)) if (!GUARD.test(m[0].slice(0, -1).trimEnd())) out.push(['function body', m.index]);
  for (const m of code.matchAll(/=>/g)) if (!GUARD.test(code.slice(Math.max(0, m.index - 200), m.index).trimEnd())) out.push(['arrow function', m.index]);
  return out;
}

// Today's violations (docs/plans/architecture-review.md section 1). Only shrinks: A2 took the headless -> root ones,
// A3 the contract's, nav's and the sim's two type cycles, A7 the client -> world-sim one (SeatReads to its own shared
// module), A4 the client -> server ones (TrafficMirror to the client, the in-thread session as the client's
// InThreadSession, the worker's messages to sim/contract/worker.ts), A12 the host -> page loader ones (the host's
// loaders as ports: host/browser.ts, host/node.ts).
const BASELINE = [
  "R1 client/sim-client.ts (client) -> sim/traffic.ts (domain)",
  "R1 client/sim-client.ts (client) -> sim/traffic.ts (domain) type",
  "R1 sim/tuning.ts (shared) -> sim/edit-keeper.ts (domain)",
  "R1 view/boats.ts (presentation) -> sim/boat-traffic.ts (domain)",
  "R1 view/life.ts (presentation) -> sim/traffic.ts (domain)",
  "R1 view/life.ts (presentation) -> sim/traffic.ts (domain)",
  "R1 view/meshes.ts (presentation) -> sim/traffic.ts (domain)",
  "R1 view/trains.ts (presentation) -> sim/train-traffic.ts (domain)",
  "R2 type cycle: foliage.ts, voxelMaterial.ts",
  "R2 type cycle: nav/craft.ts, nav/foot.ts, nav/nav.ts, nav/orbit.ts, nav/ride.ts",
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
  if (layer === TYPES_ONLY) for (const [what, at] of codeOf(bare)) found.push([`R5 ${r}: ${what}`, lineOf(bare, at)]);
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
console.log(`PASS core-deps: ${scanned.length} modules (src/core/, src/sim/, src/physics/, src/client/sim-client.ts, src/host/sim-host.ts and what they import) free of three.js, util.ts, voxelMaterial.ts and DOM globals; ${apps.length} modules of src/ import nothing from checks/`);
console.log(`PASS core-deps layers: ${edges.size} modules, ${[...edges.values()].reduce((s, e) => s + e.length, 0)} imports in src/, no value-import cycle; baseline: R1 ${of('R1')} imports, R2 ${of('R2')} type cycles, R3 ${of('R3')}, R4 ${of('R4')}, R5 ${of('R5')} (sim/contract/ types only); none new, none gone`);
