import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['picopix'] },
  // picopix is linked from ../.. (file:), outside Vite's default fs allow-list.
  server: { port: 5173, host: true, fs: { allow: ['../..'] } },
  build: { target: 'es2022' },
});
