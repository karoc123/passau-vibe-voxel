import type { Vector3 } from 'three';
import { clamp } from '../util';
import { type CarInput, PARK } from '../sim/contract/inputs';
import type { SimClient } from '../client/sim-client';
import { CRASH_MS, SINK_MS, type DriverSnapshot } from '../sim/contract/snapshot';
import type { Nav, Ride } from './nav';
import type { CraftContext, PlayerCraft } from './craft';
import { TouchSticks } from '../touch/sticks';
import { VEHICLE_IDS, VEHICLES, vehicleOf } from '../sim/vehicles';
import type { VehicleId } from '../sim/contract/ids';
import { gameKey, gamepad, HeldKeys, inFocus, onFocusLoss, padAxis, PAUSED } from './input';
import { shake } from './chase-rig';
import { HoldButton, ModePanel } from './mode-panel';
import './drive.css';

// The drive mode sends the local player’s commands to the world sim's client (client/sim-client.ts; the sim's road physics). Here: the panel, the input, the
// camera's shake. A craft on the ride's camera (craft.ts): Nav follows the car taken and tells it when it is left (the
// car parks). Out of focus it holds still (input.ts). The road physics is the host's to load (host/sim-host.ts): a
// wheel refused while it loads is asked for again every RETRY_MS.
const RETRY_MS = 400;

const KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
// what the player takes the wheel of (the type button, V): 'any', the traffic vehicle as it is, or a type of the
// catalog (sim/vehicles.ts) the vehicle taken becomes; remembered
const CHOICES: ('any' | VehicleId)[] = ['any', ...VEHICLE_IDS];
const CHOICE_KEY = 'voxel.drive.vehicle';
const readChoice = (): 'any' | VehicleId => {
  try { const v = localStorage.getItem(CHOICE_KEY); return CHOICES.includes(v as VehicleId) ? v as VehicleId : 'any'; } catch { return 'any'; }
};
// the touch stick's steering: |x|^STEER_CURVE, so a small deflection steers gently and the full one locks
const STEER_CURVE = 1.7;

export class DriveMode implements PlayerCraft {
  readonly id = 'drive';
  readonly view = 'ride';
  get mouse() { return this.driving !== null || this.pending !== null; }
  private readonly nav: Nav;
  private readonly focus: Vector3;
  private readonly touch: TouchSticks;
  // on a touch screen: one stick on the left (up gas, down brake then reverse, sideways steer), the handbrake under the
  // right thumb (held), and the right side's fingers pinch the camera (style.css #handbrake-button)
  private readonly handbrake = new HoldButton('handbrake-button', 'Hand<br>brake', 'Handbrake (hold)');
  private readonly keys = new HeldKeys(KEYS);
  private readonly panel: ModePanel;
  private readonly action: HTMLButtonElement;
  private readonly typeButton: HTMLButtonElement;
  private choice = readChoice();
  private readonly speed: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private pending: Ride | null = null;
  private driving: Ride | null = null;
  // the wheel taken (its answer came back): from then on, no car of the player's means the car was lost. Not the tick
  // the claim was sent at: the server ticks on its own clock, and a snapshot of a later tick may still predate the claim
  private taken = false;
  // the wheel refused while the host's road physics loads: asked for again at this time (performance.now)
  private retryAt: number | null = null;
  private snapshot: DriverSnapshot | null = null;
  // the world sim's client, once it is there
  private world: SimClient | null = null;

  constructor({ nav, target, sim, host, canvas }: CraftContext) {
    this.nav = nav; this.focus = target;
    sim.then((world) => { this.world = world; }, () => {});
    // two fingers close together pinch the chase camera in and out (at the eyes, the field of view; nav.ts zoomRide)
    // (the right side is the camera's: no stick, only the pinch, so a drive never steers from the right thumb)
    this.touch = new TouchSticks(canvas, { onPinch: ratio => this.nav.zoomRide(ratio), camera: 'right' });
    const P = this.panel = new ModePanel(host, 'drive', 'Drive a car');
    this.action = P.button('', () => this.toggle());
    this.typeButton = P.button('', () => this.cycleType(), 'drive-type');
    this.typeButton.title = 'What to drive (V)';
    this.speed = P.line('speed');
    this.help = P.help('W/S accelerate and brake/reverse · A/D steer · Space handbrake · T back on the road · Esc exit',
      'Left thumb: drag up for gas, down to brake/reverse, sideways to steer. Hold the right button for the handbrake. Pinch on the right to zoom.');
    addEventListener('keydown', e => {
      if (!gameKey(e)) return;
      if (e.code === 'KeyV' && !this.driving && !this.nav.craftView && !e.repeat) { this.cycleType(); e.preventDefault(); return; }
      if (!this.driving) return;
      if (e.code === 'KeyT') { if (!e.repeat) this.world?.send({ kind: 'request', request: { kind: 'resetDriver' } }); e.preventDefault(); return; }
      if (this.keys.press(e)) e.preventDefault();
    });
    onFocusLoss(() => this.touch.clear());
    this.draw();
  }

  update() {
    if (this.pending) this.prepare(this.pending);
    if (this.driving && this.world) {
      // (the wheel refused: the car gone, or another player's; or the car lost after it was taken. Refused while the
      // road physics loads: asked for again; its load failed: told)
      const results = this.world.results('enterSeat', 'driver'), now = performance.now();
      const refused = results.find((r) => !r.ok && r.reason !== 'loading');
      if (!refused && results.some((r) => !r.ok)) this.retryAt = now + RETRY_MS;
      if (results.some((r) => r.ok)) this.taken = true;
      if (this.retryAt !== null && now >= this.retryAt) this.claim(this.world, this.driving);
      this.snapshot = this.world.driver();
      if (refused?.reason === 'failed') this.panel.say('Road physics could not load', 1800);
      if (refused || (!this.snapshot && this.taken)) this.nav.leaveCraft();
      else if (this.retryAt === null) {
        const focused = inFocus();
        this.world.send({ kind: 'seatInput', role: 'driver', input: focused ? this.input() : PARK });
        for (const note of this.world.driverNotes()) this.panel.say(note.text, note.ms);
        if (this.snapshot) {
          this.shakeCamera(this.snapshot, now);
          const p = this.snapshot.pose;
          this.nav.life?.clearFallen(p.x, p.z, 35);
        }
      }
    }
    this.draw();
  }

  // the camera shaken by a crash and dipped by a splash
  private shakeCamera(snapshot: DriverSnapshot, now: number) {
    const offset = this.nav.rideCamera.shake.set(0, 0, 0);
    const crash = snapshot.crashMs / CRASH_MS;
    if (crash > 0) shake(offset, 0.45 * crash * crash, now);
    const sink = snapshot.sinkMs / SINK_MS;
    if (sink > 0) offset.y -= 1.6 * Math.sin(Math.min(1, (1 - sink) * 4) * Math.PI / 2);
  }

  // the panel's button: take the wheel, or park
  private toggle() {
    if (this.driving) this.nav.leaveCraft();
    else this.enter();
  }

  // take the wheel of the car followed, else of the one nearest the focus (once the client is there: prepare)
  enter() {
    if (this.driving || this.nav.craftView) return false;
    if (this.nav.ride?.ref.kind !== 'car') {
      const life = this.nav.life;
      if (!life?.group.visible) return false;
      const choice = life.nearest('car', this.focus, null) ?? life.first('car');
      if (choice) this.nav.startRide(choice);
    }
    if (this.nav.ride?.ref.kind !== 'car') return false;
    this.pending = this.nav.ride;
    return true;
  }

  // takes the wheel once the client is there
  private prepare(ride: Ride) {
    const life = this.nav.life, car = ride.ref;
    if (!life || ride !== this.nav.ride || car.kind !== 'car') { this.pending = null; return; }
    const world = this.world;
    if (!world) return;
    if (!life.pose(car)) { this.pending = null; return; }
    this.pending = null;
    // (Nav first: whatever it leaves for this sends its leaveSeat before the takeWheel; an old answer dropped)
    this.nav.enterCraft(this);
    world.results('enterSeat', 'driver');
    this.claim(world, ride);
    this.driving = ride;
    this.touch.setActive(true);
    this.keys.clear();
    this.panel.silence();
  }

  // the wheel of ride's car asked for (the host warms the terrain round it; refused while its road physics loads)
  private claim(world: SimClient, ride: Ride) {
    world.send({ kind: 'enterSeat', entity: { kind: 'car', id: ride.ref.id }, role: 'driver',
      choice: this.choice === 'any' ? undefined : this.choice });
    this.taken = false;
    this.retryAt = null;
  }

  // left (Park, the map, a walk, another ride or craft): the car parks where it is
  leave() {
    if (!this.driving) return;
    this.world?.send({ kind: 'leaveSeat', pose: this.nav.stepOut ?? undefined });
    this.nav.rideCamera.shake.set(0, 0, 0);
    this.driving = null;
    this.taken = false;
    this.retryAt = null;
    this.snapshot = null;
    this.keys.clear();
    this.handbrake.release();
    this.touch.setActive(false);
  }

  private cycleType() {
    this.choice = CHOICES[(CHOICES.indexOf(this.choice) + 1) % CHOICES.length];
    try { localStorage.setItem(CHOICE_KEY, this.choice); } catch { /* not remembered */ }
    this.draw();
  }

  private input(): CarInput {
    const pressed = (...codes: string[]) => this.keys.any(...codes);
    const pad = gamepad(), stick = padAxis(pad?.axes[0]);
    // the one touch stick: up gas, down brake (below ~0.8 m/s reverse, car.ts), sideways steer on a curve
    const left = this.touch.axes('left');
    const pedal = left ? clamp(left.y, -1, 1) : 0;
    const sx = left ? clamp(left.x, -1, 1) : 0;
    const steering = Math.sign(sx) * Math.abs(sx) ** STEER_CURVE;
    const handbrake = this.handbrake.held;
    return {
      gas: Math.max(pressed('KeyW', 'ArrowUp'), pad?.buttons[7]?.value ?? 0, pedal),
      brake: Math.max(pressed('KeyS', 'ArrowDown'), pad?.buttons[6]?.value ?? 0, -pedal),
      steer: clamp(pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') + stick + steering, -1, 1),
      handbrake: this.keys.has('Space') || !!pad?.buttons[0]?.pressed || handbrake,
    };
  }

  private draw() {
    const active = this.driving, following = this.nav.ride?.ref.kind === 'car', P = this.panel;
    const life = this.nav.life, driven = active && life?.agent(active.ref);
    P.active = !!(active || this.pending);
    ModePanel.text(this.action, active ? `Park ${driven && driven.kind === 'car' ? vehicleOf(driven).name.toLowerCase() : 'car'}` : 'Take the wheel');
    this.typeButton.hidden = !!active || !!this.pending;
    ModePanel.text(this.typeButton, `Vehicle: ${this.choice === 'any' ? 'any' : VEHICLES[this.choice].name}`);
    this.action.disabled = !!this.pending || (!active && (!life?.group.visible ||
      (!following && !life.first('car'))));
    P.details.hidden = !active && !this.pending;
    this.speed.hidden = this.help.hidden = !active;
    P.status.hidden = !this.pending && !active;
    ModePanel.text(P.status, this.pending ? 'Loading…' : active && this.retryAt !== null ? 'Loading road physics…' :
      active && (!this.snapshot || this.snapshot.waiting) ? 'Loading road collision tiles…' :
      active && !inFocus() ? PAUSED : P.saying);
    if (active) ModePanel.text(this.speed, Math.round(Math.abs(this.snapshot?.kmh ?? 0)) + ' km/h');
  }
}
