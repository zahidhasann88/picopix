export {
  ImageToolsError,
  AbortError,
  TimeoutError,
  isImageToolsError,
  isAbortError,
  type ImageToolsErrorCode,
} from "./errors";

export type * from "./types";

export * from "./pixels";

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
} from "./codec/backend";
export {
  browserBackend,
  isBrowserBackendAvailable,
  createBrowserCanvas,
  installBrowserBackend,
} from "./codec/browser";

export { sniffFormat, formatToMimeType } from "./meta/sniff";
export {
  parseExif,
  parseTiff,
  readOrientation,
  findJpegExif,
  forEachJpegSegment,
} from "./meta/exif";
export {
  stripMetadataBytes,
  stripJpegMetadata,
  stripPngMetadata,
  strippableFormat,
  type StripOptions,
} from "./meta/strip";
export { getImageInfo, readImageInfo, readJpegSize } from "./meta/info";

export {
  processImage,
  ImagePipeline,
  type PipelineOptions,
  type OutputOptions,
} from "./api/pipeline";
export {
  resizeImage,
  convertImage,
  compressImage,
  cropToAspect,
  generateThumbnail,
  stripMetadata,
  generateSrcSet,
  generatePlaceholder,
  type HelperOptions,
  type ResizeImageOptions,
  type ConvertImageOptions,
  type CropToAspectOptions,
  type ThumbnailOptions,
  type StripMetadataOptions,
  type CompressOptions,
  type SrcSetOptions,
  type SrcSetEntry,
  type PlaceholderOptions,
  type Placeholder,
} from "./api/helpers";

export { createMaskProvider, createUpscaleProvider } from "./providers/factory";
export {
  chromaKeyProvider,
  chromaKeyMask,
  parseColor,
  suppressSpill,
  type ChromaKeyOptions,
} from "./providers/chroma";
export type {
  BackgroundRemovalProvider,
  BackgroundRemovalOptions,
  UpscaleProvider,
  UpscaleOptions,
  MaskProviderFn,
  UpscaleProviderFn,
} from "./providers/types";

export {
  createImageWorker,
  createWorkerPool,
  type ImageWorker,
  type ImageWorkerOptions,
  type ImageWorkerPool,
  type WorkerPoolOptions,
  type RunOptions,
} from "./worker/client";
export { executeOps, validateOps } from "./worker/execute";
export type {
  WorkerOp,
  WorkerRequest,
  WorkerResponse,
} from "./worker/protocol";
