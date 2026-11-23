// The rule of web/src/core/ (docs/adr/0001-world-layers.md): no three.js, no DOM, so the viewer, the node tools and a
// Node server share it. The same for the world sim (docs/plans/life-physics.md "The server seam"): the traffic
// (src/sim/traffic.ts) and its bodies (src/physics/rapier/life-phys.ts); and for the player's vehicles' cores (what a
// server would step or check for each player: nav/boat-motion.ts, nav/plane-flight.ts, nav/fpv-flight.ts,
// physics/rapier/car.ts; their shells draw them). A static scan of every module under src/core/, those, and everything
// they import, transitively
// (relative imports, type-only ones included):
//   - no import of three (or three/...), util.ts (three.js helpers and the DOM) or voxelMaterial.ts (the shaders);
//   - no DOM global in the code (comments and strings left out): window, document, location, navigator, localStorage,
//     sessionStorage, requestAnimationFrame, HTML...Element, ... and no fetch (core takes its loader injected).
// And for all of src/ (the shipped app): no import from web/checks/ (the check harnesses the tools run).
// usage (in web/): node tools/core-deps.mjs [-v]; prints PASS and the modules scanned, or each violation and exit 1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(web, 'src'), core = path.join(src, 'core'), checks = path.join(web, 'checks'), verbose = process.argv.includes('-v');
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
for (const f of walk(core, [])) queue.push([f, null]);
const SEAM = ['sim/traffic.ts', 'sim/train-traffic.ts', 'sim/boat-traffic.ts', 'physics/rapier/life-phys.ts',
  'nav/boat-motion.ts', 'nav/craft-motion.ts', 'nav/plane-flight.ts', 'nav/fpv-flight.ts', 'physics/rapier/car.ts'];
for (const f of SEAM) queue.push([path.join(src, f), null]);
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

const scanned = [...seen].map(rel).sort();
if (verbose || bad.length) console.log(`scanned: ${scanned.join(', ')}`);
if (bad.length) { for (const b of bad) console.log(`  FAIL ${b}`); console.log(`FAIL core-deps: ${bad.length} violation(s)`); process.exit(1); }
console.log(`PASS core-deps: ${scanned.length} modules (src/core, the world sim, the player's vehicles' cores and what they import) free of three.js, util.ts, voxelMaterial.ts and DOM globals; ${apps.length} modules of src/ import nothing from checks/`);
