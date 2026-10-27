import { invalidArgument, throwIfAborted } from "../errors";
import type { CanvasBackend } from "../codec/backend";
import {
  bytesToBase64,
  formatToMime,
  getBackend,
  inputToBytes,
} from "../codec/backend";
import { sniffFormat } from "../meta/sniff";
import { stripMetadataBytes } from "../meta/strip";
import { flatten } from "../pixels/composite";
import { averageColor } from "../pixels/analysis";
import { aspectCropRect } from "../pixels/fit";
import { thumbHash, thumbHashToDataURL } from "../pixels/thumbhash";
import type {
  CallOptions,
  FitMode,
  ImageFormat,
  ImageInput,
  ProgressInfo,
  RawImage,
  ResizeKernel,
  RGBA,
} from "../types";
import { processImage, type PipelineOptions } from "./pipeline";
import type { ImageWorker } from "../worker/client";

export interface HelperOptions extends CallOptions {
  backend?: CanvasBackend;
  worker?: ImageWorker;
  format?: ImageFormat | string;
  quality?: number;
  stripMetadata?: boolean;
}

function baseOptions(
  options: HelperOptions,
  fallbackFormat?: string,
): PipelineOptions {
  const pipelineOptions: PipelineOptions = {};
  if (options.backend) pipelineOptions.backend = options.backend;
  if (options.worker) pipelineOptions.worker = options.worker;
  if (options.signal) pipelineOptions.signal = options.signal;
  if (options.onProgress) pipelineOptions.onProgress = options.onProgress;
  if (options.format) pipelineOptions.format = options.format;
  else if (fallbackFormat) pipelineOptions.format = fallbackFormat;
  if (options.quality !== undefined) pipelineOptions.quality = options.quality;
  if (options.stripMetadata !== undefined)
    pipelineOptions.stripMetadata = options.stripMetadata;
  return pipelineOptions;
}

const REENCODABLE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);

async function detectFormat(input: ImageInput): Promise<string | null> {
  try {
    const bytes = await inputToBytes(input);
    const format = sniffFormat(bytes);
    return format === "unknown" ? null : formatToMime(format);
  } catch {
    return null;
  }
}

export interface ResizeImageOptions extends HelperOptions {
  width?: number;
  height?: number;
  fit?: FitMode;
  kernel?: ResizeKernel;
  withoutEnlargement?: boolean;
}

export async function resizeImage(
  input: ImageInput,
  options: ResizeImageOptions = {},
): Promise<Blob> {
  return processImage(input, baseOptions(options))
    .orient()
    .resize({
      width: options.width,
      height: options.height,
      fit: options.fit,
      kernel: options.kernel,
      withoutEnlargement: options.withoutEnlargement,
    })
    .toBlob({
      signal: options.signal,
      onProgress: options.onProgress,
      stripMetadata: options.stripMetadata,
    });
}

export interface ConvertImageOptions extends HelperOptions {
  quality?: number;
}

export async function convertImage(
  input: ImageInput,
  format: ImageFormat | string,
  options: ConvertImageOptions = {},
): Promise<Blob> {
  const mime = formatToMime(format);
  return processImage(input, baseOptions(options, mime))
    .orient()
    .toFormat(format, { quality: options.quality })
    .toBlob({
      signal: options.signal,
      onProgress: options.onProgress,
      stripMetadata: options.stripMetadata,
    });
}

export interface CropToAspectOptions extends HelperOptions {
  anchor?: "center" | "top" | "bottom" | "left" | "right";
  quality?: number;
}

export async function cropToAspect(
  input: ImageInput,
  aspect: number,
  options: CropToAspectOptions = {},
): Promise<Blob> {
  if (!(aspect > 0))
    throw invalidArgument("cropToAspect(): aspect must be > 0");
  const sourceFormat = await detectFormat(input);
  const keepFormat =
    sourceFormat && REENCODABLE_MIMES.has(sourceFormat)
      ? sourceFormat
      : "image/png";
  const pipeline = processImage(input, baseOptions(options)).orient();
  const raw = await pipeline.toRaw({ signal: options.signal });
  const rect = aspectCropRect(raw.width, raw.height, aspect);
  const anchor = options.anchor ?? "center";
  if (anchor !== "center") {
    const dy = raw.height - rect.height;
    const dx = raw.width - rect.width;
    if (anchor === "top") rect.y = 0;
    if (anchor === "bottom") rect.y = dy;
    if (anchor === "left") rect.x = 0;
    if (anchor === "right") rect.x = dx;
  }
  return processImage(raw, baseOptions(options, keepFormat))
    .crop(rect)
    .toBlob({ signal: options.signal, onProgress: options.onProgress });
}

export interface ThumbnailOptions extends HelperOptions {
  /** Fit strategy. Default `'cover'` (crop to a square). */
  fit?: FitMode;
  kernel?: ResizeKernel;
}

export async function generateThumbnail(
  input: ImageInput,
  size: number | { width?: number; height?: number },
  options: ThumbnailOptions = {},
): Promise<Blob> {
  const box = typeof size === "number" ? { width: size, height: size } : size;
  if (box.width === undefined && box.height === undefined) {
    throw invalidArgument("generateThumbnail(): size is required");
  }
  const quality = options.quality ?? 0.8;
  return processImage(input, baseOptions(options))
    .orient()
    .resize({
      width: box.width,
      height: box.height,
      fit: options.fit ?? "cover",
      kernel: options.kernel ?? "lanczos3",
    })
    .toBlob({
      signal: options.signal,
      onProgress: options.onProgress,
      quality,
      stripMetadata: options.stripMetadata,
    });
}

export interface StripMetadataOptions {
  keepColorProfile?: boolean;
  signal?: AbortSignal;
}

export async function stripMetadata(
  input: ImageInput,
  options: StripMetadataOptions = {},
): Promise<Blob> {
  throwIfAborted(options.signal);
  const bytes = await inputToBytes(input);
  const stripped = stripMetadataBytes(bytes, {
    keepColorProfile: options.keepColorProfile,
  });
  const format = sniffFormat(bytes);
  const type =
    format === "jpeg"
      ? "image/jpeg"
      : format === "png"
        ? "image/png"
        : "application/octet-stream";
  return new Blob([stripped as unknown as BlobPart], { type });
}

export interface CompressOptions extends HelperOptions {
  maxSizeKB?: number;
  minQuality?: number;
  maxQuality?: number;
  maxWidthOrHeight?: number;
  minWidthOrHeight?: number;
  downscaleStep?: number;
  maxDownscaleSteps?: number;
}

/**
 * Binary-searches the quality for the largest value that fits `maxSizeKB`,
 * downscaling by `downscaleStep` when even `minQuality` is too big. When the
 * target is unreachable the smallest attempt is returned instead of throwing.
 */
export async function compressImage(
  input: ImageInput,
  options: CompressOptions = {},
): Promise<Blob> {
  const signal = options.signal;
  const onProgress = options.onProgress;
  throwIfAborted(signal);

  const sourceFormat = await detectFormat(input);
  const lossySource =
    sourceFormat &&
    sourceFormat !== "image/png" &&
    REENCODABLE_MIMES.has(sourceFormat);
  const targetType = formatToMime(
    options.format ?? (lossySource ? sourceFormat : "image/jpeg"),
  );
  const backend = options.backend ?? (await getBackend());
  if (!(await backend.canEncode(targetType))) {
    throw invalidArgument(
      `compressImage(): this environment cannot encode '${targetType}'`,
    );
  }

  const minQuality = clamp01(options.minQuality ?? 0.4);
  const maxQuality = clamp01(options.maxQuality ?? 0.92);
  const step = options.downscaleStep ?? 0.8;
  const minEdge = options.minWidthOrHeight ?? 256;
  const maxDownscaleSteps = options.maxDownscaleSteps ?? 6;
  const targetBytes = options.maxSizeKB
    ? Math.max(1, Math.round(options.maxSizeKB * 1024))
    : 0;

  let raw = await processImage(input, {
    backend,
    ...(options.worker ? { worker: options.worker } : {}),
    signal,
  })
    .orient()
    .toRaw({ signal });

  if (
    options.maxWidthOrHeight &&
    Math.max(raw.width, raw.height) > options.maxWidthOrHeight
  ) {
    const longest = Math.max(raw.width, raw.height);
    const scale = options.maxWidthOrHeight / longest;
    raw = await processImage(raw, { backend })
      .resize({
        width: Math.max(1, Math.round(raw.width * scale)),
        height: Math.max(1, Math.round(raw.height * scale)),
        fit: "fill",
      })
      .toRaw();
  }

  const encode = async (image: RawImage, quality: number): Promise<Blob> => {
    const prepared =
      targetType === "image/jpeg" ? flattenIfTransparent(image) : image;
    return backend.encode(prepared, { type: targetType, quality }, { signal });
  };

  if (!targetBytes) {
    const blob = await encode(raw, maxQuality);
    onProgress?.({ phase: "compress", ratio: 1, loaded: blob.size });
    return blob;
  }

  let best: Blob | null = null;
  let current = raw;
  let attempts = 0;

  for (let down = 0; down <= maxDownscaleSteps; down++) {
    throwIfAborted(signal);
    let lo = minQuality;
    let hi = maxQuality;
    let found: Blob | null = null;
    for (let i = 0; i < 8; i++) {
      const q = (lo + hi) / 2;
      const blob = await encode(current, q);
      attempts++;
      onProgress?.({
        phase: "compress",
        ratio: Math.min(0.99, attempts / 16),
        loaded: blob.size,
        total: targetBytes,
      } as ProgressInfo);
      if (blob.size <= targetBytes) {
        found = blob;
        lo = q;
      } else {
        hi = q;
        if (!best || blob.size < best.size) best = blob;
      }
      if (hi - lo < 0.03) break;
    }
    if (found) {
      onProgress?.({
        phase: "compress",
        ratio: 1,
        loaded: found.size,
        total: targetBytes,
      });
      return found;
    }
    if (Math.max(current.width, current.height) <= minEdge) break;
    const scale = Math.max(0.1, Math.min(0.95, step));
    const width = Math.max(1, Math.round(current.width * scale));
    const height = Math.max(1, Math.round(current.height * scale));
    if (width === current.width && height === current.height) break;
    current = await processImage(current, { backend })
      .resize({ width, height, fit: "fill", kernel: "lanczos3" })
      .toRaw();
    onProgress?.({
      phase: "downscale",
      ratio: Math.min(0.99, (down + 1) / (maxDownscaleSteps + 1)),
    });
  }

  onProgress?.({
    phase: "compress",
    ratio: 1,
    loaded: best!.size,
    total: targetBytes,
  });
  return best!;
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

export interface SrcSetOptions extends HelperOptions {
  /** Target widths in pixels. Default `[320, 640, 960, 1280, 1920]`. */
  widths?: number[];
  kernel?: ResizeKernel;
  /**
   * Skip widths larger than the source (the source width is emitted once
   * instead). Default `true`.
   */
  withoutEnlargement?: boolean;
}

export interface SrcSetEntry {
  width: number;
  height: number;
  blob: Blob;
  /** The `srcset` width descriptor, e.g. `'640w'`. */
  descriptor: string;
}

/**
 * Produces one resized file per width for `<img srcset>`, decoding and
 * orienting the input only once. Entries are sorted by width and
 * de-duplicated. Output keeps the input format (PNG for formats that can't be
 * re-encoded) unless `format` is given.
 */
export async function generateSrcSet(
  input: ImageInput,
  options: SrcSetOptions = {},
): Promise<SrcSetEntry[]> {
  const requested = options.widths ?? [320, 640, 960, 1280, 1920];
  if (
    requested.length === 0 ||
    requested.some((w) => !Number.isFinite(w) || w < 1)
  ) {
    throw invalidArgument(
      "generateSrcSet(): widths must be a non-empty list of positive numbers",
    );
  }
  const sourceFormat = options.format
    ? undefined
    : await detectFormat(input);
  const keepFormat =
    sourceFormat && REENCODABLE_MIMES.has(sourceFormat)
      ? sourceFormat
      : "image/png";
  const raw = await processImage(input, baseOptions(options))
    .orient()
    .toRaw({ signal: options.signal });

  const withoutEnlargement = options.withoutEnlargement ?? true;
  const widths = [
    ...new Set(
      requested.map((w) => {
        const width = Math.round(w);
        return withoutEnlargement ? Math.min(width, raw.width) : width;
      }),
    ),
  ].sort((a, b) => a - b);

  const entries: SrcSetEntry[] = [];
  for (const [index, width] of widths.entries()) {
    throwIfAborted(options.signal);
    const height = Math.max(1, Math.round((raw.height * width) / raw.width));
    const pipeline = processImage(raw, baseOptions(options, keepFormat));
    if (width !== raw.width) {
      pipeline.resize({
        width,
        height,
        fit: "fill",
        kernel: options.kernel ?? "lanczos3",
      });
    }
    const blob = await pipeline.toBlob({
      signal: options.signal,
      stripMetadata: options.stripMetadata,
    });
    entries.push({ width, height, blob, descriptor: `${width}w` });
    options.onProgress?.({
      phase: "encode",
      ratio: (index + 1) / widths.length,
    });
  }
  return entries;
}

export type PlaceholderOptions = Pick<
  HelperOptions,
  "backend" | "worker" | "signal"
>;

export interface Placeholder {
  /** The raw ThumbHash bytes (~20–25 bytes). */
  hash: Uint8Array;
  /** `hash` as base64 — the compact form to store in a database or JSON. */
  base64: string;
  /** A tiny PNG data URL decoded from the hash, ready for `<img src>`. */
  dataURL: string;
  /** Size of the oriented source image, for reserving layout space. */
  width: number;
  height: number;
  averageColor: RGBA;
}

/**
 * Decodes an image and returns its ThumbHash placeholder. Store `base64` and
 * call `thumbHashToDataURL` on the client, or use `dataURL` directly.
 */
export async function generatePlaceholder(
  input: ImageInput,
  options: PlaceholderOptions = {},
): Promise<Placeholder> {
  const pipelineOptions: PipelineOptions = {};
  if (options.backend) pipelineOptions.backend = options.backend;
  if (options.worker) pipelineOptions.worker = options.worker;
  if (options.signal) pipelineOptions.signal = options.signal;
  const raw = await processImage(input, pipelineOptions)
    .orient()
    .toRaw({ signal: options.signal });
  const hash = thumbHash(raw);
  return {
    hash,
    base64: bytesToBase64(hash),
    dataURL: thumbHashToDataURL(hash),
    width: raw.width,
    height: raw.height,
    averageColor: averageColor(raw),
  };
}
