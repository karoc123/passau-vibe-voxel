import type { Vec3 } from '../../../core/vec';
import { trace, type Projectile, type ShotWorld, type Weapon } from '../weapon';

// A grenade lobbed, not shot: slow enough to be seen arcing across a square, ~90 m at 45 degrees.
const SPEED = 30, GRAVITY = 9.81;
// (a grenade that meets nothing, fired into the sky, bursts in the air: no crater)
export const FUSE = 6;
const BLAST_R = 3;

/** where a grenade that left at `at` with velocity v is t s later (the host's flight and the view's alike) */
export function flight(at: Vec3, v: Vec3, t: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = at.x + v.x * t; out.y = at.y + v.y * t - 0.5 * GRAVITY * t * t; out.z = at.z + v.z * t;
  return out;
}

function grenade(from: Vec3, dir: Vec3): Projectile {
  const at = { ...from }, v = { x: dir.x * SPEED, y: dir.y * SPEED, z: dir.z * SPEED };
  return {
    at, v, r: BLAST_R,
    // (the arc as straight pieces, one a tick: at 30 m/s a piece is a metre, a voxel)
    fly(world: ShotWorld, t0: number, t1: number) {
      const a = flight(at, v, t0), b = flight(at, v, Math.min(t1, FUSE));
      const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, len = Math.hypot(d.x, d.y, d.z);
      if (len > 1e-9) {
        d.x /= len; d.y /= len; d.z /= len;
        const s = trace(world, a, d, len);
        if (s.hit !== null) return s.to;
      }
      return t1 >= FUSE ? b : null;
    },
  };
}

/** the grenade launcher: a grenade every 1.5 s that bursts where it lands and leaves a crater */
export const launcher: Weapon = {
  id: 'launcher', slot: 2, name: 'Launcher', rate: 1 / 1.5,
  fire: (_world, from, dir) => grenade(from, dir),
};
