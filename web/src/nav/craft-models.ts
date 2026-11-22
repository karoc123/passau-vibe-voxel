import * as THREE from 'three';
import type { CraftKind } from './craft-motion';

const box = new THREE.BoxGeometry();

export function makeCraftModel(kind: CraftKind) {
  const group = new THREE.Group();
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const part = (parent: THREE.Group, color: number, size: [number, number, number], x: number, y: number, z: number) => {
    let material = materials.get(color);
    if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: 0.8 }); materials.set(color, material); }
    const mesh = new THREE.Mesh(box, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(...size);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  let rotor: THREE.Group | undefined;
  if (kind === 'hovercraft') {
    part(group, 0x27343b, [2.7, 0.54, 4.5], 0, -0.08, 0);
    part(group, 0xd98332, [2.55, 0.3, 4.2], 0, 0.29, 0);
    part(group, 0xe9b55f, [1.65, 0.54, 1.6], 0, 0.57, 0.64);
    part(group, 0x314e58, [1.46, 0.42, 0.64], 0, 0.83, 0.65);
    for (const x of [-0.75, 0.75]) {
      part(group, 0x415058, [1, 1, 0.23], x, 0.93, -1.39);
      part(group, 0x1c262b, [0.74, 0.71, 0.25], x, 0.93, -1.41);
      part(group, 0xd1d8d6, [0.55, 0.1, 0.29], x, 0.93, -1.42).rotation.z = Math.PI / 4;
    }
  } else if (kind === 'helicopter') {
    part(group, 0xce4236, [1.9, 1.05, 3.5], 0, 0.15, 0.28);
    part(group, 0xe6ded0, [1.92, 0.18, 3.51], 0, -0.19, 0.28);
    part(group, 0x324e5c, [1.77, 0.75, 1.62], 0, 0.52, 1.04);
    part(group, 0xce4236, [0.48, 0.43, 2.8], 0, 0.25, -2.49);
    part(group, 0xce4236, [0.21, 1, 0.66], 0, 0.59, -3.67);
    part(group, 0x26343a, [0.15, 0.65, 0.09], 0.16, 0.67, -3.68).rotation.x = Math.PI / 5;
    for (const x of [-0.93, 0.93]) {
      part(group, 0x344149, [0.14, 0.13, 3], x, -0.72, 0.22);
      for (const z of [-0.74, 1.05]) part(group, 0x344149, [0.12, 0.5, 0.12], x, -0.49, z);
    }
    part(group, 0x344149, [0.18, 0.66, 0.18], 0, 0.94, 0);
    rotor = new THREE.Group();
    rotor.position.y = 1.3;
    group.add(rotor);
    part(rotor, 0x26343a, [7, 0.05, 0.18], 0, 0, 0);
    part(rotor, 0x26343a, [0.18, 0.05, 7], 0, 0, 0);
  } else {
    part(group, 0x294256, [0.48, 0.55, 0.34], 0, 0.56, 0);
    part(group, 0xe9b685, [0.26, 0.26, 0.25], 0, 0.97, 0.03);
    part(group, 0x314454, [0.35, 0.3, 0.31], 0, 0.59, -0.23);
    for (const sign of [-1, 1]) {
      part(group, 0x344451, [0.15, 0.44, 0.15], sign * 0.14, 0.18, 0.09).rotation.x = -0.38;
      part(group, 0x294256, [0.11, 0.51, 0.12], sign * 0.29, 0.66, 0.06).rotation.z = -sign * 0.35;
      for (let i = 0; i < 4; i++) {
        part(group, i % 2 ? 0xe5aa41 : 0xf2c977, [0.91, 0.2, 1.65 - i * 0.22],
          sign * (0.43 + 0.86 * i), 3.4 - 0.06 * i * i, -0.06 * i * i).rotation.z = -sign * (0.06 + i * 0.12);
      }
      for (const z of [-0.55, 0.49]) {
        const wing = new THREE.Vector3(sign * 2.8, 2.85, z);
        const handle = new THREE.Vector3(sign * 0.35, 0.88, 0.05);
        const mid = handle.clone().lerp(wing, 0.5);
        const line = part(group, 0x4d5e63, [0.02, handle.distanceTo(wing), 0.02], mid.x, mid.y, mid.z);
        line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), wing.sub(handle).normalize());
      }
    }
  }
  group.visible = false;
  return { group, rotor };
}
