/**
 * Serves the repository over HTTP so ES modules and the module `Worker` resolve
 * as in a real app, then runs `tests/browser/page.js` against the built `dist/`.
 * Requires `pnpm build` and a Chromium (see `BROWSER_CHANNEL` below).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname === '/' ? '/tests/browser/index.html' : url.pathname;
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

let browser;
let failures = 0;

try {
  // BROWSER_CHANNEL=chrome|msedge uses an installed browser instead of the
  // Playwright download (`pnpm exec playwright-core install chromium`).
  const channel = process.env.BROWSER_CHANNEL || undefined;
  browser = await chromium.launch({ args: ['--no-sandbox'], channel });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    // Failed loads are reported per URL below; their console text has no URL.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('response', (response) => {
    if (response.status() >= 400) consoleErrors.push(`HTTP ${response.status()} ${response.url()}`);
  });

  await page.goto(`http://127.0.0.1:${port}/tests/browser/index.html`);
  await page.waitForFunction('window.__itcResults || window.__itcError', null, { timeout: 60_000 });

  const error = await page.evaluate(() => window.__itcError ?? null);
  if (error) throw new Error(`page error: ${error.message}\n${error.stack}`);
  const r = await page.evaluate(() => window.__itcResults);

  const check = (name, fn) => {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (assertionError) {
      failures++;
      console.log(`  ✗ ${name}\n    ${assertionError.message}`);
    }
  };

  console.log('\nbrowser: ' + (await browser.version()));
  console.log(JSON.stringify(r, null, 2) + '\n');

  check('OffscreenCanvas and createImageBitmap exist', () => {
    assert.equal(r.offscreenCanvas, true);
    assert.equal(r.createImageBitmap, true);
  });
  check('PNG and JPEG encoding is supported', () => {
    assert.equal(r.canEncodePng, true);
    assert.equal(r.canEncodeJpeg, true);
  });
  check('decodes a PNG to 64x32 RGBA', () => {
    assert.deepEqual(r.decode, { width: 64, height: 32, byteLength: 64 * 32 * 4 });
    // The top-left third carries the green marker, so green must dominate.
    assert.ok(r.decodeFirstPixel[1] > r.decodeFirstPixel[0], JSON.stringify(r.decodeFirstPixel));
    assert.ok(r.decodeFirstPixel[1] > 150, JSON.stringify(r.decodeFirstPixel));
  });
  check('pipeline resize + WebP encode', () => {
    assert.equal(r.webp.type, 'image/webp');
    assert.ok(r.webp.size > 0);
    assert.equal(r.webpSniff, 'webp');
    assert.deepEqual(r.webpDims, [32, 16]);
  });
  check('compressImage hits the byte budget', () => {
    assert.ok(r.compressed.size <= 12 * 1024, `size ${r.compressed.size}`);
  });
  check('EXIF orientation is applied exactly once', () => {
    assert.equal(r.exif.orientation, 6);
    assert.deepEqual(r.exif.display, [20, 40]);
    assert.deepEqual(r.exif.oriented, [20, 40]);
    assert.deepEqual(r.exif.unoriented, [40, 20]);
  });
  check('a real module worker runs ops', () => {
    assert.equal(r.workerMode, 'worker');
    assert.ok(r.workerPing >= 0);
    assert.deepEqual(r.workerOut, [20, 10]);
  });
  check('the worker reports progress', () => {
    assert.ok(r.workerProgress.length > 0);
    assert.ok(r.workerProgress.at(-1) > 0.4);
  });
  check('the worker decodes and encodes with OffscreenCanvas', () => {
    assert.deepEqual(r.workerDecode, [64, 32]);
    assert.equal(r.workerEncode.type, 'image/webp');
    assert.ok(r.workerEncode.size > 0);
  });
  check('aborting a worker request rejects with ABORTED', () => {
    assert.equal(r.workerAborted, 'ABORTED');
  });
  check('the worker pool serves concurrent requests', () => {
    assert.equal(r.pool.mode, 'worker');
    assert.deepEqual(r.pool.sizes, [4, 6, 8]);
  });
  check('decode failures and bad arguments raise typed errors', () => {
    assert.equal(r.decodeError, 'UNSUPPORTED_FORMAT');
    assert.equal(r.unsupportedFormat, 'UNSUPPORTED_FORMAT');
  });
  check('pure pixel functions work in the browser', () => {
    assert.deepEqual(r.pixels, [4, 4, 50]);
  });
  check('the worker runs the sharpen op', () => {
    assert.deepEqual(r.workerSharpen, [16, 16, 120]);
  });
  check('generateSrcSet emits capped, de-duplicated WebP variants', () => {
    assert.deepEqual(r.srcset, [
      ['16w', 8, 'image/webp'],
      ['32w', 16, 'image/webp'],
      ['64w', 32, 'image/webp'],
    ]);
  });
  check('generatePlaceholder returns a ThumbHash whose data URL decodes', () => {
    assert.deepEqual(r.placeholder.size, [64, 32]);
    assert.ok(r.placeholder.hashBytes >= 5 && r.placeholder.hashBytes <= 25, String(r.placeholder.hashBytes));
    // The hash stores an approximate aspect ratio, so compare with the pure decoder.
    assert.deepEqual(r.placeholder.decoded, r.placeholder.expected);
    assert.equal(r.placeholder.decoded[0], 32);
    assert.equal(r.placeholder.maxDiff, 0);
  });
  check('no uncaught page errors', () => {
    const relevant = consoleErrors.filter((message) => !message.includes('favicon'));
    assert.deepEqual(relevant, []);
  });

  console.log(`\nbrowser checks finished in ${r.totalMs}ms`);
} catch (error) {
  failures++;
  console.error('browser test crashed:', error);
} finally {
  await browser?.close();
  server.close();
}

if (failures > 0) {
  console.error(`\n${failures} browser check(s) failed`);
  process.exit(1);
}
console.log('all browser checks passed');
