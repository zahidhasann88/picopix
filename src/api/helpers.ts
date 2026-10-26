import { invalidArgument, throwIfAborted } from '../errors';
import type { CanvasBackend } from '../codec/backend';
import { formatToMime, getBackend, inputToBytes } from '../codec/backend';
import { sniffFormat } from '../meta/sniff';
import { stripMetadataBytes } from '../meta/strip';
import { flatten } from '../pixels/composite';
import { aspectCropRect } from '../pixels/fit';
import type {
  CallOptions,
  FitMode,
  ImageFormat,
  ImageInput,
  ImageInfo,
  ProgressInfo,
  RawImage,
  ResizeKernel,
} from '../types';
import { processImage, type PipelineOptions } from './pipeline';
import type { ImageWorker } from '../worker/client';

/** Shared options for the one-shot helpers. */
export interface HelperOptions extends CallOptions {
  /** Canvas backend override. */
  backend?: CanvasBackend;
  /** Worker used for the pixel work. */
  worker?: ImageWorker;
  /** Output format (`'webp'`, `'image/webp'`, …). Default: the input format. */
  format?: ImageFormat | string;
  /** Lossy quality `0..1`. */
  quality?: number;
  /** Strip metadata from the output. Default `false`. */
  stripMetadata?: boolean;
}

function baseOptions(options: HelperOptions, fallbackFormat?: string): PipelineOptions {
  const pipelineOptions: PipelineOptions = {};
  if (options.backend) pipelineOptions.backend = options.backend;
  if (options.worker) pipelineOptions.worker = options.worker;
  if (options.signal) pipelineOptions.signal = options.signal;
  if (options.onProgress) pipelineOptions.onProgress = options.onProgress;
  if (options.format) pipelineOptions.format = options.format;
  else if (fallbackFormat) pipelineOptions.format = fallbackFormat;
  if (options.quality !== undefined) pipelineOptions.quality = options.quality;
  if (options.stripMetadata !== undefined) pipelineOptions.stripMetadata = options.stripMetadata;
  return pipelineOptions;
}

async function detectFormat(input: ImageInput): Promise<string | null> {
  try {
    const bytes = await inputToBytes(input);
    const format = sniffFormat(bytes);
    return format === 'unknown' ? null : formatToMime(format);
  } catch {
    return null;
  }
}

/** Options for {@link resizeImage}. */
export interface ResizeImageOptions extends HelperOptions {
  width?: number;
  height?: number;
  fit?: FitMode;
  kernel?: ResizeKernel;
  withoutEnlargement?: boolean;
}

/**
 * One-shot resize. Encodes with the input format (or `format` when given).
 *
 * ```ts
 * const blob = await resizeImage(file, { width: 800, fit: 'inside', format: 'webp' });
 * ```
 */
export async function resizeImage(input: ImageInput, options: ResizeImageOptions = {}): Promise<Blob> {
  return processImage(input, baseOptions(options))
    .orient()
    .resize({
      width: options.width,
      height: options.height,
      fit: options.fit,
      kernel: options.kernel,
      withoutEnlargement: options.withoutEnlargement,
    })
    .toBlob({ signal: options.signal, onProgress: options.onProgress, stripMetadata: options.stripMetadata });
}

/** Options for {@link convertImage}. */
export interface ConvertImageOptions extends HelperOptions {
  quality?: number;
}

/** Converts to another format (optionally re-encoding lossily). */
export async function convertImage(
  input: ImageInput,
  format: ImageFormat | string,
  options: ConvertImageOptions = {},
): Promise<Blob> {
  const mime = formatToMime(format);
  return processImage(input, baseOptions(options, mime))
    .orient()
    .toFormat(format, { quality: options.quality })
    .toBlob({ signal: options.signal, onProgress: options.onProgress, stripMetadata: options.stripMetadata });
}

/** Options for {@link cropToAspect}. */
export interface CropToAspectOptions extends HelperOptions {
  /** Anchor of the crop rectangle. Default `'center'`. */
  anchor?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  quality?: number;
}

/** Centre-crops to an aspect ratio (`16/9`, `1`, `0.8`, …) without resampling. */
export async function cropToAspect(
  input: ImageInput,
  aspect: number,
  options: CropToAspectOptions = {},
): Promise<Blob> {
  if (!(aspect > 0)) throw invalidArgument('cropToAspect(): aspect must be > 0');
  const pipeline = processImage(input, baseOptions(options)).orient();
  // Crop rectangles are computed after orientation, so ask the pipeline for the
  // decoded size first (cheap: decode once, then reuse the pixels).
  const raw = await pipeline.toRaw({ signal: options.signal });
  const rect = aspectCropRect(raw.width, raw.height, aspect);
  const anchor = options.anchor ?? 'center';
  if (anchor !== 'center') {
    const dy = raw.height - rect.height;
    const dx = raw.width - rect.width;
    if (anchor === 'top') rect.y = 0;
    if (anchor === 'bottom') rect.y = dy;
    if (anchor === 'left') rect.x = 0;
    if (anchor === 'right') rect.x = dx;
  }
  const out = processImage(raw, baseOptions(options))
    .crop(rect)
    .toBlob({ signal: options.signal, onProgress: options.onProgress });
  return out;
}

/** Options for {@link generateThumbnail}. */
export interface ThumbnailOptions extends HelperOptions {
  /** Fit strategy. Default `'cover'` (crop to a square). */
  fit?: FitMode;
  kernel?: ResizeKernel;
}

/**
 * Generates a small thumbnail (default `160px`, `cover` cropped, quality `0.8`
 * for lossy formats).
 */
export async function generateThumbnail(
  input: ImageInput,
  size: number | { width?: number; height?: number },
  options: ThumbnailOptions = {},
): Promise<Blob> {
  const box = typeof size === 'number' ? { width: size, height: size } : size;
  if (box.width === undefined && box.height === undefined) {
    throw invalidArgument('generateThumbnail(): size is required');
  }
  const quality = options.quality ?? 0.8;
  return processImage(input, baseOptions(options))
    .orient()
    .resize({
      width: box.width,
      height: box.height,
      fit: options.fit ?? 'cover',
      kernel: options.kernel ?? 'lanczos3',
    })
    .toBlob({ signal: options.signal, onProgress: options.onProgress, quality, stripMetadata: options.stripMetadata });
}

/** Options for {@link stripMetadata}. */
export interface StripMetadataOptions {
  /** Keep the ICC profile. Default `false`. */
  keepColorProfile?: boolean;
  signal?: AbortSignal;
}

/**
 * Removes metadata **losslessly** (no decode, no re-encode):
 * - JPEG: drops APP1–APP15 (EXIF/XMP/ICC) and COM segments
 * - PNG: drops `tEXt`, `iTXt`, `zTXt`, `eXIf`, `tIME`, `pcal`, `sTER`
 *
 * Other containers are returned unchanged. Pixel data is bit-identical.
 */
export async function stripMetadata(input: ImageInput, options: StripMetadataOptions = {}): Promise<Blob> {
  throwIfAborted(options.signal);
  const bytes = await inputToBytes(input);
  const stripped = stripMetadataBytes(bytes, { keepColorProfile: options.keepColorProfile });
  const format = sniffFormat(bytes);
  const type = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'application/octet-stream';
  return new Blob([stripped as unknown as BlobPart], { type });
}

/** Options for {@link compressImage}. */
export interface CompressOptions extends HelperOptions {
  /** Target maximum size in KB (1 KB = 1024 bytes). */
  maxSizeKB?: number;
  /** Never go below this quality while searching. Default `0.4`. */
  minQuality?: number;
  /** Never go above this quality. Default `0.92`. */
  maxQuality?: number;
  /** Downscale so that `max(width, height) <= maxWidthOrHeight` *before* encoding. */
  maxWidthOrHeight?: number;
  /** Stop downscaling at this longest edge. Default `256`. */
  minWidthOrHeight?: number;
  /** Scale applied on each downscale retry. Default `0.8`. */
  downscaleStep?: number;
  /** Extra downscale attempts after quality hits `minQuality`. Default `6`. */
  maxDownscaleSteps?: number;
}

/**
 * Compresses to a byte budget.
 *
 * 1. Decodes + orients once, optionally downscaling to `maxWidthOrHeight`.
 * 2. Binary-searches the quality in `[minQuality, maxQuality]` for the highest
 *    value that fits `maxSizeKB`.
 * 3. If even `minQuality` is too big, downscales by `downscaleStep` and repeats,
 *    stopping at `minWidthOrHeight` or `maxDownscaleSteps`.
 *
 * The result is the smallest number of steps that hits the target; when the
 * target is unreachable the best attempt is returned (never throws for size).
 */
export async function compressImage(input: ImageInput, options: CompressOptions = {}): Promise<Blob> {
  const signal = options.signal;
  const onProgress = options.onProgress;
  throwIfAborted(signal);

  const sourceFormat = await detectFormat(input);
  const targetType = formatToMime(
    options.format ?? (sourceFormat && sourceFormat !== 'image/png' ? sourceFormat : 'image/jpeg'),
  );
  const backend = options.backend ?? (await getBackend());
  if (!(await backend.canEncode(targetType))) {
    throw invalidArgument(`compressImage(): this environment cannot encode '${targetType}'`);
  }

  const minQuality = clamp01(options.minQuality ?? 0.4);
  const maxQuality = clamp01(options.maxQuality ?? 0.92);
  const step = options.downscaleStep ?? 0.8;
  const minEdge = options.minWidthOrHeight ?? 256;
  const maxDownscaleSteps = options.maxDownscaleSteps ?? 6;
  const targetBytes = options.maxSizeKB ? Math.max(1, Math.round(options.maxSizeKB * 1024)) : 0;

  let raw = await processImage(input, {
    backend,
    ...(options.worker ? { worker: options.worker } : {}),
    signal,
  })
    .orient()
    .toRaw({ signal });

  if (options.maxWidthOrHeight && Math.max(raw.width, raw.height) > options.maxWidthOrHeight) {
    const longest = Math.max(raw.width, raw.height);
    const scale = options.maxWidthOrHeight / longest;
    raw = await processImage(raw, { backend })
      .resize({
        width: Math.max(1, Math.round(raw.width * scale)),
        height: Math.max(1, Math.round(raw.height * scale)),
        fit: 'fill',
      })
      .toRaw();
  }

  const encode = async (image: RawImage, quality: number): Promise<Blob> => {
    const prepared = targetType === 'image/jpeg' ? flattenIfTransparent(image) : image;
    return backend.encode(prepared, { type: targetType, quality }, { signal });
  };

  let best: Blob | null = null;
  let current = raw;
  let attempts = 0;

  for (let down = 0; down <= maxDownscaleSteps; down++) {
    throwIfAborted(signal);
    // Binary search quality.
    let lo = minQuality;
    let hi = maxQuality;
    let found: Blob | null = null;
    let bestForSize: Blob | null = null;
    for (let i = 0; i < 8; i++) {
      const q = (lo + hi) / 2;
      const blob = await encode(current, q);
      attempts++;
      onProgress?.({
        phase: 'compress',
        ratio: Math.min(0.99, attempts / 16),
        loaded: blob.size,
        total: targetBytes || undefined,
      } as ProgressInfo);
      if (!targetBytes || blob.size <= targetBytes) {
        found = blob;
        bestForSize = blob;
        lo = q;
        if (hi - lo < 0.03) break;
      } else {
        hi = q;
        if (!bestForSize || blob.size < bestForSize.size) {
          // Slightly-over-target candidates are kept as a fallback.
          if (!best || blob.size < best.size) best = blob;
        }
        if (hi - lo < 0.03) break;
      }
    }
    if (found) {
      onProgress?.({ phase: 'compress', ratio: 1, loaded: found.size, total: targetBytes || undefined });
      return found;
    }
    // Too big even at minQuality → downscale and try again.
    if (Math.max(current.width, current.height) <= minEdge) break;
    const scale = Math.max(0.1, Math.min(0.95, step));
    const width = Math.max(1, Math.round(current.width * scale));
    const height = Math.max(1, Math.round(current.height * scale));
    if (width === current.width && height === current.height) break;
    current = await processImage(current, { backend })
      .resize({ width, height, fit: 'fill', kernel: 'lanczos3' })
      .toRaw();
    onProgress?.({ phase: 'downscale', ratio: Math.min(0.99, (down + 1) / (maxDownscaleSteps + 1)) });
  }

  if (best) {
    onProgress?.({ phase: 'compress', ratio: 1, loaded: best.size, total: targetBytes || undefined });
    return best;
  }
  // No size target: single encode at maxQuality.
  const blob = await encode(current, maxQuality);
  onProgress?.({ phase: 'compress', ratio: 1, loaded: blob.size });
  return blob;
}

function flattenIfTransparent(image: RawImage): RawImage {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] < 255) return flatten(image, { r: 255, g: 255, b: 255 });
  }
  return image;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export { getImageInfo, readImageInfo } from '../meta/info';
export type { ImageInfo };
