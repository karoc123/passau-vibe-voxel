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
// And the weapons are packages (src/sim/weapons/<name>/), so removing one is deleting its folder and one line: no
// module of the scan above imports a file of a package but the registry, src/sim/weapons/index.ts, and the package's
// own files (the core reaches a weapon through the registry; no package leans on another).
// And the craft looks are packages (src/view/crafts/<type>/: a craft's model and what moves on it), so a craft's look
// changes inside its folder: no module of src/ imports a file of a package but the registry, src/view/crafts/index.ts,
// and the package's own files.
// And the layer rules of docs/adr/0009-layers-and-owners.md, over every module of src/:
//   R1 layer table: LAYERS maps today's files to a layer, ALLOWED says which layers each may import (every import
//      statement, type-only ones included);
//   R2 no value-import cycle (hard), and the type cycles (cycles through type-only imports) are the baseline's;
//   R4 window.__ assigned only in HOOKS_OWNER (app/debug-hooks.ts, which types them all; the rest call its hook());
//   R5 the contract is types: a module of the contract layer (sim/contract/) declares no class and no function body
//      (function or arrow) but a type guard's (its return type `x is T`); its constants are data.
//   R6 touch is read in touch/ only: no pointerType compared with 'touch' or 'pen', no maxTouchPoints, TouchEvent,
//      .touches or touch* event names elsewhere, so a mode takes the fingers as touch/ hands them (sticks' axes, intents).
// R1, R2, R4-R6 are a ratchet: today's violations are BASELINE below. A violation not in it fails; a baseline entry that no
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
const weapons = path.join(src, 'sim', 'weapons'), WEAPON_REGISTRY = path.join(weapons, 'index.ts');
// the weapon package a file is in (its folder under sim/weapons/), else null
const packageOf = (f) => { const r = path.relative(weapons, f).split(path.sep); return r.length > 1 && r[0] !== '..' ? r[0] : null; };
const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, out); else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(f); } return out; };
// the headless directories, whole, and the headless client (A4 moved it out of sim/)
// (a weapon package's gate.mjs is a node tool beside its code, not part of the app)
for (const d of ['core', 'sim', 'physics']) for (const f of walk(path.join(src, d), [])) if (path.basename(f) !== 'gate.mjs') queue.push([f, null]);
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
    const pkg = target && packageOf(target);
    if (pkg && file !== WEAPON_REGISTRY && packageOf(file) !== pkg) bad.push(`${where(lineOf(code, m.index))}: imports ${spec}: a weapon package, which only ${rel(WEAPON_REGISTRY)} imports`);
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

// nothing in src/ imports from checks/ (it would ship a test harness); a craft look's package only from the registry
const looks = path.join(src, 'view', 'crafts'), LOOK_REGISTRY = path.join(looks, 'index.ts');
const lookOf = (f) => { const r = path.relative(looks, f).split(path.sep); return r.length > 1 && r[0] !== '..' ? r[0] : null; };
const apps = walk(src, []);
for (const file of apps) {
  const { code } = lex(fs.readFileSync(file, 'utf8'));
  for (const m of code.matchAll(IMPORT_RE)) {
    const target = resolve(file, m[2] ?? m[4]), look = target && lookOf(target);
    if (target && !path.relative(checks, target).startsWith('..')) bad.push(`${rel(file)}:${lineOf(code, m.index)}: imports ${m[2] ?? m[4]}: checks/ is not part of the app`);
    if (look && file !== LOOK_REGISTRY && lookOf(file) !== look) bad.push(`${rel(file)}:${lineOf(code, m.index)}: imports ${m[2] ?? m[4]}: a craft look's package, which only ${rel(LOOK_REGISTRY)} imports`);
  }
}

// ---- the layer rules (R1-R6) ----

// Layer of a module (path relative to src/), first match wins: 'dir/' a folder, else one file. Today's layout (A2-A4
// move files; this table follows them). A mixed module is placed where its main code goes in section 3.
const LAYERS = [
  ['core/', 'data'],
  ['sim/contract/', 'contract'],
  ['sim/craft/', 'shared'], ['sim/path.ts', 'shared'],
  ['sim/vehicles.ts', 'shared'], ['sim/river.ts', 'shared'],
  ['sim/weapons/', 'shared'], // (fired by the host; their slots and pace are the page's too)
  ['sim/tuning.ts', 'shared'], ['sim/types.ts', 'shared'], ['sim/traffic-pack.ts', 'shared'], ['sim/walk-bounds.ts', 'shared'],
  ['sim/seat-reads.ts', 'shared'], // (a reader's reads of the event log: a session's, a mirror client's; A7)
  ['sim/hello.ts', 'shared'], // (the hello: made by the host, checked by the client; A6)
  ['sim/sun.ts', 'shared'], // (the sun's maths: the page's light, the host's start time)
  ['sim/body-pose.ts', 'shared'], // (a body's drawn pose: the sim's and a mirror's; A11)
  ['sim/agent-wire.ts', 'shared'], // (the cars and people as sent: a session's and a mirror's)
  ['sim/road-net.ts', 'shared'], ['sim/coaches.ts', 'shared'], ['sim/flow.ts', 'shared'], // (where the traffic and the trains are drawn: the sim's and a mirror's)
  ['sim/solids.ts', 'shared'], // (the shapes the walk meets)
  ['sim/walk.ts', 'shared'], ['sim/swim.ts', 'shared'], ['sim/walker.ts', 'shared'], // (the walk: the page's player's and the host's NPCs')
  ['sim/figure.ts', 'shared'], // (the figure's size: drawn by the page, walked and shot at on the host)
  ['sim/seats.ts', 'shared'], // (a model's seats: the host holds them, the page offers and draws them)
  ['sim/player-name.ts', 'shared'], // (a chosen name cleaned: by the page and by the host)
  ['sim/tank.ts', 'shared'], // (a vehicle's power: the host's and the copy a page runs ahead)
  ['sim/health.ts', 'shared'], // (each type's health as data, in the tuning; what a weapon does is its package's)
  ['sim/server/', 'server'], // (sim-server.ts: SimServer, Session; snapshot.ts: takeSnapshot)
  ['sim/', 'domain'], ['physics/', 'domain'],
  ['client/', 'client'], // (SimClient, MirrorSimClient, TrafficMirror, the links)
  // (sim-host.ts: the wiring of a world, its loaders and clock as ports; browser.ts, node.ts: the ports; sim.worker.ts:
  // the worker's entry. The page's own loaders, fetch.ts and viewer-tiles.ts, are the root's: presentation, A12)
  ['host/', 'server'],
  ['view/', 'presentation'], ['nav/', 'presentation'], ['ui/', 'presentation'], // (ui/: the page's small widgets)
  ['touch/', 'touch'], // (the fingers as sticks, taps and holds: knows no mode; R6)
  ['main.ts', 'app'], ['app/', 'app'], // (the composition: main.ts; app/: the session, the frame's phases, the debug hooks)
  ['chamfer.ts', 'shared'], ['sections.ts', 'shared'], // (pure: the walk keeps the eyes off the walls they draw)
  ['*', 'presentation'], // the rest of the root: render modules, UI (A2 moved the headless data modules to core/)
];
const ALLOWED = {
  data: ['data'],
  contract: ['data', 'contract'],
  shared: ['data', 'contract', 'shared'],
  domain: ['data', 'contract', 'shared', 'domain'],
  server: ['data', 'contract', 'shared', 'domain', 'server'],
  client: ['data', 'contract', 'shared', 'client'],
  touch: ['data', 'contract', 'shared', 'touch'],
  presentation: ['data', 'contract', 'shared', 'client', 'touch', 'presentation'],
  app: ['data', 'contract', 'shared', 'domain', 'server', 'client', 'touch', 'presentation', 'app'],
};
const HOOKS_OWNER = 'app/debug-hooks.ts';
const TYPES_ONLY = 'contract'; // R5
const TOUCH_RE = /pointerType\s*[!=]==?\s*['"](?:touch|pen)['"]|['"](?:touch|pen)['"]\s*[!=]==?\s*[\w$.]*pointerType|\bmaxTouchPoints\b|\bTouch(?:Event|List)\b|\.touches\b|['"]touch(?:start|move|end|cancel)['"]/g; // R6

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

// Today's violations (docs/adr/0009-layers-and-owners.md). Only shrinks.
const BASELINE = [
  "R1 view/boats.ts (presentation) -> sim/boat-traffic.ts (domain)",
  "R2 type cycle: nav/craft.ts, nav/nav.ts, nav/orbit.ts, nav/ride.ts",
  "R6 main.ts: pointerType==='pen'",
  "R6 main.ts: pointerType==='touch'",
  "R6 nav/nav.ts: pointerType==='touch'",
  "R6 nav/nav.ts: pointerType==='touch'",
  "R6 nav/nav.ts: pointerType==='touch'",
  "R6 nav/orbit.ts: .touches",
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
  if (layer !== 'touch') for (const m of code.matchAll(TOUCH_RE)) found.push([`R6 ${r}: ${m[0].replace(/\s+/g, '').replace(/"/g, "'")}`, lineOf(code, m.index)]);
  if (layer === TYPES_ONLY) for (const [what, at] of codeOf(bare)) found.push([`R5 ${r}: ${what}`, lineOf(bare, at)]);
  // (window.__x = …, and window[name] = … as the owner's hook() writes)
  if (r !== HOOKS_OWNER) for (const m of code.matchAll(/\bwindow(?:\s+as\s+[^)]*\))?\s*(?:\.\s*(__[\w$]+)|\[[^\]\n]*\])\s*=(?![=>])/g)) found.push([`R4 ${r}: window${m[1] ? `.${m[1]}` : '[…]'}`, lineOf(code, m.index)]);
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
  bad.push(`${k}${at ? ` (line ${at})` : ''}: new layer violation (docs/adr/0009-layers-and-owners.md; LAYERS, ALLOWED here)`);
}
for (const [k, left] of base) for (let i = 0; i < left; i++) bad.push(`${k}: in BASELINE but no longer found; delete it there (node tools/core-deps.mjs --baseline)`);

const scanned = [...seen].map(rel).sort();
if (verbose || bad.length) console.log(`scanned: ${scanned.join(', ')}`);
if (verbose) { console.log(`baseline (${BASELINE.length}):`); for (const k of BASELINE) console.log(`  ${k}`); }
if (bad.length) { for (const b of bad) console.log(`  FAIL ${b}`); console.log(`FAIL core-deps: ${bad.length} violation(s)`); process.exit(1); }
const of = (r) => BASELINE.filter((k) => k.startsWith(r)).length;
console.log(`PASS core-deps: ${scanned.length} modules (src/core/, src/sim/, src/physics/, src/client/sim-client.ts, src/host/sim-host.ts and what they import) free of three.js, util.ts, voxelMaterial.ts and DOM globals, a weapon package imported only by sim/weapons/index.ts; ${apps.length} modules of src/ import nothing from checks/ and a craft look's package only through view/crafts/index.ts`);
console.log(`PASS core-deps layers: ${edges.size} modules, ${[...edges.values()].reduce((s, e) => s + e.length, 0)} imports in src/, no value-import cycle; baseline: R1 ${of('R1')} imports, R2 ${of('R2')} type cycles, R4 ${of('R4')}, R5 ${of('R5')} (sim/contract/ types only), R6 ${of('R6')} (touch read outside touch/); none new, none gone`);
