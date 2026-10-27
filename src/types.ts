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

export interface MaskImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type ResizeKernel = "nearest" | "bilinear" | "catmull-rom" | "lanczos3";

export type FitMode = "contain" | "cover" | "fill" | "inside" | "outside";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type FlipAxis = "x" | "y";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export type BlendMode = "normal" | "multiply" | "screen";
export interface ProgressInfo {
  phase: string;
  ratio?: number;
  loaded?: number;
  total?: number;
}
export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProgressInfo) => void;
}

export type ImageInput =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | string
  | RawImage;

export interface EncodeOptions {
  type: string;
  quality?: number;
}

export type ImageFormat = "png" | "jpeg" | "webp" | "avif";

/** Options for {@link resize} and `pipeline.resize()`. */
export interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: FitMode;
  kernel?: ResizeKernel;
  withoutEnlargement?: boolean;
  antialias?: boolean;
}

export interface CropOptions extends Partial<Rect> {
  width?: number;
  height?: number;
}

export interface RotateOptions {
  background?: RGBA;
}

export interface BlurOptions {
  radius: number;
  type?: "box" | "gaussian";
  passes?: number;
}

export interface SharpenOptions {
  /** Strength; 0 is a no-op. Default `1`. */
  amount?: number;
  /** Blur radius of the unsharp mask, in pixels. Default `1`. */
  radius?: number;
  /** Ignore differences below this (0–255). Default `0`. */
  threshold?: number;
}

export interface CompositeOptions {
  x?: number;
  y?: number;
  opacity?: number;
  blendMode?: BlendMode;
}

export interface TrimOptions {
  threshold?: number;
  color?: RGBA;
  alpha?: boolean;
}

export interface DominantColorsOptions {
  count?: number;
  sampleStep?: number;
  method?: "median-cut" | "kmeans";
  alphaThreshold?: number;
}

export interface DominantColor {
  r: number;
  g: number;
  b: number;
  hex: string;
  count: number;
  ratio: number;
}

export interface Histogram {
  r: number[];
  g: number[];
  b: number[];
  a: number[];
  luma: number[];
  pixels: number;
}

export interface AverageHash {
  width: number;
  height: number;
  bits: string;
  hex: string;
  data: Uint8Array;
}

export type ImageFormatId =
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "avif"
  | "bmp"
  | "ico"
  | "svg"
  | "unknown";

export interface ExifData {
  orientation: number;
  make?: string;
  model?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  hasGps: boolean;
  tags: Record<number, string | number>;
}

export interface ImageInfo {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  format: ImageFormatId;
  mimeType: string | null;
  size: number;
  hasAlpha: boolean | null;
  orientation: number;
  hasColorProfile: boolean;
  hasExif: boolean;
  exif: ExifData | null;
}
