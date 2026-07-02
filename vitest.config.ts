import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@kpl/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
