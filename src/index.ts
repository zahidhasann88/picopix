/**
 * `picopix` — browser-first, tree-shakeable image processing core.
 *
 * The main entry re-exports the pipeline API, the one-shot helpers, the codec
 * layer, metadata utilities and the provider interfaces. Pure pixel functions
 * live in `picopix/pixels` so that a bundle which only needs `resize`
 * never sees a `Uint8Array`-to-canvas code path (verified in CI by
 * `tests/treeshake.test.ts`).
 */

// --- errors -----------------------------------------------------------------
export {
  ImageToolsError,
  AbortError,
  TimeoutError,
  isImageToolsError,
  isAbortError,
  type ImageToolsErrorCode,
} from './errors';

// --- types ------------------------------------------------------------------
export type * from './types';

// --- pure pixels (also available from `/pixels`) -----------------------------
export * from './pixels';

// --- codec ------------------------------------------------------------------
export {
  getDefaultBackend,
  getBackend,
  setBackend,
  canEncode,
  isBackendAvailable,
  formatToMime,
  normalizeMime,
  inputToBytes,
  registerBackendDetector,
  registerAsyncBackendDetector,
  type CanvasBackend,
} from './codec/backend';
export {
  browserBackend,
  isBrowserBackendAvailable,
  createBrowserCanvas,
  installBrowserBackend,
} from './codec/browser';

// --- metadata ---------------------------------------------------------------
export { sniffFormat, formatToMimeType } from './meta/sniff';
export { parseExif, parseTiff, readOrientation, findJpegExif, forEachJpegSegment } from './meta/exif';
export {
  stripMetadataBytes,
  stripJpegMetadata,
  stripPngMetadata,
  strippableFormat,
  type StripOptions,
} from './meta/strip';
export { getImageInfo, readImageInfo, readJpegSize } from './meta/info';

// --- pipeline & helpers ------------------------------------------------------
export {
  processImage,
  ImagePipeline,
  type PipelineOptions,
  type OutputOptions,
} from './api/pipeline';
export {
  resizeImage,
  convertImage,
  compressImage,
  cropToAspect,
  generateThumbnail,
  stripMetadata,
  type HelperOptions,
  type ResizeImageOptions,
  type ConvertImageOptions,
  type CropToAspectOptions,
  type ThumbnailOptions,
  type StripMetadataOptions,
  type CompressOptions,
} from './api/helpers';

// --- providers --------------------------------------------------------------
export {
  createMaskProvider,
  createUpscaleProvider,
} from './providers/factory';
export {
  chromaKeyProvider,
  chromaKeyMask,
  parseColor,
  suppressSpill,
  type ChromaKeyOptions,
} from './providers/chroma';
export type {
  BackgroundRemovalProvider,
  BackgroundRemovalOptions,
  UpscaleProvider,
  UpscaleOptions,
  MaskProviderFn,
  UpscaleProviderFn,
} from './providers/types';

// --- worker (client side only; the worker bundle is `picopix/worker`) -
export {
  createImageWorker,
  createWorkerPool,
  type ImageWorker,
  type ImageWorkerOptions,
  type ImageWorkerPool,
  type WorkerPoolOptions,
  type RunOptions,
} from './worker/client';
export { executeOps, validateOps } from './worker/execute';
export type { WorkerOp, WorkerRequest, WorkerResponse } from './worker/protocol';
