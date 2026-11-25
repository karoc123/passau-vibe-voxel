// Fetching the page's data files, three.js-free: the mesher worker imports these as well as the main thread (via
// util.ts).
// (The host's own, for the Web Worker: host/browser.ts; presentation may not import the host, nor the host this.)

export async function fetchGzip(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export const fetchJson = <T>(url: string): Promise<T> => fetch(url).then((r) => r.json() as Promise<T>);
