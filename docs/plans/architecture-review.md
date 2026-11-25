# Architecture review: layers, owners, and the way to a server

Status: review only, nothing built. Main `2b73ca1c` (after E14 lean), 2026-11-24. Read-only: no code changed, no
gate added. File:line of `web/src/` at that commit. Target: the owner's direction of 2026-11-24
([handoff](handoff-refactor-todos.md)): stable, separated, more multiplayer-ready; no game rules, UI or lag tuning.
Builds on ADR [0006](../adr/0006-world-sim-seam.md), [0007](../adr/0007-player-control-in-world-sim.md),
[0008](../adr/0008-server-vision.md), local-server.md (E9 plan, deleted; in git at `b5483793`), [entities-and-modes.md](entities-and-modes.md),
[smooth-motion-and-lag.md](smooth-motion-and-lag.md). It does not repeat their packages (E15–E21, M2–M10); it lists
what they leave open structurally.

Method: an import graph over every `import`/`export from`/`import()` in `web/src` (131 modules, comments stripped,
type-only imports counted apart), `tools/core-deps.mjs` run (PASS, 53 modules), and the files read. Counts below are
import statements, not symbols.

## Summary

The inner seam is sound: `core/`, `sim/`, `physics/` are free of three.js and the DOM (gated), the sim runs
headless on a fixed tick with seeded randomness (gated), commands are plain data applied in one place, and a snapshot
path exists and is checked against direct drawing. What is missing for "a server with thin clients" is mostly at the
edge of that seam, not inside it:

1. The client still drives the world: its frame `dt`, its hour and day, its camera focus, its seed, its game mode and
   its player id are inputs the host takes as given.
2. Per-connection state (who is asking, what they have read) lives inside the world sim and in a server class that
   knows one implicit client.
3. The default page does not use the path a server would use: it draws the sim's own objects and writes into them.
4. The wire contract is implicit (reflection, `unknown`, object references) and is never actually serialised in a gate.
5. `sim/` holds four roles (domain, contract, server, client) and the headless code depends on modules in the
   unsorted root; only "no three.js, no DOM" is enforced, no direction between layers.

## 1. The layering as it is

| Folder | Modules | Role today | Imports (statements; type-only in brackets) |
|---|---|---|---|
| `core/` | 14 | voxel data, tile format, edits, maths, fixed step | root 3 (2) |
| `sim/` | 18 | domain (world-sim, traffic, entities, mode) **and** contract (commands, snapshot types) **and** server (sim-server) **and** client (sim-client, TrafficMirror) | core 18 (5), sim/craft 14 (6), physics 5 (5), root 2 (1), sim/modes 1 |
| `sim/craft/` | 13 | the player vehicles' cores, voxel collision | core 24 (3), sim 4 (2), root 2 (2) |
| `sim/modes/` | 1 | sandbox | sim 2 (2) |
| `physics/rapier/` | 5 | Rapier bodies, terrain colliders, the driven car | core 10, sim 9 (4), root 2 (2), rapier 4 |
| `view/` | 4 | draws the traffic (three.js) | three 7, sim 10 (2), root 1 |
| `nav/` | 27 | input, cameras, craft shells, three.js models, DOM panels | three 26 (6), root 26 (13), sim 22 (16), sim/craft 19 (8), physics 2 (1), view 2 (2), core 2 |
| root (`src/*.ts`) | 49 | renderer, streamer, UI, **and** the host (`sim-host.ts`, `sim.worker.ts`, `sim-worker-link.ts`), **and** headless data modules (`tile-data.ts`, `types.ts`, `world.ts`, `tile-world.ts`, `fetch.ts`, `viewer-tiles.ts`) | three 25, sim 21 (16), core 16, nav 16 (3), … |

Directions that hold (and which gate proves them):

- `core/`, `sim/`, `physics/` and everything they import: no three.js, no `util.ts`, no `voxelMaterial.ts`, no DOM
  global, no `fetch` (`core-deps`, fast set). Nothing in `src/` imports `checks/` (`core-deps`).
- `core/` imports nothing from `sim/`, `physics/`, `view/`, `nav/` (0 edges; not gated, true today).
- `sim/` and `physics/` import nothing from `view/` or `nav/` (0 edges; implied by the three.js ban, not stated).
- `view/` imports nothing from `nav/` (0 edges; not gated).
- No value-import cycle anywhere in `src/` (0 strongly connected components over value imports; not gated).

Directions that are violated or undefined:

| What | Count | Evidence |
|---|---|---|
| headless code depends on a root module | 9 (6 type-only) | `core/columns.ts:13`, `core/live-edits.ts:7`, `core/tile-cache.ts:8` (value: `decodeTile`), `sim/edit-keeper.ts:14` (value) → `tile-data.ts`; `sim/world-sim.ts:38`, `sim/craft/voxel-collision.ts:3`, `physics/rapier/life-phys.ts:32`, `terrain.ts:19` → `types.ts` (`Meta`); `voxel-collision.ts:4` |
| sim's contract types defined in the physics implementation | 5 (all type) | `sim/commands.ts:6` (`CarInput` from `physics/rapier/car.ts`), `sim/sim-client.ts:13`, `sim/snapshot.ts:13`, `sim/world-sim.ts:27-28` (`DriverSnapshot`, `DriveNote`, `LifePhysics`) |
| server and client halves import each other | 2 type cycles | `{sim-client, sim-server, snapshot}` (`sim-server.ts:14` takes `SimCommand` from the client module; `snapshot.ts:21` takes `TrafficView` from it); `{commands, mode, world-sim}` |
| presentation imports server-side modules | 4 | `nav/craft.ts:3`, `nav/crafts-view.ts:3`, `nav/player.ts:1` (types from `sim/world-sim.ts`); `nav/drive.ts:6` (value import from `physics/rapier/player-car.ts`: `CRASH_MS`, `PARK`, `SINK_MS`) |
| nav reaches the sim through the view | 2 imports, 4 uses | `nav/nav.ts:3`, `nav/ride.ts:6`; `life.client.traffic…` at `nav/drive.ts:129, 214`, `nav/nav.ts:574`, `nav/ride.ts:83-85`; set at `main.ts:498` (`nav.life = life`) |
| view imports a three.js/DOM helper bag | 1 | `view/boats.ts:3` → `util.ts` (fine in itself; `util.ts` has the highest fan-in, 35) |
| type cycles elsewhere | 2 | `{foliage, voxelMaterial}`; `{nav/craft, foot, nav, orbit, ride}` |

The headless modules in the root (`world.ts`: `import type` of three only, line 1; `tile-world.ts`; `sim-host.ts`;
`sim.worker.ts`) are scanned by `core-deps` only where something in `core/`/`sim/`/`physics/` imports them; the
host files are not.

## 2. Findings, by impact

Confidence: **high** = read in code and reproducible from the lines given; **medium** = the reading is clear, the
consequence depends on how the server is built.

### F1. The client drives the world's clock, time of day, population centre and options — high

- **What:** every sim advance is a client frame. `SimClient.update(dt, input)` (`sim/sim-client.ts:64`) carries the
  page's `dt` and `SimInput { hour, day, focus, viewer }` (`sim/world-sim.ts:89-94`), filled from the page's UI and
  camera (`main.ts:562`: `daylight.hour`, `daylight.day`, `focus()`, `camera.position`). Over the worker link the
  same: `WorkerLink.frame` adds up the page's `dt` and posts it (`sim-worker-link.ts:33, 42`), the worker runs
  `s.update(m.dt, m.input)` (`sim.worker.ts:55`). The seed is drawn on the page with `Math.random`
  (`main.ts:478`); the mode, whether edits are allowed and the physics options come from the page's URL
  (`main.ts:485-487`) and are sent to the worker in `init` (`main.ts:490`).
- **Also one focus:** `Traffic.active` is one circle and one `viewer` (`sim/traffic.ts:134-136, 203-207`);
  `LifePhysics` fixes its origin from one focus at load (`physics/rapier/life-phys.ts:126-131`); the worker keeps
  the last frame's focus in a module variable for it (`sim.worker.ts:29, 53`).
- **Why it matters:** ADR 0008 ("the server is authoritative", "nothing may assume one local player or one focus").
  With two clients there is no answer to whose `dt`, hour or focus counts. This is an interface problem before it is
  an interest-management problem: `SimInput` mixes world state (hour, day) with one player's view.
- **Not covered by** M3–M10 (they assume the server ticks) or E15–E21.

### F2. Player identity is a field the client writes; session state sits in the world sim — high

- **What:** every `PlayerCommand` carries `player` (`sim/commands.ts:31-35`) and the server applies it as sent
  (`sim/sim-server.ts:39-41`, `sim.worker.ts:54`). The page's id is a constant named 37 times in 7 files
  (`nav/player.ts:5`; `nav/craft.ts` 11, `nav/drive.ts` 9, `nav/ride.ts` 8, `main.ts` 4, `dig.ts` 2,
  `nav/crafts-view.ts` 2; imports included). The worker holds one `player` (`sim.worker.ts:29, 56`).
- **Read cursors in the domain:** `WorldSim.results()` drains (`sim/world-sim.ts:337-344`), `SeatReads` keeps
  per-player read positions inside `WorldSim` (`:133, 597-618`), `SimServer.since` and `outcomes` per player
  (`sim/sim-server.ts:20-22`), unread results pile up (noted open in E7 and E14). A second reader for the same
  player (a reconnect, a spectator, a test) steals the first one's results.
- **Why it matters:** a connection must be bound to a player by the host, and what a connection has read is the
  connection's state, not the world's. Today there is no object for "a connection".

### F3. The default page does not use the server path, and the view writes into sim objects — high

- **What:** by default the page holds a `LocalSimClient` whose `traffic` is the live `Traffic`
  (`sim/sim-client.ts:110`; chosen at `main.ts:495`). `TrafficView` is `Pick<Traffic, …>` of the concrete class
  (`sim/sim-client.ts:39-41`), so the mirror has to instantiate a whole `Traffic` to satisfy it
  (`sim/snapshot.ts:98-131`).
- **Drawn state on sim objects:** `Car.rp/rh/pitch/roll` and `Person.rp/rh` are declared in the sim's types
  (`sim/types.ts:45-52, 101-102`), written by the view (`view/life.ts:35, 158, 183, 190-193, 215-218`), by the road
  physics (`physics/rapier/life-phys.ts:439-440, 707-709`), by the mirror (`sim/snapshot.ts:187-199`) and read by
  the sim once (`sim/traffic.ts:788`: `car.rp ??= …`). Picking hands the sim's objects to the nav
  (`view/life.ts:33, 304-343`: `Picked.obj: Rideable`), which holds them across frames.
- **Why it matters:** two client implementations with different aliasing rules; the one everybody plays is the one
  a server cannot offer. `mirror-check` keeps them equal for path agents, but a Rapier body's drawn pose differs
  (lerp against slerp; "not covered by a gate", local-server.md section 6). Every new feature is written and judged
  on the local path first.

### F4. The wire contract is implicit and never serialised in a gate — high

- **What:**
  - a craft crosses as `core: Record<string, unknown>`, made by reflection over the core's own fields with a skip
    list of field names (`sim/craft/core-state.ts:8-21`; `sim/snapshot.ts:33`). Renaming a private field changes
    the protocol; nothing types it.
  - events carry `e: unknown` (`sim/world-sim.ts:119`) and whole `Person` objects (`:115, 117`), which the snapshot
    special-cases (`sim/snapshot.ts:88`) and the mirror re-links by id (`:137`).
  - a car's state on the wire is the sim's path internals (`CAR_KEYS`, `sim/snapshot.ts:26-27`: `prev`, `prev2`,
    `next`, `next2`, …); the client re-runs the sim's path maths on its own `traffic.json`. That is a sound choice,
    but it makes "same data build and same code" a hard precondition, and nothing checks it: `meta.json`'s `world`
    (`buildId`, `formatVersion`; written by `scripts/world_id.py`) is read by no runtime code (`types.ts:65-71` is
    the type only), and neither the worker's `init` nor the snapshot has a protocol version.
  - an edit crosses as the edited node's full columns (`EditNote.node: LiveNode`, `sim/snapshot.ts:37`), not as the
    op.
- **No gate serialises anything:** `ThreadLink` hands the snapshot object to the client by reference
  (`sim/sim-client.ts:161-165`); `takeSnapshot` copies the top level but passes `detachedPose`, `BodyDraw`, the
  seat and the `DriverSnapshot` as the sim's own objects (`sim/snapshot.ts:77, 84, 89`). `mirror-check` and
  `life-edit` therefore pass even if a snapshot is not cloneable or if either side mutates a shared object.
  Structured clone is exercised only by hand with `?worker=1`.
- **Why it matters:** the first network transport will find these one at a time.

### F5. `sim/` holds four roles; the contract's types live in implementation modules — medium/high

- **What:** domain (`world-sim.ts`, `traffic.ts`, `entities.ts`, `mode.ts`, `craft/`), contract (`commands.ts`, the
  `Snapshot` type, `SimEvent`, ids), server (`sim-server.ts`, `takeSnapshot`) and client (`SimClient`,
  `LocalSimClient`, `MirrorSimClient`, `TrafficMirror`, `ThreadLink`) share a folder and import each other in
  cycles (section 1). `PlayerId`, `CraftId`, `SimEvent`, `SimInput`, `FrameTime`, `Ack` are exported from
  `world-sim.ts` (618 lines, fan-out 18), so a client that only needs an id imports the server's main class module
  (type-only today). `CarInput`, `DriverSnapshot`, `DriveNote` come from `physics/rapier/`. `sim-client.ts` imports
  the module-global `liveEdits` as a value (`:15, 216`).
- **Why it matters:** "small stable interfaces" need a place. Today a change to `WorldSim` is a change to the module
  every client names; a thin client bundle cannot be cut by folder; a rule like "the client never imports the
  server" cannot be written down.

### F6. Three hand-wired hosts, the real one ungated and browser-bound — medium/high

- **What:** `sim-host.ts` `hostSim` is the wiring a server would reuse, but it reads `performance.now()` (`:51`),
  fetches `data/boats.json` by relative URL (`:61`), logs with `console.warn` (`:61, 63, 76`), registers a
  `liveEdits` listener it never removes (`:56`) and lives in the root, outside the scanned folders. The tools do not
  use it: `life-edit.mjs:101, 363, 411, 503, 560`, `mirror-check.mjs:25`, `popin-check.mjs:82`, `life-phys.mjs:33`
  each build `new WorldSim(...)` / `new SimServer(...)` with their own loaders. `sim.worker.ts` and
  `sim-worker-link.ts` have no gate at all (types only).
- **Why it matters:** a Node server would be the fourth wiring. What is gated (the tools' wiring) is not what ships
  (`hostSim`), so "runs headless as it would on a server" (ADR 0006) is true of `WorldSim`, not of the host.

### F7. Edits and tile readiness enter the tick from outside the command path — medium

- **What:** an `edit` is not a `PlayerCommand`; `SimServer` queues it apart (`sim/sim-server.ts:19, 39-41`), asks
  the mode itself (`:76`) and applies it with an un-awaited promise (`:81`): the edit takes effect whenever the
  tiles resolve, its result is stamped with the tick at which it was *sent on* (`:75`). The world's edits and their
  queue are module state (`core/live-edits.ts:42`, `core/world-edits.ts:27-29`, `viewer-tiles.ts:9`), accepted by
  ADR 0008 (one world per process), but in the page's thread the client and the sim share that one instance while
  across a worker the client mirrors it (`sim/sim-client.ts:216`, the `edits` flag at `:187-188`): two ownership
  models, chosen by a constructor flag.
- **Crafts:** a craft's step is dropped while a tile is not in (`sim/world-sim.ts:579-589`), paced by an injected
  wall clock (`sim/craft/voxel-collision.ts:128, 289`; `sim-host.ts:51`). `physics/rapier/terrain.ts:231` defaults
  `now` to `performance.now()` (the sim passes its own clock, `life-phys.ts:352`).
- **Why it matters:** ADR 0007: "the host controls when inputs and terrain edits become visible to a tick", so a run
  is reproducible from seed, tuning and input history. Today that holds only where I/O is synchronous (the tools
  read tiles from disk synchronously, which is why `life-edit` is bit-stable). Medium because a server with all
  tiles on local disk can make it true by construction; the interface should say so.

### F8. Client-only state a server would have to own (inventory) — high

| State | Where it lives now | Needed |
|---|---|---|
| world time (hour, day) | `Daylight` and the bar (`main.ts:288-303`, sent each frame `:562`) | host; a client may ask (creative) |
| seed, mode, edits allowed, physics options | page URL (`main.ts:478, 485-487`) | host configuration |
| player id | `nav/player.ts:5` | assigned per connection |
| where the world is simulated | the camera's focus (`main.ts:286, 562`) | each player's view, merged by the host |
| "load the road physics now" | client call `SimClient.loadPhysics(warm)` (`sim/sim-client.ts:87`; `nav/drive.ts`) | host's own concern; at most a hint |
| a new craft's spot | the shell's search, trusted by the sandbox (`sim/mode.ts:14-16`, `sim/modes/sandbox.ts:16-21`) | mode decides (known open point, local-server.md section 8) |
| the walk | client-authored poses, bounded (`sim/walk-bounds.ts`) | decided: stays until a walk core (entities-and-modes.md decision 2) |
| the car type taken with the wheel | `enterSeat.choice` (`sim/commands.ts:32`) | mode decides |

Weather is rendering only today and can stay on the client until a rule depends on it.

### F9. `main.ts` is the composition root and also holds policy; hooks are scattered — medium (hygiene)

- **What:** 686 lines, fan-out 46 (highest), about 25 module-level `let`s. Besides wiring it holds UI widgets
  (credits, toast, jump button: `:118-213`), go-to and search (`:353-399`), the view-distance and far-plane policy
  (`:644-683`), the frame loop whose order is the M1/M3 contract (`:548-609`, order kept by a comment), and the
  session set-up inline in a `fetch` callback (`:474-503`). Eight `window.__*` hooks (`:44-45, 490, 500-506, 517,
  533, 611-615`); `__three` exposes 20 objects and is used by `judder.mjs` and `shoot.mjs`.
- **Why it matters:** not a god object in the sense of owning state others need (code-health.md agrees), but the two
  things multiplayer will change, which client and link is built and the order of the frame's phases, are not
  addressable units. `nav/nav.ts` (655 lines) is the other large knot and sits in a 5-module type cycle.

### F10. What the gates prove and what they do not — high

| Boundary | Gate | Gap |
|---|---|---|
| headless folders free of three.js / DOM / fetch | `core-deps` | no direction rule between layers; `performance.now`, `Date`, `Math.random`, timers not banned statically (`life-edit` makes `Math.random` throw, only on the paths it runs) |
| determinism of the sim | `life-edit` (two runs, two frame rates) | with synchronous loaders only (F7) |
| snapshot draws what the sim holds | `mirror-check`, `popin-check --mirror` (full set) | by reference, never cloned (F4); bodies' pose not compared; one player |
| commands, seats, modes | `life-edit` scenarios | through `WorldSim`/`SimServer` built by the tool, not `hostSim` (F6) |
| worker path | none | `sim.worker.ts`, `sim-worker-link.ts`, `tile-world.ts` |
| tile file format, pipeline ↔ web | `tile-roundtrip` | JSON outputs (`meta`, `traffic`, `boats`, `flood`) are typed by hand in `types.ts`/`sim/types.ts`, no version check at load |
| import cycles, `window.__*` | none | |
| CI | `.github/workflows/pages.yml` runs `pnpm build` (tsc) only | no gate runs in CI (code-health item 1; needs the owner's consent to touch) |

### F11. The pipeline's output contract — medium (hygiene)

The Python pipeline reaches the app only as files under `web/public/data/` (22 files in `scripts/` name that path). The
binary node format is a real contract (ADR 0004, `core/tile-sections.ts` mirrored from `scripts/tilefile.py`,
checked by `tile-roundtrip`). The JSON side is not: each file is fetched where it is needed (`main.ts:413, 424, 466,
469, 474`, `sim-host.ts:61`, `sim.worker.ts:40`, `city.ts:77`, …), with no manifest and no check of
`meta.world.formatVersion`. For a server this matters in one place: client and server must load the same build
(F4). The rest is hygiene.

## 3. Target structure

Layers, innermost first. A module may import its own layer and the layers above it in this table, nothing else.
Folder names are a proposal; the rules matter, the moves are packages in section 4.

| Layer | Folder | Holds | Rule |
|---|---|---|---|
| 0 data | `core/` | voxel columns, tile format and cache, edits, world queries (`World`), `Meta`, maths, fixed step | imports `core/` only; no three.js, DOM, fetch |
| 1 contract | `sim/contract/` (new) | ids, `EntityRef`, `Seat`, commands, inputs per role, events, `Snapshot`, results, protocol version | types and constants only; imports `core/` types and itself; everything here is plain data that survives `structuredClone` |
| 2 shared sim code | `sim/craft/`, `sim/path.ts`, `sim/vehicles.ts`, `sim/river.ts`, `sim/tuning.ts` | maths and cores both sides step (prediction needs the same code, ADR 0008) | imports 0–1; no world state |
| 3 domain | `sim/` (world-sim, traffic, entities, mode, modes), `physics/` | the world and its rules | imports 0–2; no clock but the tick, no randomness but the seed, no I/O (ports injected) |
| 4a server | `sim/server/` (new), `host/` (new) | sessions, snapshots per session, the wiring of a world, platform entries (worker, later Node) | imports 0–3; `host/` is the only place that reads a clock, a file or a URL |
| 4b client | `client/` (new) | `SimClient`, the mirror, links | imports 0–2; never 3 or 4a (the in-thread link is given a server by the app) |
| 5 presentation | `view/`, `nav/`, render modules | three.js, DOM, input | imports 0–2 and 4b; never 3 or 4a |
| 6 app | `main.ts`, `app/` | composition, frame order, debug hooks | may import everything; the only place that constructs layer 4a and 4b together |

One owner per piece of state:

- world state (entities, seats, edits kept, world time, tick): layer 3, changed only by commands applied in a tick;
- connection state (player id, read cursors, input seq, last snapshot tick): a session in 4a;
- drawn state (interpolated poses, fades, picks): 4b/5, keyed by entity id, never a field on a layer-3 object;
- view state (camera, focus, graphics settings, weather look): 5/6.

Enforceable mechanically, by extending `tools/core-deps.mjs` (it already resolves every import):

- **R1 layer table.** A list of `[glob, layer]` and the allowed targets per layer; every import statement checked,
  type-only ones included (a type import is still a dependency on a module's shape). Existing violations go into a
  baseline list in the tool that may only shrink (a ratchet), so the rule can land before the moves.
- **R2 no value-import cycle** in `src/` (0 today), and the type-cycle count may not grow (4 today).
- **R3 determinism words** in layers 0–3: no `Math.random`, `Date.now`, `new Date`, `setTimeout`, `setInterval`;
  `performance.now` only in files on a stats allow-list (`life-phys.ts`, `terrain.ts`) until a stats clock is
  injected.
- **R4 hooks.** `window.__` assigned in one module only.
- **R5 contract is types.** Modules under `sim/contract/` contain no `class` and no function bodies beyond
  constants and type guards.

Needs a new gate rather than a static rule:

- **G1 `protocol`**: `mirror-check` and the `life-edit` client scenarios run through a link that
  `structuredClone`s (and, for commands, JSON-round-trips) everything crossing; same PASS counts.
- **G2 `host-smoke`**: `hostSim` itself in Node with injected loaders, two sessions, some hundred ticks, a snapshot
  per session, run twice and compared.

## 4. Work packages

In the handoff file's style. Sizes S/M/L as there. "Neutral" = behaviour-neutral: same gate counts, no visible
change. **Server** = a prerequisite for a real network server; **hygiene** = makes the structure hold, not needed
for the first server. Every package: `tsc`, `core-deps` and the fast set green; extra gates named.

| # | Goal | Size | Neutral | Kind | Waits for |
|---|---|---|---|---|---|
| A1 | layer rules as a ratchet | S | yes | hygiene (keeps the rest) | – |
| A2 | headless modules out of the root | S–M | yes | hygiene | A1 |
| A3 | the contract module | M | yes | **server** | A1 |
| A4 | `sim/` split by role (moves only) | S–M | yes | hygiene | A3 |
| A5 | the protocol gate (clone link) | S | yes | **server** | – |
| A6 | typed wire data: events by id, craft state, hello with build and version | M | yes | **server** | A3, A5 |
| A7 | sessions: connection state out of the world, player stamped by the host | M | yes | **server** | A3 |
| A8 | views per player; world time owned by the host | M | in-thread yes; worker pacing not | **server** | A7 |
| A9 | edits through the command path, one edits owner on the page | M | no (when an edit's result arrives) | **server** | A7 |
| A10 | drawn state off the sim's objects; picks by id | M | yes | **server** (thin client) | A3 |
| A11 | one read path: the mirror in the page's thread by default | S + measuring | no (bodies' drawn pose) | **server** (thin client) | A5, A10; owner |
| A12 | one host for page, worker, tools, Node; `host-smoke` | M | yes | **server** | A4, A7 |
| A13 | app composition: session, frame phases, hooks | M | yes | hygiene | A7 |
| A14 | data build identity checked at load | S | yes | hygiene (feeds A6) | – |

### A1. Layer rules as a ratchet (S)

- **Goal:** R1–R4 of section 3 in `core-deps`, with today's violations as a baseline that may only shrink.
- **Files:** `web/tools/core-deps.mjs`, `web/tools/gates.mjs` (the `guards` text).
- **Do:** the layer table mapped onto today's files (no moves yet: e.g. `sim/sim-client.ts` → client,
  `sim/sim-server.ts` → server, `sim-host.ts` → host); the baseline printed with `-v`; a removed baseline entry
  that no longer occurs is an error too (so the list stays true).
- **Gates:** `core-deps` passes on main unchanged; a planted violation in a scratch copy fails.
- **Landed** (2026-11-24): `core-deps` checks R1–R4 over all 131 modules of `src/` (559 imports, ~0.2 s). `LAYERS`
  in the tool maps today's files (snapshot.ts → server; commands.ts → contract; sim/craft, path, vehicles, river,
  tuning, types, traffic-pack, walk-bounds → shared; `sim-host.ts`, `sim.worker.ts` → server; `sim-worker-link.ts`
  → client; `fetch.ts`, `viewer-tiles.ts` and the headless root modules stay presentation for now, as the
  mesher, `util.ts` and `stream.ts` load through them). Value-import cycles fail outright (0). Baseline: R1 47
  imports, R2 4 type cycles (those of section 1), R3 0, R4 0 (`main.ts` owns `window.__`). A new violation fails,
  and so does a baseline entry no longer found; `node tools/core-deps.mjs --baseline` prints the current list to
  paste over `BASELINE`, `-v` prints it. Planted violations of each rule failed (R1 import, R2 value cycle,
  R3 `Math.random`, R4 hook, a stale entry). R5 waits for `sim/contract/` (A3).

### A2. Headless modules out of the root (S–M)

- **Goal:** `core/` imports only `core/`; `sim/`, `physics/` import nothing from the root.
- **Files:** `tile-data.ts` → `core/tile-data.ts`; `Meta`, `WorldId`, `TileLevel`, `ColumnData` out of `types.ts`
  into `core/meta.ts` (`types.ts` keeps the viewer's types and re-exports for one step); `world.ts`,
  `tile-world.ts` → `core/` (the `import type * as THREE` at `world.ts:1` replaced by the `Point` it already
  declares); importers updated (14 of `tile-data`, 24 of `types`, 11 of `world`).
- **Gates:** fast set; `mesh-golden` with a file recorded before (the mesher imports `tile-data`); A1's baseline
  shrinks by 9.
- **Landed** (2026-11-24): `core/meta.ts` holds `Meta`, `WorldId`, `TileLevel`, `ColumnData` and, because `Meta`
  names them, `Label`, `Facts`, `View`, `Vec3Tuple` (all meta.json data); `types.ts` keeps `FloodInfo`, `Zones`,
  `Place` and re-exports the rest for one step (every importer already switched, so the re-export can go).
  `tile-data.ts`, `world.ts`, `tile-world.ts` are in `core/` (git mv); `World.raycast` takes `Point` (no three).
  Importers in `src/` and `checks/` switched, and the tools' load paths (`imp('src/tile-data.ts')`,
  `load('tile-data.ts')`, `load('world.ts')` in 12 tools). Baseline R1 47 → 35: the 9 headless → root entries and
  3 server → root ones (`sim-host.ts`, `sim.worker.ts` → `types.ts`; `sim.worker.ts` → `tile-world.ts`); none
  added. `core/` now imports only `core/`; `sim/`, `physics/` nothing from the root. The fast set scans 55
  modules (with `core/world.ts`, `core/tile-world.ts`). `mesh-golden` identical (106 meshes), fast set 16/16,
  `popin-check`, `vite build`, and the page with and without `?worker=1` load without errors. Comments and docs that
  name the old paths (`tile-data.ts`, `world.ts` in prose) were left as they are.

### A3. The contract module (M)

- **Goal:** every type that crosses between client and server in one place that imports neither.
- **Files:** new `sim/contract/` (`ids.ts`, `commands.ts`, `events.ts`, `snapshot.ts`, `inputs.ts`); out of
  `sim/world-sim.ts` (`PlayerId`, `CraftId`, `SimEvent`, `SimInput`, `FrameTime`, `Ack`, `MAX_DT`,
  `EVENT_TICKS`), `sim/entities.ts` (`EntityRef`, `Seat`, `Role`), `sim/commands.ts`, `sim/snapshot.ts` (the
  `Snapshot`, `CarState`, `PersonState`, `CraftState`, `EditNote` types), `sim/sim-client.ts` (`SimCommand`),
  `sim/mode.ts` (`ModeRequest`), `physics/rapier/car.ts` (`CarInput`), `physics/rapier/player-car.ts`
  (`DriverSnapshot`, `DriveNote`, and the constants `nav/drive.ts:6` imports), `sim/craft/craft-core.ts`
  (`CraftSpot`). The old modules import from it; importers in `nav/`, `view/`, root switched.
- **Result:** both sim type cycles gone; `nav/` no longer names `world-sim.ts` or `physics/`.
- **Gates:** fast set, `popin-check`; A1's baseline shrinks (sim→physics 5, nav→server 4).
- **Landed** (2026-11-24): `sim/contract/` holds the wire types; it imports only `core/` types and itself.
  `ids.ts`: `PlayerId`, `CraftId`, `EntityKind`, `EntityRef`, `Role`, `Seat`, `VehicleId`, `CraftType` (now explicit
  unions; `VEHICLES` and `CORES` are checked against them, `CORES satisfies Record<CraftType, …>`). `pose.ts`: `Pose`,
  `WalkPose`, `RoadPose` (out of `sim/types.ts`). `inputs.ts`: `CarInput`, `NO_INPUT`, `PARK`, each craft's input
  (`BoatInput`, `CraftInput`, `FlightInput`, `DroneInput`, `PlaneInput`), their union `PilotInput` (was world-sim's
  derived `CraftInput`; `cores.ts` asserts it equals the cores' inputs), `SimInput`, `FrameTime`, `MAX_DT`.
  `commands.ts` (git mv): `PlayerCommand`, `SeatInput`, `CommandResult`, `SimCommand`, `ModeRequest`, `CraftSpot`.
  `events.ts`: `SimEvent`, `DriveNote`, `EVENT_TICKS`. `agents.ts` (new beside the five named): `Person` (whole,
  as events still carry it until A6), `PersonState`, `CarState` (explicit; `sim/snapshot.ts` asserts both equal the
  `Pick`s of `CAR_KEYS`/`PERSON_KEYS`), `BodyDraw`, `TrainState`, `BoatPose`, `BoatView` (`BoatTraffic implements`
  it). `snapshot.ts`: `Snapshot`, `CraftState`, `EditNote`, `Ack`, `DriverSnapshot`, `SINK_MS`/`CRASH_MS`/`FALL_MS`.
  No re-exports from the old places: every importer switched (src, checks, `tools/vehicles.mjs`). Moved to make the
  cycles go, not to the contract: `CraftWorld` and `Craft` to `sim/craft/craft-core.ts` (nav named world-sim for
  `CraftWorld`; mode ↔ world-sim for `Craft`), `TrafficView` to `sim/snapshot.ts` beside `TrafficMirror` (A4 takes
  both to the client). R5 in `core-deps`: a `sim/contract/` module has no `class`, no function or arrow body but a
  type guard's (type and interface declarations skipped); planted class, function and arrow failed, a guard, a
  function type and `Object.freeze` passed. Baseline 39 → 18, only removals: R1 35 → 16 (the 6 of
  `commands.ts`, nav → world-sim/physics 5, `sim-worker-link`/`sim.worker` → snapshot/world-sim/sim-client 3,
  sim-client → player-car/boat-traffic/entities 3, sim-server/snapshot → sim-client 2), R2 4 → 2 (both sim type
  cycles gone). Fast set 16/16, `popin-check` (and `--mirror`), `tsc`, the page plain and `?worker=1` without errors.

### A4. `sim/` split by role (S–M, moves only)

- **Files:** `sim/sim-server.ts` and `takeSnapshot` → `sim/server/`; `SimClient`, `LocalSimClient`,
  `MirrorSimClient`, `TrafficMirror`, `ThreadLink`, `sim-worker-link.ts` → `client/`; `sim-host.ts`,
  `sim.worker.ts`, `viewer-tiles.ts`, `fetch.ts` → `host/`. `tools/*.mjs` load paths updated (`mirror-check`,
  `life-edit`, `popin-check`).
- **Gates:** fast set, `popin-check`; a browser check with `?worker=1` (the worker URL in `WorkerLink` moves).
- **Landed** (2026-11-24): `git mv` to `sim/server/` (`sim-server.ts`, `snapshot.ts`: `takeSnapshot`), `client/`
  (`sim-client.ts`, `sim-worker-link.ts`), `host/` (`sim-host.ts`, `sim.worker.ts`, `viewer-tiles.ts`, `fetch.ts`);
  `client/` and `host/` beside `sim/` in `src/`, as the layer table names them. `TrafficMirror` and `TrafficView` moved
  out of `snapshot.ts` into `client/sim-client.ts` (one module with `MirrorSimClient`: a file of their own would have
  added a client -> `sim/traffic.ts` entry). The client imports no server any more: `LocalSimClient` and `ThreadLink`
  take an `InThreadSession` (the `Session` shape they use, declared in the client; the app passes the `Session`), and
  the worker's messages (`ToWorker`, `FromWorker`) and the road physics' options (`PhysicsOptions`;
  `HostOptions.physics` is it plus `at`) are in `sim/contract/worker.ts` (types only, R5). Types only, no behaviour
  change. `core-deps` `LAYERS` by folder; `host/fetch.ts` and `host/viewer-tiles.ts` are kept presentation there (the
  mesher, `util.ts`, `stream.ts` load through them, so as server they would add three entries for the three they
  remove), and `client/sim-client.ts` is scanned for three.js and DOM globals as it was under `sim/`. The worker URL in
  `WorkerLink` is `../host/sim.worker.ts`; the tools' load paths (`mirror-check`, `life-edit`, `popin-check`) and
  `checks/world.ts`, `checks/plane-real.ts` follow; comments naming the old paths and the gates' guard texts updated.
  Baseline 17 -> 13, only removals: the four client -> server entries (`sim-client` -> `sim-server` type, ->
  `snapshot`; `sim-worker-link` -> `sim-host` type, -> `sim.worker` type); the rest renamed (same violations). Fast set
  16/16, `popin-check`, `tsc`; the page plain and `?worker=1`: traffic moves, follow a car, 0 page errors.
  Open: `client/` still imports `sim/traffic.ts` (`TrafficMirror` over a whole `Traffic`: A11's later step);
  `host/fetch.ts`/`host/viewer-tiles.ts` are the page's loaders too (split, or ports in A12).

### A5. The protocol gate (S)

- **Goal:** G1: prove that what crosses is plain data, before anything depends on it.
- **Files:** a `CloneLink` (a `SimLink` wrapper: `structuredClone` of the snapshot, JSON round trip of the
  commands) beside `ThreadLink`; `tools/mirror-check.mjs` and the `left`/`events` scenarios of
  `tools/life-edit.mjs` run through it; `gates.mjs` counts.
- **Expect:** it may fail first (typed arrays in `EditNote` are fine for clone; anything aliasing sim objects shows
  as a mutation difference). Fix what it finds by copying in `takeSnapshot`; no format change here.
- **Landed:** `CloneLink` in `sim/sim-client.ts` wraps any `SimLink`: each snapshot is checked to be plain data
  (`plainData`: no function, class instance, Map/Set, cycle; typed arrays allowed) and `structuredClone`d; each
  frame (`dt`, `input`, commands) and `loadPhysics`' `warm` is checked stricter (also no typed array, NaN/Infinity,
  `undefined` in an array) and sent through JSON. `mirror-check`, `life-edit` `left`/`events` and
  `popin-check --mirror` run through it; the page's `?mirror=1` keeps `ThreadLink` (behaviour unchanged). It
  passed at once: no copy needed in `takeSnapshot`. A function or a class instance put into the snapshot fails
  `mirror-check` and `life-edit` (`not plain data: snapshot.probe is a …`). Not yet covered: none of these runs
  loads the road physics, so `BodyDraw` and `DriverSnapshot` never cross, and none tracks edits
  (`SimServer.trackEdits`: the worker only), so no `EditNote` does; no separate `protocol` gate name (the gates
  above are it).

### A6. Typed wire data (M)

- **Goal:** F4 closed without changing what is drawn.
- **Do:** events name people by id with the fields the fall animation needs (no `Person` object; drop the special
  cases at `sim/snapshot.ts:88, 137`); `craft` events typed per craft type (a union instead of `unknown`); each
  core declares its wire state (`save(): State`, `load(State)`) in place of reflection, with `core-state.ts` kept as
  the check that the declared state is complete (a tool compares both); a `hello` from host to client with
  `protocol` (a number bumped by hand), `meta.world.buildId` and the tuning's hash, refused on mismatch.
- **Files:** `sim/contract/`, `sim/world-sim.ts`, `sim/traffic.ts` (`struck`, `dropped`), `sim/craft/*-core.ts`,
  `sim/craft/core-state.ts`, `view/life.ts` (reads events), `client/`, `host/sim.worker.ts`.
- **Gates:** `protocol` (A5), `mirror-check`, `life-edit` (`events`, `left`, `rates`), `craft-motion`, `plane`,
  `boat`. Edits as ops instead of columns on the wire: not here (open question 4).

### A7. Sessions (M)

- **Goal:** F2. One object per connection; the world knows players, not readers.
- **Do:** `SimServer.connect(player): Session`. A `Session` owns `since`, the outcomes delivered, the seat reads
  and the input seq; commands on the wire carry no `player`, the session stamps it; `WorldSim` publishes command
  results as tick-numbered events (or a per-tick list) and loses `results()` draining and `SeatReads`; the client
  takes its id from the session (`client.player`), `LOCAL_PLAYER` goes; the worker makes one session per `init`.
  Two sessions for one player each get everything.
- **Files:** `sim/server/`, `sim/world-sim.ts`, `sim/contract/`, `client/`, `nav/craft.ts`, `nav/drive.ts`,
  `nav/ride.ts`, `nav/crafts-view.ts`, `dig.ts`, `main.ts`, `host/sim.worker.ts`; the tools that send commands.
- **Gates:** `life-edit` (`players`, `events`, `left`), `mirror-check`, `protocol`; a new scenario: two sessions
  for one player read the same results.
- **Landed** (2026-11-24): `SimServer.connect(player): Session` in `sim/sim-server.ts` (not yet `sim/server/`: A4;
  in the same module so the client's one type import of the server stays the baseline's one entry). A `Session` stamps
  its player on every command (`WorldSim.send(player, cmd, taken?)`; `PlayerCommand` and the `edit` command lost
  `player`; a `player` field a client puts in anyway is ignored) and owns the connection's state: the snapshot's event
  cursor, the result cursor and the results not yet taken (`results(kind?, role?)`), its edits' outcomes and
  `onEdit` (the refs are the client's), the seat reads (`craftEvents()`, `driverNotes()`), the ack (the world tells the
  sender through `taken`; `WorldSim.ack` gone) and the world's edits not yet sent (`trackEdits` now feeds every
  session). `WorldSim` lost `results()`, `ack()`, `craftEvents()`, `driverNotes()` and `SeatReads`; it publishes
  results as a log by tick like the events (`resultsSince(player, tick)`, kept `EVENT_TICKS`) and the log itself
  (`eventLog`). `SeatReads` moved to `sim/seat-reads.ts` (shared layer, with `seatKey`), so the client no longer imports
  `world-sim.ts`. `session.leave()`: the last session of a player leaves the seat and the follow (next tick). The
  snapshot's `player` carries `id`; `SimClient.player` (a `LocalSimClient`'s session's, a `MirrorSimClient`'s from its
  snapshots, null before the first) and every own-player read lost its `player` argument (`results`, `seat`, `ack`,
  `driver`, `driverNotes`, `craftOf`, `craftEvents`, `edit(op)`). `LOCAL_PLAYER` and `nav/player.ts` are gone: the host
  names the page's player (`sim-host.ts PAGE_PLAYER`, `'local'`), `main.ts` connects it in-thread, the worker
  connects one session per `init` (`init` lost `player`); `ThreadLink(session)`. `crafts-view` compares with
  `sim.player`. Behaviour changes: unread results older than `EVENT_TICKS` (10 s) are dropped instead of piling up
  (E7/E14's open point; the nav reads its kinds every frame); a session's first snapshot carries the world's event log
  as before. Gates: `life-edit sessions` (new): two clients on one `SimServer`, each over its own session through a
  `CloneLink`, plus a second session of one player read directly: each client named by its snapshots, its own
  results, seat events and ack, the second session of a player the same results and seat events and no ack; a
  command claiming another player acts as the session's (planted: trusting the claim fails two checks); leaving the
  player's last session frees the seat and another player takes it. `life-edit events` reads the direct side through
  a second session of the pilot (no ack: it sent none). Baseline 18 → 17 (only the removal of
  `sim-client → world-sim`). Fast set 16/16, `popin-check` (and `--mirror`), `tsc`, `life-phys --driver`, `judder`
  28/28; the page plain, `?mirror=1`, `?worker=1` (each also with `?dig=1`): follow, walk as a person, the walk,
  drive, every craft, dig, `client.player` `'local'`, no command naming a player, 0 page errors.
  Not done: `Session` has no input seq of its own (the client numbers its seat inputs, the session acks them);
  edit outcomes go to the sending session only (their refs are its client's), not to every session of the player.

### A8. Views per player; world time owned by the host (M)

- **Goal:** F1. `SimInput` disappears from the client's frame.
- **Do:** (a) a per-player `view { focus, viewer }` command, kept in the player's state; `WorldSim.update(dt)`
  takes no focus; the active circle is computed from the players' views (with one player: the same circle, neutral;
  several circles is interest management, not this package). `LifePhysics` takes its origin from the map, not from
  a focus. (b) hour and day are world state set by the host (`WorldSim.setTime`), changed by a mode request the
  sandbox grants (the bar keeps working); the snapshot carries them and `Daylight` reads them from the client.
  (c) the link's `frame(dt, …)` becomes `advance(dt)` on the in-thread link only; the worker ticks on its own timer
  and the page sends commands as they come.
- **Not neutral:** (c) changes the worker's pacing (it stops following the page's frames; alpha comes from M4's
  render clock, so (c) waits for M4 or keeps the page's `dt` as a hint until then). (a) and (b) are neutral
  in-thread.
- **Files:** `sim/world-sim.ts`, `sim/traffic.ts` (`frame`), `physics/rapier/life-phys.ts` (origin), `sim/mode.ts`,
  `sim/modes/sandbox.ts`, `sim/contract/`, `client/`, `main.ts`, `host/`.
- **Gates:** `life-edit` (rates, determinism), `mirror-check`, `popin-check`, `rapier-car`, `surface-gap` (the
  origin), `judder` by hand.

### A9. Edits through the command path (M, not neutral)

- **Goal:** F7. An edit is applied in a tick the host chose; the page has one edits owner.
- **Do:** `edit` becomes a `PlayerCommand`; `WorldSim.apply` asks `mode.mayEdit`; the host resolves the touched
  nodes before the tick that applies it (a port: `tiles.ready(nodes): Promise`, the command held until then, its
  result carrying the tick it was applied in); the client owns a `LiveEdits` instance given to the streamer and the
  page's `TileCache` (in-thread it is handed the world's instance by the app; no `import { liveEdits }` in
  `client/`, `stream.ts` or the shells); `hostSim` keeps its listener's unsubscribe.
- **Files:** `sim/server/`, `sim/world-sim.ts`, `core/world-edits.ts`, `core/live-edits.ts`, `client/`,
  `stream.ts`, `host/viewer-tiles.ts`, `dig.ts`.
- **Gates:** `life-edit`, `edit-roundtrip`, `layers`, `world-smoke`; browser check `?dig=1` in-thread and with
  `?worker=1`.

### A10. Drawn state off the sim's objects; picks by id (M)

- **Goal:** F3, first half: layer-3 objects carry no presentation fields.
- **Do:** `rp`, `rh`, `pitch`, `roll` leave `Car` and `Person` (`sim/types.ts`); the view keeps a `Map<id, Drawn>`
  per kind; `TrafficBodies.pose(c, a)` returns a pose instead of writing one (`life-phys.ts:439, 707`,
  `snapshot.ts:187-199`); `Traffic.detachCar` stops seeding the drawn pose (`traffic.ts:788`);
  `Picked` and `Ride` hold an `EntityRef`, the nav reads poses through `StreetLife.pose(ref)`; the nav gets the
  client directly (`nav.sim`), not through `nav.life.client`.
- **Files:** `sim/types.ts`, `sim/traffic.ts`, `physics/rapier/life-phys.ts`, `sim/snapshot.ts`, `view/life.ts`,
  `view/meshes.ts`, `nav/nav.ts`, `nav/ride.ts`, `nav/drive.ts`.
- **Gates:** `mirror-check` (instance matrices bit-equal as now), `popin-check`, `life-edit`, `rapier-car`;
  `judder` by hand (the ride camera reads the drawn pose).
- **Landed** (2026-11-24): `Car` lost `rp`, `rh`, `pitch`, `roll`; `Person` (`sim/contract/agents.ts`, `Blocked` in
  `sim/types.ts`) lost `rp`, `rh`, so the contract's `Person` carries no drawn fields (A3's open point; events still
  carry it whole until A6). `StreetLife` keeps a `Drawn` entry per car id and per person id (the pose, and what was in
  WeakMaps by object: a motorbike's lean, a walked person's step phase), marked each frame and dropped when not drawn
  (ids are never reused, so this is the old per-object lifetime). `TrafficBodies.pose(c, a, under): RoadPose` returns
  the drawn pose (`under`: the path's pose for a car in the traffic, the last drawn otherwise); `LifePhysics` and
  `TrafficMirror` share `fadeOut` (`sim/traffic.ts`); `LifePhysics.release` computes its fade from `poseAt` instead of
  writing and reading `c.rp`. `Traffic.detachCar` seeds nothing: a parked car never drawn starts from its
  `detachedPose` in the view (position only, heading 0, as the old seed; overwritten at once when bodies exist).
  `Picked` is `{ ref: AgentRef, label }` (`AgentRef`: an `EntityRef` of kind car or person); `Ride` extends it.
  `StreetLife.pose(ref)`, `agent(ref)` (what it is now: a car's type, length, bus; the ride camera, the drive panel's
  label and the hud read it per frame instead of holding the object), `first(kind)`, `nearest(kind, from, skip)`,
  `pick(..., skip: AgentRef)`, `drawn(kind, id)` (tools). `StreetLife.client` is private; `Nav.sim` holds the client
  (set by `main.ts` beside `nav.life`), `RideHost.sim()`; the walked person is kept by id. Tools: `mirror-check`,
  `popin-check`, `judder` read `life.drawn`; `life-edit` and `checks/drive-scenarios.ts` (`Drive.pose(c)`) keep their
  own pose maps. Measured against main: `mirror-check` (2 239 722 poses), `life-edit`, `popin-check` and its
  `--mirror` print the same lines (only timings differ), `rapier-car` the same details apart from `stepMs`; fast set
  16/16, `tsc`, `core-deps` (baseline 17, unchanged: no entry concerned the drawn fields); `judder` 28/28 (J and E
  at most 0.10 cm); the page plain, `?mirror=1`, `?worker=1`: follow a car, tap a car and a person, walk as them, drive
  and park, 0 page errors. One edge differs in
  principle: the hud's "moto" comes from the agent looked up at the mode change, so for an agent already gone it falls
  back to the ride's label (before: the held object's type; the hud is hidden while driving). Kept as it was: a parked
  car never drawn and without bodies is drawn heading 0 (the old seed's quirk).

### A11. One read path (S, plus measuring; owner's call)

- **Goal:** F3, second half: the page draws from snapshots in every mode; `LocalSimClient` and `TrafficView` as
  `Pick<Traffic>` go.
- **Do:** first close the known gap (a body's drawn pose as a quaternion in the snapshot, compared by
  `mirror-check`); measure the in-thread mirror's cost (0.22–0.27 ms a frame was measured for the worker's apply,
  local-server.md section 6); then `main.ts` builds `MirrorSimClient(ThreadLink)` by default. In-thread there is
  no added latency (the link is synchronous).
- **Later, not here:** `TrafficMirror` without a whole `Traffic` behind it (the path maths as functions over the
  road data: layer 2).
- **Gates:** `mirror-check` loses its reference side, so record the direct path's instance matrices once as a
  golden before the flip; `popin-check`; `judder` car/plane/boat/drone unchanged.

### A12. One host (M)

- **Goal:** F6. The wiring that ships is the wiring that is gated and that a Node server starts.
- **Do:** `hostSim(data, ports)` with ports `{ tileLoader, now, log, physicsLoader }` and the data handed in (no
  `fetch`, no `performance`, no `console` inside); the page and the worker pass browser ports, a new
  `host/node.ts` passes file ports; `life-phys.mjs`, `popin-check.mjs`, `mirror-check.mjs` build their sims
  through it (`life-edit`'s unit-like scenarios may keep a bare `WorldSim`); `sim.worker.ts`'s `handle` takes its
  `post` as a parameter so G2 can drive it in Node. New gate `host-smoke` (G2), fast set.
- **Files:** `host/*`, `tools/host-smoke.mjs` (new), `tools/gates.mjs`, the three tools.
- **Gates:** `host-smoke`, `mirror-check`, `popin-check`; browser check `?worker=1`.
- **Landed** (2026-11-25): `host/sim-host.ts` `hostSim(data, ports, opts)`: `HostData` `{ meta, traffic, boats? }`
  (boats as data or a promise: the page's and the worker's fetch, set when in, as before), `HostPorts` `{ tiles, now,
  log, physicsLoader }` (`tiles` is the tile loader as a `TileCache`, so the page's stays shared with its streamer;
  `physicsLoader` gives the road physics' module), `HostOptions` as before minus `cache` and `base` (`seed` optional:
  the traffic's default). No `fetch`, `performance`, `console`, `Date`, `process` in it: `core-deps` scans it with the
  headless modules and fails on those words (`PORTS_ONLY`). `host/browser.ts`: `browserPorts(tiles)` and the worker's
  `fetchJson`, `fetchGzip`, `tileCacheAt`; `host/node.ts`: `nodeTileCache`, `nodePorts`, `readHostData`,
  `nodeHost(dir, opts, data?)` (`world: 'tiles'`: a `tileWorld` over its cache, as the worker's; node:fs/zlib through
  `process.getBuiltinModule`, so no `@types/node`; the physics module imported statically, vite's runner closes after
  the load). `mirror-check`, `popin-check`, `life-phys` start their sims through `nodeHost` (`life-edit` keeps its bare
  `WorldSim`s); `PhysicsOptions.look` (optional) carries `life-phys --no-look`. `sim.worker.ts` `handle(s, m, post,
  setFocus)` is exported; the worker's `onmessage` is set only in a worker scope. The A4 open point: the page's loaders
  moved out of `host/` to the root (`fetch.ts`, `viewer-tiles.ts` `viewerTileCache`; presentation), the host gets them
  only as ports, `host/` is server in `LAYERS` whole; the two fetch helpers and the cache's line are written twice
  (`fetch.ts`/`viewer-tiles.ts` and `host/browser.ts`), as no layer both may import may fetch. Baseline 13 -> 10, only
  removals (the three host -> page loader entries). New fast gate `host-smoke` (~5 s): `nodeHost` on the real data with
  its ground from the tiles, two sessions x 240 frames, every snapshot hashed: run twice and once through `handle`,
  all alike; then `loadPhysics` through `handle` (Rapier through the physics port, terrain through the tile port).
  Measured: `mirror-check --seconds 60` output byte-identical to main's; `life-phys --run 4 60` counts as main's. Fast
  set 17/17, `popin-check`, `tsc`; the page plain and `?worker=1`: traffic moves, follow a car, drive (the road physics
  through the browser port), 0 page errors.
  Open: `hostSim` still registers a `liveEdits` listener it never removes (one per host; tools that start several hosts
  in one process collect them; harmless while no edit is made); the handoff's gate count text.

### A13. App composition (M, hygiene)

- **Goal:** F9. The two things that will change are units: the session and the frame.
- **Do:** `app/session.ts` (options → client: local, mirror, worker; later network), `app/frame.ts` (the phases of
  `main.ts:548-609` as an ordered list of named steps: input, sim, poses, cameras, camera readers, render),
  `app/debug-hooks.ts` (every `window.__*`, typed once; R4), the toast/credits/jump widgets to `ui/`, the
  view-distance policy (`main.ts:644-683`) to its own module. No behaviour change, no new abstraction beyond the
  list of phases.
- **Gates:** fast set; `shoot.mjs --compare` on two views; `judder` (frame order) by hand.

### A14. Data build identity checked at load (S, hygiene)

- **Goal:** F11. A page or host that loads a build it does not understand says so.
- **Do:** one `core/data-contract.ts` naming the files a host and a client load and the `formatVersion` this code
  reads; `meta.world` checked where `meta.json` is loaded (`main.ts:413`, the host); a missing `world` warns (old
  builds). No pipeline change, no rebuild (`meta.json` has `world` today).
- **Gates:** fast set; `tile-roundtrip`.

Suggested order: A1, A5 (independent, small) → A2, A3 → A7 → A10 → A4, A12 → A6, A8, A9 → A11, A13, A14.
A2/A3/A4 move many import lines: one at a time, not in parallel with each other or with an E/M package.

## 5. Non-goals and open questions

Non-goals of this review and of the packages above:

- No game rules: health, items, spawn, avatar, population (E15, E16, E21), what a mode decides.
- No lag work: snapshot buffer, prediction, wire encoding, interest filtering, lag compensation (M4–M10, E17–E19).
  A8(c) and A11 touch them and say where they wait.
- No transport, accounts, persistence.
- No rewrite of `Traffic`, `LifePhysics` or the craft cores; no ECS. The per-kind stores behind `Entities`
  (entities-and-modes.md section 1) are fine.
- No renderer restructuring (`voxelMaterial.ts`, `post.ts`, `daylight.ts`, `stream.ts`, `city.ts`): they are large
  but they are leaves of the graph, import nothing from `sim/` beyond types for the minimap, and do not affect
  multiplayer-readiness.
- No pipeline restructuring beyond A14 (code-health.md 13, 14, 18 cover it).
- `nav/` internals (the 655-line `Nav`, input and camera duplication) stay with code-health.md 19 and N2/N3.

Answers (2026-11-24):
1. The host owns the time of day, the same for everyone (A8: `hour` is world state in the snapshot; the hour slider
   only in the sandbox or for the host).
2. Open; the owner can't judge it yet. Until then keep today's behaviour (an observer's camera is a focus); keep it
   one switch so either answer stays cheap.
3. Lead's call: yes, flip to one read path after A10 and the quaternion fix.
4. Lead's call: columns for now (no client determinism needed); revisit with A6's `hello`.
5. No: the gates stay local, `.github/` is not touched.
6. Yes: split the folders, one package at a time (A2, A4).

Open questions for the owner (only where the structure depends on the answer):

1. **Who owns the time of day in a shared world?** A8 makes it world state the host sets. If each player may keep
   their own hour (a purely visual choice), it stays client state and only the traffic's density needs a world hour.
   This decides whether `hour` is in the snapshot or in the client.
2. **Does the creative camera simulate the world where it looks?** Today the orbit camera's focus is where traffic
   exists. With a server, either an observer is a player with a view (the world is simulated round it, at a cost
   per observer) or it sees only what players' presence already simulates. ADR 0008 says creative mode has no
   authority; it does not say whether it has presence.
3. **One read path by default (A11)?** It makes the played path the server path and deletes a client
   implementation, for a measured 0.2–0.3 ms a frame and a body's pose blended slightly differently. The
   alternative keeps `LocalSimClient` as the fast path and relies on `mirror-check` to hold the two together.
   Recommendation: flip, after A10 and the quaternion fix.
4. **Edits on the wire: ops or columns?** Columns (today) need no determinism from the client but cost up to a
   node's columns per edit; ops are small and already have an encoding (`core/layers.ts` VXD1) but require the
   client to hold the same base build and apply them identically (A6's `hello` would guarantee the build). This
   decides whether the client needs `core/world-edits.ts` at all.
5. **May CI run the fast gates?** Without data, `tsc`, `core-deps`, `layers`, `bld-ids`, `tile-roundtrip` (needs
   uv), `boat`, `collision`, `craft-motion`, `rapier-car`, `vehicles`, `plane` run. The handoff rule forbids
   touching `.github/`; a layer ratchet (A1) is worth most when it cannot be skipped.
6. **Is the folder proposal acceptable** (`sim/contract/`, `sim/server/`, `client/`, `host/`, `app/`)? The rules of
   section 3 can be enforced on today's layout by A1 alone; the moves (A2, A4) buy readability, not correctness.
