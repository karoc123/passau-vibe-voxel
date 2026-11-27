# Health and damage (game building block 1)

One damage model for players, every vehicle kind, later NPCs. The host decides; pages are told.

## Model

- A **life** is what has health: a player (wherever they are: on foot, at a wheel, in a seat), a car, a craft; later
  an NPC (one more kind of life, nothing else changes). Keyed `player:p1`, `car:12`, `craft:3`.
- **Toughness**, per type as data (Tuning `health`, the host's own): max health, a factor per **damage kind**
  (`bullet`, `blast`, `crash`, `fall`), the share of a vehicle's damage that reaches those in it (`through`), the
  speed (m/s) a crash or a landing is taken at without harm (`safe`).
- **Damage** = amount x the kind's factor; a vehicle passes `through` of it to each occupant. Health is whole
  points, 0..max.

## Sources (all host side)

- MG: a ray's hit (avatar: its player; car or craft: the vehicle). The weapon package says its damage.
- Launcher: its blast, falling off linearly to its reach (twice the crater's radius), to every body in reach.
- Driven cars: the road physics' contacts (wall, landing, knock, coach), the hardest of a tick, past `safe`.
- Crafts: the velocity lost in a tick (one generic rule for every craft; the plane's crash event, whose state
  freezes the velocity, counts its speed), past `safe`; not in the tick a plane is put back.
- On foot: a fall, from the walk's poses: a descent that ends, its height to an impact speed, past `safe`; none in
  the water.

## Consequences (hooks a game mode may override; defaults in the sim)

- A vehicle at 0 is **wrecked**: its driver's or pilot's input is no more taken (park, neutral), nobody takes its
  driver's or pilot's seat again, a car out of the traffic (charred). Occupants are not killed by it.
- A player at 0 is **down**: their inputs, fire and seats are refused; after a few seconds they are **back**: full
  health, on foot at their safe spot (the last place they stood on the ground). The page follows the `back` event.
- Mode hooks: `downFor` (ms, null: stays down), `backAt` (where), `wrecks` (false: a vehicle at 0 keeps going).

## Wire (PROTOCOL +1)

- Snapshot `health`: `[life, hp, max][]`, only lives whose health changed since the session's last snapshot and that
  it sees (its own player always); left out when empty. A life at full health it never heard of is not sent.
- Event `back` (player, where): the page puts its walk there.

## Page

- HUD: own health and the current vehicle's, small, bottom left; a hit: the crash tint and a short shake.
- Down: the walk and the arms held still.

## Gate (`tools/health.mjs`, synthetic world)

MG hit lowers a player's and a helicopter's health (its pilot a share), the clients see it; launcher to 0: the
helicopter wrecked (the pilot's climb not taken, its seat refused); a player shot to 0 is down, then back at full
health with the event; a fall hurts; quiet ticks send no health.
