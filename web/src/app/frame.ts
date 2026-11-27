// The frame's order: the players' input (the car's, Nav's, the crafts that
// own the camera), the sim's update (its ticks; the frame's time: sim.time), this frame's poses drawn, then the cameras
// on them (the ride's, a craft's own), then what reads the camera, then the render. The order is this list's; main.ts
// gives each phase its work.
const PHASES = ['input', 'sim', 'poses', 'cameras', 'cameraReaders', 'render'] as const;
export type Phase = (typeof PHASES)[number];

// now: the frame's time (ms, requestAnimationFrame's); dt: seconds since the last frame, at most 0.1
export type Step = (now: number, dt: number) => void;

// the animation loop's callback: each phase in order; start: the time the first frame's dt counts from; cap: the
// frames a second at most (0: every frame the display shows). A frame over the cap is skipped whole, by its time: the
// display's frames come at its own rate, so a timer would beat against them
export function frameLoop(steps: Record<Phase, Step>, start: number, cap: () => number = () => 0): (now: number) => void {
  let lastT = start, due = 0;
  return (now) => {
    const fps = cap();
    if (fps > 0) {
      const ms = 1000 / fps;
      // (a frame a little early still counts, else a 60 Hz display under a 60 cap would drop every other one; due
      // moves on by whole intervals, so the rate holds on average, but never stays far behind after a stall)
      if (now < due - ms * 0.2) return;
      due = Math.max(due + ms, now + ms * 0.8);
    }
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    for (const p of PHASES) steps[p](now, dt);
  };
}
