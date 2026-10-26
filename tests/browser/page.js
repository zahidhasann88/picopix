/**
 * Runs inside a real browser (Chromium via Playwright).
 *
 * Everything here uses the **built** bundles from `/dist`, so this exercises the
 * shipped artifacts: the browser canvas backend (`createImageBitmap` +
 * `OffscreenCanvas`), the pipeline, encoding, and a real module `Worker` running
 * `dist/worker.js`.
 *
 * Results are published on `window.__itcResults` / `window.__itcError` and the
 * driver script in `scripts/browser-test.mjs` asserts on them.
 */
import {
  browserBackend,
  canEncode,
  processImage,
  compressImage,
  getImageInfo,
  setBackend,
  createImageWorker,
  createWorkerPool,
  sniffFormat,
  ImageToolsError,
  resize,
} from '/dist/index.js';

const log = (message) => {
  document.getElementById('log').textContent += `${message}\n`;
};

/** Draws a gradient with a green marker and returns an encoded blob. */
async function makeImage(type = 'image/png', width = 64, height = 32) {
  const canvas = document.getElementById('source');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#ff0000');
  gradient.addColorStop(1, '#0000ff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, Math.round(width / 3), Math.round(height / 3));
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type });
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type));
}

function jpegWithExifOrientation(jpegBytes, orientation) {
  // Minimal APP1/EXIF segment: TIFF header + IFD0 with one Orientation tag.
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian header, IFD0 @ 8
    0x00, 0x01, // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, count 1
    (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00, // value (inline)
    0x00, 0x00, 0x00, 0x00, // next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  const segment = [0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...body];
  const out = new Uint8Array(jpegBytes.length + segment.length);
  out.set(jpegBytes.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpegBytes.subarray(2), segment.length + 2);
  return out;
}

async function run() {
  const results = {};
  const started = performance.now();

  // --- 1. backend + capability probe ---------------------------------------
  setBackend(browserBackend);
  results.offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  results.createImageBitmap = typeof createImageBitmap === 'function';
  results.canEncodePng = await canEncode('png');
  results.canEncodeJpeg = await canEncode('jpeg');
  results.canEncodeWebp = await canEncode('webp');
  results.canEncodeAvif = await canEncode('avif');

  // --- 2. decode ----------------------------------------------------------
  const png = await makeImage('image/png');
  const raw = await browserBackend.decode(png);
  results.decode = { width: raw.width, height: raw.height, byteLength: raw.data.length };
  results.decodeFirstPixel = Array.from(raw.data.slice(0, 4));

  // --- 3. pipeline + encode ----------------------------------------------
  const webpBlob = await processImage(png)
    .orient()
    .resize({ width: 32, fit: 'inside' })
    .toFormat('webp', { quality: 0.8 })
    .toBlob();
  results.webp = { type: webpBlob.type, size: webpBlob.size };
  const webpBytes = new Uint8Array(await webpBlob.arrayBuffer());
  results.webpSniff = sniffFormat(webpBytes);
  const webpInfo = await getImageInfo(webpBlob);
  results.webpDims = [webpInfo.width, webpInfo.height];

  // --- 4. compress to a byte budget --------------------------------------
  const jpeg = await makeImage('image/jpeg', 400, 300);
  const compressed = await compressImage(jpeg, { maxSizeKB: 12, maxWidthOrHeight: 400 });
  results.compressed = { size: compressed.size, type: compressed.type };

  // --- 5. EXIF orientation (browser decoder auto-rotates; we must not) ----
  const baseJpeg = new Uint8Array(await (await makeImage('image/jpeg', 40, 20)).arrayBuffer());
  const withExif = jpegWithExifOrientation(baseJpeg, 6);
  const info = await getImageInfo(withExif);
  const oriented = await processImage(withExif).orient().toRaw();
  const unoriented = await processImage(withExif).orient(false).toRaw();
  results.exif = {
    orientation: info.orientation,
    display: [info.displayWidth, info.displayHeight],
    oriented: [oriented.width, oriented.height],
    unoriented: [unoriented.width, unoriented.height],
  };

  // --- 6. real module worker ---------------------------------------------
  const worker = createImageWorker();
  results.workerMode = worker.mode;
  results.workerPing = await worker.ping();
  const workerOut = await worker.process(
    { width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(128) },
    [{ op: 'resize', width: 20, height: 10, fit: 'fill' }, { op: 'flip', axis: 'x' }],
  );
  results.workerOut = [workerOut.width, workerOut.height];

  const progressRatios = [];
  await worker.process(
    { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(200) },
    [{ op: 'flip', axis: 'x' }, { op: 'flip', axis: 'y' }],
    { onProgress: (p) => progressRatios.push(p.ratio) },
  );
  results.workerProgress = progressRatios;

  // Decode + encode through the worker (OffscreenCanvas inside the worker).
  const workerDecoded = await worker.decode(png);
  results.workerDecode = [workerDecoded.width, workerDecoded.height];
  const workerEncoded = await worker.encode(workerDecoded, { type: 'image/webp', quality: 0.7 });
  results.workerEncode = { type: workerEncoded.type, size: workerEncoded.size };

  // Cancellation over a real worker.
  const controller = new AbortController();
  const cancelled = worker.process(
    { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(1) },
    [{ op: 'blur', radius: 2 }],
    { signal: controller.signal },
  );
  controller.abort();
  results.workerAborted = await cancelled.then(
    () => 'resolved',
    (error) => error.code,
  );
  worker.dispose();

  // --- 7. worker pool -----------------------------------------------------
  const pool = createWorkerPool({ size: 2 });
  const poolResults = await Promise.all(
    [4, 6, 8].map((size) =>
      pool.process(
        { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(9) },
        [{ op: 'resize', width: size, height: size, fit: 'fill' }],
      ),
    ),
  );
  results.pool = { mode: pool.mode, sizes: poolResults.map((image) => image.width) };
  pool.dispose();

  // --- 8. typed errors ---------------------------------------------------
  try {
    processImage(png, { format: 'tiff' });
    results.unsupportedFormat = 'no-throw';
  } catch (error) {
    results.unsupportedFormat = error instanceof ImageToolsError ? error.code : 'not-a-typed-error';
  }
  results.decodeError = await browserBackend
    .decode(new Uint8Array([1, 2, 3, 4, 5]))
    .then(
      () => 'resolved',
      (error) => (error instanceof ImageToolsError ? error.code : 'not-a-typed-error'),
    );

  // --- 9. pure pixels in the browser ------------------------------------
  const resized = resize({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(50) }, 4);
  results.pixels = [resized.width, resized.height, resized.data[0]];

  results.totalMs = Math.round(performance.now() - started);
  void log;
  return results;
}

run().then(
  (results) => {
    window.__itcResults = results;
  },
  (error) => {
    window.__itcError = { message: String(error && error.message ? error.message : error), stack: String(error && error.stack) };
  },
);
