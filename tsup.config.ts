import { defineConfig } from 'tsup';

export default defineConfig({
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
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
  treeshake: true,
  minify: false,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
