# F4 Shared road physics

The local driver submits entity claims, input, reset and release to the world by player ID. Claims are resolved in command order before traffic moves. The driving panel reads the result and the latest tick's driver snapshot. Crash recovery follows the simulation clock.

LifePhysics owns the Rapier world, terrain cache and budget. A claim reuses a traffic chassis when the selected vehicle type matches. Unbuilt terrain holds a car until collision chunks are ready. Street traffic outside the edit radius keeps its path controller, with kinematic colliders near drivers. A hard hit can promote a path car to a wreck in the same world. Released cars brake and settle on following ticks.

Keep the existing car, vehicle and edit gates. Add a headless replay for conflicting driver claims and a collision with an already physical AI car. Measure costs on the real map with `tools/life-phys.mjs`, with and without a driver.

## Real-map measurements

At map coordinates (6500, 2600), the benchmark tagged an 8 m edit at 17:00 with seed 7. It sampled 10 s after the 20 s traffic warm-up using `node tools/life-phys.mjs --run 10 60`. The driver run used `--driver` to take the nearest car and apply straight-line input up to 30 km/h.

| Run | Bodies avg / max | Physics tick avg / p99, ms | Rapier steps avg, ms | Colliders avg, ms | Chunks built |
| --- | ---: | ---: | ---: | ---: | ---: |
| Prior edit-only world | 1.27 / 3 | 1.03 / 12.54 | 0.23 | 0.22 | 55 |
| Shared world, edit only | 1.27 / 3 | 0.96 / 7.54 | 0.21 | 0.22 | 55 |
| Shared world, edit and driver | 4.30 / 7 | 1.75 / 9.58 | 0.28 | 0.25 | 67 |

The collider budget is three chunks per world tick. The headless replay adds one scenario to the car gate (43 total). It checks command order, contact with an existing AI body, release while a second player drives, and identical snapshots on repeat.
