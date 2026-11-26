# Build fixtures

Run `uv run python scripts/check.py verify --fixture scripts/fixtures/haissengasse.json`
from the repository root. Each fixture builds under `data/check/<fixture>/base/`. Its
`data/debug/report.json` contains human-readable notes and counters keyed by region.

[road-defects.json](road-defects.json) defines the local checks for the fixed road defects
and the nearby fixture features. Each box covers a half-open rectangle in project
coordinates, ordered `[x0, z0, x1, z1]`. Road and water heights use the map base.
Deck heights measure clearance above the water, `bridge` heights a deck's surface over land (map base). A `dry` box
must hold no water.

## Baseline results

The following general checks also failed on `main` at `6c4c941d`. Their thresholds
apply across the whole fixture, including areas outside the local defects.

| Fixture | Existing failure |
|---|---|
| `dietzing` | 11 of 50 LoD2-matched outlines moved (22.0%, minimum 40%; fixture added with Q8) |
| `gaissa` | 30 of 93 LoD2-matched outlines moved (32.3%, minimum 40%) |
| `haissengasse` | Footpaths sunk 2.09% and hovering 2.12% (maximum 1.50% each) |
| `holes` | Bridge deck 8092867 sags 2.1 m, tunnels 24153461 and 101216178 blocked (the same with every block built: the fixture's south edge, not the block left out; for `covers` and `windows`) |
| `hals` | Footpaths hovering 3.22% (maximum 1.50%), cap roughness p99 14.45 cm (maximum 12 cm) |
| `inn` | Bridge deck 8092867 sags 2.1 m (as in `holes`) |
| `kachlet` | 445 of 1419 LoD2-matched outlines moved (31.4%, minimum 40%) |

The LoD2 ratio measures how many outlines were shifted among those already
matched to LoD2. The lower ratios in Gaißa and Kachlet describe fewer shifts,
while the checks on the share of building cells using LoD2 roofs pass.

A full fixture `build` runs `phenology.py` after voxelization. On Gaißa, its
iNaturalist query yielded no observations for the fixture's urban tree genera.
The urban class list was empty, and `site_classes` raised `IndexError` when
selecting a class for an urban tree. `verify` can check the fixture's voxel
output before that step.
