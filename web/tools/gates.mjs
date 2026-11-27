// The web gates in one run: tsc and the headless checks of web/tools/, in parallel, with a PASS / FAIL table and their
// times. Each gate in GATES below names the files it guards (`paths`); a change to a file of CORE selects every gate.
//   --changed [REF]: before a merge, only the gates whose paths match what changed since REF (default main; the diff
//     from the merge-base, REF...HEAD, plus uncommitted and untracked files): which gates and why (the first file each
//     matched), which skipped. tsc always runs; nothing matched: tsc alone. With --full, the full set's gates too.
//   fast set (default, about a minute and a half on 20 cores: the load gate runs alone at the end): tsc and every check
//   that runs in seconds; after a series of merges;
//   full set (--full): also section-check, popin-check, caps-check --all, see-through --all --max 0, surface-gap
//     --check against tools/surface-gap-baseline.json, and mesh-golden check if a golden file is given (--golden FILE,
//     recorded before the change with `node tools/mesh-golden.mjs write FILE`).
// A gate passes when its command exits 0 and, where `expect` is set, it printed at least that many PASS lines and no
// FAIL line (a scenario dropped from a check would otherwise go unnoticed; the counts include the real-data checks
// those tools run when the data is there, so they apply only then). Gates on the real data (`data`) are
// SKIP without public/data/meta.json (or VOXEL_DATA, tools/data-dir.mjs). Nothing is written; the output of a failed
// gate is printed after the table (-v: every gate's).
// usage (in web/): node tools/gates.mjs [--full] [--changed [REF]] [--golden FILE] [-j N] [-v] [--list] [--coverage] [gate ...]
//   gate ...: only those (by name, from either set); --list: the table with each gate's paths and the coverage check,
//   nothing run (with --changed: which gates it would run); --coverage: only the check that every file of src/ and
//   tools/ is in a gate's paths, CORE or UNGATED (the gate gate-coverage: a new package without a gate fails it);
//   -j: gates at once (default: half the cores, at most 8); exit code 1 if a gate fails
// pnpm gates / pnpm gates:full run the same.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { web, dataDir } from './data-dir.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const FULL = args.includes('--full'), VERBOSE = args.includes('-v'), LIST = args.includes('--list');
const golden = opt('--golden');
const jobs = Math.max(1, +(opt('-j') ?? Math.min(8, Math.floor(os.availableParallelism() / 2))));

// name, the command (run in web/ with this node), set, real data needed, alone (it times the host: run after the
// others, by itself), PASS lines expected (at least), seconds as
// measured (WSL, 20 cores, alone; for the order: longest first), what it guards, and `paths`: the files it guards, as
// globs relative to web/ (`*` within a folder, `**` at any depth; the pipeline is ../scripts/), from its guards and
// from what the tool imports and reads. tsc has none (it always runs); `wide`: those of its paths that are all of a
// folder (core-deps reads all of src/): no gate of a file's own (--coverage).
const tsc = path.join(web, 'node_modules/typescript/bin/tsc');
// the real data and what makes it: a gate reading public/data/ guards the pipeline and the data format
const DATA = ['../scripts/**', '../pyproject.toml', '../uv.lock', 'public/data/**', 'tools/real-city.mjs'];
const MESH = ['src/mesher.worker.ts', 'src/tile-request.ts', 'src/sections.ts', 'src/chamfer.ts', 'src/roofs.ts'];
const SIM = ['src/sim/*.ts', 'src/sim/server/**', 'src/sim/modes/**', 'src/sim/craft/cores.ts', 'src/sim/craft/core-state.ts',
  'src/client/sim-client.ts', 'src/host/node.ts', 'src/host/sim-host.ts'];
const GROUPS = { DATA, MESH, SIM };
const GATES = [
  { name: 'tsc', cmd: [tsc, '--noEmit'], set: 'fast', secs: 0.7, guards: 'all of src/ and checks/ (types)', paths: [] },
  { name: 'knip', cmd: [path.join(web, 'node_modules/knip/bin/knip.js'), '--no-progress'], set: 'fast', secs: 3, wide: ['src/**', 'tools/**'], guards: 'no unused file, export or dependency in src/, checks/, tools/ and package.json (knip.config.js: the entries, the TS the tools load by name)', paths: ['src/**', 'checks/**', 'tools/**', 'knip.config.js'] },
  { name: 'gate-coverage', cmd: ['tools/gates.mjs', '--coverage'], set: 'fast', secs: 0.1, wide: ['src/**', 'tools/**'], guards: 'every file of src/ and tools/ in a gate\'s paths, CORE or UNGATED (this file)', paths: ['src/**', 'tools/**'] },
  { name: 'core-deps', cmd: ['tools/core-deps.mjs'], set: 'fast', secs: 0.1, wide: ['src/**'], guards: 'src/core/, src/sim/ (with sim/craft/), src/physics/ and their imports: no three.js, no DOM, a weapon package (sim/weapons/<name>/) imported only by sim/weapons/index.ts, a craft look (view/crafts/<type>/) only by view/crafts/index.ts; nothing in src/ imports checks/; all of src/: layer table, no value-import cycle, window.__ hooks, sim/contract/ types only, touch read only in src/touch/ (a ratchet: BASELINE in the tool)', paths: ['src/**', 'tools/core-deps.mjs'] },
  { name: 'bld-ids', cmd: ['tools/bld-ids.mjs'], set: 'fast', secs: 0.4, guards: 'mesher.worker.ts greedy merge, building ids', paths: [...MESH, 'tools/bld-ids.mjs'] },
  { name: 'layers', cmd: ['tools/layers.mjs'], set: 'fast', secs: 0.4, guards: 'core/layers.ts (L0/L1/L2, routeOps, deltas)', paths: ['tools/layers.mjs'] },
  { name: 'edit-roundtrip', cmd: ['tools/edit-roundtrip.mjs'], set: 'fast', data: true, secs: 0.6, guards: 'core/columns.ts (edits, encode)', paths: [...DATA, 'tools/edit-roundtrip.mjs'] },
  { name: 'tile-roundtrip', cmd: ['tools/tile-roundtrip.mjs'], set: 'fast', secs: 2, guards: 'node file format: scripts/tilefile.py, tiles.py column_runs, tile-data.ts, core/tile-sections.ts (needs uv)', paths: ['../scripts/**', '../pyproject.toml', '../uv.lock', 'src/roofs.ts', 'src/chamfer.ts', 'src/sections.ts', 'tools/tile-roundtrip.mjs'] },
  { name: 'boat', cmd: ['tools/boat.mjs'], set: 'fast', expect: 20, secs: 5.5, guards: 'sim/craft/boat-motion.ts, sim/river.ts, core/safe-trail.ts, core/world.ts waterColumn (the river traffic\'s top at every node level); checks/boat-checks.ts, world.ts', paths: [...DATA, 'src/sim/craft/boat-motion.ts', 'src/sim/craft/craft-core.ts', 'src/sim/craft/voxel-collision.ts', 'src/sim/craft/sweep.ts', 'src/sim/river.ts', 'src/sim/boat-traffic.ts', 'checks/boat-checks.ts', 'tools/boat.mjs'] },
  { name: 'collision', cmd: ['tools/collision.mjs'], set: 'fast', expect: 16, secs: 2.7, guards: 'sim/craft/voxel-collision.ts, the tile format, the walker (nav/walk.ts); checks/collision-checks.ts, world.ts', paths: [...DATA, 'src/sim/craft/voxel-collision.ts', 'src/sim/craft/sweep.ts', 'src/nav/walk.ts', 'checks/collision-checks.ts', 'tools/collision.mjs'] },
  { name: 'solids', cmd: ['tools/solids.mjs'], set: 'fast', expect: 10, secs: 3, guards: 'the walker among the solid things (sim/solids.ts, nav/walk.ts walkFrame, view/life.ts solids, through a host on a synthetic world): a parked car, a car driven into it, another player on foot, a hovercraft, a traffic boat stop or shove it, never let it through, a car squeezing it at a wall pushes it out past its side; on foot A/D strafe, the arrows turn (nav/move-keys.ts)', paths: ['src/sim/solids.ts', 'src/nav/walk.ts', 'src/nav/move-keys.ts', 'src/view/life.ts', 'src/view/avatars.ts', 'src/sim/coaches.ts', 'src/sim/vehicles.ts', 'src/sim/boat-traffic.ts', 'tools/solids.mjs'] },
  { name: 'avatar', cmd: ['tools/avatar.mjs'], set: 'fast', expect: 9, secs: 3, guards: 'the player\'s avatar as another player sees it (view/avatars.ts, view/life.ts, through a host on a synthetic world): a figure of its own at the player\'s pose, not one of the crowd, its legs following its speed, an outfit by player, a place for a name over it, a gun held in its right hand standing and walking (view/weapons/weapons-view.ts); in orbit mode none; in a craft the craft alone in every frame, out of it a figure beside it again', paths: ['src/view/avatars.ts', 'src/view/life.ts', 'src/sim/agent-wire.ts', 'src/sim/server/snapshot.ts', 'src/sim/world-sim.ts', 'src/client/sim-client.ts', 'src/view/weapons/weapons-view.ts', 'tools/avatar.mjs'] },
  { name: 'craft-solids', cmd: ['tools/craft-solids.mjs'], set: 'fast', expect: 9, secs: 2.5, guards: 'the crafts among the solid things (sim/solids.ts, sim/world-sim.ts stepCrafts, the cores\' meet; sim/boat-traffic.ts giving way, through a host on a synthetic world): a traffic boat stops before a player\'s boat in its way and goes on, a boat driven at a moored traffic boat or another player\'s boat bounces off, a hovercraft driven at a parked car stops, none passes through; a car driven at a hovercraft bumps off it (the crafts as walls to the road physics, physics/rapier/life-phys.ts), a car of the traffic stops for a player on foot in its lane (sim/traffic.ts)', paths: ['src/sim/solids.ts', 'src/sim/craft/**', 'src/sim/vehicles.ts', 'src/physics/rapier/life-phys.ts', ...SIM, 'tools/craft-solids.mjs'] },
  { name: 'craft-motion', cmd: ['tools/craft-motion.mjs'], set: 'fast', expect: 26, secs: 1.2, guards: 'sim/craft/craft-motion.ts and sim/craft/craft-collision.ts, the craft cores\' wire state (sim/craft/core-state.ts, sim/contract/crafts.ts); checks/world.ts', paths: ['src/sim/craft/**', 'src/sim/tuning.ts', 'src/sim/walk-bounds.ts', 'checks/scenarios.ts', 'tools/real-city.mjs', 'tools/craft-motion.mjs'] },
  { name: 'canopy', cmd: ['tools/canopy.mjs'], set: 'fast', expect: 12, secs: 3.3, guards: 'the paraglider let go of into a free fall on foot (nav/foot.ts fallAt, canOpen: its velocity kept, within the host\'s walk bound, landed) and opened again while falling, not on the ground, many times, through the host (sim/world-sim.ts seats, sandbox craft/dropCraft/walk requests, nav/craft.ts CraftLink) as another player sees it', paths: ['src/nav/foot.ts', 'src/nav/walk.ts', 'src/nav/craft.ts', 'src/nav/special-craft.ts', 'src/sim/craft/craft-motion.ts', 'src/sim/craft/special-core.ts', ...SIM, 'tools/canopy.mjs'] },
  { name: 'swim', cmd: ['tools/swim.mjs'], set: 'fast', expect: 13, secs: 1.5, guards: 'swimming on foot (nav/foot.ts, nav/swim.ts: the water no floor, a made-up bed; nav/walk.ts climbing out) on the viewer\'s World over a synthetic basin through the host: walked into deep water it wades then swims, the eyes over the water, never under the bed nor on the water\'s top; out onto a low bank, not up a quay; a fall from a footbridge or a paraglider ends afloat without a landing; poses unclamped (sim/walk-bounds.ts), another player sees the swim', paths: ['src/nav/foot.ts', 'src/nav/swim.ts', 'src/nav/walk.ts', 'src/nav/spots.ts', 'src/sim/walk-bounds.ts', 'checks/collision-checks.ts', ...SIM, 'tools/swim.mjs'] },
  { name: 'edge', cmd: ['tools/edge.mjs'], set: 'fast', expect: 7, secs: 1, guards: 'core/built.ts and the map\'s edge at a block not built (meta.json built): sim/craft/voxel-collision.ts sweep and waterColumn, core/world.ts inside, physics/rapier/terrain.ts (its walls), sim/craft/plane-flight.ts edge; checks/edge-checks.ts', paths: ['../scripts/map.json', 'src/sim/craft/voxel-collision.ts', 'src/sim/craft/sweep.ts', 'src/sim/craft/plane-flight.ts', 'src/physics/rapier/terrain.ts', 'src/nav/walk.ts', 'checks/edge-checks.ts', 'checks/collision-checks.ts', 'tools/edge.mjs'] },
  { name: 'world-smoke', cmd: ['tools/world-smoke.mjs'], set: 'fast', data: true, secs: 2.5, guards: 'core/ stack, layers, mesher from columns, rapier terrain.ts', paths: [...DATA, ...MESH, 'src/physics/rapier/terrain.ts', 'tools/world-smoke.mjs'] },
  { name: 'wall-view', cmd: ['tools/wall-view.mjs'], set: 'fast', data: true, expect: 4, secs: 30, guards: 'no seeing through a wall standing close to it (headless Chrome, a tiny real scene): on foot walked into a diagonal wall (its slanted face, chamfer.ts), a flat one and an outer corner, the view\'s middle is the wall (nav/walk.ts eyeRoom against nav.ts WALK_NEAR); a car backed up to a wall keeps its chase camera on its side of it (nav/ride.ts clearOf)', paths: [...DATA, 'src/nav/walk.ts', 'src/nav/ride.ts', 'src/nav/spots.ts', 'src/chamfer.ts', 'tools/wall-view.mjs'] },
  { name: 'see-through', cmd: ['tools/see-through.mjs'], set: 'fast', data: true, expect: 1, secs: 5, guards: 'mesher.worker.ts, roofs.ts, chamfer.ts: no building seen through (a hole: a ray from the sky meets a face\'s back first) in a few real nodes, one of each kind of hole fixed', paths: [...DATA, ...MESH, 'tools/see-through.mjs'] },
  { name: 'rapier-car', cmd: ['tools/rapier-car.mjs'], set: 'fast', expect: 45, secs: 3.1, guards: 'physics/rapier/ (car.ts, life-phys.ts, player-car.ts, terrain.ts); checks/scenarios.ts, drive-scenarios.ts, world.ts', paths: [...DATA, 'src/physics/rapier/**', 'src/sim/vehicles.ts', 'checks/scenarios.ts', 'checks/drive-scenarios.ts', 'tools/rapier-car.mjs'] },
  { name: 'struck', cmd: ['tools/struck.mjs'], set: 'fast', expect: 3, secs: 3.4, guards: 'a person run into by the driven car at 30 and 50 km/h (physics/rapier/life-phys.ts hitPeople, its struck event drawn by view/life.ts StreetLife): thrown ahead along the car\'s heading, off the ground, further the faster, then lying flat and still', paths: ['src/view/life.ts', 'src/physics/rapier/life-phys.ts', 'src/sim/traffic.ts', 'checks/drive-scenarios.ts', 'tools/struck.mjs'] },
  { name: 'vehicles', cmd: ['tools/vehicles.mjs'], set: 'fast', expect: 37, secs: 3.4, guards: 'sim/vehicles.ts, physics/rapier/car.ts, physics/rapier/player-car.ts', paths: ['src/sim/vehicles.ts', 'src/physics/rapier/car.ts', 'src/physics/rapier/player-car.ts', 'src/physics/rapier/vehicle.ts', 'checks/scenarios.ts', 'checks/drive-scenarios.ts', 'tools/real-city.mjs', 'tools/vehicles.mjs'] },
  { name: 'caps-check', cmd: ['tools/caps-check.mjs'], set: 'fast', data: true, secs: 6, guards: 'core/surface.ts, mesher caps, roofs.ts (20 nodes)', paths: [...DATA, ...MESH, 'tools/caps-check.mjs'] },
  { name: 'plane', cmd: ['tools/plane.mjs'], set: 'fast', expect: 32, secs: 12.5, guards: 'sim/craft/plane-flight.ts, core/safe-trail.ts; checks/plane-checks.ts, jet-checks.ts, plane-real.ts, world.ts', paths: [...DATA, 'src/sim/craft/plane-flight.ts', 'src/sim/craft/plane-core.ts', 'src/sim/craft/voxel-collision.ts', 'src/sim/craft/sweep.ts', 'checks/plane-checks.ts', 'checks/jet-checks.ts', 'checks/plane-real.ts', 'tools/plane.mjs'] },
  { name: 'mirror-check', cmd: ['tools/mirror-check.mjs', '--seconds', '60'], set: 'fast', data: true, secs: 27, guards: 'sim/server/snapshot.ts, client/sim-client.ts, sim/server/sim-server.ts, sim/body-pose.ts, sim/road-net.ts, sim/coaches.ts (agents drawn from snapshots on the render clock, every tick in order; the bodies drawn alike by the sim and from the snapshot of the tick drawn; the protocol: snapshots structured-cloned, commands through JSON, CloneLink), view/life.ts', paths: [...DATA, ...SIM, 'src/view/**', 'tools/mirror-check.mjs'] },
  { name: 'flow', cmd: ['tools/flow.mjs'], set: 'fast', data: true, secs: 3, guards: 'what a page draws without being sent it (sim/flow.ts, sim/coaches.ts, client/sim-client.ts TrafficMirror; target architecture step 5) on the real data with one host and two pages: the trains alike on both pages and the host every tick and reckoned far ahead, none in a snapshot; far road traffic drawn beyond the agents\' circle and not inside it; every car the host spawns on a flow car of its road and lane (no pop when a road comes into the circle)', paths: [...DATA, ...SIM, 'src/client/sim-client.ts', 'tools/flow.mjs'] },
  { name: 'life-edit', cmd: ['tools/life-edit.mjs'], set: 'fast', data: true, secs: 10, guards: 'sim/world-sim.ts (its commands and seats: sim/commands.ts, walk-bounds.ts; its crafts: sim/craft/cores.ts), traffic.ts, train-traffic.ts, boat-traffic.ts, edit-keeper.ts, physics/rapier/life-phys.ts, core/live-edits.ts, core/world-edits.ts, car.ts; left, events, sessions: through a CloneLink (the protocol); sessions: sim/server/sim-server.ts Session (two clients on one SimServer, the player stamped by the host)', paths: [...DATA, ...SIM, 'src/physics/rapier/**', 'tools/life-edit.mjs'] },
  { name: 'host-smoke', cmd: ['tools/host-smoke.mjs'], set: 'fast', data: true, expect: 1, secs: 5, guards: 'host/ (sim-host.ts hostSim, its ports: node.ts; sim.worker.ts handle, step): the one host started in Node, two sessions run twice and through the worker\'s handler alike, the road physics loaded through its ports; the hello (sim/hello.ts, sim/contract/hello.ts) taken or refused (protocol, build, tuning) by the mirror and worker clients', paths: [...DATA, ...SIM, 'src/host/**', 'src/client/**', 'tools/host-smoke.mjs'] },
  { name: 'board', cmd: ['tools/board.mjs'], set: 'fast', expect: 9, secs: 6, guards: 'sim/world-sim.ts enterSeat from foot and leaveSeat onto foot (sim/walk-bounds.ts reaches, besideBox; Tuning.walk.board) through the host and its sessions: a helicopter left in the world (synthetic world) and a car of the traffic (real data, with the road physics) got into from beside it, refused far off and once taken, seen gone by another page, got out of onto foot beside it', paths: [...DATA, ...SIM, 'src/host/**', 'src/client/**', 'src/physics/rapier/**', 'src/sim/craft/**', 'src/sim/weapons/weapon.ts', 'checks/world.ts', 'tools/board.mjs'] },
  { name: 'passengers', cmd: ['tools/passengers.mjs'], set: 'fast', expect: 18, secs: 5, guards: 'riding along in another player\'s craft (sim/world-sim.ts passenger seats, sim/entities.ts SEATS; the snapshot\'s passengers) through the host and its sessions on a synthetic world: a passenger\'s seat taken from beside a hovercraft another flies, the body gone for another page, the passenger\'s input steering nothing, flown far off still on their own page, out onto foot beside it, aboard while the pilot gets out and another takes over; three in a helicopter, not four; none from orbit mode; the craft taken away puts them on foot beside it', paths: [...SIM, 'src/host/**', 'src/client/**', 'src/sim/craft/**', 'tools/passengers.mjs'] },
  { name: 'kept', cmd: ['tools/kept.mjs'], set: 'fast', expect: 15, secs: 13, guards: 'the network host\'s kept things over a restart (host/world-store.ts, host/ws.ts, tools/serve.mjs, sim/edit-keeper.ts lasting, traffic.ts parkAgain, core/world-edits.ts restoreNow) on a synthetic world: a crater, a hovercraft left and a parked car seen by a new page after the host closed, after SIGTERM, after a kill -9; a cell file of another format set aside, a node whose files changed dropped', paths: [...SIM, 'src/host/**', 'src/client/**', 'src/core/world-edits.ts', 'src/core/live-edits.ts', 'tools/serve.mjs', 'tools/kept.mjs'] },
  { name: 'resume', cmd: ['tools/resume.mjs'], set: 'fast', expect: 16, secs: 2.5, guards: 'a page coming back to its host as its player (host/ws.ts join tokens and the grace period, sim/server/sim-server.ts held players, sim/world-sim.ts handsOff, client/sim-worker-link.ts SocketLink, client/sim-client.ts restart) over a real WebSocket on a synthetic world: a pilot and a passenger cut off keep their seats, the craft hands off, no one else let in; back within the grace period the same players, aboard, named, steering; after it the seat free and a new player; a wrong token a new player', paths: [...SIM, 'src/host/**', 'src/client/**', 'tools/resume.mjs'] },
  { name: 'ws-smoke', cmd: ['tools/ws-smoke.mjs'], set: 'fast', data: true, expect: 1, secs: 20, guards: 'host/ws.ts, client/sim-worker-link.ts SocketLink: two players over a real WebSocket see each other\'s craft, car and body on foot moving smoothly (the body gone when the walk ends) on their render clocks, and each other\'s edits; sim/traffic.ts circles: street life round two players 3 km apart', paths: [...DATA, ...SIM, 'src/host/**', 'src/client/**', 'src/sim/craft/craft-core.ts', 'src/view/life.ts', 'src/view/avatars.ts', 'tools/ws-smoke.mjs'] },
  { name: 'overload', cmd: ['tools/overload.mjs'], set: 'fast', data: true, expect: 1, secs: 8, guards: 'the network host giving way over its tick (host/overload.ts, host/ws.ts; sim/traffic.ts crowd, carShare) in the owner\'s order with a driver and one on foot by the cathedral: the crowd, then the cars, then the send rate to the one on foot, given back in reverse; the driver\'s own car in every tick\'s snapshot, the world\'s clock a STEP a tick', paths: [...DATA, ...SIM, 'src/host/**', 'src/physics/rapier/**', 'tools/overload.mjs'] },
  { name: 'load', cmd: ['tools/load.mjs'], set: 'fast', data: true, alone: true, expect: 1, secs: 55, guards: 'the network host (host/ws.ts) with 16 players by the cathedral over real WebSockets, walking, driving and firing (craters): tick p95 and p99, ticks a second, bytes per player (mean, peak); one player firing at a road, its bytes not growing with the craters (sim/agent-wire.ts: what the page holds not sent again); the host\'s tile cache (host/node.ts), the shots\' bodies (sim/weapons/weapon.ts, sim/world-sim.ts), the crowd over holes (sim/traffic.ts), the crowd thinned over the tick', paths: [...DATA, ...SIM, 'src/host/**', 'src/physics/rapier/**', 'src/sim/weapons/**', 'src/sim/craft/**', 'tools/load.mjs'] },
  { name: 'maps', cmd: ['tools/maps.mjs'], set: 'fast', data: true, expect: 18, secs: 25, guards: 'the minimap, the full map (,) and the waypoint as two players on one host see them in headless Chrome (a vite dev server and the host of its own): a click on either map sets the waypoint where clicked (dragged, zoomed), again on it or Backspace clears it, the distance shown at the top; each page\'s maps mark the other player (on foot, in a craft; the snapshot\'s drivers for a car)', paths: ['src/minimap.ts', 'src/minimap.css', 'src/fullmap.ts', 'src/waypoint.ts', 'src/main.ts', 'src/sim/server/snapshot.ts', 'src/client/sim-client.ts', 'tools/maps.mjs'] },
  { name: 'menu', cmd: ['tools/menu.mjs'], set: 'fast', data: true, expect: 14, secs: 40, guards: 'the start menu (the server preselected as ./voxel builds it, skipped with ?server=), the Esc menu (on foot it opens and does not fly up, Back to orbit mode; Esc closes the full map first), a name set by one player cleaned and shown to another on the maps and over them (not through a building), the ping on a host, the frame cap at 30, in headless Chrome with two players on a host of its own', paths: ['src/ui/menu.ts', 'src/ui/name-tags.ts', 'src/sim/player-name.ts', 'src/app/frame.ts', 'src/app/session.ts', 'src/nav/nav.ts', 'src/nav/input.ts', 'src/perf.ts', 'src/main.ts', 'src/sim/server/sim-server.ts', 'src/host/ws.ts', 'src/client/sim-client.ts', 'src/client/sim-worker-link.ts', 'tools/menu.mjs'] },
  { name: 'section-check', cmd: ['tools/section-check.mjs'], set: 'full', data: true, secs: 56, guards: 'sections.ts, mesher.worker.ts meshSections', paths: [...DATA, ...MESH, 'tools/section-check.mjs'] },
  { name: 'popin-check', cmd: ['tools/popin-check.mjs'], set: 'full', data: true, secs: 59, guards: 'view/life.ts, sim/world-sim.ts, sim/traffic.ts (one run with a second player far off), sim/train-traffic.ts, sim/boat-traffic.ts', paths: [...DATA, ...SIM, 'src/view/**', 'tools/popin-check.mjs'] },
  { name: 'see-through-all', cmd: ['tools/see-through.mjs', '--all', '--max', '0'], set: 'full', data: true, expect: 1, secs: 55, guards: 'as see-through, every node: no building of the map seen through (a data rebuild can open one)', paths: [...DATA, ...MESH, 'tools/see-through.mjs'] },
  { name: 'caps-check-all', cmd: ['tools/caps-check.mjs', '--all'], set: 'full', data: true, secs: 85, guards: 'as caps-check, every node with caps', paths: [...DATA, ...MESH, 'tools/caps-check.mjs'] },
  { name: 'surface-gap', cmd: ['tools/surface-gap.mjs', '--check', 'tools/surface-gap-baseline.json'], set: 'full', data: true, secs: 12, guards: 'physics/rapier/terrain.ts and car.ts against core/surface.ts (the baseline)', paths: [...DATA, 'src/physics/rapier/terrain.ts', 'src/physics/rapier/car.ts', 'src/physics/rapier/vehicle.ts', 'tools/surface-gap.mjs', 'tools/surface-gap-baseline.json'] },
  { name: 'mesh-golden', cmd: golden ? ['tools/mesh-golden.mjs', 'check', path.resolve(golden)] : null, set: 'full', data: true, secs: 11, guards: 'mesher.worker.ts byte for byte (only with --golden FILE)', paths: [...DATA, ...MESH, 'tools/mesh-golden.mjs'] },
];
// Each weapon package's gate (src/sim/weapons/<name>/gate.mjs, on a synthetic world: no data) is found by its folder,
// so adding or removing a weapon needs no line here. It guards its package (sim and view) and what fires it: the
// weapons' core and the world sim, not the map.
const WEAPON_CORE = ['src/sim/weapons/*.ts', 'src/view/weapons/*.ts', ...SIM];
for (const e of fs.readdirSync(path.join(web, 'src/sim/weapons'), { withFileTypes: true })) {
  const gate = `src/sim/weapons/${e.name}/gate.mjs`;
  if (e.isDirectory() && fs.existsSync(path.join(web, gate))) GATES.push({ name: `weapon-${e.name}`, cmd: [gate], set: 'fast', secs: 3,
    guards: `the weapon ${e.name} (src/sim/weapons/${e.name}/, src/view/weapons/${e.name}/) fired through the host on a synthetic world: shots, hits, rate, on foot only, who is sent them, its view`,
    paths: [`src/sim/weapons/${e.name}/**`, `src/view/weapons/${e.name}/**`, ...WEAPON_CORE] });
}
// what every gate stands on: a change here selects them all
const CORE = ['src/core/**', 'src/sim/contract/**', 'src/fetch.ts', 'checks/check.ts', 'checks/world.ts', 'tools/gates.mjs', 'tools/lib.mjs',
  'tools/data-dir.mjs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vite.config.js'];
// files of src/ and tools/ with no gate of their own, on purpose (tsc and core-deps still read all of src/): the
// viewer's drawing, input and page (three.js and the DOM: tools/judder.mjs and shoot.mjs, run by hand) and the tools
// run by hand
const UNGATED = ['src/*.ts', 'src/*.css', 'src/app/**', 'src/ui/**', 'src/nav/**', 'src/touch/**', 'tools/wt.sh', 'tools/judder.mjs', 'tools/shoot.mjs', 'tools/where.mjs',
  'tools/lamps.mjs', 'tools/life-phys.mjs', 'tools/life-phys-scan.mjs', 'tools/mesh-profile.mjs', 'tools/remesh-bench.mjs',
  'tools/rapier-car-bench.mjs', 'tools/serve.mjs', 'tools/tris.mjs'];

const glob = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*/g, (m) => (m === '*' ? '[^/]*' : '.*'))}$`);
const matcher = (globs) => { const res = globs.map(glob); return (f) => res.some((r) => r.test(f)); };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);

function coverage() {
  const covered = matcher([...CORE, ...UNGATED, ...GATES.flatMap((g) => g.paths.filter((p) => !g.wide?.includes(p)))]);
  const missing = git(web, 'ls-files', '--cached', '--others', '--exclude-standard', 'src', 'tools')
    .filter((f) => fs.existsSync(path.join(web, f)) && !covered(f));
  if (missing.length) console.log(`FAIL gate-coverage: in no gate's paths, CORE or UNGATED (tools/gates.mjs):\n  ${missing.join('\n  ')}`);
  else console.log('PASS gate-coverage: every file of src/ and tools/ is in a gate\'s paths, CORE or UNGATED');
  return !missing.length;
}
if (args.includes('--coverage')) process.exit(coverage() ? 0 : 1);

// the paths as written (the groups by name)
const show = (paths) => {
  let rest = [...paths];
  const out = [];
  for (const [k, g] of Object.entries(GROUPS)) if (g.every((p) => rest.includes(p))) { out.push(k); rest = rest.filter((p) => !g.includes(p)); }
  return [...out, ...rest].join(' ');
};
if (LIST && !args.includes('--changed')) {
  for (const g of GATES) console.log(`${g.name.padEnd(15)} ${g.set.padEnd(5)} ${g.data ? 'data' : '    '} ~${String(g.secs).padStart(4)} s  ${g.guards}\n${''.padEnd(16)}paths: ${g.name === 'tsc' ? '(always runs)' : show(g.paths)}`);
  console.log(`\nCORE (selects every gate): ${CORE.join(' ')}`);
  for (const [k, g] of Object.entries(GROUPS)) console.log(`${k}: ${g.join(' ')}`);
  console.log(`UNGATED: ${UNGATED.join(' ')}\n`);
  process.exit(coverage() ? 0 : 1);
}

const ci = args.indexOf('--changed'), isGate = (a) => GATES.some((g) => g.name === a);
const refArg = ci >= 0 && args[ci + 1] && !args[ci + 1].startsWith('-') && !isGate(args[ci + 1]) ? ci + 1 : -1;
const named = args.filter((a, i) => !a.startsWith('-') && i !== refArg && !['--golden', '-j'].includes(args[i - 1]));
const hasData = fs.existsSync(path.join(dataDir, 'meta.json'));
let gates;
if (named.length) {
  const unknown = named.filter((n) => !isGate(n));
  if (unknown.length) { console.error(`no gate ${unknown.join(', ')}; gates: ${GATES.map((g) => g.name).join(' ')}`); process.exit(2); }
  if (ci >= 0) { console.error('--changed or gate names, not both'); process.exit(2); }
  gates = GATES.filter((g) => named.includes(g.name));
} else gates = GATES.filter((g) => g.set === 'fast' || FULL);

if (ci >= 0) {
  const ref = refArg > 0 ? args[refArg] : 'main', top = git(web, 'rev-parse', '--show-toplevel')[0];
  const changed = [...new Set([...git(top, 'diff', '--name-only', `${ref}...HEAD`), ...git(top, 'diff', '--name-only', 'HEAD'),
    ...git(top, 'ls-files', '--others', '--exclude-standard')])].map((f) => path.relative(web, path.join(top, f)));
  const core = changed.find(matcher(CORE)), why = new Map();
  for (const g of gates) {
    const hit = g.name === 'tsc' ? ['(always)'] : core ? [`${core} (CORE)`] : changed.filter(matcher(g.paths));
    if (hit.length) why.set(g, `${hit[0]}${hit.length > 1 ? ` (+${hit.length - 1})` : ''}`);
  }
  console.log(`changed since ${ref} (merge-base), uncommitted and untracked: ${changed.length} file(s)`);
  const w = Math.max(...gates.map((g) => g.name.length));
  for (const [g, f] of why) console.log(`  run  ${g.name.padEnd(w)}  ${f}`);
  const skip = gates.filter((g) => !why.has(g));
  if (skip.length) console.log(`  skip ${skip.map((g) => g.name).join(' ')}`);
  gates = gates.filter((g) => why.has(g));
  if (LIST) process.exit(0);
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

// longest first, `jobs` at a time; then those that time the machine (`alone`), one by one with nothing beside them
const queue = gates.filter((g) => !g.alone).sort((a, b) => b.secs - a.secs);
const results = new Map();
const t0 = performance.now();
console.log(`gates (${ci >= 0 ? 'changed' : FULL ? 'full' : named.length ? 'named' : 'fast'}): ${gates.length}, ${jobs} at a time`);
const runOne = async (g) => {
  const r = await run(g);
  results.set(g.name, r);
  console.log(`  ${r.status.padEnd(4)} ${g.name} (${fmt(r.secs)})`);
};
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { for (let g; (g = queue.shift()); ) await runOne(g); }));
for (const g of gates.filter((x) => x.alone)) await runOne(g);
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
