# Vehicle types and the motorbike

The player drives more than the one car: a catalog of vehicle types as data, shared by the player's car, the street
traffic and (later) a server; among them a motorbike. Arcade, not a simulator.

Status: built (branch `vehicles`).

## The catalog

`web/src/sim/vehicles.ts`: no three.js, no DOM, no Rapier (the world sim imports it: `tools/core-deps.mjs` scans it).
A type is its body on Rapier's raycast wheels (`CarBuild`: chassis half extents, mass, wheels, engine force per driven
wheel, brakes, top speed, ride height, and `tune`: what differs from the car's ride, `vehicle.ts` RIDE, and its
steering), its length in the traffic, an optional own paint, and its model: boxes `[w, h, l, x, y, z, colour]` (bottom
centre in the vehicle's frame: x left, y up from the ground, z forward), the colour `paint` (the vehicle's, per
instance), `head` / `tail` (lamps: lit at night, the tail brighter braking) or a name of the catalog's `PALETTE`.

| type | mass | top (measured) | 0-50 km/h | chassis (m) | character |
|---|---|---|---|---|---|
| car | 1200 kg | 79 (82) km/h | 3.2 s | 1.8 x 0.9 x 4.2 | the traffic's car, as always (tools/rapier-car.mjs's numbers: unchanged) |
| coupé | 1250 kg | 180 (182) km/h | 1.9 s | 1.84 x 0.72 x 4.4 | low, stiff, grippy (2.0 / 1.95), more downforce |
| van | 2400 kg | 94 (95) km/h | 4.9 s | 2.0 x 1.8 x 5.1 | heavy, soft springs (24), less grip, less lock |
| pickup | 1900 kg | 108 (111) km/h | 3.5 s | 1.9 x 1.1 x 5.2 | between the two, a load bed |
| bus | 11000 kg | 61 (64) km/h | 5.5 s | 2.5 x 1.9 x 11.8 | the traffic's bus |
| motorbike | 260 kg | 140 (141) km/h | 1.9 s | 0.64 x 1.0 x 2.0 | nimble (wheelbase 1.44 m), leans |

`vehicleOf(car)` gives a traffic or player car's type (`Car.vt`, else bus or car), `buildOf(car)` what drives it.

**Drawn** (`sim/meshes.ts`): each type's model as four instanced meshes (paint, fixed colours, head and tail lamps:
the car's own set as before, the same geometry), `sim/life.ts` drawCars puts each car on its type's. The traffic's
buses are now drawn with the bus model (before: the car's boxes stretched).

**The traffic** draws some of its cars from the catalog (`trafficType(id)`: from the car's id, no random number drawn,
so the sim draws the same random numbers when spawning each vehicle): about 1 in 14 a coupé, 1 in 12 a van,
1 in 16 a pickup and 1 in 20 a motorbike. The motorbike uses its 2.2 m catalogue length and the same rider model
as the player's. The renderer leans the bike and rider together based on speed and lane curvature. The lean
fades when a Rapier body takes over near an edit. Its bodies (`life-phys.ts`) and the obstacles the player's car
meets (`drive-world.ts`) use the type's own dimensions and mass.

## Choosing and driving

**Vehicle: …** beside **Take the wheel** cycles the choice (also V while not driving; remembered in localStorage
`voxel.drive.vehicle`): *any* (the traffic vehicle taken as it is: a van stays a van, a bus a bus), or one of the
types, which the vehicle taken becomes (its type, length, a bus its yellow). Controls are the car's for every type:
keyboard (W/S, A/D, Space handbrake), the touch stick and handbrake button, the gamepad. New: **T** puts the vehicle
back on the road (where it last was on it, a little way back, standing: the river's respawn). **Park <type>** parks it.

## The motorbike

Approach: the simplest robust one, a narrow car. Physically four raycast wheels on a 0.6 m track (hidden; two drawn),
the centre of mass low (0.22 m over the ground), and `car.ts` `bike()`:

- **upright**: on its wheels, its roll rate pulled each step to what rights it (firmly: there is no balance to keep);
  in the air the car's air assist rights it.
- **lean**: drawn only, from its sideways acceleration, `atan(v x yaw rate / g)`, up to 0.7 rad, eased over 0.12 s;
  `drive-world.ts` drawn() adds it to the roll (about the wheels' line on the ground).
- **wheelie**: full throttle under 43 km/h lifts the front by up to 0.16 rad (drawn, about the rear wheel).
- **crash**: a crash landing, a wall or car hit losing 7 m/s or more at once, or on its side: the rider comes off
  (`drive-session.ts` fall: "Crash! You came off the bike", no input, the bike drawn falling on its side over
  FALL_MS 1.6 s), then back on the road as from the river.
- steering: less lock (0.42 rad) than the car but on a short wheelbase, halved at 9 m/s (the car: 14).

## Checks

`node tools/vehicles.mjs [type ...]` (30 checks): each type's top speed within its range from rest on a flat km, half
lock at 50 km/h (bus 30), a third of the lock at 80 % of its top speed (at most 120 km/h), up a 20 % street from rest;
the motorbike at rest 5 s, leaning both ways in the fast curve (the body upright), over a 0.3 m kerb square and at
30°, up a 1 m terrace (the wedge), and into a wall through the drive (falls off, held, drawn on its side, back on the
road). The default car keeps `tools/rapier-car.mjs` (42, output identical to before but for timings).

`tools/life-edit.mjs` measures a car's lowest edge (its model's box, by its roll) where it measured its drawn ground
point: a van fallen into the dug hole lies on its side, its ground point half its width up (the same for a car on its
wheels).

## How to add a type

1. An entry in `VEHICLES` (and its id in `VehicleId`): `build` (start from the nearest type; `tune` only what
   differs), `len`, `chase` (the camera's distance behind and above the vehicle, in metres at normal zoom), and
   `model` (boxes; the wheels at the build's wheel positions, their bottom on the ground; lamps).
2. A top-speed range in `tools/vehicles.mjs` TOP; run it.
3. Optionally in the traffic's mix: `trafficType`.

It shows up in the chooser by itself. Colours: the catalog's PALETTE (hex strings, not `scripts/palette.json`, which
is the voxels').

## Left out

- Getting into a particular vehicle from the street on foot. When taking the wheel with a type selected, the
  chooser turns the vehicle taken into the type.
- Per-type wheel radius (all 0.36 m).
- A rider thrown from the bike as a body: the bike and rider fall over together, drawn.
