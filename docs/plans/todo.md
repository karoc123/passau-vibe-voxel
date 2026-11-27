# To do

Open work only. When something lands, delete its line. Owner questions are in `FRAGEN.md`.

## Now: the server (target-architecture.md, owner 2026-11-26)

- **Steps 5–8** in the order of target-architecture.md.
- With steps 1–2: input commands by tick with ack and buffer (M5); drop bit-exact determinism checks; remove the
  observer-view switch (orbit mode is a presence, unseen: GLOSSARY.md).

- Overload (target-architecture.md): all three steps built (host/overload.ts), but the third cuts a whole session's
  snapshots to every second tick (not for a player in a vehicle or firing), not the others' agents inside one: that
  needs AgentWire to keep what a snapshot leaves out. Cars given back refill slowly (from sources).

## Later, in this order of likelihood

- Bandwidth (owner 2026-11-26: <= 20 kB/s mean, 50 peak, phones over the internet): at the cathedral, deflated per
  player, ~10 kB/s on foot, ~13 driving, ~15 in the helicopter, ~1 far off; ws-smoke holds it under 25; a round of
  16 at the cathedral 13–16 (`load` holds 20). What is left is every tick's moving bodies (~5 kB/s raw each: the
  traffic within 60 m of a crater) and crafts (~4, a helicopter's core whole, a parked one too). Not measured: a busy
  square, a late joiner after many craters (a node's whole op list), a phone on 4G. Binary only after a Pi
  measurement. Trains are still simulated with spacing on the host (step 5: from the timetable).
- E17–E18: prediction of the player's craft, then the car (one-body world). Belongs to step 7.
- E20: a headless probe mode (no city, players placed, an item, a round end), once E15/E16 exist.
- M6–M10: prediction, wire compaction, lag compensation for hits (with the first weapon).

## On hold until the game is decided (owner 2026-11-24)

- Concepts to choose from later (concepts-and-scale.md): manhunt, courier/rally, bridgehead PvP, extraction (§0),
  flood rescue. Open: genre, round length, PvP. Decided: a lobby later.
- Creative mode (the map maintained by hand, kept apart from a round's damage): who may write (the team only, never
  in a deployed build), where the edits live, how they survive a pipeline rebuild. A concept first.
- E15 health and items, E16 spawn/despawn/keep.
- M2 `?pace=1`: real frame times and judder on the owner's machine.
- Debug spawning of crafts and car type stays client-trusted until placed vehicles replace it.

## Owner's next (2026-11-27)

- The ping is the socket's round trip, not the snapshot's age.

## Pipeline and city

- The buildings' looks before landmark work (the painted windows land on broken blocks and do not carry walkable,
  differing houses): `building-looks.md`, waiting for the owner's answers there.
- Q7: the Wels-Passau railway's Inn bridge near Ingling (ways 131994367, 131994370) is a through truss; the deck is
  right, the truss is not drawn.
- Q5 leftover at -1102,1292: a 1–2 m strip 10 m over LoD2 where the surface model's step lies a cell off LoD2's.
- Road spots the general fixes leave: `roads.md`.
- ALKIS ponds that OSM does not map (about 23 000 cells) stay land; drawing them is a possible package.
- `voxelize.py` stage split (each stage a function over a context, one per commit under the golden check): only when a
  pipeline feature needs it.

## Small defects


- Buildings seen through (`tools/see-through.mjs --all --classify`): 8 left. 6 "steep caps" are steep roofs (50 deg
  and more) where an eave cell without a cap (its voxels off its plane) meets capped ones, e.g. 49_25 bld 301; 2 are
  slivers of 1-2 rays. Hans-Hösl-Straße 20's NW side is roof voxels from 2 m up (a 35 m strip under a 38.8 m eave,
  caps.py / voxelize): reads as the roof hanging down.
- A placed block leaves trees poking through; the edit keep radius (600 m) and delay (120 s) are guesses.
- Temporary damage needs the tile cache to expose a node's raw files.
- On leaving a seat, 1–2 frames where nobody draws the craft; empty crafts' events are published.
- `walkAs` start height is unbounded.
- Walkers and solid things (ADR 0010): a driven car does not feel a walker (it shoves it); the host does not check
  them; the walker cannot stand on a car's roof.
- Crafts and solid things (ADR 0012): the traffic's cars without a body do not feel crafts; a plane does not meet
  what it runs into (it has no meet); drone and paraglider have no shape.
- The parked-car cap (8/24) sits beside presence; it goes with presence per cell (target step 6).
- The worker decodes nodes the page also decodes.
- The own car and boat answer ~15–30 ms later since step 1 (render clock ~0.5 tick behind): prediction (step 7)
  removes it. The world keeps ticking while the tab is hidden.
- Aircraft wings do not collide. Not measured: does tile streaming keep up with the floatplane at ~245 km/h.
- Getting in from foot: E is the helicopter's, hovercraft's and drone's own key, so out of those only by the button;
  a car is got into at any speed (no stopping it first); the host's reach uses a rough box for a car (2.2 m half-length).
- Passengers are not drawn sitting in the craft or car (only their body on foot hidden); a car passenger on a touch
  screen cannot look round (Nav leaves touch to the drive's sticks); a full craft or car is still offered (the host says it is full).
