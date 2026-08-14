import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../server/src/types.ts'),
    },
  },
  test: {
    // Node by default — the layout, manifest and memory code is pure, and
    // booting jsdom for it costs more than the tests themselves. The one file
    // that needs a DOM opts in with `@vitest-environment jsdom`.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    restoreMocks: true,
  },
});
