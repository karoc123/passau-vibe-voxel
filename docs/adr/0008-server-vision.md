# 0008 The server the engine is built towards

Status: accepted as direction (owner, 2026-11-23). Nothing of it is built yet; it decides how the engine packages
(`docs/plans/handoff-refactor-todos.md`, E1–E5) are cut. Builds on [ADR 0006](0006-world-sim-seam.md) and
[ADR 0007](0007-player-control-in-world-sim.md).

## Context

The goal is a GTA-like world in Passau, hosted by a server, played by several people at once. No server exists yet,
and there is no hurry for one: the engine is to be cleanly decoupled first, so the vision can still move.

## Decision

- **One world per server.** A server process runs exactly one world. Module-level world state (`liveEdits`, the tile
  cache) is acceptable; do not thread world instances through the code for a second world.
- **The server is authoritative.** It simulates traffic, physics and every player's vehicle or walker. Clients send
  input and draw snapshots; they may predict their own vehicle with the same sim code and correct to the server.
  Hence every player-controlled thing (car, boat, aircraft, special craft, walker) must run on the world clock from
  the sim side, not in a viewer shell.
- **10–50 players** in the one world. The sim runs active areas around players under a per-tick budget, and the server
  sends each client only what is near it (interest management). Nothing may assume one local player or one focus.
- **Edits live on the server, by presence.** A changed tile is the server's. It is kept while a player is near it
  and may be discarded when none is. The renderer never decides whether an edit exists; it draws what the world holds.
- **Edits are bounded.** Not a block-building game: players may damage things (a rocket hits a wall, which is broken
  for a while) and may build a house. Damage is temporary by default; a built house outliving its owner is likely
  later (out of scope now).
- **Gameplay state on the server:** collisions between players' vehicles, health and damage, weapons, police and
  wanted level, missions. These are per-player and per-entity sim state, keyed by player and entity ids (ADR 0007),
  never fields the presentation writes.
- **Co-op in vehicles is the long-term focus.** Several players share one vehicle, each in a seat with a role
  (driver, gunner, navigator, ...). So control is per seat, not per vehicle: a vehicle entity has seats, a seat holds
  at most one player and takes that role's input; `takeWheel` is the driver's seat of that model. On foot the game is
  first-person.
- **Creative mode stays** for checking and developing the world (orbit camera, free flight, teleport, debug views). In
  the server model it is a client without authority over others (an observer or a local-only session). It must not
  leak into the sim; if keeping it turns into a code smell, it is negotiable. Game clients are consistently the game.
- **Out of scope for now:** persistence across sessions (built houses that outlive their builder, money, owned
  vehicles, mission progress) and player accounts. Likely later; do not design them in yet.
- **A first game, as direction (not decided, owner 2026-11-23):** a small squad (e.g. three players) starts spread
  over Passau among hostile NPCs (zombies?), looks for loot, finds each other and travels on together by helicopter
  (pilot, gunner, ...) while doing objectives; later several squads with different objectives, PvP an option. Open on
  purpose: what happens to today's city life (an empty city, or one that empties over the round), what ends a round
  (a rising flood, a helicopter extraction, an objective chain, open-ended), the length of a round. Combat could be
  first-person guns, melee, vehicle weapons and temporary destruction; none of it is to be built now. Hence the engine
  is to carry many game variants: the rules of a game (who spawns where, what the city's population is, objectives,
  what ends a round) are a mode layered on the world sim, not woven into it; the sim offers entities with ids, seats,
  health and items as general mechanisms, and runs on its own clock whether or not anything is drawn.
- **Language: TypeScript for now.** The sim is shared by server and client (prediction needs the same code), Rapier
  already runs as WebAssembly, and 10–50 players are within reach of one Node process. The sim stays free of three.js
  and the DOM (`core-deps`) so a hot part can later be measured and, only if needed, moved to Rust behind the same
  interface. Measure before deciding (a headless `WorldSim`, E1, makes that possible).

## Consequences

- E1 (`WorldSim`), E2 (players by id), E3 (edits owned by the world) and E4 (crafts on the world clock) are required,
  not optional. E3 drops instance injection (one world) and gains the presence rule. F2 (walk to a vehicle) is set
  aside.
- New gameplay (damage, weapons, police, missions) goes into the sim with ids, not into `nav/` or `view/`.
- The world sim ticks whether or not a viewer draws it (today `main.ts` gates it on the life being visible; E2 lifts
  that). Events become tick-numbered so several clients can read them.
- The city's population (traffic, pedestrians, trains) is a setting the mode chooses, not a fixed part of the sim.
- E2 and E4 model control as seats on an entity (one seat per vehicle for now, the driver's), so co-op roles are an
  addition later, not a rewrite.
