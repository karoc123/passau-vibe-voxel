# 0009 Layers and owners

Status: accepted (owner, 2026-11-24). Enforced by `web/tools/core-deps.mjs` (`LAYERS`, `ALLOWED`, `BASELINE`) and
`web/tools/host-smoke.mjs`. Builds on [ADR 0006](0006-world-sim-seam.md) and [ADR 0008](0008-server-vision.md).

## Context

ADR 0008 asks for a server with thin clients. Keeping three.js and the DOM out of the sim was not enough: the client
drove the world's clock and focus, connection state sat in the world sim, and the page drew the sim's own objects.
The structure below makes the server path the one every transport uses and keeps it that way mechanically.

## Decision

Layers, innermost first. A module imports its own layer and the layers above it in this table, nothing else.

| Layer | Folder | Holds |
|---|---|---|
| data | `core/` | voxel columns, tile format and cache, edits, world queries, `Meta`, the data build's contract |
| contract | `sim/contract/` | what crosses between host and client: ids, commands, events, snapshot, results, hello; types and constants only, all plain data that survives `structuredClone` |
| shared | `sim/craft/`, `sim/path.ts`, `sim/road-net.ts`, `sim/coaches.ts`, `sim/vehicles.ts`, `sim/river.ts`, `sim/tuning.ts`, `sim/hello.ts`, … | code both sides run (a mirror re-runs it; prediction will) |
| domain | the rest of `sim/`, `physics/` | the world and its rules |
| server | `sim/server/`, `host/` | sessions, snapshots per session, the one host `hostSim` and its platform entries; `host/` is the only place that reads a clock, a file or a URL |
| client | `client/` | `SimClient`, the mirror, the links; never imports domain or server |
| presentation | `view/`, `nav/`, `ui/`, the root's render modules | three.js, DOM, input; never imports domain or server |
| app | `main.ts`, `app/` | composition, frame order, debug hooks; the only place that builds server and client together |

Rules (`core-deps`): R1 the layer table; R2 no value-import cycle; R3 no `Math.random`, `Date`, timers in the
headless layers (time is the tick, randomness the seed); R4 `window.__*` only in `app/debug-hooks.ts`; R5 the contract
declares no class or function body. Today's violations are a baseline that may only shrink.

One owner per piece of state:

- **World state** (entities, seats, kept edits, world time, tick): the domain, changed only by commands applied in a
  tick. Edits are commands too.
- **Connection state** (player id, read cursors, acks): a `Session` of `SimServer`; the session stamps its player on
  every command, so a client cannot name another.
- **Drawn state** (interpolated poses, fades, picks): client and presentation, keyed by entity id, never a field on a
  domain object.
- **View state** (camera, graphics settings, weather look): presentation and app.

Every client checks the host's hello (protocol, data build, tuning hash) before it sends or draws anything.

Owner answers that stand: the host owns the time of day, the same for everyone; the page draws from snapshots in
every mode (in its own thread over a `ThreadLink`; a body's pose crosses as quaternions); edits cross as columns, not ops, so the client needs no
determinism; the gates stay local (`.github/` is not touched).

## Consequences

- A network transport is a new `SimLink` and a new `host/` entry; nothing below them changes.
- Moving a file between layers means updating `LAYERS` in `core-deps.mjs`; a new violation fails the fast set.
