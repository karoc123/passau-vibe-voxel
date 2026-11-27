# Glossary

The words the owner and the code use for the same thing. One name per thing; use these in code, docs and talk.

## Modes of the player

- **Orbit mode**: the map view the page starts in; the city dragged, turned and zoomed from above, a double-click
  flies there. The player has no body in it and is seen by nobody (owner 2026-11-27). Not "free camera".
- **Walk**: on foot, first person (walker, avatar). Swims in deep water.
- **Ride**: following a person or a car, or driving a car (the car driven is a craft on the ride's camera).
- **Craft**: a vehicle that owns the camera and the input: drone, boat, hovercraft, helicopter, floatplane, jet,
  paraglider.
- **Passenger**: riding along in a car or craft another player drives or flies; steers nothing.
- **Menu**: what Esc (or ☰) opens in every mode: Resume, Settings, Graphics, Time & weather, Back to orbit mode, Full screen, Start menu.
  Not "pause menu": the world goes on.
- **Start menu**: where a page begins: alone (the host in its worker) or on a server.

## World and multiplayer

- **Host**: the one place the world is simulated (in a browser's worker alone, or `serve` for several players).
- **Page**: the browser side of a player: draws and takes input; its walk is its own, the rest the host's.
- **Session**: one player's connection to a host.
- **Player name**: the name a player chose for the others (optional; else their id, p1, p2, ...); the host cleans it.
- **Ping**: the page's round trip to a host on the network, ms.
- **Prediction**: the page running its player's own craft or car ahead from its input, corrected to each snapshot (the
  correction blended out, a big one shown at once). Not "client-side physics".
- **Tick**: one step of the host's simulation (30 a second); the budget is its 33 ms.
- **Snapshot**: what a host sends a session each tick about what lies near that player.
- **Presence**: a place the host keeps living (street life, traffic) because a player is there.
- **Overload**: the host over its tick; it gives way in a fixed order (people, cars, send rate).
- **PROTOCOL**: the number page and host must share; bumped when the wire or the shared code changes.

## Map data

- **Node**: one file of tiles (an octree node) the page and the host stream in.
- **Region**: a block of the map the pipeline builds at once.
- **Stretch**: a piece of river with one water level, between weirs (map config).
- **Gate**: an automated check guarding what a player would notice (`web/tools/gates.mjs`).
- **Cap**: a 1 m column's top drawn as a sloped quad (four corner heights) instead of its voxel's flat top: what
  wheels and feet stand on.
- **Rule roof**: a small simple house's roof made by rule (gable, hip or flat, even steps) instead of the survey's.
  Its counterpart, a **tidied roof**: the survey's (LoD2's) roof with dormers, spikes and near levels taken out.
  A **landmark** keeps its roof as surveyed: churches, castles and their grounds, towers, buildings with OSM parts
  or a curated override.
