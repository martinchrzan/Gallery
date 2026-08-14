import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each file gets its own photo root, data dir and SQLite database, created
    // by the setup file below. Forks keep that isolation honest: the config and
    // database modules both memoise, and a shared module registry would leak one
    // file's library into the next.
    pool: 'forks',
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
