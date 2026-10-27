import { invalidArgument, throwIfAborted } from "../errors";
import type { MaskImage, ProgressInfo, RawImage } from "../types";
import type {
  BackgroundRemovalOptions,
  BackgroundRemovalProvider,
  MaskProviderFn,
  UpscaleOptions,
  UpscaleProvider,
  UpscaleProviderFn,
} from "./types";

/**
 * Wraps any function into a {@link BackgroundRemovalProvider}.
 *
 * ```ts
 * const provider = createMaskProvider(async (image) => myModel.mask(image));
 * await processImage(file).removeBackground(provider).toBlob({ type: 'image/png' });
 * ```
 */
export function createMaskProvider(
  fn: MaskProviderFn,
  name = "custom-mask",
): BackgroundRemovalProvider {
  if (typeof fn !== "function")
    throw invalidArgument("createMaskProvider: fn must be a function");
  return {
    name,
    async remove(
      image: RawImage,
      options?: BackgroundRemovalOptions,
      signal?: AbortSignal,
    ) {
      throwIfAborted(signal);
      const result = await fn(image, options, signal);
      if (!result || typeof result !== "object" || !("data" in result)) {
        throw invalidArgument(
          "createMaskProvider: the function must return a MaskImage or RawImage",
        );
      }
      return result as MaskImage | RawImage;
    },
  };
}

/** Wraps any function into an {@link UpscaleProvider}. */
export function createUpscaleProvider(
  fn: UpscaleProviderFn,
  options: { name?: string; scales?: number[] } = {},
): UpscaleProvider {
  if (typeof fn !== "function")
    throw invalidArgument("createUpscaleProvider: fn must be a function");
  const scales = options.scales?.length ? [...options.scales] : [2];
  return {
    name: options.name ?? "custom-upscale",
    scales,
    async upscale(
      image: RawImage,
      upsampleOptions: UpscaleOptions,
      signal?: AbortSignal,
      onProgress?: (progress: ProgressInfo) => void,
    ) {
      throwIfAborted(signal);
      const scale = upsampleOptions?.scale;
      if (!scales.includes(scale)) {
        throw invalidArgument(
          `createUpscaleProvider: unsupported scale ${String(scale)}; supported: ${scales.join(", ")}`,
        );
      }
      return (await fn(image, upsampleOptions, signal, onProgress)) as RawImage;
    },
  };
}
