# 0024 The military helicopter: a co-op craft with two door guns

Status: accepted (2026-11-27). Builds on [ADR 0015](0015-health-and-damage.md), [ADR 0019](0019-the-gunner.md) and
[ADR 0021](0021-the-combat-plane.md).

## Decision

- A craft type of its own on the helicopter's flight law, with its own numbers and a bigger cell (a medium twin, a
  15 m rotor): heavier, slower to gather speed and to turn, tougher, a little longer on its tank. Its size is its own
  in every table that knew one size per helicopter.
- Four seats: the pilot; two gunners, one in each open door, each with an MG covering its own side wide and steeply
  down (about 60 degrees either way off the beam, from 70 degrees down to 10 up), never the nose, the tail or the
  other side; one plain seat. The first aboard take the guns.
- No gun for the pilot and no hover hold when the pilot leaves the controls: the pilot flies for the gunners. Left
  alone, it lets itself down as the light one does.
- The seat switch goes to the next free seat in the seats' order (the controls, each gun, the plain seat, round
  again), the same for the speedboat, where that is still the wheel and the gun.
- The mount stays level: it turns with the heading only, on the host and on the page alike. The drawn tilt of the
  hull moves the drawn gun by a few decimetres at full tilt; shot and camera agree with each other.
- The light helicopter becomes a two-seater: the pilot and one passenger.
- For now only from the menu's sandbox, where every vehicle is spawned; no stands.

## Why

- A door gun looks sideways, so a target is circled or passed alongside, and the pilot decides which side gets it:
  that is the play this craft has and the combat plane has not.
- Without a hover hold, one player alone cannot fly and fire; that keeps it a craft for several players, and the
  combat plane remains the craft for one.
- One switch key cycling the seats serves any number of guns without new keys.
- A level mount needs nothing new on the wire and keeps the shot and the gunner's view in one point.
- Sandbox only: standing everywhere, nobody would take the unarmed one.

## Consequences

- From a hover the gunner on the target's side lands most shots, over a ~150 ms link as well; the other cannot.
- Every craft table gains an entry, and the protocol changes with the type.
- Later: a place on the map, NPC door gunners, the numbers tried in play.
