// Every window.__* the page sets, for the tools (web/tools: shoot.mjs, judder.mjs, …) and the console; typed once here
// and set only here (tools/core-deps.mjs R4).
import type { SimClient } from '../client/sim-client';
import type { SocketLink, WorkerLink } from '../client/sim-worker-link';
import type { PlayerCraft } from '../nav/craft';
import type { TileStreamer } from '../stream';
import type { StreetLife } from '../view/life';
import type { FullMap } from '../fullmap';
import type { Minimap } from '../minimap';
import type { Waypoint } from '../waypoint';
import type { Prefs } from '../ui/menu';
import type { NameTags } from '../ui/name-tags';

export interface DebugHooks {
  // the city is shown (shoot.mjs waits for it)
  __ready: boolean;
  // the camera, the controls, nav, the scene, the settings, … (main.ts; judder.mjs, shoot.mjs)
  __three: object;
  __life: StreetLife;
  __sim: SimClient;
  // the sim's link (its tick times)
  __simLink: WorkerLink | SocketLink;
  __streamer: TileStreamer;
  // into the nearest craft no one pilots (F)
  __board: () => boolean;
  // the player's craft shells (judder.mjs enters one at a spot)
  __crafts: PlayerCraft[];
  // the maps and the waypoint (tools/maps.mjs)
  __map: { minimap: Minimap; full: FullMap; waypoint: Waypoint };
  // the Esc menu, the player's settings, the frames shown, the names over the others (tools/menu.mjs)
  __menu: { menu: { open(): void; close(): void; isOpen(): boolean }; prefs: Prefs; fps: () => number; tags: NameTags };
}

declare global {
  interface Window extends Partial<DebugHooks> {}
}

export function hook<K extends keyof DebugHooks>(name: K, value: DebugHooks[K]) {
  (window as Partial<DebugHooks>)[name] = value;
}
