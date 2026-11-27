import type { Daylight } from '../daylight';
import { dateOf, hourAt, solarNoon } from '../sun';
import { $, ease, el, lerp } from '../util';
import { type Climate, typical, type Weather, WEATHERS } from '../weather';
import { choices, Slider } from './controls';

// the choices of weather: the day's typical one (climate.json), then each of WEATHERS
const WEATHER_NAMES = ['typical', ...Object.keys(WEATHERS)];
const hhmm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const dayMonth = (d: number) => dateOf(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// the named times of a day, its marks on the hour slider
const timesOf = (d: number) => ({ morning: Math.max(7.5, hourAt(d, 6, false)), midday: solarNoon(d), 'golden hour': hourAt(d, 5, true),
  'blue hour': hourAt(d, -7, true), night: Math.min(23.5, Math.max(23, hourAt(d, -14, true))) });

// The menu's day, hour and weather (in box), the light they set (daylight) and the URL that keeps them (?date, ?hour,
// ?weather); not kept in the browser: the day and hour are the world's, and a link or a reload keeps them by the URL.
// The time of day is the world's (the host's, app/session.ts PageTime): a day or hour chosen here is shown at once and
// asked of it (ask); the world's own time comes back through show. The weather is the page's own.
export function makeDayWeather({ box, days, daylight, ask }: { box: HTMLElement; days: Record<string, number>; daylight: Daylight; ask: (hour: number, day: number) => void }) {
  let climate: Climate | null = null, weatherName = 'typical', shareT = 0;
  let fade: { from: Weather; to: Weather; t0: number } | null = null;
  const date = new Slider(box, { min: 1, max: 365, step: 1, marks: days, near: 3, log: false, show: dayMonth, onInput: (d) => { setDay(d); share(); },
    onChange: () => { if (weatherName === 'typical') setWeather('typical'); } });
  date.input.name = 'day';
  const time = new Slider(box, { min: 4, max: 23.5, step: 1 / 60, marks: {}, near: 1 / 3, log: false, show: hhmm, onInput: (h) => { setHour(h); share(); } });
  time.input.name = 'hour';
  const sky = choices('sky', 'Weather', WEATHER_NAMES, box);
  sky.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) { setWeather(b.dataset.v!); share(); } });
  const online = el('div', 'menu-note', 'On a server the day and the hour are the world’s, the same for everyone: changing them changes them for all, where the server’s game mode allows it (else they snap back). The weather is yours alone.', box);
  online.hidden = true;

  function setHour(h: number, asked = true) {
    daylight.apply(h);
    if (document.activeElement !== time.input) time.set(h);
    if (asked) ask(h, daylight.day);
  }

  function setDay(d: number, asked = true) {
    const times = timesOf(daylight.day), was = Object.entries(times).find(([, h]) => Math.abs(h - daylight.hour) < 1 / 3)?.[0] as keyof typeof times | undefined;
    daylight.day = d;
    const now = timesOf(d);
    date.set(d);
    time.setMarks(now);
    offerWeathers(d);
    setHour(was ? now[was] : daylight.hour, asked);
  }

  function offerWeathers(d: number) {
    const snow = climate?.snowy[d - 1] ?? true;
    $<HTMLButtonElement>('button[data-v="snow"]', sky).disabled = !snow;
    if (!snow && weatherName === 'snow') setWeather('typical');
  }

  function setWeather(name: string, now = false) {
    weatherName = name;
    const t = name === 'typical' && climate ? typical(climate, daylight.day) : null;
    const to = t?.w ?? WEATHERS[name] ?? WEATHERS.clear;
    sky.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === name));
    $('.val', sky).innerHTML = `Weather${t?.said ? ` <span class="mark">${t.said}</span>` : ''}`;
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
    /** more of the year's days named (the foliage's) */
    setDays(more: Record<string, number>) { date.setMarks({ ...more, ...days }); date.set(date.value); },
    /** on a server (the note on whose the time is) */
    set online(on: boolean) { online.hidden = !on; },
    // the start: the climate, the world's start time (the host's: host/start.ts, from the URL's ?date, ?hour), the URL's
    // weather (else the typical one)
    start(c: Climate, qs: URLSearchParams, time: { hour: number; day: number }) {
      climate = c;
      setDay(time.day);
      setWeather((qs.get('weather') ?? '') in WEATHERS ? qs.get('weather')! : 'typical', true);
      setHour(time.hour);
    },
    // the world's time of day (PageTime.follow), shown without asking it back
    show(t: { hour: number; day: number }) {
      if (t.day !== daylight.day) setDay(t.day, false);
      if (t.hour !== daylight.hour) setHour(t.hour, false);
    },
  };
}
