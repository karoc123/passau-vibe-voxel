# Glossary

The words the owner and the code use for the same thing. One name per thing; use these in code, docs and talk.

## Modes of the player

- **Orbit mode**: the map view the page starts in; the city dragged, turned and zoomed from above, a double-click
  flies there. The player has no body in it and is seen by nobody (owner 2026-11-27). Not "free camera".
- **Walk**: on foot, first person (walker, avatar). Swims in deep water.
- **Figure**: the body on foot as drawn and as it meets the world (a player's avatar, an NPC, a **passer-by** of the
  street life, a **rider** on a bike or a motorbike, a craft's own pilot): three quarters of a grown-up, about 1.4 m,
  the eyes at about 1.28 m (owner 2026-11-27); it climbs a block's step all the same.
- **Ride**: following a person or a car, or driving a car (the car driven is a craft on the ride's camera).
- **Craft**: a vehicle that owns the camera and the input: drone, boat, hovercraft, helicopter, military helicopter,
  floatplane, jet, combat plane, paraglider.
- **Helicopter**: the light, unarmed one, a two-seater (pilot and one passenger).
- **Military helicopter**: a bigger helicopter with its own numbers and four seats: the pilot, a **door gun** each
  side (a gunner's seat), a bench without a gun. Its pilot flies for the gunners. `gunship` in code. Not "attack helicopter"
  or "armed helicopter".
- **Combat plane**: the craft on the floatplane's flight with its own numbers and an MG fixed in its nose; its pilot
  aims by flying. `fighter` in code. Not "warplane" or "armed floatplane".
- **Passenger**: riding along in a car or craft another player drives or flies; steers nothing.
- **Opened car**: a car drawn with someone in it: its windows see-through (**panes**), its cabin hollowed. Every other
  car keeps a solid cabin with dark glass in the same places.
- **Boarding**: getting into a vehicle from foot beside it; a car may be rolling, up to running speed.
- **Bail out**: getting out (X) of an aircraft high in the air, pilot or passenger: the player hangs under an open
  paraglider, the aircraft flies on empty. Low over the ground X gets out onto foot. Not "eject" or "deploy".
- **Grappling hook**: a line fired at a voxel in range that reels the player there, on foot or under the paraglider;
  **reel**: the pull; **hang**: held on the line high on a wall. Not "grapple" or "rope".
- **Mouse look**: in every vehicle the player sits in, the mouse is taken and swings the chase or seat view as a
  drag does (a pilot's swings back behind after a moment); at a gun it aims.
- **Menu**: what Esc (or ☰, top left) opens in every mode: Resume, Settings, Graphics, Time & weather, Help, Debug, Back to orbit mode, Full screen, Start menu.
  Not "pause menu": the world goes on.
- **Help**: the keys of the situation the player is in (the map, on foot, each vehicle, at a gun, riding along), or on
  a touch screen what the thumbs do. **Key strip**: its first keys at the bottom left of a desktop. Not "legend".
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
- **Mind**: an enemy NPC's state machine: **post**, **attack** (a player, on foot or in a vehicle, noticed by a clear
  sight line: fires, follows
  a little), **search** (walks to where it last saw them, looks round), **back** (to its post). Not "AI".
- **Mount**: a weapon fixed to a seat of a vehicle's type, in its data: the point a shot leaves from, its **swing**
  (how far either side of its middle off the bow it turns) and its pitch's limits; at a **stop** the crosshair greys.
  A **nose mount** turns with the vehicle's nose, pitch too (the combat plane's). Not "turret".
- **Gunner**: a passenger at a mount; no role of its own. Not "co-pilot".
- **Aim point**: the world point under a gunner's crosshair (a pilot's: along the nose) as their page sees it, sent
  with each shot; the host aims at it from the mount where it has the vehicle.
- **Gunsight**: the combat plane's dot, where its nose points at the MG's range.
- **Seat switch**: one key (or, on a touch screen, one button) to the next free seat of the own vehicle with a gun:
  the controls, each gun, the plain seats, round again.
- **Enemy camp** (code: camp): a chosen place where a **squad** of enemy NPCs keeps watch; **manned** when a player
  comes near (never in front of one), **stood down** once all are far, **cleared** when its squad is dead, **refilled** a
  while after its first loss. Not "outpost", "base" or "spawner".
- **Lookout**: an enemy NPC that guards a high place of a camp with numbers of its own (a long sight, a tight
  spread, no leash) and fires at players in vehicles as on foot; air defence's first step. Not "flak" or "sniper".
- **Enemy plane**: a combat plane flown by an NPC **pilot** with a player's input and trigger; a camp's alarm calls
  it, it appears and goes out of sight, makes **passes** at a player (turn in, a shallow dive with a few seconds of
  fire, pull out, climb away) with pauses between, and its pilot dies with it. Not "bot", "AI plane" or "bomber".
- **Leash**: how far an NPC follows or searches from its post. **Alarm**: an NPC that notices a player telling its
  squad.
- **Spread**: how far an NPC's aim strays from where it aims, more the further off.
- **Incoming fire**: a shot or blast that met the page's player (a **hit**: their body or the vehicle they sit in) or
  passed close (a **near miss**), read by their page from the host's events. **Arc**: its mark on a ring round the
  screen's middle, towards where it came from as the view looks. Not "damage indicator".
- **Dead**: an NPC at 0: lies where it fell, no target and no body to shots, taken away after a while. A player is
  down, never dead.
- **Walkable grid**: the host's cells, a metre each, round an NPC, each with the floor a walker stands on there (or
  none), read from the voxels as a search reaches them; **stale** once an edit touches it.
- **Way**: the points an NPC walks to in turn, found on a walkable grid. Not "path" (a road's or footpath's line).
