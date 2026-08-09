import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Keep pipeline progress logging out of test output; failures are what matter.
    env: { SF_LOG_LEVEL: 'error' },
  },
});
