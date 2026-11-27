# 0027 The enemy plane: an NPC pilot in the combat plane

Status: accepted (2026-11-27). Builds on [ADR 0021](0021-the-combat-plane.md), [ADR 0022](0022-enemy-camps.md) and
[ADR 0023](0023-the-lookout.md). Kept small on purpose: the owner expects it to change.

## Decision

- An enemy camp may have planes, a number in the tuning: the Oberhaus has one, however many players come. Its
  alarm calls one a few seconds later; shot down, the next comes only with the camp's refill.
- The plane appears already flying, out of every player's sight (past the radius in which crafts are sent), and is
  taken away only out of sight again. Boarding a moored plane comes later.
- Its pilot flies it with a player's input and trigger: the gun is the nose's, so it hits only where it flies the
  nose. It passes at one player at a time (on foot or in any vehicle, the paraglider too) within its leash round
  the camp: out, turn in, a shallow dive with a few seconds of fire, pull out, climb away; a pause before the next.
- The ground goes first: it looks ahead along its path and climbs before anything else, and it begins no pass
  without a way to climb out past the target.
- Its pilot holds the seat (no player can take it) but is no player: presence, a camp waking, what is sent and to
  whom count only players.
- The pilot dies with the plane: shot down (as any combat plane) or crashed, its controls are let go for good and
  the wreck stays down. Bailing out on a paraglider later is left open.
- A debug request calls one to wherever the player is.

## Why

- Flying through the same input and the same gun keeps it fair: what a player can dodge is what a player can do.
- The pause between passes is the player's chance to take cover or shoot back; a plane always overhead is not.
- A plane appearing out of sight and never popping away keeps the world honest.

## Consequences

- A plane's crash would otherwise put it back at a safe point; a pilotless crashed plane stays down instead.
- It flies its passes at the target's height, so a target on a slope near a hill may get fewer passes.
- It has no lead: a fast target is mostly missed, which is the point for now.
