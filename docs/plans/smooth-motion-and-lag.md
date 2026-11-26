# Smooth motion and lag: render clock and input commands

The rest of the plan (frame order, one tick loop, crafts interpolated) landed; its research is in `git log` of this
file. M4 (render clock and snapshot buffer) landed with target step 1; M5 is left. Owner questions on tick rate and car
prediction are in `FRAGEN.md`.

## Clocks

| Clock | Is | Advances by |
|---|---|---|
| sim tick | `n`, at `n · STEP` (STEP = 1/30 s); the server's is the truth | whole ticks |
| render time, remote | estimated server time − interpolation delay, in ticks with a fraction | `dt`, slewed ±2 % towards the estimate; never by a snapshot's arrival |
| predicted tick (own seat) | server tick + round trip / 2 + input buffer | `dt`, slewed by the server's hint |

A frame fixes these once and every reader gets the same values. In solo play (worker on the same machine) the delay
is small but not zero; the code path is the same as over a network.

## M5. Input commands: tick, ack, buffer

- **Why:** over a link, a lost or late input must not stall or skip the player's vehicle.
- **Do:** the client resends its last K unacked commands; the server buffers each player's commands by tick and
  repeats the last on a gap; the snapshot carries the ack and a buffer hint; the client's predicted clock slews by it.
  No prediction yet: the own vehicle is still drawn from snapshots.
- **Done when:** over the lag wrapper with 2 % loss and ±20 ms, no tick without the player's input after warm-up, and
  the buffer stays within 1–3 ticks.

Transport: WebSocket first (owner, 2026-11-26). Snapshots self-contained and inputs redundant from the start, so
datagrams (WebTransport) are a transport swap later, not a redesign.
