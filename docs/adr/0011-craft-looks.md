# 0011 A craft's look is a package

Status: proposed (2026-11-26). Builds on [ADR 0009](0009-layers-and-owners.md), alongside the weapon packages.

## Context

The crafts' models lived in shared files, and what moves on them (the helicopter's rotors) was animated by the code
that draws a craft: once by the shell of the craft the player flies, once by the drawing of everyone else's. Making
the hovercraft's fans turn meant changing both, and both knew which craft has a rotor.

## Decision

- Each craft type's look is a package of its own: its model and a per-frame draw that places it and animates it from
  the craft's state (its pilot, its core's drawn pose, throttle, turn rate). One registry lists the packages, one line
  each; nothing else imports a package.
- The same draw runs for the craft the local player flies, another player's and one left in the world. The shells
  keep the camera, the input and the panel; the drawing of the others knows no craft by name.
- What a look animates from must be on the wire: a moving part driven by the pilot's input reads an eased value the
  core keeps (the hovercraft's throttle), since other pages never see the input.
- Sizes stay with the sim: the solid shape table is the one source a craft's walker collision, boarding reach and
  shot box are taken from; the collision probes follow the model's measures.

## Consequences

- A new moving part, or a new look, changes one folder; a new craft type adds a folder and a registry line.
- The layer check fails an import of a package from outside it or the registry.
