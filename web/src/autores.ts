import * as THREE from 'three';
import type { Measured } from './settings';

// The resolution and the city's detail (settings.ts) chosen once, at the first visit on a GPU, when neither the URL nor
// the visitor set them: when the city is in and its shadow map drawn, a few seconds of frames are timed, by the GPU
// (EXT_disjoint_timer_query) where it tells, else between animation frames. Left out: frames that redrew (part of) the
// shadow map, changed the pixels or the settings, while tiles are meshed or uploaded, and while the camera moves fast.
// If the median is well over 30 fps' 33 ms, the resolution goes down a step (more for slower: pixels' time goes with
// res², a guess) and is timed again, down to 0.6; still far too slow there, the detail goes down (less of the city at
// 1 m: fewer triangles, also in the shadow map), once or twice, timed again after each. Then both stay: never up again,
// nothing measured again in the session, and they are remembered with the GPU's name. Nothing else changes them by
// itself: no frame rate watched later moves them back and forth.
const STEPS = [1, 0.85, 0.7, 0.6];
const DETAILS = [1, 0.75, 0.5];
const TARGET = 1000 / 30, SLOW = 40, FAR = 50; // ms: aimed at; over it, a step down; at the least resolution, the detail down
const QUIET = 1000, MEASURE = 2500; // ms: undisturbed before timing; timing at least
const TURN = THREE.MathUtils.degToRad(25), SPEED = 40; // per s: the camera faster than these is "moving fast"

export interface FrameState {
  ready: boolean; // the city in, nothing being meshed, the shadow map drawn, the page visible
  disturbed: boolean; // this frame redrew the shadow map, or changed pixels or settings
}

export class AutoRes {
  done = false;
  private phase: 'wait' | 'time' = 'wait';
  private quietAt = 0;
  private timeAt = 0;
  private samples: number[] = [];
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly queries: { q: WebGLQuery; ok: boolean }[] = [];
  private query: WebGLQuery | null = null;
  private lastT = -1;
  private lastOk = false;
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();

  private res: number;
  private detail: number;

  constructor(renderer: THREE.WebGLRenderer, private readonly camera: THREE.Camera, start: Measured,
    private readonly apply: (m: Measured, final: boolean) => void) {
    ({ res: this.res, detail: this.detail } = start);
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pos.copy(camera.position);
    this.quat.copy(camera.quaternion);
    this.quietAt = performance.now();
  }

  get by() { return this.ext ? 'gpu' : 'frames'; }

  // around the frame's drawing
  begin() {
    if (this.done || !this.ext || this.phase !== 'time' || this.queries.length > 8) return;
    this.query = this.gl.createQuery();
    if (this.query) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
  }

  end(now: number, { ready, disturbed }: FrameState) {
    if (this.done) return;
    const dt = this.lastT < 0 ? 0 : Math.min(5000, now - this.lastT);
    this.lastT = now;
    const c = this.camera, s = dt / 1000;
    const fast = s > 0 && (c.position.distanceTo(this.pos) / s > SPEED || c.quaternion.angleTo(this.quat) / s > TURN);
    this.pos.copy(c.position);
    this.quat.copy(c.quaternion);
    const ok = ready && !disturbed && !fast;
    if (this.query) { this.gl.endQuery(this.ext!.TIME_ELAPSED_EXT); this.queries.push({ q: this.query, ok }); this.query = null; }
    this.poll();
    if (!ok) this.quietAt = now;
    if (this.phase === 'wait') {
      if (now - this.quietAt > QUIET) { this.phase = 'time'; this.timeAt = now; this.samples = []; this.drop(); }
    } else {
      // between animation frames: the time of the frame before, both undisturbed
      if (!this.ext && ok && this.lastOk && dt > 0) this.samples.push(dt);
      this.decide(now);
    }
    this.lastOk = ok;
  }

  // the GPU's times as they come in; a disjoint (the GPU clock reset, throttled) voids those in flight
  private poll() {
    const gl = this.gl, X = this.ext;
    if (!X) return;
    if (gl.getParameter(X.GPU_DISJOINT_EXT)) { this.drop(); return; }
    while (this.queries.length && gl.getQueryParameter(this.queries[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, ok } = this.queries.shift()!;
      if (ok && this.phase === 'time') this.samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  }

  private drop() { for (const { q } of this.queries) this.gl.deleteQuery(q); this.queries.length = 0; }

  private decide(now: number) {
    const n = this.samples.length, t = now - this.timeAt;
    // enough frames, fewer if clearly slow or slow to come
    if (t < MEASURE || !(n >= 20 || (n >= 5 && this.median > 2 * TARGET) || (n >= 3 && t > 4 * MEASURE))) return;
    const med = this.median, min = STEPS[STEPS.length - 1];
    console.info(`resolution ${this.res}, detail ${this.detail}: ${med.toFixed(1)} ms (median of ${n}, ${this.by})`);
    if (med <= SLOW) return this.finish();
    if (this.res > min + 0.01) {
      const want = this.res * Math.sqrt(TARGET / med);
      this.res = STEPS.find((r) => r < this.res - 0.01 && r <= want + 0.01) ?? min;
    } else {
      // at the least resolution: far too slow, the detail a step down; more than twice that, two
      const lower = DETAILS.filter((d) => d < this.detail - 0.01);
      if (med <= FAR || !lower.length) return this.finish();
      this.detail = lower[Math.min(lower.length - 1, med > 2 * FAR ? 1 : 0)];
    }
    this.apply({ res: this.res, detail: this.detail }, false);
    this.phase = 'wait';
    this.quietAt = now;
    this.drop();
  }

  private get median() { const a = [...this.samples].sort((x, y) => x - y); return a[a.length >> 1]; }

  private finish() {
    this.done = true;
    this.drop();
    this.apply({ res: this.res, detail: this.detail }, true);
  }

  // the visitor set the resolution or the detail meanwhile: what stands now is kept
  stop() { this.finish(); }
}
