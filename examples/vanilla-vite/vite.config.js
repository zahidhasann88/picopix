import { defineConfig } from 'vite';

/**
 * `picopix` ships its worker as a separate ESM bundle and creates it
 * with `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`.
 * Vite understands that pattern natively, so no special worker configuration is
 * needed here — this file only sets the dev server port and enables the
 * package's own source for local hacking.
 */
export default defineConfig({
  server: { port: 5173, host: true },
  build: { target: 'es2022' },
});
