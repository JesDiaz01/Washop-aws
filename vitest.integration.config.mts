import { defineConfig } from 'vitest/config';

/** Integration tests call a deployed stack over HTTP; see tests/integration/api.test.ts. */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 90_000, // each test waits on asynchronous processing
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
