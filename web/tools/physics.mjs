#!/usr/bin/env node
// Headless physics scenarios (src/physics/scenarios.ts): the driven car and bodies against synthetic voxel worlds
// through the real collision code, in Node, in a second or two. No browser, no data files.
//
//   node tools/physics.mjs                    all scenarios: checks and feel numbers; exit code 1 if a check fails
//   node tools/physics.mjs ramp cliff-3m      only these
//   node tools/physics.mjs --json             the outcomes as JSON (to compare numbers before/after a change)
//   node tools/physics.mjs --trace ramp [--every 9]   the run step by step (t x y z speed vy mode status), CSV
//
// The TypeScript is loaded through Vite's SSR module loader (no build, no extra dependency).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(WEB, 'package.json'));
const { createServer } = await import(require.resolve('vite'));

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const ti = argv.indexOf('--trace'), trace = ti >= 0 ? argv[ti + 1] : null;
const ei = argv.indexOf('--every'), every = ei >= 0 ? +argv[ei + 1] : 1;
const names = argv.filter((a, i) => !a.startsWith('-') && (ti < 0 || i !== ti + 1) && (ei < 0 || i !== ei + 1));

const server = await createServer({ root: WEB, configFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
let failed = 0;
try {
  const { SCENARIOS } = await server.ssrLoadModule('/src/physics/scenarios.ts');
  if (trace) {
    const s = SCENARIOS.find((x) => x.name === trace);
    if (!s) throw new Error(`no scenario ${trace}: ${SCENARIOS.map((x) => x.name).join(', ')}`);
    const o = await s.run();
    console.log('t,x,y,z,h,speed,vy,mode,status');
    (o.trace ?? []).forEach((r, i) => {
      if (i % every && r.status === 'moved') return;
      console.log([r.t, r.x, r.y, r.z, r.h, r.speed, r.vy].map((v) => +v.toFixed(3)).join(',') + `,${r.mode},${r.status}`);
    });
  } else {
    const pick = names.length ? SCENARIOS.filter((s) => names.includes(s.name)) : SCENARIOS;
    if (names.length && pick.length !== names.length) throw new Error(`unknown scenario among ${names}: ${SCENARIOS.map((x) => x.name).join(', ')}`);
    const out = {};
    for (const s of pick) {
      const t0 = Date.now();
      let o;
      try { o = await s.run(); } catch (e) { o = { checks: [{ ok: false, what: `threw: ${e.stack ?? e}` }], metrics: {} }; }
      const ok = o.checks.every((c) => c.ok);
      if (!ok) failed++;
      out[s.name] = { ok, checks: o.checks, metrics: o.metrics };
      if (json) continue;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${s.name.padEnd(12)} ${s.about}  (${Date.now() - t0} ms)`);
      for (const c of o.checks) if (!c.ok || argv.includes('-v')) console.log(`     ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}`);
      const m = Object.entries(o.metrics).map(([k, v]) => `${k} ${v}`).join(', ');
      if (m) console.log(`     ${m}`);
    }
    if (json) console.log(JSON.stringify(out, null, 1));
    else console.log(failed ? `\n${failed} of ${pick.length} failed` : `\nall ${pick.length} passed`);
  }
} finally {
  await server.close();
}
process.exitCode = failed ? 1 : 0;
