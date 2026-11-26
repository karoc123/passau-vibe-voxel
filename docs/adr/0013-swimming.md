# 0013 Swimming on foot

Status: accepted (2026-11-26). Builds on [ADR 0010](0010-walker-and-solid-things.md).

## Context

The walker stood on the water's top: every voxel was a floor. The owner asked for swimming, or drowning if swimming
were too hard. The data knows no river bed: each water body is one flat voxel over the soil, so read as it is every
river is ankle deep.

## Decision

- Swim, not drown. The walk treats water as no floor and makes a bed up: shelving from a bank low enough to climb out
  onto, deep at once along a higher one (a quay's wall), so a fountain is waded and a river swum a step from its bank.
  Deeper than about 1.2 m the walker floats, the eyes just over the water, slower than walking, without running or
  jumping; shallower it wades on the bed, slower the deeper.
- Out of the water the walker climbs a bank or a step up to about a metre over the water, no higher. On land the
  terrain's top stays climbable however high, as before.
- A fall into the water ends afloat: it is braked within a few metres, never lands on the top, and comes back up.
- The swim is the page's, like the walk: the pose says it swims and others draw a swimmer. The host's walk bounds
  already hold a swimmer's moves.

## Why a made-up bed

A real bed would need sonar data or a model of the river's cross-section the build does not have. The bed only has
to make wading near a beach and swimming in a river feel right; nothing else reads it.

## Consequences

- Most of the banks in the data are within a metre of the water, so in the rivers a way out is near. A stretch
  walled by quays higher than that has no way out until the walker swims to a low spot.
