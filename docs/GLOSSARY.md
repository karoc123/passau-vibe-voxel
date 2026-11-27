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
- **Menu**: what Esc (or ☰) opens in every mode: Resume, Settings, Graphics, Time & weather, Debug, Back to orbit mode, Full screen, Start menu.
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
- **Rule building**: a building drawn by rule instead of as surveyed: its outline straightened to one or two
  rectangles, a **rule roof** of one type (flat, with a parapet on halls; shed, gable, hip, mansard) from its
  surveyed eaves to its ridge. Its counterpart, a **tidied roof**: the survey's (LoD2's) roof with dormers, spikes
  and near levels taken out (a building no two rectangles cover). A **landmark** keeps its outline and roof as
  surveyed: churches, castles and their grounds, towers, buildings with OSM parts or a curated override.

## Game building blocks

- **Life**: what has health: a player (wherever they are: on foot, at a wheel, along for the ride), a car, a craft,
  an NPC. Not "entity": a player's avatar is an entity, their health stays with the player.
- **Health**: a life's points, 0 to its type's max; the host's alone, pages are told.
- **Damage kind**: bullet, blast, crash, fall; each type takes each kind by a factor of its own.
- **Toughness**: a type's health as data: max, the factor per damage kind, the share passed to those in a vehicle
  (through), the speed a crash or a fall is taken at without harm (safe).
- **Down**: a player at 0: steers, walks and fires nothing until **back** (full health, on foot where they last
  stood on the ground).
- **Wreck**: a vehicle at 0: its driver's or pilot's controls dead, that seat refused; those in it are not harmed by
  that. A car wreck is charred. Not "destroyed".
- **Tank**: a vehicle's fuel, full at the start, burnt by load; **empty**: no power (not a wreck: not charred,
  its seat free). The paraglider and the drone have none. **Power**: what drives a vehicle; a wreck or an empty tank
  cuts it. **Gauge**: the HUD's fuel bar.
- **Placed vehicle**: a vehicle the host put in the world for anyone to take (not spawned from the debug menu).
- **Stand**: where a placed vehicle of one class stands, found by the host from the map's voxels and roads; **stocked**
  while a player is near, empty past that; **used** once its vehicle is taken, moved, harmed or wrecked (the vehicle
  then a left one like any other), **refilled** a while later out of sight.
- **Landing room**: level, dry, open ground round a point, wide enough to set a craft down on.
- **Asleep**: a placed craft not yet touched: not stepped, sent once.
- **NPC**: a body on foot the host runs (no player behind it), by the players' walk; drawn as an avatar. Not "bot".
  An enemy NPC keeps a **duty**: a **guard** stands at its **post** facing one way, a **patrol** walks its **loop**.
- **Mind**: an enemy NPC's state machine: **post**, **attack** (a player noticed by a clear sight line: fires, follows
  a little), **search** (walks to where it last saw them, looks round), **back** (to its post). Not "AI".
- **Mount**: a weapon fixed to a seat of a vehicle's type, in its data: the point a shot leaves from, its **swing**
  (how far either side of its middle off the bow it turns) and its pitch's limits; at a **stop** the crosshair greys.
  Not "turret".
- **Gunner**: a passenger at a mount; no role of its own. Not "co-pilot".
- **Aim point**: the world point under a gunner's crosshair as their page sees it, sent with each shot; the host aims
  at it from the mount where it has the vehicle.
- **Seat switch**: one key from the wheel of the own vehicle to its gun, or back.
- **Spread**: how far an NPC's aim strays from where it aims, more the further off.
- **Dead**: an NPC at 0: lies where it fell, no target and no body to shots, taken away after a while. A player is
  down, never dead.
- **Walkable grid**: the host's cells, a metre each, round an NPC, each with the floor a walker stands on there (or
  none), read from the voxels as a search reaches them; **stale** once an edit touches it.
- **Way**: the points an NPC walks to in turn, found on a walkable grid. Not "path" (a road's or footpath's line).
