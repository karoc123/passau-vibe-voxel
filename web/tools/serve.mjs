// The world as a network host (src/host/ws.ts) for pages opened with ?server=ws://<this machine>:<port>. Bound to every
// interface by default, so a phone on the LAN reaches it. Every 10 s: the players, the ms per tick, the kB/s per player.
// usage (in web/): node tools/serve.mjs [--port 5300] [--host 0.0.0.0] [query, e.g. 'dig=1&seed=3']
import os from 'node:os';
import { imp } from './lib.mjs';
import { dataDir } from './data-dir.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const port = +opt('--port', 5300), host = opt('--host', '0.0.0.0'), query = args[0] ?? '';
const { serve } = await imp('src/host/ws.ts');
const h = serve({ dir: dataDir, host, port, query, log: (l) => console.log(l) });
const bound = await h.port;
const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a?.family === 'IPv4' && !a.internal).map((a) => a.address);
console.log(`host on ws://${host}:${bound} (data ${dataDir}${query ? `, ${query}` : ''}); open the page with ?server=ws://${lan[0] ?? 'localhost'}:${bound}`);
setInterval(() => {
  const s = h.stats();
  if (!s.bytes.length) return;
  const per = s.bytes.map(([p, b]) => `${p} ${(b / 10240).toFixed(0)} kB/s`).join(', ');
  console.log(`${s.bytes.length} player(s): tick ${s.tickMs.toFixed(2)} ms + snapshots ${s.sendMs.toFixed(2)} ms; ${per} (before deflate)`);
}, 10000);
process.on('SIGINT', () => { h.close(); process.exit(0); });
