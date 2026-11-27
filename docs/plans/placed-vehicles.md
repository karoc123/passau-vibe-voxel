# Placed vehicles (building block 2)

Vehicles stand in the world for anyone to take, placed by the host from the map data, so any map gets them. The
debug menu's spawning stays as a debug tool.

## Stands

A **stand** is a spot the host found for one class of vehicle. The host looks for them a block of the map at a time
(3 x 3 nodes), once, when a player first comes near the block, reading the nodes' voxels as the crafts do; nothing is
added to the pipeline.

- Helicopter: level, dry, open ground with **landing room** (a disc as wide as the rotor and a margin, its top the
  ground's, no tree or roof, no water). The room test is its own function for the later landing-zone block.
- Speedboat: open water off a bank, the hull fitting as the boat's own spawn test has it, along the bank; the boat
  timetable's landing stages first where the block has one.
- Hovercraft: landing room on the bank, facing the water.
- Floatplane: water with a long straight run and room either side, facing along it.
- Paraglider: high ground with a clear drop ahead (the ground falling away under a glide slope over 120 m).
- Cars: beside the slower roads (the traffic's road lines, off their outer lane), level ground, a type of the
  traffic's mix without buses.
- Not placed: the jet (no runway in the data), the drone (a pilot's tool).

At most one craft of a class and a few cars a block, the best spot by a score of each finder.

## Lifecycle

- A stand far from every player has no vehicle (not instantiated). Within the wake radius it is stocked; out past it
  again an untouched vehicle goes, so a city of 42 km² costs only what is near players.
- A stocked craft sleeps: not stepped, its collision let go, until it is touched (a seat taken, harm).
- Taken (any seat), moved off, harmed or wrecked: used. The vehicle is then an ordinary left one (kept while players
  are near, gone 120 s after the last leaves), and the stand refills after a refill time, once its spot is clear and
  no player is close by to see it appear.
- A placed paraglider waits on its launch spot; its pilot's seat taken launches it over the drop.
- Numbers in the tuning (host only), so the gate can shorten them.

## Wire

A craft at rest is sent once and then only when its state changes (the wire's craft delta, gone ids for crafts), so
standing vehicles cost no bandwidth; parked cars already go so. PROTOCOL 45.

## Speedboat

A passenger's seat beside the pilot (owner decision): drawn, ridden along in as in the helicopter.

## Gate

`stands`: on a synthetic world (flat field, river, cliff, a rough far end) a player on foot finds a helicopter,
speedboat, hovercraft, floatplane and paraglider near; boards the helicopter; it is left elsewhere and stays; the stand
refills; a player far off is sent none of them and they go once nobody is near; a second player rides along in the
speedboat. On the real data: cars and boats round the cathedral, a car taken.
