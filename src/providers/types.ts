import type { MaskImage, ProgressInfo, RawImage } from '../types';

/** Options accepted by {@link BackgroundRemovalProvider.remove}. */
export interface BackgroundRemovalOptions {
  /** Ask the provider for a soft (anti-aliased) mask. Default provider-specific. */
  soft?: boolean;
  /** Optional hint: the caller only needs `width x height` resolution. */
  outputSize?: { width: number; height: number };
  /** Reserved for provider-specific settings (model name, threshold, …). */
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
  /** Human-readable identifier, e.g. `'imgly'` or `'chroma-key'`. */
  readonly name: string;
  remove(
    image: RawImage,
    options?: BackgroundRemovalOptions,
    signal?: AbortSignal,
  ): Promise<MaskImage | RawImage>;
}

/** Options accepted by {@link UpscaleProvider.upscale}. */
export interface UpscaleOptions {
  /** Requested scale factor; must be one of {@link UpscaleProvider.scales}. */
  scale: number;
  /** Reserved for provider-specific settings. */
  [key: string]: unknown;
}

/**
 * A pluggable "make it bigger" implementation (Real-ESRGAN, SwinIR, …).
 *
 * Upscalers are usually tiled and slow, so providers should honour `signal` and
 * report progress through `onProgress` when they can.
 */
export interface UpscaleProvider {
  readonly name: string;
  /** Scale factors this provider supports, e.g. `[2, 4]`. */
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
