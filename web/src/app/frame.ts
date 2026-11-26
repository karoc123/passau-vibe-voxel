// The frame's order: the players' input (the car's, Nav's, the crafts that
// own the camera), the sim's update (its ticks; the frame's time: sim.time), this frame's poses drawn, then the cameras
// on them (the ride's, a craft's own), then what reads the camera, then the render. The order is this list's; main.ts
// gives each phase its work.
export const PHASES = ['input', 'sim', 'poses', 'cameras', 'cameraReaders', 'render'] as const;
export type Phase = (typeof PHASES)[number];

// now: the frame's time (ms, requestAnimationFrame's); dt: seconds since the last frame, at most 0.1
export type Step = (now: number, dt: number) => void;

// the animation loop's callback: each phase in order; start: the time the first frame's dt counts from
export function frameLoop(steps: Record<Phase, Step>, start: number): (now: number) => void {
  let lastT = start;
  return (now) => {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    for (const p of PHASES) steps[p](now, dt);
  };
}
