# 0025 Bail out with the get-out key, and the mouse in every vehicle

Status: accepted (2026-11-27, the owner's; the pilot's fixed view and the fall beside 2026-11-28, the owner's).

## Decision

- Getting out of an aircraft high in the air (the same height a falling body may open a canopy at) puts the player
  under an open paraglider, from every seat of every aircraft a player sits in. The empty aircraft flies on without
  a pilot. The plane's own key and button for a paraglider are gone.
- Where no paraglider opens (too low, a wall or roof in its way, a vehicle that is no aircraft) the player leaves a
  vehicle in the air just outside it, at its height, and falls from there with its speed (amended 2026-11-28, the
  owner's). Only a vehicle standing on the ground or the water is stepped out of onto the ground beside it.
- The get-out key is the paraglider's only key (amended 2026-11-28, the owner's): in the air on foot at that height
  it opens one, under one it folds it away into a fall. The paraglider's own key and touch button are gone; the
  get-out button says what it does. A paraglider opens one way, whatever it opens out of.
- Every vehicle a player sits in takes the mouse, as walking does. Where it aims nothing, it swings the chase or seat
  view as a drag does; a driver's view swings back behind after a moment. Touch and gamepad stay as they were.
- The pilot of an aircraft is the exception: the mouse is taken (a gun fires by its button) but does not turn the
  view, which stays behind the aircraft. Passengers and gunners in it look and aim as anywhere. One rule says which
  seats the mouse turns the view from, and a gate takes every aircraft type.
- Each aircraft type states whether it is in the air, and each vehicle whether it takes the mouse: a new type is
  refused by the compiler until it says.
- A helicopter set down on a vessel's deck stands on it and is carried along, as a walker on a roof; the vessel goes
  on. The other crafts meet a deck as a wall.

## Why

- One key that always gets out is easier than a second key that only works in some aircraft; the height rule is
  the one already known from falling. Set down on the ground under the aircraft, the player was moved somewhere they
  had not been: leaving a vehicle means being outside it, nothing more. Two keys for one paraglider were mixed up, and a long jump could not open one.
- The controls a pilot sent last are for the seat they sat in: taken by the next craft, a plane's left the paraglider
  out of it hanging still in the air.
- A vehicle that leaves the mouse free read as broken, and a turned view is the use a mouse has where there is no gun.
- A view swung round an aircraft that banks and pitches read as strange, and the pilot steers by the view behind.

## Consequences

- A player who only wanted out of a hovering helicopter high up gets a paraglider instead.
- The page's run ahead sets its helicopter down on a deck but does not carry it; the host's snapshots correct it.
