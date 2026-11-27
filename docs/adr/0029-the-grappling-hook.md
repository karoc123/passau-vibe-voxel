# 0028 The grappling hook

Status: accepted (2026-11-27, the owner's; the numbers and the button are expected to change in play).

## Decision

- A player on foot or under a paraglider fires a line at the voxel aimed at, up to 80 m off, and is reeled there
  fast. Nothing in range: no line. Vehicles and people are not hooked.
- On foot the right mouse button fires it with a tap; held, the button still aims as before. Under the paraglider,
  where the button did nothing, a press fires. A second tap at nothing or at the same point, or a jump, lets go.
- The pull runs where the motion already runs. On foot that is the page's walk: the body is reeled through the
  walk's own collision checks in short steps, and the host bounds the poses by the reel's speed while the pose names
  a hook point within range. Under the paraglider it is the craft's motion on the host, the hook point part of the
  pilot's input, so the page's run ahead reels the same way.
- On foot the reel ends by itself where the ground is near: the player lands standing. A point near a wall's top
  pulls them up onto it. High on a wall they hang until they let go or jump. Let go in flight, they keep part of the
  speed.
- The host counts no fall while a walker is on the line.
- Under the paraglider the wing turns to where it is pulled and is let go a few metres short; the glide then carries
  the speed and the climb on, so hooks can be chained for height.

## Why

- A pull applied anywhere else than in the motion would be corrected by it a moment later and jerk.
- Tap and hold on one button keeps the aim where players have it; the owner asked for the hook on that button.
- No fall on the line: reeling down from a roof is the hook's point, and a landing that kills would make it useless.
- Hanging instead of dropping: a hook high on a wall would otherwise end in a deadly fall every time.

## Consequences

- The aim starts a moment (under a fifth of a second) after the button goes down.
- A page that lies about a hook point moves faster than a run and takes no fall harm while it does; the host checks
  only the range, not that a voxel is there.
- Other players see the pull but not the line. Touch screens have no hook button yet.
