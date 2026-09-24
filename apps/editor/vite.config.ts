import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  envDir: '../web',
  plugins: [react()],
  publicDir: '../web/public',
  build: { rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), render: fileURLToPath(new URL('./render.html', import.meta.url)) } } },
  resolve: {
    alias: [
      { find: /^@kpl\/shared$/, replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
      { find: /^@kpl\/editor-core$/, replacement: fileURLToPath(new URL('../../packages/editor-core/src/index.ts', import.meta.url)) },
      { find: /^@kpl\/match-presentation$/, replacement: fileURLToPath(new URL('../../packages/match-presentation/src/index.ts', import.meta.url)) },
    ],
  },
});
