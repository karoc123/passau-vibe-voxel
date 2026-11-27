// The sun over Passau (shared: the page's light, sun.ts, and the host's start time, host/start.ts): where it stands at
// a day of the year and a local hour, and when it crosses an elevation. The year is given (it sets the summer time's
// dates): no clock here, so the host and a test may pick the day.
const RAD = Math.PI / 180, LAT = 48.574 * RAD;
export const LON = 13.466;

/** the day of the year (1..366) of a date given as year, month (0..11), day of the month */
export const dayOfDate = (year: number, month: number, date: number) => Math.round((Date.UTC(year, month, date) - Date.UTC(year, 0, 0)) / 864e5);

// the date of the month of the month's last Sunday
function lastSunday(year: number, month: number) {
  const end = Date.UTC(year, month + 1, 0) / 864e5, weekday = (((end + 4) % 7) + 7) % 7; // (1970-01-01: a Thursday)
  return end - Date.UTC(year, month, 0) / 864e5 - weekday;
}

/** the hours local time is ahead of UTC on day (CEST from March's last Sunday to October's) */
export function utcOffset(day: number, year: number) {
  const start = dayOfDate(year, 2, lastSunday(year, 2)), end = dayOfDate(year, 9, lastSunday(year, 9));
  return day >= start && day < end ? 2 : 1;
}

/** the sun's elevation and azimuth (rad) at day and local hour: NOAA's low-precision declination and equation of time */
export function sunAt(day: number, hour: number, year: number) {
  const g = 2 * Math.PI / 365 * (day - 1 + (hour - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const solar = hour - utcOffset(day, year) + LON / 15 + eot / 60;
  const H = (solar - 12) * 15 * RAD;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
  return { el, az };
}

const elDeg = (day: number, h: number, year: number) => sunAt(day, h, year).el / RAD;

/** the local hour the sun stands highest on day */
export function solarNoon(day: number, year: number) {
  let lo = 9, hi = 16;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (elDeg(day, m + 1e-3, year) > elDeg(day, m, year)) lo = m; else hi = m; }
  return lo;
}

/** the local hour the sun crosses deg (degrees) on day: rising, or setting (evening) */
export function hourAt(day: number, deg: number, evening: boolean, year: number) {
  const noon = solarNoon(day, year);
  let lo = evening ? noon : noon - 12, hi = evening ? noon + 12 : noon;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2, above = elDeg(day, m, year) > deg;
    if (above === evening) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** the golden hour of day: the evening's sun 5 degrees high */
export const goldenHour = (day: number, year: number) => hourAt(day, 5, true, year);
