import * as THREE from 'three';
import type { SimClient } from '../../client/sim-client';
import type { Pose } from '../../sim/contract/pose';
import type { WeaponId } from '../../sim/contract/ids';
import { weaponIn } from '../../sim/weapons';
import { WEAPON_VIEWS } from './index';
import type { WeaponEvent, WeaponView } from './weapon-view';

// The page's own shots leave from a muzzle low and right of the eyes, so its flash and tracers neither blind nor hide
// the crosshair; the gun in the hand is drawn there, small, its tip at the muzzle.
const RIGHT = 0.22, DOWN = 0.2, AHEAD = 0.6;
const HELD_SCALE = 0.55, HAND_AHEAD = 0.25;
// the kick of a shot (m back, rad up), gone at RECOIL_BACK per s
const KICK_BACK = 0.05, KICK_UP = 0.12, RECOIL_BACK = 14;
// the gun in a figure's hand (view/avatars.ts Figure hand), set back so its pistol grip, not its middle, is in the fist
const GRIP = new THREE.Vector3(0, 0.1, -0.1);

/** another player on foot as drawn (view/life.ts avatarsDrawn): arm, the slot in their hand; hand, their figure's
 * grip (none: not drawn as a figure, no gun) */
export interface ArmedAvatar { player: string; pose: Readonly<Pose>; arm?: number; hand?: THREE.Object3D }

/** the weapons' events drawn by their packages' views, the page's own trigger at once, the gun in the page's player's
 * hand and in the others' */
export class WeaponsView {
  private readonly views = new Map<WeaponId, WeaponView>();
  private seen: number;
  // where the page's player last fired from (null: not yet, in this view)
  private muzzle: THREE.Vector3 | null = null;
  // the gun in the hand: drawn over the frame with a camera of its own (never in the walls, nor smeared by the TAA)
  private readonly heldScene = new THREE.Scene();
  private readonly heldCamera = new THREE.PerspectiveCamera(65, 1, 0.01, 10);
  private readonly hand = new THREE.Group();
  private readonly held = new Map<WeaponId, THREE.Object3D>();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private readonly sky = new THREE.HemisphereLight(0xdde8ff, 0x605848, 1.2);
  private kick = 0;
  // the others' guns, by player, each in its figure's hand
  private readonly carried = new Map<string, { weapon: WeaponId; obj: THREE.Object3D }>();

  constructor(scene: THREE.Scene, private readonly client: SimClient) {
    for (const make of WEAPON_VIEWS) { const v = make(); this.views.set(v.id, v); scene.add(v.group); }
    this.seen = client.tick;
    this.hand.position.set(RIGHT, -DOWN, -HAND_AHEAD);
    this.hand.rotation.y = Math.PI;
    this.hand.scale.setScalar(HELD_SCALE);
    this.sun.position.set(0.4, 1, 0.6);
    this.heldScene.add(this.hand, this.sun, this.sky);
  }

  /** the page's player fired weapon, looking as camera does */
  fired(weapon: WeaponId, camera: THREE.Camera) {
    const v = this.views.get(weapon);
    if (!v) return;
    const dir = camera.getWorldDirection(new THREE.Vector3()), right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir);
    this.muzzle = camera.position.clone().addScaledVector(right, RIGHT).addScaledVector(up, -DOWN).addScaledVector(dir, AHEAD);
    v.fired(this.muzzle.clone(), dir);
    this.kick = 1;
  }

  /** the frame's events and effects; avatars: the others on foot as drawn, each given the gun in their hand; eye:
   * where the frame is seen from */
  update(dt: number, avatars: readonly ArmedAvatar[], eye: THREE.Vector3) {
    const C = this.client;
    for (const e of C.eventsSince(this.seen)) {
      if (!('weapon' in e)) continue;
      const own = e.player === C.player;
      // (the host's shot leaves from the eyes; the page's own is drawn from its muzzle, where its flash was)
      const fromMuzzle = own && this.muzzle && (e.kind === 'shot' || e.kind === 'launch');
      this.views.get(e.weapon)?.event(fromMuzzle ? { ...e, at: this.muzzle!.clone() } as WeaponEvent : e, own);
    }
    this.seen = C.tick;
    for (const v of this.views.values()) v.update(dt, eye);
    this.kick *= Math.exp(-RECOIL_BACK * dt);
    this.carry(avatars);
  }

  private carry(avatars: readonly ArmedAvatar[]) {
    const here = new Set<string>();
    for (const a of avatars) {
      const id = a.arm === undefined ? null : weaponIn(a.arm)?.id ?? null, v = id && this.views.get(id);
      if (!v || !a.hand) continue;
      here.add(a.player);
      let c = this.carried.get(a.player);
      if (c?.weapon !== id) {
        c?.obj.removeFromParent();
        const obj = v.model();
        obj.position.copy(GRIP);
        this.carried.set(a.player, c = { weapon: id, obj });
      }
      if (c.obj.parent !== a.hand) a.hand.add(c.obj);
    }
    for (const [p, c] of this.carried) if (!here.has(p)) { c.obj.removeFromParent(); this.carried.delete(p); }
  }

  /** after the frame is drawn: the gun of slot in the page's player's hand over it (0, or an empty slot: none) */
  drawHeld(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, slot: number, night: number) {
    const id = slot ? weaponIn(slot)?.id : undefined, v = id && this.views.get(id);
    if (!v) return;
    let m = this.held.get(v.id);
    if (!m) this.held.set(v.id, m = v.model());
    for (const o of this.hand.children) if (o !== m) this.hand.remove(o);
    if (m.parent !== this.hand) this.hand.add(m);
    m.position.set(0, 0, -KICK_BACK * this.kick);
    m.rotation.x = -KICK_UP * this.kick;
    const light = 1 - 0.75 * night;
    this.sun.intensity = 1.6 * light; this.sky.intensity = 1.2 * light;
    const H = this.heldCamera;
    // (its own field of view: aiming narrows the world's, not the gun's size)
    if (H.aspect !== camera.aspect) { H.aspect = camera.aspect; H.updateProjectionMatrix(); }
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.clearDepth();
    renderer.render(this.heldScene, H);
    renderer.autoClear = auto;
  }
}
