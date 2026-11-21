// The switch between a node's caps section (core/surface.ts capField) and the legacy inference from the voxels
// (core/caps-legacy.ts) where a node has caps: caps by default; the viewer's ?caps=0 and the node tools' CAPS=0 (env)
// take the legacy path, to measure the one against the other. The mesher's worker gets it with each job
// (MeshRequest.noCaps). To be deleted with the legacy path (docs/plans/surface-caps.md A8).
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CAPS;
const query = typeof location !== 'undefined' && typeof document !== 'undefined' ? location.search : '';
export const CAPS = { use: env !== '0' && !/[?&]caps=0(&|$)/.test(query) };
