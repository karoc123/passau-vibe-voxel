// The sun and the moon for the page's light (daylight.ts) and its bar (ui/day-weather.ts, bar.ts). The sun's maths are
// shared with the host (sim/sun.ts: its start time), taken here in this year (the page's clock).
import * as S from './sim/sun';

const RAD = Math.PI / 180, LAT = 48.574 * RAD, LON = S.LON;
const thisYear = () => new Date().getFullYear();

export const dayOfYear = (d: Date) => S.dayOfDate(d.getFullYear(), d.getMonth(), d.getDate());
export const dateOf = (day: number, year = thisYear()) => new Date(year, 0, day);
export const utcOffset = (day: number, year = thisYear()) => S.utcOffset(day, year);
export const sunAt = (day: number, hour: number) => S.sunAt(day, hour, thisYear());
export const solarNoon = (day: number) => S.solarNoon(day, thisYear());
export const hourAt = (day: number, deg: number, evening: boolean) => S.hourAt(day, deg, evening, thisYear());

// Clear-sky transmittance of the direct beam at 610, 550, 465 nm: Rayleigh (Bucholtz), urban haze (Ångström β 0.05,
// α 1.3), ozone (Chappuis band); Kasten-Young air mass
const TAU = [0.191, 0.244, 0.339];
export const airMass = (elDeg: number) => { const h = Math.max(elDeg, -0.5); return 1 / (Math.sin(h * RAD) + 0.50572 * (h + 6.07995) ** -1.6364); };
export const beam = (elDeg: number) => TAU.map((t) => Math.exp(-airMass(elDeg) * t)) as [number, number, number];

// The moon, low precision (its main periodic terms; a degree or so off, enough for the sky): elevation and azimuth as
// sunAt's, and its phase -- the share of the disc lit (0 new .. 1 full) and the elongation from the sun (rad, + waxing)
export function moonAt(day: number, hour: number, year = thisYear()) {
  const d = (Date.UTC(year, 0, day) + (hour - utcOffset(day, year)) * 36e5 - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const L = 218.316 + 13.176396 * d, M = (134.963 + 13.064993 * d) * RAD, F = (93.272 + 13.22935 * d) * RAD;
  const lam = (L + 6.289 * Math.sin(M)) * RAD, beta = 5.128 * Math.sin(F) * RAD, eps = 23.439 * RAD;
  const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps), Math.cos(lam));
  const decl = Math.asin(Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lam));
  const H = (280.16 + 360.9856235 * d + LON) * RAD - ra;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
  const g = (357.529 + 0.98560028 * d) * RAD, sunLam = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const elong = Math.atan2(Math.sin(lam - sunLam), Math.cos(lam - sunLam));
  return { el, az, lit: (1 - Math.cos(elong)) / 2, elong };
}
