/**
 * `image-tools-core/providers/transformers` — adapter for
 * [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers)
 * image segmentation (`pipeline('image-segmentation', model)`).
 *
 * The package is an **optional peer dependency** loaded through a dynamic
 * `import()` on first use. Works with any segmentation model the library
 * supports, e.g. `Xenova/modnet`, `briaai/RMBG-1.4`, `onnx-community/BiRefNet-ONNX`.
 *
 * ```ts
 * import { createTransformersProvider } from 'image-tools-core/providers/transformers';
 * const provider = createTransformersProvider({ model: 'Xenova/modnet' });
 * const blob = await processImage(file).removeBackground(provider).toBlob();
 * ```
 *
 * Runs where it was created (model sessions are not serialisable) — see the
 * README section on workers.
 */
import { ImageToolsError, invalidArgument, throwIfAborted } from '../errors';
import type { RawImage } from '../types';
import type { BackgroundRemovalOptions, BackgroundRemovalProvider } from './types';

/** One entry of the array returned by a segmentation pipeline. */
export interface SegmentationResult {
  label: string;
  score?: number;
  /** Raw mask, `{ data, width, height }` (transformers.js `RawImage`). */
  mask?: { data: Uint8ClampedArray; width: number; height: number; channels?: number };
}

/** The subset of the transformers.js `image-segmentation` pipeline we use. */
export type SegmentationPipeline = (
  image: unknown,
  options?: Record<string, unknown>,
) => Promise<SegmentationResult[] | SegmentationResult>;

export interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<SegmentationPipeline>;
  RawImage?: {
    fromCanvas?: (canvas: unknown) => unknown;
    fromURL?: (url: string) => Promise<unknown>;
  };
  env?: Record<string, unknown>;
}

export interface TransformersProviderOptions {
  /** Model id passed to `pipeline('image-segmentation', model)`. */
  model: string;
  /** Pipeline options (`{ dtype: 'q8', device: 'webgpu' }`, …). */
  pipelineOptions?: Record<string, unknown>;
  /** Which labels count as foreground. Default: everything that is not `'background'`. */
  foregroundLabels?: string[];
  /** Invert the resulting mask. Default `false`. */
  invert?: boolean;
  /** Threshold applied to soft masks, `0..1`. Default `0.5`. */
  threshold?: number;
  /** Override the import (tests / custom bundling). */
  loadModule?: () => Promise<TransformersModule>;
}

async function defaultLoad(): Promise<TransformersModule> {
  try {
    const mod = (await import('@huggingface/transformers' as string)) as unknown as TransformersModule;
    if (typeof mod.pipeline !== 'function') {
      throw new Error('@huggingface/transformers does not export pipeline()');
    }
    return mod;
  } catch (error) {
    throw new ImageToolsError(
      'BACKEND_UNAVAILABLE',
      'The transformers provider requires the optional peer dependency `@huggingface/transformers` ' +
        '(npm i @huggingface/transformers). It is loaded lazily on first use.',
      error,
    );
  }
}

/** Extracts a single-channel mask out of a segmentation result. */
export function maskFromSegmentation(
  result: SegmentationResult | SegmentationResult[],
  options: { foregroundLabels?: string[]; invert?: boolean; threshold?: number } = {},
): { width: number; height: number; data: Uint8ClampedArray } {
  const list = Array.isArray(result) ? result : [result];
  if (list.length === 0) throw new ImageToolsError('PROVIDER_FAILED', 'The segmentation pipeline returned no masks');
  const foreground = options.foregroundLabels;
  const chosen = foreground?.length
    ? list.filter((entry) => foreground.includes(entry.label))
    : list.filter((entry) => entry.label?.toLowerCase() !== 'background');
  const entries = chosen.length ? chosen : list;
  const first = entries[0].mask;
  if (!first || !first.data) {
    throw new ImageToolsError('PROVIDER_FAILED', 'The segmentation result has no mask data');
  }
  const { width, height } = first;
  const channels = first.channels ?? (first.data.length === width * height ? 1 : 4);
  const data = new Uint8ClampedArray(width * height);
  const threshold = options.threshold ?? 0.5;
  const invert = options.invert ?? false;

  for (const entry of entries) {
    const mask = entry.mask;
    if (!mask) continue;
    const scaleX = mask.width / width;
    const scaleY = mask.height / height;
    const maskChannels = mask.channels ?? (mask.data.length === mask.width * mask.height ? 1 : 4);
    for (let y = 0; y < height; y++) {
      const sy = Math.min(mask.height - 1, Math.floor(y * scaleY));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(mask.width - 1, Math.floor(x * scaleX));
        const si = sy * mask.width + sx;
        const value =
          maskChannels === 1 ? mask.data[si] : mask.data[si * maskChannels + (maskChannels === 4 ? 3 : 0)];
        const index = y * width + x;
        data[index] = Math.max(data[index], value);
      }
    }
  }

  if (threshold <= 1) {
    const cut = threshold * 255;
    for (let i = 0; i < data.length; i++) data[i] = data[i] >= cut ? 255 : 0;
  }
  if (invert) {
    for (let i = 0; i < data.length; i++) data[i] = 255 - data[i];
  }
  return { width, height, data };
}

/** Loads the segmentation pipeline once per provider instance. */
function createPipelineLoader(options: TransformersProviderOptions): () => Promise<SegmentationPipeline> {
  let pipelinePromise: Promise<SegmentationPipeline> | null = null;
  return () => {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const load = options.loadModule ?? defaultLoad;
        const mod = await load();
        return mod.pipeline('image-segmentation', options.model, options.pipelineOptions);
      })();
    }
    return pipelinePromise;
  };
}

/**
 * Creates a {@link BackgroundRemovalProvider} backed by transformers.js
 * segmentation. The model is downloaded from the Hugging Face hub on first use
 * (and cached by the library).
 */
export function createTransformersProvider(options: TransformersProviderOptions): BackgroundRemovalProvider {
  if (!options?.model) throw invalidArgument('createTransformersProvider: `model` is required');
  const getPipeline = createPipelineLoader(options);

  return {
    name: `transformers:${options.model}`,
    async remove(image, providerOptions?: BackgroundRemovalOptions, signal?: AbortSignal) {
      if (!image || !image.data) throw invalidArgument('transformers provider: expected a RawImage');
      throwIfAborted(signal);
      const segment = await getPipeline();
      throwIfAborted(signal);

      // transformers.js accepts a RawImage built from a canvas; go through PNG to
      // avoid depending on a specific canvas implementation.
      const { getBackend } = await import('../codec/backend');
      const backend = await getBackend();
      const png = await backend.encode(image as RawImage, { type: 'image/png' });
      const mod = await (options.loadModule ? options.loadModule() : defaultLoad());
      let input: unknown = png;
      if (mod.RawImage?.fromURL) {
        const url = URL.createObjectURL(png);
        try {
          input = await mod.RawImage.fromURL(url);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      throwIfAborted(signal);
      const result = await segment(input, providerOptions?.threshold !== undefined ? { threshold: providerOptions.threshold } : undefined);
      throwIfAborted(signal);
      return maskFromSegmentation(result as SegmentationResult | SegmentationResult[], {
        foregroundLabels: options.foregroundLabels,
        invert: options.invert,
        threshold: options.threshold ?? 0.5,
      });
    },
  };
}

/** Alias for {@link createTransformersProvider}. */
export const transformersProvider = createTransformersProvider;
