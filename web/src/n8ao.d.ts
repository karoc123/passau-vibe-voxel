declare module 'n8ao' {
  import type { Pass } from 'postprocessing';
  import type { Camera, Scene, ShaderMaterial, WebGLRenderer, WebGLRenderTarget } from 'three';

  interface Quad { material: ShaderMaterial; render(renderer: WebGLRenderer): void }
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width: number, height: number);
    configuration: {
      aoRadius: number;
      distanceFalloff: number;
      intensity: number;
      halfRes: boolean;
      depthAwareUpsampling: boolean;
      aoSamples: number;
      denoiseSamples: number;
      denoiseRadius: number;
      denoiseIterations: number;
    };
    effectCompositerQuad: Quad;
    accumulationQuad: Quad;
    copyQuad: Quad;
    outputTargetInternal: WebGLRenderTarget;
    writeTargetInternal: WebGLRenderTarget;
    configureEffectCompositer(depthBufferType?: number, ortho?: boolean): void;
    renderTransparency(renderer: WebGLRenderer): void;
  }
}
