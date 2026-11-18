import * as THREE from 'three';
import type { Nav } from './nav';
import { clamp } from '../util';

const KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'];
const deadzone = (n: number) => Math.sign(n) * Math.max(0, Math.abs(n) - 0.08) / 0.92;

// Throwaway prototype for a stabilised first-person camera inside the Passau viewer.
export class FpvPrototype {
  private readonly keys = new Set<string>();
  private readonly axes: number[];
  private readonly button = document.createElement('button');
  private readonly status = document.createElement('pre');
  private readonly velocity = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly step = new THREE.Vector3();
  private readonly rotation = new THREE.Euler(0, 0, 0, 'YXZ');
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private device: { index: number; id: string } | null = null;
  private nextStatus = 0;

  constructor(private readonly nav: Nav, private readonly camera: THREE.PerspectiveCamera,
    private readonly target: THREE.Vector3, qs: URLSearchParams) {
    const override = qs.get('fpvAxes')?.split(',').map(Number);
    this.axes = override?.length === 4 && override.every(n => Number.isSafeInteger(n) && n !== 0) ? override : [1, -2, 3, -4];

    const panel = document.createElement('aside');
    panel.id = 'fpv-prototype';
    this.button.type = 'button';
    this.button.textContent = 'Start FPV prototype';
    this.status.textContent = 'Move a stick or press a controller button to detect it.';
    const keys = document.createElement('div');
    keys.textContent = 'W/S forward/back · A/D yaw · Q/E bank and strafe · R/F climb · Esc exit';
    panel.append(this.button, keys, this.status);
    document.body.append(panel);
    this.button.addEventListener('click', () => {
      if (nav.mode === 'fpv') nav.flyUp();
      else this.start();
      this.button.blur();
    });
    addEventListener('keydown', e => {
      if (nav.mode !== 'fpv' || !KEYS.includes(e.code) || e.metaKey || e.ctrlKey || e.altKey ||
          (e.target as Element).closest?.('input, textarea')) return;
      this.keys.add(e.code);
      e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  private start() {
    const world = this.nav.world;
    if (!world || !this.nav.startFpv()) return;
    const p = this.camera.position;
    const f = this.target.clone().sub(p);
    this.yaw = Math.atan2(-f.x, -f.z);
    this.roll = this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.keys.clear();
    this.device = null;
    p.x = clamp(p.x, 1, world.W - 1);
    p.z = clamp(p.z, 1, world.D - 1);
    p.y = Math.max(world.top(p.x, p.z) + 12, Math.min(p.y, 410));
    this.camera.fov = 80;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    const pads = Array.from(navigator.getGamepads?.() ?? []).filter(p => p?.connected);
    const active = this.nav.mode === 'fpv';
    const first = pads.find(p => p && this.axes.every(i => Math.abs(i) <= p.axes.length));
    const pad = active && this.device
      ? pads.find(p => p?.index === this.device?.index && p?.id === this.device?.id)
      : first;
    if (active && pad && !this.device) this.device = { index: pad.index, id: pad.id };

    if (active && this.nav.world) {
      if (document.hasFocus()) this.fly(dt, pad);
      else this.velocity.set(0, 0, 0);
    }
    const now = performance.now();
    if (now < this.nextStatus) return;
    this.nextStatus = now + 100;
    this.button.disabled = !active && (!this.nav.world || this.nav.mode !== 'orbit');
    this.button.textContent = active ? 'Exit FPV' : 'Start FPV prototype';
    const p = this.camera.position;
    const device = pad ?? (!active ? pads[0] : null);
    const controller = device
      ? `${device.id} (${device.mapping || 'raw'})\nAxes: ${device.axes.map((v, i) => `${i + 1}=${v.toFixed(2)}`).join('  ')}`
      : active && this.device ? 'Controller disconnected. Keyboard is available.' : 'Move a stick or press a controller button to detect it.';
    this.status.textContent = controller + (active
      ? `\nAltitude: ${Math.round(p.y - (this.nav.world?.groundAt(p.x, p.z) ?? 0))} m AGL · Speed: ${this.velocity.length().toFixed(1)} m/s`
      : '');
  }

  private fly(dt: number, pad: Gamepad | null | undefined) {
    const world = this.nav.world!;
    const [yaw, lift, roll, pitch] = this.axes.map(i => deadzone(Math.sign(i) * (pad?.axes[Math.abs(i) - 1] ?? 0)));
    const key = (pos: string, neg: string) => Number(this.keys.has(pos)) - Number(this.keys.has(neg));
    const signed = (value: number) => clamp(value, -1, 1);
    const bank = signed(roll + key('KeyE', 'KeyQ'));
    const forward = signed(pitch + key('KeyW', 'KeyS'));
    const rise = signed(lift + key('KeyR', 'KeyF'));
    this.yaw -= signed(yaw + key('KeyD', 'KeyA')) * 1.8 * dt;
    const ease = 1 - Math.exp(-5 * dt);
    this.pitch += (-forward * 0.32 - this.pitch) * ease;
    this.roll += (-bank * 0.46 - this.roll) * ease;
    this.rotation.set(this.pitch, this.yaw, this.roll);
    this.camera.quaternion.setFromEuler(this.rotation);

    this.desired.set(bank * 20, rise * 14, -forward * 36).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw);
    if (this.device && !pad && !this.keys.size) this.velocity.set(0, 0, 0);
    this.velocity.lerp(this.desired, ease);
    const p = this.camera.position;
    this.step.copy(p).addScaledVector(this.velocity, dt);
    this.step.x = clamp(this.step.x, 1, world.W - 1);
    this.step.z = clamp(this.step.z, 1, world.D - 1);
    this.step.y = clamp(this.step.y, world.groundAt(this.step.x, this.step.z) + 1.2, 420);
    this.direction.subVectors(this.step, p);
    const distance = this.direction.length();
    if (distance > 0) {
      this.direction.divideScalar(distance);
      const hit = world.raycast(p, this.direction, distance + 0.65);
      p.addScaledVector(this.direction, Math.max(0, Math.min(distance, hit - 0.65)));
      if (hit < distance + 0.65) this.velocity.set(0, 0, 0);
    }
    this.camera.getWorldDirection(this.direction);
    this.target.copy(p).addScaledVector(this.direction, 180);
  }
}
