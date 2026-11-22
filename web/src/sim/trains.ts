import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { setCount } from './meshes';
import { COACH_LENGTH, type CoachPose } from './train-traffic';

const MAX_CARS = 240;
const EXPRESS = [0xdfe2e4, 0x1d3d6e, 0xd8892b];
const OTHER = [0xe6e8ea, 0x3a4f63, 0x3a4f63];

function box(w: number, h: number, l: number, y: number) { return new THREE.BoxGeometry(w, h, l).translate(0, y + h / 2, 0); }

export class Trains {
  readonly group = new THREE.Group();
  private readonly body: THREE.InstancedMesh;
  private readonly band: THREE.InstancedMesh;
  private readonly stripe: THREE.InstancedMesh;
  private readonly win: THREE.InstancedMesh;
  private readonly meshes: THREE.InstancedMesh[];
  private readonly winMat = new THREE.MeshStandardMaterial({ color: 0x26323d, roughness: 0.15, metalness: 0.4, emissive: new THREE.Color(1.0, 0.85, 0.6), emissiveIntensity: 0 });

  constructor() {
    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.15, ...o });
    const inst = (g: THREE.BufferGeometry, m: THREE.Material, colour: boolean) => {
      const mesh = new THREE.InstancedMesh(g, m, MAX_CARS);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (colour) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARS * 3), 3);
      mesh.count = 0;
      this.group.add(mesh);
      return mesh;
    };
    const L = COACH_LENGTH;
    this.body = inst(mergeGeometries([box(2.9, 2.75, L, 1.3), box(2.5, 0.3, L - 1.5, 4.05)]), std({ color: 0xffffff }), true);
    this.band = inst(box(2.92, 1.0, L, 0.3), std({ color: 0xffffff }), true);
    this.stripe = inst(box(2.94, 0.25, L - 0.6, 3.2), std({ color: 0xffffff }), true);
    this.win = inst(box(2.96, 0.95, L - 2.4, 2.05), this.winMat, false);
    this.win.castShadow = false;
    this.meshes = [this.body, this.band, this.stripe, this.win];
  }

  render(coaches: Iterable<CoachPose>, night: number) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3(), c = new THREE.Color();
    let n = 0;
    for (const coach of coaches) {
      if (n >= MAX_CARS) break;
      const [body, band, stripe] = coach.express ? EXPRESS : OTHER;
      m.compose(pos.set(coach.x, coach.y, coach.z), q.setFromAxisAngle(up, coach.heading), one);
      for (const mesh of this.meshes) mesh.setMatrixAt(n, m);
      this.body.setColorAt(n, c.setHex(body));
      this.band.setColorAt(n, c.setHex(band));
      this.stripe.setColorAt(n, c.setHex(stripe));
      n++;
    }
    setCount(n, ...this.meshes);
    this.winMat.emissiveIntensity = night * 1.6;
  }
}
