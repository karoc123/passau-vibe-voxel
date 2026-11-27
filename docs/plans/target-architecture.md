# Target architecture: cost follows players, not the city

Status: accepted by the owner (2026-11-26, section 6); steps 1 to 7 landed (7 without the car). Facts are marked by
their source (code path or URL); everything under "Judgement" is mine.

Goal (owner, revised 2026-11-26 after concepts-and-scale.md): 3–8 players at once is normal, 16 in a round, 50 is
a stress test, on a map of several km² that keeps growing. The owner provides the hosts; a Raspberry Pi 5 is a wish,
measured when one is at hand. The design must make cost depend on players and what they see. Over its tick the host
gives way in this order: ambient people, then cars, then the send rate of others' agents; never the player's own
vehicle, never slow motion.

## 0. The game (owner, 2026-11-26; a direction, not a spec)

Open again (owner, 2026-11-26, after concepts-and-scale.md): the genre, the round's length and whether players
shoot each other are not decided; the lines below are the leading idea, not the plan. Decided: a lobby later, so a
group starts together; the game need not be fun alone; the phone need not be equal in every mode; other cities get
no work now (split where it falls out anyway; the next is likely another Bavarian one).

- **Round-based co-op survival shooter in a living city** (in the spirit of PUBG, Rust, DayZ). Fun for three first;
  PvP between squads later, in the same structure.
- **One server, one round:** 10–50 players in squads of about 3; a round lasts 30–45 min.
- **A round:** squads are dropped scattered by paraglider, find each other, scavenge equipment, survive; missions on
  the side. The end is open; a timed evacuation is the best idea so far. No rising flood.
- **Threats:** armed hostile groups amid the city's normal life; civilians react simply (flee, can be hit).
- **Combat:** firearms are the core; vehicles have seats with roles (pilot, gunner, passenger), e.g. a military
  helicopter flown by one and fired from by another.
- **Down, not out:** a hit player goes down and squadmates can revive them; a squad all down is out of the round.
- **Vehicles stand in the world and are found;** spawning one on demand is a sandbox/debug tool only.
- **Changes:** one edit mechanism, two targets. In a round, an overlay that dies with the round (destruction makes
  holes; no structural collapse). In the creative mode (free movement), changes are written into the map; that is
  how Passau will be maintained, the import pipeline then only makes new maps. Only the owner's team writes into
  the map, never in a deployed build; that needs a concept of its own first.
- **Fun beats realism.** The phone stays a client (touch, aim assist), not necessarily equal in every mode.
- **Later ideas, not goals now:** a simple slot inventory, loot by building type (needs building function in the
  data), enterable buildings (generated, then hand-built for key places).
- **Now:** multiplayer must work (steps 1 and 2 below) before any of the above.

## 1. What the code does today (it differs from the assumption)

The brief says the host simulates the whole city. The code does not:

- **Road traffic is one circle round one player.** `sim/traffic.ts` `setActive` simulates the roads within
  `ACTIVE_R` = 900 m of a focus (`sim/road-net.ts`); agents outside are removed, roads crossing the edge are sources
  and exits. Caps: 1400 cars, 4000 people, 1200 bikes (`sim/contract/agents.ts`). Agents appear and vanish only
  300 m (cars) or 150 m (people) from the viewer.
- **The circle is the first player's.** `WorldSim.update` takes `firstView()`: "the active circle round the first
  player's view; several circles are interest management, not yet". A second player elsewhere gets an empty city.
- **Trains** run on every route of the map with state (spacing, braking, dwell: `sim/train-traffic.ts`). They are few.
- **River boats** are already a function of the timetable, day and hour (`sim/boat-traffic.ts`).
- **Road physics** is by proximity: bodies within 60 m of an edit or near a driver (`physics/rapier/life-phys.ts`).
- **Edits and left vehicles** are kept by presence: 600 m, 120 s (`sim/tuning.ts` `EDIT_KEEPING`).
- **Every session gets everything.** `sim/server/snapshot.ts` `takeSnapshot` copies all agents as objects for each
  session, each frame. The client calls `link.frame(dt, commands)`: the page's frame drives the world's clock.
- **No network server exists.** `host/node.ts` starts the host for the gates only. No second player has ever joined.

So the real gaps are three: one focus instead of many, no cheap tier beyond 900 m (a pilot sees empty roads), and no
filter per client. Cost already does not grow with the map. That makes the step smaller than feared.

## 2. How others do it

Facts (read on the pages cited, 2026-11-26, unless marked unverified):

| System | Mechanism | Source |
|---|---|---|
| Minecraft Java | Simulation distance (default 10 chunks) and view distance are separate settings. Mobs spawn only within 128 blocks of a player and not within 24; they despawn at once beyond 128. Caps are counted per player. | [Chunk](https://minecraft.wiki/w/Chunk), [Server.properties](https://minecraft.wiki/w/Server.properties), [Mob spawning](https://minecraft.wiki/w/Mob_spawning) |
| Paper | Entities are sent within 64–128 blocks by kind; beyond an "activation range" of 16–64 blocks they tick less often. | [Paper config](https://docs.papermc.io/paper/reference/spigot-configuration/) |
| Luanti | Three nested ranges in 16-node blocks: simulate 4, send objects 8, send map 13. Server step 0.09 s. An object leaving the active range is stored as a string in its block and gets the seconds it was away (`dtime_s`) when it returns. | [settingtypes.txt](https://github.com/luanti-org/luanti/blob/master/builtin/settingtypes.txt), [lua_api.md](https://github.com/luanti-org/luanti/blob/master/doc/lua_api.md) |
| GTA III–SA | Cars spawn about 70 m away in view and 15 m off screen; they despawn at 90 m and 25 m. Distant cars run reduced physics without collision. Secondary write-up of the original programmer's account. | [libertycity.net](https://libertycity.net/news/8122-how-cars-appear-and-disappear-in-the.html) |
| FiveM OneSync | The server sends a client only the entities within 424 units of it. | [OneSync](https://docs.fivem.net/docs/scripting-reference/onesync/) |
| Unreal Mass | Three independent LODs: simulation (update rate per bucket), representation, replication per client. Each level has a distance and a maximum count. | [Mass overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-gameplay-in-unreal-engine) |
| Unreal Replication Graph | A spatial grid decides relevancy per connection instead of a check per actor and connection. | [Replication Graph](https://dev.epicgames.com/documentation/en-us/unreal-engine/replication-graph-in-unreal-engine) |
| Veloren rtsim | NPCs persist world-wide. One in an unloaded chunk runs its AI every 10th tick with the summed dt. | [npc_ai source](https://docs.veloren.net/src/veloren_rtsim/rule/npc_ai/mod.rs.html), [devblog 134](https://veloren.net/devblog-134) |
| S.T.A.L.K.E.R. A-Life | NPCs are "online" within about 150 m; offline ones move on a coarse graph, and results are written back. | [Game Developer](https://www.gamedeveloper.com/design/a-life-an-insight-into-ambitious-ai) |
| Cities: Skylines II | Every agent is simulated; no simulation LOD is described. | [Traffic AI](https://paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai) |
| Gambetta | Own player predicted and reconciled; others drawn about 100 ms in the past between two server states. | [Entity interpolation](https://www.gabrielgambetta.com/entity-interpolation.html) |
| Fiedler | Interpolation buffer of about three send intervals. Quantising and delta coding took 901 bodies from 17.4 Mbps to under 256 kbps. A priority accumulator sends the most overdue objects first. | [Snapshot interpolation](https://gafferongames.com/post/snapshot_interpolation/), [compression](https://gafferongames.com/post/snapshot_compression/), [state sync](https://gafferongames.com/post/state_synchronization/) |
| WebTransport | In Chrome, Edge, Firefox and Safari 26.4+; needs an HTTP/3 server and HTTPS. | [caniuse](https://caniuse.com/webtransport), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport) |

Not verified (page blocked or only snippets): Valve's Source networking numbers (20 snapshots/s, 100 ms
interpolation), Arma 3 Dynamic Simulation distances, the Tribes ghost model, GTA V's population files. No usable
measurement of any game server on a Pi 5 was found; the blog numbers for Minecraft (4–12 players) name no method. No
primary source was found for trains or traffic as a pure function of time; the closest are Luanti's `dtime_s` and
this project's own river boats.

Judgement, what to take from it:

- Everyone uses nested rings per player: simulate, send entities, send terrain. Nobody simulates by map.
- Ambient population is disposable. It is spawned outside a near ring and dropped beyond a far one, with a gap
  between the two. Only what a player touched is kept.
- Budgets are counts per player as well as distances. A count is what bounds a Pi.
- A pilot's view is the special case here. The games above have no 3 km ring of real agents; they show a cheap
  picture. That is the tier this project lacks.

## 3. The target

Five concepts. Nothing else is needed for the goal.

1. **Cell.** The map is a grid of 256 m cells (two tiles; today's `ACTIVE_CELL` is 300 m). Roads, footways, edits
   and stateful entities are indexed by cell. The cell is the only unit of simulation, interest and persistence.
2. **Interest.** Each player has a position and a height. From them the server derives two sets of cells: the
   agent ring (about 350 m on the ground) and the send ring (a little larger, so entities do not flicker at the
   edge). A cell's tier is the highest any player asks of it. The client never names cells.
3. **Three tiers.**
   - **Flow** (no state): a pure function of static data, seed and world time. Trains, buses on their lines, river
     boats, and far road traffic as cars at hashed phases along each road. The client computes it to draw; the
     server computes it only at the moment a cell is promoted. It costs the server nothing per tick and nothing on
     the wire.
   - **Agents** (state, path-following with signals and following distance): today's `Traffic`, in the cells of
     some player's agent ring, under a count budget per player.
   - **Bodies** (Rapier): today's `LifePhysics`, near drivers and edits.
4. **Kept things.** Edits, vehicles players left, wrecks, later built houses. They live in their cell and are kept by
   presence, in memory: a host restart starts the world afresh.
5. **Authoritative server on its own clock.** It ticks at 30 Hz whether or not anyone draws. Clients send inputs
   and their view; each receives only its send ring.

```
            flow f(seed, time)          agents (30 Hz, budget/player)      bodies (Rapier)
            everywhere, stateless       cells in an agent ring             near drivers, edits
                    |                            |                                |
 cell enters ring:  +--- materialise from f ---> |  --- driver or edit near --->  |
 cell leaves ring:  | <-- drop (kept things stay)|  <--- far, at rest ----------- |

 server (Node on the Pi, or a Web Worker for solo play)        client (browser)
 ----------------------------------------------------         ---------------------------------
 tick 30 Hz:  inputs -> players' vehicles -> agents            sends: seat input (seq, tick), view
              -> bodies -> kept things by presence             predicts: own vehicle (same sim code)
 per client:  interest = cells(position, height)               interpolates: agents, bodies, others
 send:        own vehicle + nearby bodies   30 Hz              draws flow itself from seed and time
              agents in the send ring       10 Hz              draws edits from columns sent per cell
              events, edited columns        on change
 disk:        kept things per cell
```

Rules for promoting and demoting:

- A cell enters an agent ring: its agents are created from the flow function at that time, so what was seen from
  afar is roughly what is met. It happens beyond the pop distance of every player on the ground, as today.
- A cell leaves all rings (after a delay, as presence has): its agents are dropped. Kept things stay.
- Anything a player acts on from afar (a rocket's target, a followed car) is a focus like a player and promotes its
  cell.
- Over budget, the server lowers density first, then the agents' tick rate. It never slows a player's own vehicle.

Authority: the server owns everything with state (agents, bodies, players, kept things, world time). Flow is owned
by nobody; it is derived. The client owns only what is drawn.

Why this is enough for the Pi goal (judgement, to be measured later): with a 350 m ring, a player costs roughly a
sixth of today's 900 m circle in road length. Twenty players spread out then cost about three of today's circles,
fifty about eight, and less when they are together: the budget per player matters. The city's size appears nowhere
in the tick.

### How today's pieces map onto it

| Piece | Fate |
|---|---|
| `sim/traffic.ts` active circle, `wayGrid` | Stays. One circle becomes a set of cells; `firstView()` goes. |
| `sim/traffic.ts` sources, exits, pop radii | Stay. The source rate comes from the flow function. |
| `sim/boat-traffic.ts` | Stays; already flow. Its poses leave the snapshot once the client samples the timetable. |
| `sim/train-traffic.ts` | Changes to flow: position from timetable and a fixed speed profile. `TrainState` leaves the wire. |
| `physics/rapier/life-phys.ts`, `terrain.ts` | Stay. |
| `sim/edit-keeper.ts` `Presence`, `EditKeeper` | Stay; become the store of kept things per cell, with a file behind it. |
| Parked-car cap 8/24 in `traffic.ts` | Goes; presence decides. |
| `sim/server/snapshot.ts` | Filtered by a radius per session (step 4); by cells, agents at 10 Hz later. |
| `client/sim-client.ts` `TrafficMirror` | Stays (the client's path maths). |
| `host/sim.worker.ts` `handle` | Stays; the WebSocket entry calls the same handler. |
| `sim/mode.ts`, `sim/entities.ts`, seats | Stay as they are. No extension until a game needs one. |
| `core/`, tiles, mesher, `view/`, `nav/` | Unchanged. |

### The path, each step playable

1. **The server's own clock.** Landed 2026-11-26.
2. **Two browsers.** Landed 2026-11-26 (every tick's full snapshot, two to a message at 15 Hz).
3. **Many foci.** Landed 2026-11-26 (a circle per player, overlaps counted once, a count budget per circle).
4. **Interest filter.** Landed 2026-11-26 (a radius round the player's view and seat, not cells yet: `?interest=`,
   default the street life's + 150 m; trains and boats still go to all, they become flow in step 5).
5. **Flow.** Landed 2026-11-27 (trains a timetable every page works out, none sent; far road traffic drawn by the
   page out to 1.5 km; the agent ring 350 m, cars sent to 400 m; agents spawned on the flow's cars).
6. ~~Kept things on disk.~~ Dropped by the owner 2026-11-27: a host restart need not keep the game (landed the same
   day, then removed).
7. **Prediction** of the player's own craft. Landed 2026-11-27 for the crafts (rewound to each snapshot and stepped
   again with the inputs since, corrections blended out), for the own car over a network the same day (the host's
   Rapier car and terrain in a world of the page's own, the traffic and other cars left to corrections). The host holds a
   driver's or pilot's input for the tick it is meant for (ADR 0014), so a jittery link neither loses nor doubles
   steering and the prediction lines up (landed 2026-11-27).
8. **Measure on a Pi.** Only then compact the wire (typed arrays, deltas) or move a hot part to Rust.

Steps 1 and 2 come first on purpose: they end the preparation and give every later step a user.

## 4. Why the work went in circles

Facts from `git log` (671 commits in nine days):

- Of the last 250 commits without merges, about 95 have a docs or bookkeeping subject ("Handoff: A4 landed",
  "Architecture review: A7 landed note") and about 51 are lettered engine refactors. About 10 are Q or F packages.
- Four package alphabets in five days, each from a review written by an agent: R1–R7, E1–E21, A1–A14, M1–M10.
- The same things were moved twice. E6 moved files "to follow the seam"; A2 and A4 moved them again. E7 introduced
  `takeWheel` and `drive`; E11 replaced them. E9 built `LocalSimClient`; A11 deleted it.
- Two changes were merged and reverted (the worker's drawn clock, the toon look).
- About thirty packages prepared a server. No server process and no second player exist.

Judgement on the causes:

1. **Abstractions without a user.** Sessions, hello with a tuning hash, links, ports, the mode seam, acks, the
   entity index: each is reasonable, and none has met a network. With no user there is no feedback, so every
   review finds a cleaner cut and the cut is made again.
2. **The direction of 2026-11-24** ("architecture first, no fine-tuning until the vision is clear") made
   structure the product. Structure with no use case has no stopping point.
3. **Gates that test the structure against itself.** `mirror-check` compares the mirror with a golden recorded
   from a path that A11 deleted; it must be re-recorded after every data rebuild. The bit-exact determinism checks
   in `life-edit.mjs` guard a replay nobody uses: ADR 0009 itself says the client needs no determinism.
4. **Docs that name code.** ADRs and comments list paths and symbols, so every move costs doc commits ("Docs:
   current paths after A2–A10", "Comments: deleted plan docs repointed").
5. **Reviews by agents produce packages.** Each review is a plan of 300–500 lines with ten or more packages, and
   each package is "behaviour-neutral", so it can never be judged by playing.

## 5. What to throw away

Risk is what could be lost. Code removals come with steps 1 and 2 (owner, decision 10).

### Docs

Done (owner, 2026-11-26): finished plans deleted, the to-do list is `todo.md`, road notes are `roads.md`, owner
questions in `FRAGEN.md`. ADRs 0006–0009 are merged into one after step 2.

### Code and tools

| Item | Reason | Risk |
|---|---|---|
| `CloneLink`, `plainData` | They prove data survives a clone. Since step 2 a dozen gates connect through `CloneLink`; `mirror-check` no longer has a golden and guards the wire with tolerances, so it stays. | Low; needs another link for those gates. |
| `core-deps.mjs` rules R2, R4, R5 and the baseline ratchet | Eight layers and five rules for 25 000 lines. Two rules suffice: the headless folders import no three.js or DOM; `client/`, `view/`, `nav/` import no domain or server. | Low. |
| `PageTime` request counting in `app/session.ts` | An optimistic protocol for the hour slider. | Low. |
| Parked-car cap in `sim/traffic.ts` | A second rule beside presence. | Low. |
| `tools/`: `lamps`, `tris`, `shoot`, `real-city`, `mesh-profile`, `remesh-bench`, `rapier-car-bench`, `life-phys-scan` | Not in the gate list. Delete those the owner has not run in two weeks. | Check each; I did not. |
| File-header comments that restate the module (`sim/world-sim.ts` has 33 lines) and comments that say where code moved | About a fifth of `sim/` is comment lines; they must be edited on every move. | Low. |

Done (2026-11-27): bit-exact determinism (the second dig and its hash, transit and craft runs compared bit for bit:
now within 1 cm, a host run twice, rule R3, the replay claims in ADRs 0006 and 0007) and the observer-view switch.

Keep, although small and unproven: hello, the mode seam, the entity index, seats. They cost little while nobody
extends them.

### Rules against circles

Adopted into `AGENTS.md` (owner, 2026-11-26).

## 6. Decisions (owner, 2026-11-26)

1. Build steps 1 and 2 now, reversing "architecture first" of 2026-11-24: yes.
2. Solo play always in a Web Worker, the in-thread mode deleted: yes.
3. Far traffic may be a picture until its cell is promoted: yes.
4. Player target: stays 10–50 (ADR 0008).
5. Orbit mode counts as a presence: yes (unseen by the others).
6. Kept things on disk: yes, later (step 6); dropped 2026-11-27, a restart need not keep the game.
7. Drop the bit-exact determinism requirement: yes.
8. WebSocket first, WebTransport later: yes. `ws` (MIT, npm) is added only in step 2.
9. Trains as a pure timetable, no dynamic spacing: yes.
10. Docs cleanup now; code removals with steps 1 and 2.
