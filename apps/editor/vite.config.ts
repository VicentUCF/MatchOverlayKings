import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({base:'./',envDir:'../web',plugins:[react()],publicDir:'../web/public',resolve:{alias:{'@kpl/shared':fileURLToPath(new URL('../../packages/shared/src/index.ts',import.meta.url)),'@kpl/editor-core':fileURLToPath(new URL('../../packages/editor-core/src/index.ts',import.meta.url)),'@kpl/match-presentation':fileURLToPath(new URL('../../packages/match-presentation/src/index.ts',import.meta.url))}}});
