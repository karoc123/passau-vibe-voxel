import { el } from '../util';

/** the credits and licences, in the menu's section (box) */
export function makeCredits(box: HTMLElement) {
  el('div', 'credits', `<div>Passau in voxels, derived from <a href="https://github.com/stared/warsaw-vibe-voxel" target="_blank" rel="noopener">warsaw-vibe-voxel</a> by <a href="https://p.migdal.pl/" target="_blank" rel="noopener">Piotr Migdał</a> & <a href="https://quesma.com/blog/invisible-cities-one-shot/" target="_blank" rel="noopener">Opus 5.5</a> (MIT)</div>
  <div>data: <a href="https://www.geodaten.bayern.de" target="_blank" rel="noopener">Bayerische Vermessungsverwaltung</a> (CC BY 4.0) and <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> contributors (ODbL)</div>
  <div>weather <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0), phenology <a href="https://www.dwd.de/" target="_blank" rel="noopener">Deutscher Wetterdienst</a> (DL-DE BY 2.0)</div>
  <div>tree species <a href="https://geoservice.dlr.de/web/maps/eoc:tcde:2022" target="_blank" rel="noopener">Tree Species Germany 2022/2016 – DLR Earth Observation Center (Wegler et al.)</a>, CC BY 4.0</div>`, box);
}
