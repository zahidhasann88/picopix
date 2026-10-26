import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**', 'node_modules/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: 'default',
  },
});
