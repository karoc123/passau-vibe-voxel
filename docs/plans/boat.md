# Sport boat

A speedboat of the player's own on the Danube, the Inn and the Ilz: driven like the car, but on the water. Arcade,
not a simulator.

Status: built (branch `boat`). Not built: the river boats making way for it (see Left out).

## Using it

**Boat** in the toolbar's mode tools (beside Walk, FPV Acro, Take the wheel), from the map view. The boat is put in at
the river point nearest the map's focus (`flood.json`'s river points), on the nearest spot within 48 m where its hull
fits, facing downstream (along the river there, towards the Dreiflüsseeck; east beyond it). The camera glides down
behind it. **Exit boat** or **Esc**: back to the map.

| input | does |
|---|---|
| W / ↑ | throttle |
| S / ↓ | brake, then reverse (up to 18 km/h) |
| A / D, ← / → | steer (works better with way on; reversed going backwards, as the car) |
| Space (held) | drift: less grip across the hull, a tighter turn |
| T | unstick: back on open water, standing still |
| Wheel | chase camera nearer / further |
| Esc | exit |

**Touch**: the car's layout (`TouchSticks(canvas, { onPinch, camera: 'right' })`): one stick on the left (up throttle,
down reverse, sideways steer on the car's curve), a held **Drift** button where the car's handbrake sits
(`#boat-drift-button`, same style and safe-area rules), pinch on the right zooms.
**Gamepad** (standard mapping, as the car): left stick steer, RT throttle, LT brake / reverse, A drift.

## Design

- **Mode plumbing**: `Mode` has `'boat'`; `flying(mode)` (`fpv` or `boat`) is "a craft owns the camera and the input"
  (Nav leaves keys, pointer, wheel alone; the car's panel and the HUD hide); `nav.startCraft(mode)` replaces
  `startFpv()`. As `docs/plans/plane.md` phase 0, which adds `'plane'` the same way.
- **Motion** (`web/src/nav/boat-motion.ts`, `BoatMotion`): pure (no DOM, no three.js), fixed step 1/120 s. State:
  position, waterline, heading, velocity on the water, yaw rate. Thrust settles at **18.5 m/s (67 km/h)** (95 % in
  ~5.5 s), quadratic and linear drag, a little more coasting so it stops by itself; the yaw rate follows the wheel,
  scaled by speed (30 % at rest, full from 6 m/s, a bit less at top speed); the velocity stays where it pointed as
  the hull turns under it and the part across the hull decays (grip 2.6 /s, drifting 0.9 /s with 70 % of what is lost
  carried forward), which is the slide. Drawn only: nose up as it gathers way (most at the hump before planing) and
  with the acceleration, a lean into the turn, bobbing at rest. All numbers in `BOAT`.
- **Staying on the water**: the hull's outline (9 points, 6.4 x 2.3 m) must be on columns whose ground's top voxel
  is water (`VoxelCollision.waterColumn`, the rule of `physics/rapier/terrain.ts`), within 1.2 m of the boat's
  waterline (a weir's drop is a wall), with nothing solid from 0.5 m under the waterline to 2 m over it. So land,
  quay walls, bridge piers and footbridges lower than 2 m stop it, bridge decks above do not. A step that does not
  fit bounces off the shore's normal (from the open water round the points that met it; restitution 0.3, 80 % of the
  speed along it kept), swings the hull along the shore and slides on; wedged, it is eased out. A column not loaded
  holds the step (the drone's rule). The waterline follows the water's top; the drawn boat rides the river level
  slider's rise (`flood.level`) without changing what is water.
- **Mode** (`nav/boat.ts`, `BoatMode`): panel, input (keyboard, touch, gamepad, as `drive.ts`), the spawn, the chase
  camera (9.5 m behind, 3.4 m up, following the heading with a lag; pulled in where `VoxelCollision.sweep` meets
  something; field of view 60..68° with speed; a short shake on a bump), `window.__boat` for tools (`enter()`,
  `pose`). Lazily loaded beside the drone and the car in `main.ts`.
- **Model** (`nav/boat-model.ts`): ~30 boxes merged with vertex colours (white hull, red stripe, teak deck, seats,
  console, windscreen, outboard), the river boats' stepped bow; red / green / white nav lights brightened by
  `daylight.night` as the cars' lamps; a foam trail: flat additive quads laid every 0.6 m off the stern's corners,
  spreading and fading over 2.4 s (one instanced mesh; no new shader, no varyings).

## Checks

`node tools/boat.mjs` (~2 s, `nav/boat-checks.ts`): on a synthetic channel served as real node files: loading holds,
top speed and the time to it, coasting, the turn (direction, radius), drifting (more turn, more slip), turning at
rest, reverse, the bank and a pier bounced off (the outline never on land), sliding along the bank, under a 6 m bridge,
stopped by a 1 m footbridge, put in from land, none where there is no water, unstuck after running aground,
downstream. On the real data: put in near the Altstadt facing roughly east, a minute's lap there with the wheel
swinging (never off the water), east under the Schanzlbrücke untouched, north into the Danube's bank.

## Left out

The river boats (`sim/boats.ts`) do not collide with or avoid the player's boat (they run on the clock along fixed
paths; it passes through them). No damage, no fuel, no sound, no boat parked in the world to walk up to, no `?boat=`
URL parameter, no water landing for the plane.
