import { defineConfig } from 'vite';

// VOXEL_PUBLIC, VOXEL_VITE_CACHE: an agent worktree serving the main checkout's data (tools/wt.sh)
export default defineConfig({
  base: './',
  publicDir: process.env.VOXEL_PUBLIC || 'public',
  cacheDir: process.env.VOXEL_VITE_CACHE || 'node_modules/.vite',
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 2000 },
});
