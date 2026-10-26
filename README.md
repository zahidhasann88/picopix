# picopix

**Tiny, typed, tree-shakeable, browser-first image processing.** Resize, crop,
rotate, fix EXIF orientation, compress to a byte budget, convert formats, apply
filters, strip metadata — with Web Worker offloading and pluggable interfaces so
heavy ML (background removal, upscaling) lives in *your* bundle, not in this one.

- 🪶 **Small**: `picopix/pixels` is ~7.8 KB gzipped, the full entry
  ~20 KB gzipped. `sideEffects: false`, named ESM exports, subpath imports.
- 🧮 **Pure where it matters**: every pixel function is a plain function over a
  `RawImage` (`{ width, height, data: Uint8ClampedArray }`) — no DOM, no canvas,
  trivially testable in Node.
- 🎨 **Correct**: premultiplied-alpha resampling (no dark or coloured fringes),
  anti-aliased downscaling, all eight EXIF orientations, lossless metadata
  stripping, typed errors with stable codes.
- ⚙️ **Offloadable**: a serialisable ops-list protocol runs the same code on the
  main thread or in a module Worker with transferable buffers, cancellation,
  timeouts and a pool — with byte-identical results either way.
- 🧩 **Pluggable ML**: `BackgroundRemovalProvider` / `UpscaleProvider`
  interfaces + adapters for `@imgly/background-removal` and
  `@huggingface/transformers` as *optional* peers, plus a model-free
  `chromaKeyProvider` that actually ships here.
- 🖥️ **Works in Node** via the optional `@napi-rs/canvas` peer.

---

## Install

```bash
npm i picopix

# optional, depending on what you need
npm i @napi-rs/canvas                 # Node canvas backend
npm i @imgly/background-removal       # providers/imgly adapter
npm i @huggingface/transformers       # providers/transformers adapter
```

Requires Node >= 18 (dev/build) and a browser with `OffscreenCanvas` or
`HTMLCanvasElement` for encoding/decoding.

---

## Quick start (20 lines)

```ts
import { processImage, getImageInfo } from 'picopix';

const file = document.querySelector('input[type=file]').files[0];

// Metadata-only: no pixels are decoded.
const info = await getImageInfo(file);
console.log(info.format, info.displayWidth, info.displayHeight, info.orientation);

const blob = await processImage(file)
  .orient()                                        // apply EXIF orientation once
  .resize({ width: 1600, fit: 'inside', kernel: 'lanczos3' })
  .toFormat('webp', { quality: 0.82 })
  .toBlob();

const { width, height, size } = await getImageInfo(blob);
console.log(`wrote ${width}x${height}, ${(size / 1024).toFixed(1)} KB, ${blob.type}`);
document.querySelector('img').src = URL.createObjectURL(blob);
```

That is the whole core idea: **one small pipeline, pixels in, pixels out**, with
each step individually importable.

---

## Pipeline API

`processImage(input)` accepts a `Blob`, `ArrayBuffer`, typed array, data URL/URL
string, or an already-decoded `RawImage`. Steps are recorded, not executed —
nothing is decoded until you await a terminal method.

```ts
import { processImage } from 'picopix';

const blob = await processImage(file)
  .orient()                                    // EXIF orientation (auto)
  .crop({ x: 40, y: 40, width: 800, height: 800 })
  .resize({ width: 512, height: 512, fit: 'cover', kernel: 'catmull-rom' })
  .rotate(90)                                  // 90/180/270 are exact
  .flip('x')
  .filter({ type: 'contrast', amount: 1.15 })
  .blur({ radius: 2, type: 'gaussian' })
  .pad(8, { r: 255, g: 255, b: 255, a: 255 })
  .trim()
  .toFormat('jpeg', { quality: 0.85 })
  .toBlob({ stripMetadata: true });
```

| Method | What it does |
| --- | --- |
| `.orient()` / `.orient(false)` / `.orient(6)` | Apply EXIF orientation, skip it, or force a specific transform (1–8) |
| `.resize({ width?, height?, fit?, kernel?, withoutEnlargement?, antialias? })` | Resize with fit math (`contain`/`cover`/`fill`/`inside`/`outside`) |
| `.crop({ x, y, width?, height? })` | Rectangular crop, clamped to the image |
| `.rotate(angle, background?)` | Exact for multiples of 90, interpolated otherwise |
| `.flip('x' \| 'y')` | Mirror |
| `.filter(spec \| name, amount?)` | `grayscale`, `brightness`, `contrast`, `saturate`, `invert`, `threshold` |
| `.blur(radius \| { radius, type, passes })` | Gaussian (default) or box |
| `.pad(padding, color?)`, `.trim(options?)` | Border in / border out |
| `.composite(image, { x, y, opacity, blendMode })` | `normal` / `multiply` / `screen` |
| `.removeBackground(provider, opts?)` | Any `BackgroundRemovalProvider` |
| `.upscale(provider, { scale })` | Any `UpscaleProvider` |
| `.addOps(ops)` | Escape hatch: append raw worker ops |
| `.toOps()` | Inspect the recorded, JSON-serialisable ops list |

Terminal methods (all accept `{ signal?, onProgress? }`):

| Terminal | Returns |
| --- | --- |
| `.toBlob({ type?, quality?, stripMetadata? })` | `Blob` |
| `.toArrayBuffer(...)` | `ArrayBuffer` |
| `.toDataURL(...)` | `data:` URL string |
| `.toObjectURL(...)` | object URL (remember to revoke it) |
| `.toRaw(...)` | `RawImage` (`{ width, height, data }`) |

Every async API in the library accepts `{ signal?: AbortSignal, onProgress?:
({ phase, ratio, loaded?, total? }) => void }`.

---

## One-shot helpers

```ts
import {
  resizeImage, convertImage, compressImage, cropToAspect,
  generateThumbnail, stripMetadata, getImageInfo,
} from 'picopix';

await resizeImage(file, { width: 800, fit: 'inside', format: 'webp' }); // Blob
await convertImage(file, 'avif', { quality: 0.6 });                    // Blob
await cropToAspect(file, 16 / 9, { anchor: 'center' });                // Blob
await generateThumbnail(file, 160);                                    // Blob, 160x160 cover crop
await stripMetadata(file);                                             // Blob, lossless
await getImageInfo(file);                                              // ImageInfo, no decode
```

`getImageInfo` reads the container only — dimensions, sniffed format, MIME type,
byte size, alpha presence, EXIF orientation, colour-profile presence and the
parsed EXIF (Make/Model/DateTime/GPS flag). Supported snippets: PNG, JPEG, WebP,
GIF, AVIF, BMP, ICO, SVG.

---

## Compress to a target size

```ts
import { compressImage } from 'picopix';

const blob = await compressImage(file, {
  maxSizeKB: 150,       // target budget (1 KB = 1024 bytes)
  minQuality: 0.55,     // never go below this while searching
  maxWidthOrHeight: 2000, // optional cap applied before encoding
  onProgress: ({ ratio }) => console.log(`${Math.round((ratio ?? 0) * 100)}%`),
});
```

How it works: decode + orient once → optionally downscale to
`maxWidthOrHeight` → **binary-search the quality** in `[minQuality, maxQuality]`
for the largest value that fits → if even `minQuality` overshoots, downscale by
`downscaleStep` (default `0.8`) and repeat, stopping at `minWidthOrHeight`
(default `256`) or `maxDownscaleSteps` (default `6`).

If the budget is genuinely unreachable (e.g. 12 KB for a noisy 4000×3000 photo)
the smallest attempt is returned rather than throwing — check `blob.size`
yourself if the budget is a hard requirement.

---

## EXIF handling

Three separate concerns, all handled explicitly:

1. **Reading** — `parseExif(bytes)` / `getImageInfo(input)` return the
   orientation (`1`–`8`), Make, Model, DateTime, DateTimeOriginal and a
   GPS-present flag. The parser is dependency-free (~200 lines of DataView
   code), handles little- and big-endian TIFF headers, JPEG APP1 and PNG `eXIf`.
2. **Fixing pixels** — `applyOrientation(raw, orientation)` for all eight values
   (transpose/transverse included), and `.orient()` in the pipeline, which
   discovers the value from the bytes.
3. **Stripping** — `stripMetadata(blob)` / `stripMetadataBytes(bytes)` rewrite the
   container **without re-encoding**:
   - JPEG: APP1–APP15 and COM removed; SOI/APP0/tables/scan/EOI copied
     byte-for-byte, so decoded pixels are *identical*.
   - PNG: `tEXt`, `iTXt`, `zTXt`, `eXIf`, `tIME`, `pcal`, `sTER` dropped;
     `IHDR`/`PLTE`/`IDAT`/`IEND`/`tRNS`/`iCCP` preserved byte-for-byte.

**Decoder caveat (important):** browsers' `createImageBitmap`/`<img>` and skia
(used by `@napi-rs/canvas`) usually apply EXIF orientation by themselves. To keep
behaviour deterministic, both bundled backends strip the EXIF block from the
bytes they hand to the decoder, and the pipeline then applies the orientation
exactly once. That is why `decode()` never returns pre-rotated pixels, and why
`.orient(false)` really gives you the raw, unrotated image. A custom
`CanvasBackend` you implement should follow the same rule — or you can disable
the automatic step with `.orient(false)`.

---

## Web Workers

The pixel work can be offloaded with an ops list — plain JSON, no closures. This
matters for big resizes (a 12 MPix lanczos3 downscale is ~600 ms of CPU that
would otherwise jank the main thread).

```ts
import { createImageWorker } from 'picopix';

const worker = createImageWorker();               // lazily created

const raw = await worker.process(imageData, [
  { op: 'resize', width: 1200, height: 800, fit: 'cover', kernel: 'lanczos3' },
  { op: 'filter', filter: { type: 'saturate', amount: 1.1 } },
], {
  signal: controller.signal,                      // AbortError on cancel
  timeout: 30_000,                                // TimeoutError when exceeded
  onProgress: (p) => console.log(p.phase, p.ratio),
});

// Decoding/encoding can be offloaded too (uses OffscreenCanvas inside the worker):
const decoded = await worker.decode(file);
const webp = await worker.encode(decoded, { type: 'image/webp', quality: 0.8 });
worker.dispose();
```

Or hand a worker to the pipeline so every `.resize()/.crop()/…` batch runs off
the main thread:

```ts
const worker = createImageWorker();
const blob = await processImage(file, { worker })
  .orient()
  .resize({ width: 1600 })
  .toFormat('webp', { quality: 0.8 })
  .toBlob();
```

Protocol summary (see `src/worker/protocol.ts`):

| Request | Response |
| --- | --- |
| `{ id, kind: 'process', image, ops, progressEvery? }` | `result { image }` + `progress` messages |
| `{ id, kind: 'decode', bytes }` | `result { image }` |
| `{ id, kind: 'encode', image, type, quality }` | `result { bytes, type }` |
| `{ id, kind: 'cancel' }` / `{ id, kind: 'ping' }` | `cancelled` / `pong` |

Buffers are **transferred** (zero-copy) in both directions. Ops are synchronous,
so cancellation is cooperative: it is checked between ops and before replying —
a single huge resize cannot be interrupted mid-kernel.

### Setup per bundler

**Vite** — nothing to configure; Vite understands the `new Worker(new URL(...),
import.meta.url)` pattern used by the default worker factory:

```ts
import { createImageWorker } from 'picopix';
const worker = createImageWorker();          // resolves dist/worker.js automatically

// or point it at your own copy:
const custom = createImageWorker({ workerUrl: new URL('./image-worker.ts', import.meta.url) });
```

**webpack 5** — same pattern works out of the box (asset modules are on by
default):

```ts
const worker = createImageWorker({ workerUrl: new URL('picopix/worker', import.meta.url) });
```

**Plain ESM / no bundler** — serve `node_modules/picopix/dist/` and pass
an explicit URL:

```html
<script type="module">
  import { createImageWorker } from '/node_modules/picopix/dist/index.js';
  const worker = createImageWorker({ workerUrl: '/node_modules/picopix/dist/worker.js' });
</script>
```

**Fallback** — when `Worker` is missing (SSR, a locked-down CSP, an old browser),
`createImageWorker()` silently runs the same ops in-process and reports
`worker.mode === 'fallback'`. Results are byte-identical because both paths call
the same `executeOps`. Use `{ fallback: 'never' }` to throw instead,
`{ fallback: 'always' }` to force in-process, and `createWorkerPool({ size: 4 })`
to spread work over several workers.

---

## ML providers (background removal, upscaling)

The core ships *interfaces*, never models:

```ts
import type {
  BackgroundRemovalProvider, UpscaleProvider,
} from 'picopix';

interface BackgroundRemovalProvider {
  name: string;
  remove(image: RawImage, opts?, signal?): Promise<MaskImage | RawImage>;
}

interface UpscaleProvider {
  name: string;
  scales: number[];
  upscale(image: RawImage, { scale }, signal?, onProgress?): Promise<RawImage>;
}
```

**Providers always run on the thread that created them.** Model sessions (ONNX
Runtime Web, transformers.js, imgly's worker pool) are not structured-cloneable,
so they cannot be sent to `picopix/worker`. Pixel work around a provider
call still runs wherever you configured (`{ worker }` in the pipeline).

### What is actually implemented here

| Provider | Status |
| --- | --- |
| `chromaKeyProvider({ color, tolerance, feather, chromaSpace })` | **Fully implemented and tested** — a model-free keyer with YCbCr chroma distance, smoothstep feathering and optional spill suppression. Fine for green screens, flat studio backdrops, scanned paper. |
| `createMaskProvider(fn)` / `createUpscaleProvider(fn)` | **Implemented and tested** — wrap any function (your own ONNX session, a server round trip) into a provider. |
| `picopix/providers/imgly` | Adapter **tested with a mocked module**. `@imgly/background-removal` is an optional peer, dynamically imported on first use; nothing is downloaded here, so no real end-to-end model run happens in this repo's CI. |
| `picopix/providers/transformers` | Adapter **tested with a mocked pipeline**. Same story: `@huggingface/transformers` `image-segmentation` runs are simulated with fake segmentation results (`maskFromSegmentation` merging, thresholding, inversion and error paths are all covered). |

If you need a real end-to-end ML verification, run the two adapters in your own
app with the peer installed:

```ts
import { processImage } from 'picopix';
import { createImglyProvider } from 'picopix/providers/imgly';

const provider = createImglyProvider({ model: 'isnet_fp16', device: 'gpu' });
const png = await processImage(file).removeBackground(provider).toFormat('png').toBlob();
```

---

## Node usage

`@napi-rs/canvas` is an **optional peer dependency** (native addon, prebuilt
binaries). Register it explicitly — with `sideEffects: false`, a bare
`import 'picopix/node'` may be dropped by your bundler:

```ts
import { setBackend } from 'picopix';
import { nodeBackend, isNodeBackendAvailable } from 'picopix/node';
import { readFile, writeFile } from 'node:fs/promises';

if (!(await isNodeBackendAvailable())) throw new Error('npm i @napi-rs/canvas');
setBackend(nodeBackend);

const { processImage } = await import('picopix');
const input = await readFile('photo.jpg');
const out = await processImage(input)
  .orient()
  .resize({ width: 1200, fit: 'inside' })
  .toFormat('webp', { quality: 0.8 })
  .toArrayBuffer();

await writeFile('photo.webp', Buffer.from(out));
```

`picopix/node` also exports `useNodeBackend()` (async convenience) and
the lower-level `decodeNode` / `encodeNode`. Encoding support in Node:
**PNG, JPEG, WebP, AVIF** (AVIF through skia). Decoding: PNG, JPEG, WebP, GIF,
AVIF, BMP, ICO, SVG.

---

## Tree-shaking and subpaths

| Subpath | Contents | Min+gzip |
| --- | --- | --- |
| `picopix` | pipeline, helpers, codecs, metadata, providers, worker client | 20.4 KB / 18.0 KB brotli |
| `picopix/pixels` | **pure** pixel functions only (no canvas, no codec) | 7.8 KB / 6.8 KB brotli |
| `picopix/node` | Node backend (`@napi-rs/canvas`) + everything | 21.3 KB / 18.6 KB brotli |
| `picopix/worker` | worker entry (module worker) | 11.8 KB / 10.5 KB brotli |
| `picopix/providers/imgly` | imgly adapter | 2.8 KB / 2.5 KB brotli |
| `picopix/providers/transformers` | transformers.js adapter | 3.2 KB / 2.8 KB brotli |

```ts
// Only pulled in what you import:
import { resize } from 'picopix/pixels';        // zero canvas code
import { processImage } from 'picopix';         // full pipeline
```

`sideEffects: false` and named ESM exports mean a bundle that imports only
`resize` contains **no** `OffscreenCanvas`, `getImageData`, EXIF or container
code. This is asserted in CI (`tests/treeshake.test.ts` bundles a tiny entry with
esbuild and fails if any canvas/codec marker appears).

Direct sizes measured with `npm run size` (esbuild, minified, browser target,
optional peers external).

---

## Browser support

| Feature | Chrome | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- |
| Decode (`createImageBitmap`) | 50+ | 79+ | 42+ | 15+ |
| `OffscreenCanvas` (in-worker encode) | 69+ | 79+ | 105+ | 16.4+ |
| PNG encode | ✅ | ✅ | ✅ | ✅ |
| JPEG encode | ✅ | ✅ | ✅ | ✅ |
| **WebP encode** | 23+ | 79+ | 96+ | 14+ (macOS 11+) |
| **AVIF encode** | 85+ (some Linux builds compiled without it) | 85+ | ❌ (no encoder) | 16.4+ (macOS 13+) |
| `OffscreenCanvas.convertToBlob` fallback | uses `<canvas>.toBlob` | same | same | same |

Notes:

- **AVIF is the risky one.** `canEncode('avif')` is a *runtime probe* — it
  actually encodes a 1×1 image, because browsers report `image/avif` support
  inconsistently. In the Chromium 131 headless build used for this repo's
  browser tests, AVIF encode returned **false** while WebP returned **true**.
  Always probe before you promise AVIF output, or pass `format: 'webp'` as the
  fallback.
- **WebP encode on Safari** is available from 14 on macOS 11+, but older
  iOS/Safari will silently fall back to PNG via the canvas; `canEncode` catches
  that.
- Decoding depends on the *browser's* decoders, not on this library: Safari
  cannot decode AVIF before 16.4 and any browser can be told to skip formats.
- In Node, `@napi-rs/canvas` supports PNG/JPEG/WebP/AVIF encode and
  PNG/JPEG/WebP/GIF/AVIF/BMP/ICO/SVG decode. There is no GIF encoder.

---

## Performance and benchmarks

`npm run bench` resizes a synthetic 4000×3000 (12 MPix) RGBA image. Numbers below
are from a **2 vCPU Linux container, Node 20.20.2, x64** — a small machine, so
treat them as *relative* comparisons and re-run on your hardware:

| kernel | target | ms | MPix/s |
| --- | --- | ---: | ---: |
| nearest | 1000×750 | 6 | 2174 |
| bilinear | 1000×750 | 386 | 31.0 |
| catmull-rom | 1000×750 | 517 | 23.2 |
| lanczos3 | 1000×750 | 636 | 18.9 |
| nearest | 400×300 | 1 | 10954 |
| bilinear | 400×300 | 277 | 43.4 |
| catmull-rom | 400×300 | 382 | 31.4 |
| lanczos3 | 400×300 | 547 | 21.9 |
| nearest | 200×200 | 1 | 23642 |
| bilinear | 200×200 | 248 | 48.5 |
| catmull-rom | 200×200 | 354 | 33.9 |
| lanczos3 | 200×200 | 506 | 23.7 |

Upscale 1000×750 → 2000×1500 (lanczos3): 276 ms.

Run-to-run variance on the same machine is roughly ±10 %, so do not read too much
into a single number (the raw output of every run is written to
`.bench/resize.md`).

What this means in practice:

- **Lanczos3 is ~2× bilinear** and ~20 % slower than Catmull-Rom. Use
  `bilinear` for thumbnails/live preview, `catmull-rom` for a good quality/speed
  balance, `lanczos3` for final output.
- **Downscaling dominates**: the cost is set by the *source* pixel count and the
  widened kernel, not by the destination size — which is why 4000×3000 → 200×200
  costs about as much as → 1000×750.
- Anything above ~100 ms should be offloaded with `createImageWorker()`; that is
  roughly a 1000-pixel-wide output from a 12 MPix source on this machine.
- `nearest` is 50–100× faster and is the right choice for masks, pixel art and
  power-of-two operations, but it aliases badly — use it deliberately.

Memory: filtering uses two `Float32Array` scratch buffers of `w*h*4` floats for
the intermediate pass. A 12 MPix image therefore peaks at roughly 12 MPix × 4
channels × 4 bytes ≈ 192 MB for the source plus ~192 MB for the intermediate.
Chunk very large images (or tile them yourself) if that matters.

---

## Limitations

- **No ICC colour management.** Pixels are treated as sRGB; embedded profiles are
  preserved unless you strip metadata. Converting between colour spaces is out of
  scope.
- **Lossless containers only for stripping.** JPEG and PNG rewriting is
  lossless; WebP/AVIF/GIF are returned unchanged by `stripMetadata` (rebuilding
  those containers is not implemented in 0.1).
- **AVIF encode** is environment-dependent (see the matrix above).
- **No animated formats.** GIF/WebP animation frames are not preserved by the
  pipeline; only the first frame is processed.
- **Chromium-only browser tests.** `npm run test:browser` drives Playwright's
  Chromium; Firefox/Safari paths are covered by the simulated worker tests and the
  feature matrix, not by automated browsers here.
- **Provider adapters are mocked in CI.** No model weights are downloaded while
  testing this repository.
- **The ops list is not a full scripting language.** It covers geometry, filters,
  blur, padding, trim, masks and composite — not arbitrary callbacks.
- **Cancellation is cooperative** (between ops), and a single op is not
  interruptible.
- **Worker transfer copies once**: the caller's buffer is cloned before being
  transferred, so `process()` never detaches your `ImageData`.

## Verification status

| Area | How it is verified |
| --- | --- |
| Pure pixel functions, fit math, blend modes, hashes, trim, EXIF parsing, sniffing, lossless stripping | Node + Vitest, exact-value assertions on synthetic images and hand-built byte fixtures (including orientations 1–8 at both endiannesses) |
| Node codec round trips, compress-to-target, EXIF fix on real JPEG fixtures, format sniffing | Vitest against `@napi-rs/canvas` |
| Worker protocol, pool scheduling, cancellation, timeouts, fallback | Vitest, in-process handler with a fake `MessagePort` |
| Worker over a **real thread boundary** | `tests/worker.thread.test.ts` runs the built `dist/worker.js` inside `node:worker_threads` (skips if `dist/` is absent) |
| Browser `OffscreenCanvas` / module `Worker` / WebP encode / AVIF probe | **Real Chromium** via Playwright (`npm run test:browser`) — 14 checks, all passing on Chromium 131 |
| Tree-shaking | esbuild bundle assertion that the `pixels` entry contains no canvas/codec code |
| ML adapters | **Mocked** dynamic imports (imgly + transformers.js); no real model executed |

`npm run test:browser` needs the Playwright browser binary
(`npx playwright install chromium`, plus `--with-deps` on a bare Linux box); it is
not downloaded as part of this npm package. `tests/worker.thread.test.ts` needs
`dist/`, so it skips (rather than fails) when you run `npm test` before
`npm run build`.

## API summary

```ts
// pixels (picopix/pixels)
resize, resizeWithKernel, resizeNearest, resizeTo, computeFitSize, computeTaps,
coverCropRect, aspectCropRect, containScale, coverScale, centerOffset, isEnlargement,
crop, rotate, rotate90, rotate180, rotate270, flip, flipX, flipY, applyOrientation,
pad, trim, trimImage, isBlank,
blur, grayscale, brightness, contrast, saturate, invert, threshold, filter,
composite, applyAlphaMask, setAlphaMask, flatten,
histogram, dominantColors, averageColor, averageHash, hashDistance,
createImage, createMask, cloneImage, assertImage, toPremultiplied, fromPremultiplied,
maskToImage, toMask, getPixel, setPixel, luma, clampByte, clamp, sampleBilinear,
normalizeColor, sameSize

// codec
getDefaultBackend, getBackend, setBackend, canEncode, isBackendAvailable,
browserBackend, nodeBackend, installBrowserBackend, createBrowserCanvas,
formatToMime, normalizeMime, inputToBytes

// metadata
getImageInfo, readImageInfo, sniffFormat, formatToMimeType, parseExif, parseTiff,
readOrientation, findJpegExif, forEachJpegSegment, stripMetadata, stripMetadataBytes,
stripJpegMetadata, stripPngMetadata, strippableFormat

// pipeline & helpers
processImage, ImagePipeline, resizeImage, convertImage, compressImage, cropToAspect,
generateThumbnail

// providers
createMaskProvider, createUpscaleProvider, chromaKeyProvider, chromaKeyMask,
parseColor, suppressSpill, createImglyProvider, createTransformersProvider,
maskFromSegmentation

// worker
createImageWorker, createWorkerPool, executeOps, validateOps, serveWorkerScope,
createWorkerCore

// errors
ImageToolsError, AbortError, TimeoutError, isImageToolsError, isAbortError,
ImageToolsErrorCode
```

## License

MIT © 2026 picopix contributors
