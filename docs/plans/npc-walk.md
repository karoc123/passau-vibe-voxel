# The walk on the host, with way finding (building block 3)

Owner 2026-11-27: NPCs on foot move by the players' rules and find their way on any map, craters counted at once.

## What moves

- The walk's rules (stride, steps up kerbs and stairs, headroom, walls, the eyes kept off a wall, falling, swimming,
  standing on and riding solid things) leave the page's code and become shared: the page and the host run the same
  body. The page's walk keeps the camera, the keys and the stick and hands the body a stride.
- The player's walk must not change: a run recorded from the old code before the move (kerb, stairs, ledge, door,
  diagonal wall, cars, a roof ridden, water, falls) is replayed after it, bit for bit.

## Way finding

- A walkable grid, one cell per metre, made by the host round an NPC when it needs a way: a square window over start
  and goal, filled outward from the NPC's cell by the walk's own rules (the floor one step up at most, headroom over
  it, the body clear), so a bridge and the street under it are not mixed up. Read from the voxels the host holds; no
  data from the pipeline.
- A* over the cells (eight ways, no corner cut, a step up costing a little more); the way is the cells' middles,
  shortened where a straight line over the grid stays walkable.
- An edit (a crater) that touches a window marks it stale: the NPC finds its way again at its next tick. An NPC making
  no headway for a while finds its way again too.

## The test NPC

- The host holds NPC bodies (the shared body, stepped every tick at 30 Hz among the solid things it has) with a goal;
  the voxels round them are kept loaded as round a player on foot.
- Seen as an avatar (a person drawn as another player on foot is): no new wire, no new drawing.
- Made by the host's own calls only (the gate); a mode or a debug request later. Health: an NPC is a life later; its
  avatar id is already an entity's.

## Gate (`npc-walk`)

On a synthetic world through the host: a way found round a building and through a gap in a wall, up a step onto a
terrace; never into a wall; a crater blown into the way is walked round after a new search; another player sees it
walk. Printed: the walk's cost per NPC tick, the grid and A* per search, the bytes per second an NPC adds.

## Left after this

NPCs on foot with behaviour (patrol, attack, sight), boarding vehicles, health for NPCs, a request to place one.
