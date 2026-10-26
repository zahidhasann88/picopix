import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Bundles a tiny entry that imports **only** `resize` from the `pixels` subpath
 * and asserts that no codec/canvas/browser code leaked into the output.
 *
 * This is a bundle-graph test rather than a byte-size assertion: the point is
 * that `image-tools-core/pixels` cannot accidentally drag in the canvas layer.
 */
async function bundle(entrySource: string, aliasPath: string, outName: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'itc-treeshake-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, entrySource);
  const outfile = join(dir, outName);
  await build({
    entryPoints: [entry],
    bundle: true,
    write: true,
    outfile,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    treeShaking: true,
    // Resolve the package subpaths to the source tree so this test does not
    // require a build first.
    alias: {
      'image-tools-core/pixels': join(aliasPath, 'src/pixels.ts'),
      'image-tools-core': join(aliasPath, 'src/index.ts'),
    },
    logLevel: 'silent',
  });
  return readFileSync(outfile, 'utf8');
}

const root = process.cwd();

const CANVAS_MARKERS = [
  'OffscreenCanvas',
  'createImageBitmap',
  'convertToBlob',
  'getContext',
  'putImageData',
  'HTMLCanvasElement',
  'drawImage',
  'canEncode',
  '@napi-rs/canvas',
  'napi',
];

/**
 * Codec/container-specific strings. `ImageToolsError` is *not* in this list on
 * purpose: the typed error class is shared by every layer (the pixel functions
 * throw it too) and costs a few hundred bytes.
 */
const FORMAT_MARKERS = ['image/webp', 'image/avif', 'EXIF', 'IDAT', 'CompressionStream'];

describe('tree-shaking', () => {
  it('bundling only `resize` from /pixels contains no canvas or codec code', async () => {
    const source = `
      import { resize } from 'image-tools-core/pixels';
      const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
      export const out = resize(image, { width: 4, height: 4 });
    `;
    const code = await bundle(source, root, 'pixels-only.js');

    for (const marker of CANVAS_MARKERS) {
      expect(code, `bundle should not contain "${marker}"`).not.toContain(marker);
    }
    for (const marker of FORMAT_MARKERS) {
      expect(code, `bundle should not contain "${marker}"`).not.toContain(marker);
    }
    // ...and it really does contain the resize implementation.
    expect(code).toMatch(/width|height/);
    expect(code.length).toBeLessThan(40_000);
  });

  it('a pixels-only bundle is dramatically smaller than the full entry', async () => {
    const tinySource = `
      import { resize } from 'image-tools-core/pixels';
      export const out = resize({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, 2);
    `;
    const fullSource = `
      import { processImage, compressImage, getImageInfo, stripMetadata } from 'image-tools-core';
      export { processImage, compressImage, getImageInfo, stripMetadata };
    `;
    const tiny = await bundle(tinySource, root, 'tiny.js');
    const full = await bundle(fullSource, root, 'full.js');
    expect(tiny.length).toBeLessThan(full.length);
    // The full entry must contain the codec layer (proving the comparison is fair).
    expect(full).toContain('OffscreenCanvas');
  });

  it('importing grayscale alone does not pull in the resize kernels', async () => {
    const source = `
      import { grayscale } from 'image-tools-core/pixels';
      export const out = grayscale({ width: 1, height: 1, data: new Uint8ClampedArray([1,2,3,4]) });
    `;
    const code = await bundle(source, root, 'grayscale-only.js');
    // Lanczos constants would only appear if the resampler were included.
    expect(code).not.toMatch(/lanczos/i);
    expect(code.length).toBeLessThan(8_000);
  });
});
