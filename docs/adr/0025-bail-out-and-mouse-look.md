# 0025 Bail out with the get-out key, and the mouse in every vehicle

Status: accepted (2026-11-27, the owner's).

## Decision

- Getting out of an aircraft high in the air (the same height a falling body may open a canopy at) puts the player
  under an open paraglider, from every seat of every aircraft a player sits in. Lower, they get out onto foot as from
  any vehicle. The empty aircraft flies on without a pilot. The plane's own key and button for a paraglider are gone.
- Every vehicle a player sits in takes the mouse, as walking does. Where it aims nothing, it swings the chase or seat
  view as a drag does; a pilot's view swings back behind after a moment. Touch and gamepad stay as they were.
- Each aircraft type states whether it is in the air, and each vehicle whether it takes the mouse: a new type is
  refused by the compiler until it says.
- A helicopter set down on a vessel's deck stands on it and is carried along, as a walker on a roof; the vessel goes
  on. The other crafts meet a deck as a wall.

## Why

- One key that always gets out is easier than a second key that only works in some aircraft; the height rule is
  the one already known from falling.
- A vehicle that leaves the mouse free read as broken, and a turned view is the use a mouse has where there is no gun.

## Consequences

- A player who only wanted out of a hovering helicopter high up gets a paraglider instead.
- The page's run ahead sets its helicopter down on a deck but does not carry it; the host's snapshots correct it.
