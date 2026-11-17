# Ideas

For further development of the Passau model: some may or may not be done.

## Passau-specific

- **River gauges.** Calibrate the level slider to the gauges (Passau Donau, Passau Ilzstadt, Passau Ingling for the
  Inn): their zero points in the terrain model's height system, then real marks for mean water and the great floods.
  Until then the slider is in metres relative to the survey day. The three rivers also rise separately, which one
  sheet of water cannot show.
- **River bed.** `scripts/flood.py` still shapes a schematic bed for a single river running north-south; a model
  for a confluence (or real bathymetry) would be better.
- **Landmarks** (`scripts/passau.py`): Veste Oberhaus and Niederhaus, the Rathaus tower with its clock (the viewer has
  a clock-face material), St. Paul, St. Michael, Mariahilf, the bridges (Schanzlbrücke, Prinzregent-Luitpold-Brücke,
  Marienbrücke, the Innsteg), the ships at the quays.
- **The old town's colours.** The plaster palette for houses without an OSM colour was chosen upstream for another
  old town; measure Passau's pastels from photos.
- **Trees.** A municipal tree register, if the city publishes one, merged in `scripts/trees.py` for species.
- **Lit windows at night.** `web/public/data/windows.json` was counted upstream on night photos of Warsaw; count
  Passau's own (far fewer office towers, more churches and floodlit facades).
- **Lawns through the year** are Central European medians measured upstream (`LAWN_LAB` in `scripts/phenology.py`).
- **Preview image** for link previews (`og:image`) once the site has an address.
- **Labels**: more places, each with a sensible `far` distance; German search words are in `scripts/places.py`.

## Weather and seasons

Built: the sun for any day and hour (`web/src/sun.ts`), weather presets and a typical day drawn from the date's
climatology (`web/src/weather.ts`, `scripts/climate.py`), foliage that follows each tree's species through the year
(`scripts/phenology.py`, `web/src/foliage.ts`).

Still open:
- Fog: radiation fog over the rivers at sunrise is the classic Passau autumn view; a first try upstream
  (post-process height fog from the depth buffer) looked poor and was removed.
- Check each preset against dated photos from the same viewpoint.
- Rain: fewer pedestrians, umbrellas; reflections of lamps in wet streets at night.
- Snow: ice along the banks in a hard frost; lawns in winter without snow.
- A default river level per season.

Assumed, not measured, in the foliage calendar:
- Leaves take 14 days from first unfolding to a full crown; colouring and fall each ramp over ~3 weeks.
- Bare crowns keep ~30% of their voxels as twigs; which voxels go first is a hash, not the real pattern.
- The iNaturalist counts cover Poland, Germany, Czechia, Slovakia and Lithuania (the upstream choice); Germany,
  Austria and Czechia would fit Passau better.

## Night

- Street lamps as real pools of light on the ground; traffic as headlight and taillight streaks.
- Windows by building type (see above); shop windows that vary.
- Landmark illumination, checked against photos: the cathedral, Veste Oberhaus, the Rathaus tower and the river
  fronts are floodlit (the `floodlit` material exists for this).
- Parks should be the darkest patches, the street network the brightest.
