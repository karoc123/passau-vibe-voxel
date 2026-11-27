# 0022 Enemy camps at chosen places

Status: accepted (2026-11-27). Builds on [ADR 0018](0018-npc-enemies.md); answers its "where NPCs stand".

## Decision

- Enemies come from **enemy camps**: a place where a squad keeps watch, a guard and a patrol. The name says that
  enemies are there; "outpost" or "spawner" do not.
- The places are chosen, listed with the game mode, not found over the map. One for now: the inner courtyard of the
  Veste Oberhaus. The debug request stays as a tool.
- A camp is manned only when a player comes near, never with a player close enough to watch it appear, and its NPCs
  are taken away once all players are far (their number kept). The squad's size is set when it is manned, by the
  players near: two alone, up to four for four.
- A squad cut down stays so; the camp is at full strength again a while (10 min) after its first loss, out of sight.
- An NPC no longer fights alone: hit, it goes for the shooter however far; it hears a player's shots and blasts and
  goes to look; one that notices a player alarms its squad. A leash keeps each within reach of its post.
- Squad sizes, radii, refill and each NPC's numbers (sight, reaction, spread, burst, leash, hearing) are tuning with
  defaults, the host's own: not sent to pages.
- The sandbox has its camps on; tools that measure the host's tick or bytes start without them.

## Why

- The owner wants fights at places that mean something (the fortress over the town), not enemies everywhere, and
  wants to adjust the numbers often.
- Shooting an NPC from beyond its sight without an answer, and a neighbour standing idle, made fights dull.
- Manning only near players keeps a camp stood down at no cost: no body, no tick, no byte.

## Consequences

- A player who appears inside a camp finds it empty until they have gone away.
- Wounds are forgotten when a camp stands down.
- Cover and flanking come later; a squad still has no plan beyond "go and look".
