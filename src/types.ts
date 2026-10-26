/**
 * Public type surface for `picopix`.
 *
 * Everything in this file is type-only (no runtime code) so it can be imported
 * from any subpath without pulling in an implementation.
 */

/**
 * A decoded, in-memory RGBA image.
 *
 * This is deliberately *not* the DOM `ImageData` type: it is a plain object that
 * can be created, structured-cloned, transferred and inspected off the main
 * thread — and in Node without a DOM. It is structurally compatible with
 * `ImageData` (`new ImageData(raw.data, raw.width, raw.height)` works).
 *
 * - `data.length === width * height * 4`
 * - channel order is R, G, B, A, row-major, top-left origin
 * - channels are **straight (un-premultiplied)** 8-bit values
 */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * A single-channel (8-bit) coverage mask: `data.length === width * height`.
 * `0` = fully transparent, `255` = fully opaque.
 */
export interface MaskImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Resampling kernels supported by {@link resize}. */
export type ResizeKernel = 'nearest' | 'bilinear' | 'catmull-rom' | 'lanczos3';

/** CSS-like fit strategies, same semantics as `object-fit`. */
export type FitMode = 'contain' | 'cover' | 'fill' | 'inside' | 'outside';

/** Integer pixel rectangle. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Size in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Flip axis: `'x'` mirrors left/right, `'y'` mirrors top/bottom. */
export type FlipAxis = 'x' | 'y';

/** Straight-alpha colour, each channel `0..255`. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** Blend modes supported by {@link composite}. */
export type BlendMode = 'normal' | 'multiply' | 'screen';

/** Progress callback payload, shared by every async API. */
export interface ProgressInfo {
  /** Coarse phase name, e.g. `'decode' | 'ops' | 'encode' | 'provider'`. */
  phase: string;
  /** Fraction complete in `0..1` when known. */
  ratio?: number;
  /** Present for provider steps that report granular progress. */
  loaded?: number;
  total?: number;
}

/** Common per-call options accepted by every async API. */
export interface CallOptions {
  /** Cancels the operation; pending promises reject with `AbortError`. */
  signal?: AbortSignal;
  /** Coarse progress reporting. */
  onProgress?: (progress: ProgressInfo) => void;
}

/** Accepted input shapes for every async API. */
export type ImageInput =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | string
  | RawImage;

/** Encoding options for {@link CanvasBackend.encode}. */
export interface EncodeOptions {
  /** MIME type, e.g. `'image/png'`, `'image/jpeg'`, `'image/webp'`, `'image/avif'`. */
  type: string;
  /** Lossy quality in `0..1` (ignored by lossless encoders). */
  quality?: number;
}

/** Output image format accepted by the pipeline / helpers. */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif';

/** Options for {@link resize} and `pipeline.resize()`. */
export interface ResizeOptions {
  /** Target width. If omitted it is derived from `height` and the aspect ratio. */
  width?: number;
  /** Target height. If omitted it is derived from `width` and the aspect ratio. */
  height?: number;
  /** How to reconcile the target box with the source aspect ratio. Default `'fill'`. */
  fit?: FitMode;
  /** Kernel used for resampling. Default `'lanczos3'`. */
  kernel?: ResizeKernel;
  /** Do not scale the image up. Default `false`. */
  withoutEnlargement?: boolean;
  /**
   * Widen the kernel when downscaling so that every source pixel contributes
   * (proper anti-aliasing). Default `true`.
   */
  antialias?: boolean;
}

/** Options for {@link crop}. */
export interface CropOptions extends Partial<Rect> {
  /** Width; defaults to the remaining width. */
  width?: number;
  /** Height; defaults to the remaining height. */
  height?: number;
}

/** Options for {@link rotate}. */
export interface RotateOptions {
  /** Background colour used to fill the corners. Default transparent black. */
  background?: RGBA;
}

/** Options for {@link blur}. */
export interface BlurOptions {
  /** Box radius in pixels for `'box'`; sigma for `'gaussian'`. */
  radius: number;
  /** Blur algorithm. Default `'gaussian'`. */
  type?: 'box' | 'gaussian';
  /** Number of box passes used to approximate a gaussian. Default `3`. */
  passes?: number;
}

/** Options for {@link composite}. */
export interface CompositeOptions {
  /** Destination offset, default `0,0`. */
  x?: number;
  y?: number;
  /** Extra opacity multiplier in `0..1`, default `1`. */
  opacity?: number;
  /** Blend mode, default `'normal'`. */
  blendMode?: BlendMode;
}

/** Options for {@link trim}. */
export interface TrimOptions {
  /**
   * Colour distance above which a pixel counts as content, `0..255`.
   * Default `0` for alpha trimming, `10` for colour trimming.
   */
  threshold?: number;
  /** Fixed background colour to trim. Default: sample the four corners. */
  color?: RGBA;
  /** Consider only alpha when deciding what is content. Default `true` when no `color` given. */
  alpha?: boolean;
}

/** Options for {@link dominantColors}. */
export interface DominantColorsOptions {
  /** Number of clusters to return. Default `5`. */
  count?: number;
  /** Sample every Nth pixel; `0` = auto (aim for ~40k samples). Default `0`. */
  sampleStep?: number;
  /** Algorithm. Default `'median-cut'`. */
  method?: 'median-cut' | 'kmeans';
  /** Ignore pixels below this alpha. Default `16`. */
  alphaThreshold?: number;
}

/** One entry returned by {@link dominantColors}. */
export interface DominantColor {
  r: number;
  g: number;
  b: number;
  /** `#rrggbb` */
  hex: string;
  /** Number of sampled pixels assigned to this cluster. */
  count: number;
  /** `count / totalSampled`, in `0..1`. */
  ratio: number;
}

/** Per-channel 256-bin histogram plus a luma histogram. */
export interface Histogram {
  r: number[];
  g: number[];
  b: number[];
  a: number[];
  luma: number[];
  /** Total number of pixels counted. */
  pixels: number;
}

/** Result of {@link averageHash}. */
export interface AverageHash {
  /** Hash width in bits. */
  width: number;
  height: number;
  /** Bit string, row-major, `'1'`/`'0'`, length `width * height`. */
  bits: string;
  /** Hex representation (row-major, zero padded). */
  hex: string;
  /** Packed bits, one bit per pixel, MSB first. */
  data: Uint8Array;
}

/** Image formats detected by {@link sniffFormat}. */
export type ImageFormatId =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'avif'
  | 'bmp'
  | 'ico'
  | 'svg'
  | 'unknown';

/** EXIF data extracted without any dependency. */
export interface ExifData {
  /** EXIF orientation, `1..8`. `1` means "already upright". */
  orientation: number;
  /** Camera manufacturer (tag 0x010F). */
  make?: string;
  /** Camera model (tag 0x0110). */
  model?: string;
  /** `DateTime` tag (0x0132), raw EXIF string, e.g. `'2024:01:31 10:11:12'`. */
  dateTime?: string;
  /** `DateTimeOriginal` (0x9003) when present. */
  dateTimeOriginal?: string;
  /** `true` when a GPS IFD is present (no coordinates are decoded). */
  hasGps: boolean;
  /** Raw tag map for IFD0 (`tagId -> value`). */
  tags: Record<number, string | number>;
}

/** Result of {@link getImageInfo}. */
export interface ImageInfo {
  /** Pixel width as stored (before EXIF orientation is applied). */
  width: number;
  height: number;
  /** Width/height after applying EXIF orientation. */
  displayWidth: number;
  displayHeight: number;
  format: ImageFormatId;
  /** MIME type for `format`, e.g. `'image/jpeg'`; `null` for unknown/SVG. */
  mimeType: string | null;
  /** Byte length of the encoded input. */
  size: number;
  /** `true`/`false` when the container exposes it, `null` when unknown without a full decode. */
  hasAlpha: boolean | null;
  /** EXIF orientation, `1` when absent or not applicable. */
  orientation: number;
  /** `true` when an ICC colour profile is embedded. */
  hasColorProfile: boolean;
  /** `true` when EXIF metadata is present at all. */
  hasExif: boolean;
  exif: ExifData | null;
}
