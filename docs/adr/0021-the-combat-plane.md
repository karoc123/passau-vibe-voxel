# 0021 The combat plane: a gun aimed by flying

Status: accepted (2026-11-27). Builds on [ADR 0015](0015-health-and-damage.md), [ADR 0019](0019-the-gunner.md) and
[ADR 0020](0020-fuel-tank.md).

## Decision

- A craft type of its own on the floatplane's flight, with its own numbers: floats (it starts from water and finds
  its stand where the floatplane does), faster and stiffer than the floatplane and slower than the jet, banking far
  enough to turn inside the Danube's and the Inn's valleys. Floatplane and jet stay unarmed.
- One seat, the pilot's, with a mount: the MG fixed ahead, its middle following the nose (heading and pitch), not the
  heading alone. Its swing is two degrees either way. The pilot fires as a gunner does: single shots beside the steady
  input, each with the point the page sees along the nose; the host aims from the mount where it has the plane.
- A mount follows the nose by a flag in its data, not by a second kind of mount.
- The gunsight is a dot where the nose points at the MG's range.
- Its own look, its own toughness and tank entry; its wreck the one every craft has.
- First step only: a plane for a player. No NPC pilot, no bombs, no rockets.

## Why

- An aircraft that hangs in the valleys keeps a target in the gun for about four seconds a pass; the jet gets two
  and cannot land on water.
- A gun fixed in the nose lets one player alone fly and fire; a gunner's seat would mean letting go of the stick.
- The swing absorbs the gap between the plane the page draws and the one the host has, without letting the pilot aim
  off the nose: with the nose ten degrees off, a run lands nothing.
- A new type rather than a switch on the floatplane: otherwise every parked floatplane would carry a gun.

## Consequences

- An attack run from about 300 m at a standing player lands most of its shots, over a ~150 ms link as well.
- Every craft table gains an entry, and the protocol changes with the type.
- Later: the NPC pilot (needs players in vehicles as targets and an NPC on a seat), dogfights, bombs (the projectile
  would need the vehicle's speed), a rear gunner as a second seat.
