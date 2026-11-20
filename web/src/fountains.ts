import * as THREE from 'three';

// a walk-on fountain (OSM fountain=splash_pad): thin water columns out of the paving, pulsing in waves across the nozzle grid.
// The jets' places are written once; their height is animated in the vertex shader from one time uniform (nothing is
// uploaded per frame).
export class Fountains {
  private readonly mesh: THREE.InstancedMesh;
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly uT = { value: 0 };

  constructor(scene: THREE.Scene, jets: [number, number, number][]) {
    const geo = new THREE.CylinderGeometry(0.07, 0.11, 1, 6, 1, true).translate(0, 0.5, 0);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xe8f6fb, transparent: true, opacity: 0.7, roughness: 0.05, metalness: 0.1,
      emissive: new THREE.Color(0.6, 0.8, 1.0), emissiveIntensity: 0 });
    // the jet's height: phase = t * 1.8 - x * 0.35 - y * 0.2 + (i % 5) * 0.4 (x, y: its map place = the instance's
    // translation x, z); its normals as a y scale transforms them (inverse transpose)
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFountainT = this.uT;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uFountainT;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float jetPhase = uFountainT * 1.8 - instanceMatrix[3].x * 0.35 - instanceMatrix[3].z * 0.2 + float(gl_InstanceID % 5) * 0.4;
          float jetH = max(0.05, 0.4 + 1.8 * max(0.0, sin(jetPhase)));
          objectNormal = normalize(vec3(objectNormal.x, objectNormal.y / jetH, objectNormal.z));`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n          transformed.y *= jetH;');
    };
    this.mesh = new THREE.InstancedMesh(geo, this.mat, jets.length);
    this.mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    jets.forEach(([x, z, y], i) => this.mesh.setMatrixAt(i, m.makeTranslation(x, z, y)));
    scene.add(this.mesh);
  }

  update(t: number, night: number) {
    this.mat.emissiveIntensity = night * 0.9;
    this.uT.value = t;
  }
}
