import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**', 'node_modules/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: 'default',
  },
});

export default config;
