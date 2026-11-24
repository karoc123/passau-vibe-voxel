import * as THREE from 'three';

export { lerp, clamp, ease, smooth, hash, wrapAngle, pushTo } from './core/num';
export const coarsePointer = () => matchMedia('(pointer: coarse)').matches;

export { fetchGzip, fetchJson } from './host/fetch';

export function dataTexture(data: Uint8Array | Uint16Array, w: number, h: number, format: THREE.PixelFormat,
  type: THREE.TextureDataType = THREE.UnsignedByteType) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.unpackAlignment = data.BYTES_PER_ELEMENT;
  t.needsUpdate = true;
  return t;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = '', parent: HTMLElement = document.body) {
  const e = document.createElement(tag);
  e.className = className;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`missing ${sel}`);
  return e;
}
