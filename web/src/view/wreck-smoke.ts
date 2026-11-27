import * as THREE from 'three';

// The smoke over the wrecks (a car's or a craft's): a column of dark voxel puffs rising, growing, drifting
// with the wind and shrinking away, so that a wreck is seen from afar. Every column is one instanced mesh of plain lit
// boxes: one draw call however many wrecks, no shader of its own (a phone's budget).

const COLUMNS = 24, PUFFS = 9;
// s a puff takes to rise its column; m it rises (at size 1: a car's or a helicopter's)
const RISE_S = 5, HEIGHT = 16;
// the wind's way (x, z), and how far a puff drifts along it by the column's top
const WIND_X = 0.93, WIND_Z = 0.37, DRIFT = 5;

interface Column { x: number; y: number; z: number; size: number; seed: number; seen: number }

class WreckSmoke {
  readonly mesh: THREE.InstancedMesh;
  private readonly columns = new Map<string, Column>();
  private frame = 0;
  private t = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor() {
    const n = COLUMNS * PUFFS;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.62, depthWrite: false }), n);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    // (its puffs are spread over the map: three's bounds of the box would cull them)
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
  }

  /** a wreck drawn this frame (key: its life's, "car:12"), its smoke's foot at x, y, z; size 1 a car's or a
   * helicopter's, less for a small one */
  at(key: string, x: number, y: number, z: number, size = 1) {
    let c = this.columns.get(key);
    if (!c) this.columns.set(key, c = { x, y, z, size, seed: seedOf(key), seen: 0 });
    c.x = x; c.y = y; c.z = z; c.size = size; c.seen = this.frame;
  }

  /** once a frame, after the wrecks drawn have been told (at): their columns, the nearest COLUMNS to the viewer */
  update(dt: number, viewer: THREE.Vector3Like) {
    const t = this.t += dt, f = this.frame;
    let shown: Column[] = [];
    for (const [k, c] of this.columns) if (c.seen < f) this.columns.delete(k); else shown.push(c);
    if (shown.length > COLUMNS) {
      const d = (c: Column) => (c.x - viewer.x) ** 2 + (c.z - viewer.z) ** 2;
      shown = shown.sort((a, b) => d(a) - d(b)).slice(0, COLUMNS);
    }
    let n = 0;
    for (const c of shown) {
      for (let i = 0; i < PUFFS; i++) {
        const ph = (t / RISE_S + i / PUFFS + c.seed) % 1, k = c.size;
        // (born small at the wreck, the largest half-way up, shrunk away at the top)
        const grow = (0.6 + 2.8 * ph) * Math.min(1, ph * 6) * Math.min(1, (1 - ph) * 3.5) * k;
        const wobble = Math.sin(c.seed * 40 + i * 2.1) * 0.6 * k, drift = ph * ph * DRIFT * k;
        this.p.set(c.x + WIND_X * drift + wobble * WIND_Z, c.y + ph * HEIGHT * k, c.z + WIND_Z * drift - wobble * WIND_X);
        this.q.setFromEuler(this.e.set(c.seed * 9 + i, c.seed * 13 + i * 1.7 + ph, 0));
        this.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s.setScalar(Math.max(0.01, grow))));
        const g = 0.1 + 0.32 * ph;
        this.mesh.setColorAt(n, this.c.setRGB(g, g * 0.97, g * 0.94));
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true; }
    this.frame++;
  }
}

// (a column's own phase, 0..1, so that two wrecks side by side do not puff in step)
function seedOf(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/** the page's one smoke over the wrecks (the main loop adds it to the scene and updates it once a frame) */
export const wreckSmoke = new WreckSmoke();
