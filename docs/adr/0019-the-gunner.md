# 0019 A gun on a seat: the gunner

Status: accepted (2026-11-27). The first seat tool; builds on [ADR 0008](0008-server-vision.md),
[ADR 0015](0015-health-and-damage.md) and [ADR 0018](0018-npc-enemies.md).

## Decision

- A gunner is a passenger whose seat carries a mount in its vehicle's data: the weapon, the point a shot leaves from
  in the vehicle's frame, the swing either side of a middle off the bow, the pitch's limits. There is no gunner
  role: the role decides whose steady input a seat takes, and a gunner sends single shots as on foot.
- The host knows the mount, so the seats' data lives with the simulation and the page reads the same: the gunner's
  figure, camera and the host's shot share one point.
- A shot goes the way every shot goes, from the mount where the host has the vehicle now. The page sends the point
  under its crosshair, not only a direction; the host aims from its mount at that point and keeps the shot within
  the swing (clamped, not refused). It hurts whatever a player's shot hurts; it never meets its own vehicle.
- The first and only mount: the speedboat's seat beside the wheel, the MG unchanged (no recoil, no ammunition),
  swinging over the bow and both beams, not astern. Today's helicopter stays unarmed; an armed one would be a new
  craft.
- One key switches seats within the own vehicle where it has a gun: the wheel to the gun and back. A boat with no
  one at the wheel drifts as it always did.

## Why

- The gunner sees the vehicle a ping late. At 15 m/s and ~150 ms that is over two metres: with a direction alone a
  standing player 60 m off the bow, 40 degrees to the side, was missed by every shot; with the aim point every shot
  landed. The page's point is no more trusted than a direction: walls between still stop the host's ray, and the
  swing bounds it.
- A switch of seats lets one player alone try the gun, and lets a passenger take the wheel in a fight.

## Consequences

- A moving target is led by the gunner; there is no lag compensation.
- A second kind of seat tool will turn the mount into one of several kinds, then and not before.
- The seat switch has a key only; touch has no button for it yet.
