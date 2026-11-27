# 0017 The walk on the host, ways found on a walkable grid

Status: accepted (2026-11-27). The third game building block; builds on [ADR 0010](0010-walker-and-solid-things.md)
and [ADR 0013](0013-swimming.md).

## Decision

- The walk's rules and the body on foot (strides, steps up kerbs and stairs, headroom, walls, falling, swimming,
  standing on and riding solid things) are one piece of shared code. A player's page runs it for its own walker, as
  before; the host runs it for its NPCs. Players and NPCs move by the same rules.
- The player's walk stays the page's (ADR 0010): sharing the code changed none of its results.
- An NPC finds its way on a walkable grid, a metre a cell, that the host reads from the voxels it holds round the
  NPC, cell by cell as the search reaches them, by the walk's own rules: at most a step up, a few metres down,
  headroom over the floor. A* on it, then the walk follows the way's turning points.
- An edit that touches a grid makes it stale: the NPC finds its way again at its next tick. So does an NPC that
  makes no headway. A few searches a tick at most; the others wait a tick.
- An NPC is seen as an avatar, as another player on foot is: nothing new on the wire or on the page.

## Why

- One walk means an NPC cannot do what a player cannot (pass a wall, climb a quay), and a fix to the walk fixes both.
- A grid read from the voxels works on any map and sees a crater at once; navigation data from the pipeline would
  need a rebuild for every map and know nothing of the edits.
- Reading cells only as the search reaches them costs a fraction of filling the whole window: a way round a block is
  a few thousand cells.

## Consequences

- A cell takes the level the search comes to it on: under a bridge, a way finds the street or the deck, not both.
- The grid's step rule is the walk's on land; out of water it is stricter than the walk (a bank a swimmer could
  climb may be missed).
- NPCs are not yet lives (no health), have no behaviour and are made only by the host's own calls.
