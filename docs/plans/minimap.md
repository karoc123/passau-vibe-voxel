# F10 Minimap

- **Controls** — `M` follows the game keyboard guard. The Map button is also reachable by touch in every navigation mode. The optional overlay leaves the scene's pointer controls active.
- **Map data** — Draw a north-up view from the surveyed river samples, the main roads in the unpacked traffic graph, and the existing landmark categories. Build the background once when needed, crop it around the current position, and draw the heading and nearby landmark symbols over it at screen size. No map data rebuild is needed.
- **Position** — The minimap takes a plain world position and heading. Nav supplies the walking or craft state and the traffic pose for a followed or driven vehicle. In orbit mode it uses the camera's ground focus and horizontal bearing. A future world snapshot can provide the same pose without changing the overlay.
- **Verification** — Check the keyboard and touch toggles, river and road alignment at Dreiflüsseeck, the marker after movement, and the panel alongside the navigation controls on desktop and mobile.

## Follow-up map features

- Click the map to set a waypoint.
- Open a full-screen map.
- Show other players and the currently selected search result.
