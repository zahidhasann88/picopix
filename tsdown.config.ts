import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  entry: {
    index: 'src/index.ts',
    pixels: 'src/pixels.ts',
    node: 'src/node.ts',
    worker: 'src/worker.ts',
    'providers/imgly': 'src/providers/imgly.ts',
    'providers/transformers': 'src/providers/transformers.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
});

export default config;
