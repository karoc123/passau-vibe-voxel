// Not a tool: where the node tools read the data -- web/public/data, or VOXEL_DATA (a fixture's build:
// data/check/<fixture>/base/web/public/data, scripts/check.py), so the same checks run on fixture data.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = path.resolve(process.env.VOXEL_DATA ?? path.join(web, 'public/data'));
