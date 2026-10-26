# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-27

First public release.

### Added

- **Pixels layer** (`picopix/pixels`), pure and DOM-free:
  - `resize` with `nearest`, `bilinear`, `catmull-rom` and `lanczos3` kernels,
    separable filtering in premultiplied alpha, anti-aliased downscaling
    (widened kernel) and `contain`/`cover`/`fill`/`inside`/`outside` fit modes.
  - `crop`, `rotate90/180/270`, `rotate(angle, background)`, `flipX/flipY`,
    `pad`, `trim`/`trimImage`.
  - `blur` (box and multi-pass gaussian approximation), `grayscale`,
    `brightness`, `contrast`, `saturate`, `invert`, `threshold`, `filter`.
  - `composite` (source-over with `normal`/`multiply`/`screen`), `applyAlphaMask`,
    `setAlphaMask`, `flatten`.
  - `histogram`, `dominantColors` (median cut and k-means), `averageColor`,
    `averageHash`, `hashDistance`.
  - `applyOrientation` for all eight EXIF orientation values,
    `computeFitSize`, `coverCropRect`, `aspectCropRect`, `computeTaps`.
- **Codec layer**: `CanvasBackend` interface, `browserBackend`
  (`createImageBitmap` + `OffscreenCanvas`, `HTMLCanvasElement` fallback),
  `nodeBackend` (`@napi-rs/canvas`, optional peer, exported from
  `picopix/node`), `getDefaultBackend`, `setBackend`, `canEncode`.
- **Metadata**: dependency-free EXIF parser (orientation, Make, Model, DateTime,
  DateTimeOriginal, GPS-present flag, raw IFD0 tags), magic-byte format sniffing
  for PNG/JPEG/WebP/GIF/AVIF/BMP/ICO/SVG, `getImageInfo`, and **lossless**
  metadata stripping for JPEG (APP1–APP15 + COM) and PNG
  (tEXt/iTXt/zTXt/eXIf/tIME/pcal/sTER).
- **Pipeline**: `processImage()` chainable API plus `resizeImage`,
  `compressImage`, `convertImage`, `cropToAspect`, `generateThumbnail`,
  `stripMetadata` one-shot helpers.
- **Web Workers**: `createImageWorker()` client with a serialisable ops-list
  protocol, request ids, transferable buffers, `AbortSignal` cancellation,
  timeouts, main-thread fallback, and `createWorkerPool({ size })`. The worker
  entry is a separate `picopix/worker` bundle.
- **Providers**: `BackgroundRemovalProvider` / `UpscaleProvider` interfaces,
  `createMaskProvider`, `createUpscaleProvider`, a fully implemented model-free
  `chromaKeyProvider`, and thin adapters for `@imgly/background-removal`
  (`picopix/providers/imgly`) and `@huggingface/transformers`
  (`picopix/providers/transformers`).
- **Errors**: `ImageToolsError` with stable codes (`UNSUPPORTED_FORMAT`,
  `DECODE_FAILED`, `ENCODE_FAILED`, `ABORTED`, `TIMEOUT`, `BACKEND_UNAVAILABLE`,
  `INVALID_ARGUMENT`, `PROVIDER_FAILED`), plus `AbortError` and `TimeoutError`.
- Tooling: tsup multi-entry build (ESM + CJS + types), strict TypeScript,
  Vitest suites, `npm run bench`, `npm run size`, a Playwright-based
  `npm run test:browser`, and GitHub Actions CI/release workflows.

### Notes

- `avif` encoding depends on the environment: `@napi-rs/canvas` supports it;
  Chromium's headless Linux builds do not (probe with `canEncode('avif')`).
- The ML provider adapters are exercised with mocked modules in CI; no model
  weights are downloaded by this repository.
