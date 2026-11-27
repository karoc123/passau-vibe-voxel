# 0020 A fuel tank, and a vehicle's power in its own state

Status: accepted (2026-11-27). The fifth game building block; builds on [ADR 0015](0015-health-and-damage.md).

## Decision

- Every vehicle a player drives has a tank but the paraglider and the drone: the cars, the boat, the hovercraft,
  the helicopter, the floatplane and the jet. Each starts full, placed or spawned; there is no refuelling yet. A car
  keeps its tank when parked, so leaving and taking it again does not refill it.
- A full tank lasts a type's minutes under full load (helicopter 4, boat 6, hovercraft 7, jet 5, floatplane 8,
  car 10: starting points, to be tuned in play). Burn grows with throttle or load; a running engine at rest burns a
  tenth of that; nobody at the controls is the engine off.
- A vehicle's power is part of the state it already saves and loads: its fuel and a wreck's cut. Without power its
  pilot's input is replaced by an empty seat's (a helicopter sinks, a boat drifts, a plane glides) and a car's gas does
  nothing (it rolls out). An empty vehicle is not a wreck: not charred, its seat free, leaving works.
- Fuel crosses in whole steps of half a percent, only beside the state already sent; the part of a step is each
  side's own, so a page's copy run ahead runs dry within a moment of the host's.
- The HUD shows a plain gauge while driving or flying, read from the host's word. No low-fuel warning.

## Why

The page runs its own vehicle ahead; if it knew nothing of power it would predict thrust on a dead vehicle and be
pulled back a round trip later. Putting power into the saved state gives prediction and the wire one answer, the
wreck's cut included. Whole steps keep the bytes near nothing: fuel moves slowly.

## Consequences

- A long flight ends; a refuelling block comes later.
- The tuning a page shares with its host includes the tanks, so changing a tank's minutes refuses older pages.
