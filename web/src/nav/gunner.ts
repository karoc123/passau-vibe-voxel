import type { SimClient } from '../client/sim-client';
import type { Vec3 } from '../core/vec';
import type { Pose } from '../sim/contract/pose';
import { BODY_HEAD, BODY_R } from '../sim/figure';
import { inArc, type Mount } from '../sim/seats';
import { REACH, trace, type Body, type VoxelRay } from '../sim/weapons/weapon';

// The gunner's page sends the point under its crosshair, not only a direction: it sees its vehicle a ping late, and the
// host aims from the mount where it has it now (sim/world-sim.ts aim).

/** the world point along unit dir from `from` that the page sees first: its voxels or a body it draws on foot (a
 * player's or an NPC's: at a flat angle the ground behind one is far off, and a line to it from where the host has the
 * mount would pass it by), else REACH m out */
export function aimPoint(sim: SimClient, voxels: VoxelRay | null, from: Vec3, dir: Vec3): Vec3 {
  const T = sim.traffic, alpha = sim.time.alpha, p: Pose = { x: 0, y: 0, z: 0, h: 0 };
  return trace({
    voxels,
    *bodies(): Generator<Body> {
      for (const a of T.avatars) {
        if (a.pose.down) continue;
        T.avatarPose(a, alpha, p);
        yield { entity: { kind: 'avatar', id: a.id }, x: p.x, y: p.y, z: p.z, h: p.h, r: BODY_R, l: BODY_R, ht: BODY_HEAD };
      }
    },
  }, from, dir, REACH).to;
}

/** a gunner's aim, held in the world (the vehicle turning under it leaves it on its target) until the mount's swing
 * stops it; stop: at one of its stops now (the crosshair greyed) */
export class GunAim {
  h = 0;
  pitch = 0;
  stop = false;

  /** straight along the mount's middle on a vehicle heading hv */
  reset(m: Mount, hv: number) { this.h = hv + m.yaw; this.pitch = 0; this.stop = false; }

  /** turned by dh (to the left) and dp (up), then kept within m's swing on a vehicle heading hv */
  turn(m: Mount, hv: number, dh = 0, dp = 0) {
    const k = inArc(m, hv, this.h + dh, this.pitch + dp);
    this.h = k.h; this.pitch = k.pitch; this.stop = k.stop;
  }
}
