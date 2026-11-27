# 0028 Incoming fire: the page reads where it is shot from

Status: accepted (2026-11-27). Builds on [ADR 0015](0015-health-and-damage.md), [ADR 0018](0018-npc-enemies.md),
[ADR 0023](0023-the-lookout.md) and [ADR 0027](0027-the-enemy-plane.md).

## Decision

- A player fired on is shown from where: an arc on a ring round the screen's middle towards the shooter, measured
  against the way the view looks (not the way the body or the vehicle points), turning with the view and fading in
  a few seconds. A hit is a thick red arc; a shot passing close is a thin pale one, gone sooner.
- The page reads this from the shot and blast events it is sent anyway, which name the muzzle and what was hit: a
  hit is a shot stopped in the player's avatar or in the vehicle they sit in, at any seat. Nothing new crosses.
- One reading serves every shooter: an NPC on foot, a lookout, an enemy plane, another player. A shot counts as a
  near miss only some way down its path, so a friend firing from beside the player is not shown.
- Tracers and muzzle flashes are never drawn thinner than a few pixels however far, and another's tracer is a long
  streak: a burst from afar can be followed back to its gun.
- No sound yet: the game has none, and one cue alone would need its own volume and mute.

## Why

- The owner could not tell where they were shot from; health dropping says only that.
- The host's events already hold the answer, so the host's cost and the bytes stay as they were, and what the page
  shows cannot differ from what the host fired.
- An arc against the view's heading reads the same on foot, at a wheel, in a cockpit and in a chase view.

## Consequences

- Harm without a shooter (a crash, a fall) shows no arc, only the tint.
- A blast shows where it burst, not who threw it.
- A shooter straight above or below has no clear side: the arc says only its side on the map.
