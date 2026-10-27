import type { MaskImage, ProgressInfo, RawImage } from "../types";

export interface BackgroundRemovalOptions {
  soft?: boolean;
  outputSize?: { width: number; height: number };
  [key: string]: unknown;
}

/**
 * A pluggable "remove the background" implementation.
 *
 * Providers live in **your** bundle, not in this library: `picopix` only
 * defines the contract, so heavy ML (ONNX Runtime Web, transformers.js,
 * `@imgly/background-removal`, a server round trip…) stays out of the core.
 *
 * `remove()` may return either:
 * - a single-channel {@link MaskImage} (`0` = background, `255` = subject), or
 * - an RGBA {@link RawImage} where the alpha channel carries the cutout.
 *
 * Both are normalised by the pipeline, so either is fine.
 */
export interface BackgroundRemovalProvider {
  readonly name: string;
  remove(
    image: RawImage,
    options?: BackgroundRemovalOptions,
    signal?: AbortSignal,
  ): Promise<MaskImage | RawImage>;
}

export interface UpscaleOptions {
  /** Requested scale factor; must be one of {@link UpscaleProvider.scales}. */
  scale: number;
  [key: string]: unknown;
}

export interface UpscaleProvider {
  readonly name: string;
  readonly scales: number[];
  upscale(
    image: RawImage,
    options: UpscaleOptions,
    signal?: AbortSignal,
    onProgress?: (progress: ProgressInfo) => void,
  ): Promise<RawImage>;
}

/** A provider function accepted by {@link createMaskProvider}. */
export type MaskProviderFn = (
  image: RawImage,
  options?: BackgroundRemovalOptions,
  signal?: AbortSignal,
) => Promise<MaskImage | RawImage> | MaskImage | RawImage;

/** A provider function accepted by {@link createUpscaleProvider}. */
export type UpscaleProviderFn = (
  image: RawImage,
  options: UpscaleOptions,
  signal?: AbortSignal,
  onProgress?: (progress: ProgressInfo) => void,
) => Promise<RawImage> | RawImage;
