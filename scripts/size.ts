/**
 * Reports the shipped bundle sizes per entry point, raw + gzip + brotli.
 *
 * `npm run size` bundles each public entry with esbuild (minified, browser
 * target) so the numbers reflect what a consumer's bundler would actually ship,
 * not the unminified `dist` files.
 */
import { build } from 'esbuild';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entries: Array<{ name: string; path: string }> = [
  { name: 'image-tools-core', path: 'src/index.ts' },
  { name: 'image-tools-core/pixels', path: 'src/pixels.ts' },
  { name: 'image-tools-core/worker', path: 'src/worker.ts' },
  { name: 'image-tools-core/node', path: 'src/node.ts' },
  { name: 'providers/imgly', path: 'src/providers/imgly.ts' },
  { name: 'providers/transformers', path: 'src/providers/transformers.ts' },
];

const dir = mkdtempSync(join(tmpdir(), 'itc-size-'));
const rows: Array<{ name: string; raw: number; gzip: number; brotli: number }> = [];

for (const entry of entries) {
  const outfile = join(dir, `${entry.name.replace(/[/@]/g, '-')}.js`);
  await build({
    entryPoints: [entry.path],
    outfile,
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    external: ['@napi-rs/canvas', '@imgly/background-removal', '@huggingface/transformers'],
    logLevel: 'silent',
  });
  const code = readFileSync(outfile);
  rows.push({
    name: entry.name,
    raw: statSync(outfile).size,
    gzip: gzipSync(code).length,
    brotli: brotliCompressSync(code, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  });
}

const pad = (value: string, width: number): string => value.padEnd(width);
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

console.log(`${pad('entry', 30)} ${pad('raw', 10)} ${pad('gzip', 10)} brotli`);
for (const row of rows) {
  console.log(`${pad(row.name, 30)} ${pad(kb(row.raw), 10)} ${pad(kb(row.gzip), 10)} ${kb(row.brotli)}`);
}

// Sizes of the prebuilt files themselves (informational).
try {
  console.log('\ndist/ (unminified, as published):');
  for (const file of ['dist/index.js', 'dist/pixels.js', 'dist/worker.js', 'dist/providers/imgly.js']) {
    console.log(`  ${pad(file, 28)} ${kb(statSync(file).size)}`);
  }
} catch {
  console.log('\n(dist/ not built yet — run `npm run build` for package sizes)');
}
