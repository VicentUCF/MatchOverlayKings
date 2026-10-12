import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'dist-electron'), { recursive: true });
await cp(resolve(root, '../../packages/production-assets/assets'), resolve(root, 'assets'), { recursive: true });
await build({
  entryPoints: [resolve(root, 'main.ts')],
  outfile: resolve(root, 'dist-electron/main.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  external: ['electron', 'playwright', '@resvg/resvg-js', 'fastify', '@fastify/static', 'socket.io'],
  logLevel: 'info',
});
await build({
  entryPoints: [resolve(root, 'preload.ts')],
  outfile: resolve(root, 'dist-electron/preload.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'], logLevel: 'info',
});
