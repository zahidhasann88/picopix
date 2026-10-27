/**
 * `picopix/providers/transformers` — adapter for
 * [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers)
 * image segmentation (`pipeline('image-segmentation', model)`).
 *
 * The package is an **optional peer dependency** loaded through a dynamic
 * `import()` on first use. Works with any segmentation model the library
 * supports, e.g. `Xenova/modnet`, `briaai/RMBG-1.4`, `onnx-community/BiRefNet-ONNX`.
 *
 * ```ts
 * import { createTransformersProvider } from 'picopix/providers/transformers';
 * const provider = createTransformersProvider({ model: 'Xenova/modnet' });
 * const blob = await processImage(file).removeBackground(provider).toBlob();
 * ```
 *
 * Runs where it was created (model sessions are not serialisable) — see the
 * README section on workers.
 */
import { ImageToolsError, invalidArgument, throwIfAborted } from "../errors";
import type { RawImage } from "../types";
import type {
  BackgroundRemovalOptions,
  BackgroundRemovalProvider,
} from "./types";

export interface SegmentationResult {
  label: string;
  score?: number;
  mask?: {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    channels?: number;
  };
}

export type SegmentationPipeline = (
  image: unknown,
  options?: Record<string, unknown>,
) => Promise<SegmentationResult[] | SegmentationResult>;

export interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<SegmentationPipeline>;
  RawImage?: {
    new (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      channels: number,
    ): unknown;
    fromURL?: (url: string) => Promise<unknown>;
  };
  env?: Record<string, unknown>;
}

export interface TransformersProviderOptions {
  model: string;
  pipelineOptions?: Record<string, unknown>;
  foregroundLabels?: string[];
  invert?: boolean;
  threshold?: number;
  loadModule?: () => Promise<TransformersModule>;
}

async function defaultLoad(): Promise<TransformersModule> {
  try {
    const mod = (await import(
      "@huggingface/transformers" as string
    )) as unknown as TransformersModule;
    if (typeof mod.pipeline !== "function") {
      throw new Error("@huggingface/transformers does not export pipeline()");
    }
    return mod;
  } catch (error) {
    throw new ImageToolsError(
      "BACKEND_UNAVAILABLE",
      "The transformers provider requires the optional peer dependency `@huggingface/transformers` " +
        "(npm i @huggingface/transformers). It is loaded lazily on first use.",
      error,
    );
  }
}

export function maskFromSegmentation(
  result: SegmentationResult | SegmentationResult[],
  options: {
    foregroundLabels?: string[];
    invert?: boolean;
    threshold?: number;
  } = {},
): { width: number; height: number; data: Uint8ClampedArray } {
  const list = Array.isArray(result) ? result : [result];
  if (list.length === 0)
    throw new ImageToolsError(
      "PROVIDER_FAILED",
      "The segmentation pipeline returned no masks",
    );
  const foreground = options.foregroundLabels;
  const chosen = foreground?.length
    ? list.filter((entry) => foreground.includes(entry.label))
    : list.filter((entry) => entry.label?.toLowerCase() !== "background");
  const entries = chosen.length ? chosen : list;
  const first = entries[0].mask;
  if (!first || !first.data) {
    throw new ImageToolsError(
      "PROVIDER_FAILED",
      "The segmentation result has no mask data",
    );
  }
  const { width, height } = first;
  const channels =
    first.channels ?? (first.data.length === width * height ? 1 : 4);
  const data = new Uint8ClampedArray(width * height);
  const threshold = options.threshold ?? 0.5;
  const invert = options.invert ?? false;

  for (const entry of entries) {
    const mask = entry.mask;
    if (!mask) continue;
    const scaleX = mask.width / width;
    const scaleY = mask.height / height;
    const maskChannels =
      mask.channels ?? (mask.data.length === mask.width * mask.height ? 1 : 4);
    for (let y = 0; y < height; y++) {
      const sy = Math.min(mask.height - 1, Math.floor(y * scaleY));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(mask.width - 1, Math.floor(x * scaleX));
        const si = sy * mask.width + sx;
        const value =
          maskChannels === 1
            ? mask.data[si]
            : mask.data[si * maskChannels + (maskChannels === 4 ? 3 : 0)];
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

function createPipelineLoader(
  options: TransformersProviderOptions,
): () => Promise<{ mod: TransformersModule; segment: SegmentationPipeline }> {
  let loaded: Promise<{
    mod: TransformersModule;
    segment: SegmentationPipeline;
  }> | null = null;
  return () => {
    if (!loaded) {
      loaded = (async () => {
        const load = options.loadModule ?? defaultLoad;
        const mod = await load();
        const segment = await mod.pipeline(
          "image-segmentation",
          options.model,
          options.pipelineOptions,
        );
        return { mod, segment };
      })();
    }
    return loaded;
  };
}

async function toPipelineInput(
  mod: TransformersModule,
  image: RawImage,
): Promise<unknown> {
  if (typeof mod.RawImage === "function") {
    return new mod.RawImage(
      new Uint8ClampedArray(image.data),
      image.width,
      image.height,
      4,
    );
  }
  const { getBackend } = await import("../codec/backend");
  const backend = await getBackend();
  const png = await backend.encode(image, { type: "image/png" });
  const fromURL = (
    mod.RawImage as { fromURL?: (url: string) => Promise<unknown> } | undefined
  )?.fromURL;
  if (!fromURL) return png;
  const url = URL.createObjectURL(png);
  try {
    return await fromURL(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createTransformersProvider(
  options: TransformersProviderOptions,
): BackgroundRemovalProvider {
  if (!options?.model)
    throw invalidArgument("createTransformersProvider: `model` is required");
  const getPipeline = createPipelineLoader(options);

  return {
    name: `transformers:${options.model}`,
    async remove(
      image,
      providerOptions?: BackgroundRemovalOptions,
      signal?: AbortSignal,
    ) {
      if (!image || !image.data)
        throw invalidArgument("transformers provider: expected a RawImage");
      throwIfAborted(signal);
      const { mod, segment } = await getPipeline();
      throwIfAborted(signal);
      const input = await toPipelineInput(mod, image);
      throwIfAborted(signal);
      const result = await segment(
        input,
        providerOptions?.threshold !== undefined
          ? { threshold: providerOptions.threshold }
          : undefined,
      );
      throwIfAborted(signal);
      return maskFromSegmentation(
        result as SegmentationResult | SegmentationResult[],
        {
          foregroundLabels: options.foregroundLabels,
          invert: options.invert,
          threshold: options.threshold ?? 0.5,
        },
      );
    },
  };
}

/** Alias for {@link createTransformersProvider}. */
export const transformersProvider: typeof createTransformersProvider =
  createTransformersProvider;
