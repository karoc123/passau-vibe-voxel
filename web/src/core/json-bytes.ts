// Typed arrays through JSON (the network host's frames): JSON.stringify writes one as an object of its indices, which
// no reader takes for columns again, so an edited node's columns would arrive broken. bytesOut, a replacer, writes it
// as its kind and its bytes in base64; bytesIn, a reviver, makes it again.

const KINDS = { Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array, Float32Array, Float64Array } as const;
type Kind = keyof typeof KINDS;
interface Packed { $bytes: Kind; b64: string }

export function bytesOut(_key: string, v: unknown): unknown {
  if (!ArrayBuffer.isView(v) || !(v.constructor.name in KINDS)) return v;
  const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  // (in pieces: fromCharCode takes its arguments on the stack)
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return { $bytes: v.constructor.name as Kind, b64: btoa(s) } satisfies Packed;
}

export function bytesIn(_key: string, v: unknown): unknown {
  const p = v as Packed | null;
  if (!p || typeof p !== 'object' || typeof p.$bytes !== 'string' || typeof p.b64 !== 'string' || !(p.$bytes in KINDS)) return v;
  const s = atob(p.b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new KINDS[p.$bytes](u.buffer);
}
