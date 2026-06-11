import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 10000,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
