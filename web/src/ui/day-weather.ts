import type { Bar } from '../bar';
import type { Daylight } from '../daylight';
import { dateOf, dayOfYear, hourAt, solarNoon } from '../sun';
import { ease, lerp } from '../util';
import { type Climate, typical, type Weather, WEATHERS } from '../weather';

// the bar's choices of weather: the day's typical one (climate.json), then each of WEATHERS
export const WEATHER_NAMES = ['typical', ...Object.keys(WEATHERS)];

// the named times of a day, its marks on the hour slider
const timesOf = (d: number) => ({ morning: Math.max(7.5, hourAt(d, 6, false)), midday: solarNoon(d), 'golden hour': hourAt(d, 5, true),
  'blue hour': hourAt(d, -7, true), night: Math.min(23.5, Math.max(23, hourAt(d, -14, true))) });

// The bar's day, hour and weather, the light they set (daylight) and the URL that keeps them (?date, ?hour, ?weather).
// The time of day is the world's (the host's, app/session.ts PageTime): a day or hour chosen here is shown at once and
// asked of it (ask); the world's own time comes back through show.
export function makeDayWeather({ bar, daylight, ask }: { bar: Bar; daylight: Daylight; ask: (hour: number, day: number) => void }) {
  let climate: Climate | null = null, weatherName = 'typical', shareT = 0;
  let fade: { from: Weather; to: Weather; t0: number } | null = null;

  function setHour(h: number, asked = true) {
    daylight.apply(h);
    bar.setHour(h);
    if (asked) ask(h, daylight.day);
  }

  function setDay(d: number, asked = true) {
    const times = timesOf(daylight.day), was = Object.entries(times).find(([, h]) => Math.abs(h - daylight.hour) < 1 / 3)?.[0] as keyof typeof times | undefined;
    daylight.day = d;
    const now = timesOf(d);
    bar.setDay(d, now);
    offerWeathers(d);
    setHour(was ? now[was] : daylight.hour, asked);
  }

  function offerWeathers(d: number) {
    const snow = climate?.snowy[d - 1] ?? true;
    bar.offer('snow', snow);
    if (!snow && weatherName === 'snow') setWeather('typical');
  }

  function setWeather(name: string, now = false) {
    weatherName = name;
    const t = name === 'typical' && climate ? typical(climate, daylight.day) : null;
    const to = t?.w ?? WEATHERS[name] ?? WEATHERS.clear;
    bar.setWeather(name, t?.said ?? '');
    fade = now ? null : { from: { ...daylight.weather }, to, t0: performance.now() };
    if (now) { daylight.weather = to; daylight.apply(daylight.hour); }
  }

  // the weather's fade, each frame
  function step(now: number) {
    if (!fade) return;
    const k = Math.min(1, (now - fade.t0) / 1500), e = ease(k), { from, to } = fade;
    daylight.weather = { cloud: lerp(from.cloud, to.cloud, e), rain: lerp(from.rain, to.rain, e), snow: lerp(from.snow, to.snow, e), cover: lerp(from.cover, to.cover, e) };
    daylight.apply(daylight.hour);
    if (k >= 1) fade = null;
  }

  function share() {
    clearTimeout(shareT);
    shareT = setTimeout(() => {
      const d = dateOf(daylight.day), qs = new URLSearchParams(location.search); // as it is now: the settings write to it too
      qs.set('date', `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      qs.set('hour', daylight.hour.toFixed(2));
      if (weatherName !== 'typical') qs.set('weather', weatherName); else qs.delete('weather');
      history.replaceState(null, '', `?${qs}`);
    }, 400);
  }

  return {
    setHour, setDay, setWeather, step,
    // the bar's handlers
    onDay: (d: number) => { setDay(d); share(); },
    onDayEnd: () => { if (weatherName === 'typical') setWeather('typical'); },
    onHour: (h: number) => { setHour(h); share(); },
    onWeather: (w: string) => { setWeather(w); share(); },
    // the start: the climate, then the URL's day, weather and hour (else today, the typical weather, golden hour)
    start(c: Climate, qs: URLSearchParams, today: number) {
      climate = c;
      const md = qs.get('date')?.split('-').map(Number);
      setDay(md ? dayOfYear(new Date(new Date().getFullYear(), md[0] - 1, md[1])) : today);
      setWeather((qs.get('weather') ?? '') in WEATHERS ? qs.get('weather')! : 'typical', true);
      setHour(qs.get('hour') ? +qs.get('hour')! : timesOf(daylight.day)['golden hour']);
    },
    // the world's time of day (PageTime.follow), shown without asking it back
    show(t: { hour: number; day: number }) {
      if (t.day !== daylight.day) setDay(t.day, false);
      if (t.hour !== daylight.hour) setHour(t.hour, false);
    },
  };
}
