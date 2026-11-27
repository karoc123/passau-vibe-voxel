# 0014 Seat inputs by the page's tick

Status: accepted (2026-11-27). Builds on [ADR 0007](0007-player-control-in-world-sim.md) and
[ADR 0008](0008-server-vision.md).

## Context

A page sends its controls every frame. The host used to apply whatever had arrived at the start of its next tick, the
newest winning. A network that holds messages back and then delivers several at once made the host lose the inputs of
the ticks in between and hold the last one too long: a turn came out shorter or longer than the stick was held, and
the page's prediction, which had stepped each tick with its own input, was corrected all the time.

## Decision

- A driver's or pilot's input carries the page's own tick (the page's 30 Hz clock of its frames). The host holds it
  for its own tick that page tick falls on and applies each tick's input in that tick; a tick none arrived for keeps
  the last, several for one tick give the newest.
- The host sets the offset between the two clocks itself, from arrivals: the latest arrival raises it at once (that
  input and those after it on time), and a whole second of inputs arriving two ticks early or more shortens it by half
  of that. So the buffer is as long as the worst recent delay and a spike does not stay.
- An input for a page tick older than the one last applied is dropped.
- The ack names the input applied last and the host tick it was applied in; the page reads the offset from the newest
  ack, so its prediction lines each snapshot up with its own tick.
- A walker's pose is not held: it is where the page has the walker, not a control summed over time.

## Why on the host

The host sees when inputs arrive; the page would have to learn it from acks and could not tell an early input from a
late one. Holding on the host also serves the car, which is not predicted.

## Consequences

- A clean link costs up to a tick more before the host applies a control (a page at 60 frames sends two per tick and
  the second may come later). A link with jitter costs its worst recent delay, which the prediction hides for a craft
  but a driver feels.
- Each change of the offset repeats or folds one tick's input: a small correction on the page.
