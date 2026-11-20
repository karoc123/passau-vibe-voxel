// Fetching the data files, three.js-free: the mesher worker imports these as well as the main thread (via util.ts).

export async function fetchGzip(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export const fetchJson = <T>(url: string): Promise<T> => fetch(url).then((r) => r.json() as Promise<T>);
