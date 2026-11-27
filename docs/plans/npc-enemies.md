# NPCs on foot as enemies (building block 4)

Agreed with the owner 2026-11-27. Small steps; today's passers-by stay.

## Behaviour: one small state machine per NPC, on the host

- **Post**: a guard stands where it was put, facing its way; a patrol walks its loop of points.
- It **notices** a player on foot (not down) within 60 m by a clear line from its eyes to their chest: the weapons'
  voxel ray, looked along a few times a second.
- **Attack**: it turns to them and fires the MG in short bursts while it sees them, after a short reaction; it walks
  towards them while they are further than 20 m.
- **Search**: out of sight a second, it walks to where it last saw them, looks round a few seconds.
- **Back**: to its post (a guard's spot, the patrol's nearest point), then post again.
- Not now: hearing, cover, NPCs working together, a field of view, players in vehicles as targets.

## Weapon and harm

- The players' MG through the same path a player's shot takes (the host's trace, the shot event, the harm). Its aim
  strays by a spread that grows with distance (seeded, so the gates repeat), so it does not hit every shot.
- An NPC is a life (ADR 0015): MG and grenades hurt it; at 0 it lies where it fell, is no target and no body to
  shots, and is taken away after a while.

## Placing one

- The menu's Debug section: an NPC here as a guard, or with a patrol round the point. A sandbox request, trusted as a
  craft's spawn is; where NPCs stand in a game is a later mode's.

## Look

- The players' figure in its own colours (a dark vest, olive trousers, a dark cap), lying when dead.

## Bytes

- An NPC crosses as a short sample (place, heading, velocity, flags) that the page reckons on, as the crowd's: sent
  when the reckoning drifts, every few ticks only beyond 150 m, not at all while it stands. Target: 10 NPCs in sight
  under 3 kB/s a player together.
- The load gate's mean per player is near its 20 budget: a car out of the traffic crosses with only what changed (a
  driven one's pose, not its whole way each tick); shots' points to the cm. Aim ~16.

## Gates (synthetic world, a real host)

A guard notices a player in sight and not one behind a wall; it fires and the player's health drops; it searches and
returns; a patrol walks its loop; one killed by MG and one by a grenade lie and are removed later; the bytes of 10
NPCs; the debug request places one. The host's cost with 10 and 50 NPCs, some fighting.
