/**
 * `picopix/providers/imgly` — adapter for
 * [`@imgly/background-removal`](https://www.npmjs.com/package/@imgly/background-removal).
 *
 * `@imgly/background-removal` is an **optional peer dependency** and is loaded
 * with a dynamic `import()` the first time the provider runs, so apps that never
 * use it pay nothing.
 *
 * ```ts
 * import { createImglyProvider } from 'picopix/providers/imgly';
 * const provider = createImglyProvider(); // no model is downloaded until first use
 * const blob = await processImage(file).removeBackground(provider).toBlob();
 * ```
 *
 * Note: this provider must run where it was created (models are not
 * serialisable), i.e. on the main thread or *inside* a worker you created
 * yourself — it is never shipped to `picopix/worker`.
 */
import { ImageToolsError, invalidArgument, throwIfAborted } from "../errors";
import type { MaskImage, RawImage } from "../types";
import type {
  BackgroundRemovalOptions,
  BackgroundRemovalProvider,
} from "./types";

export interface ImglyOptions {
  model?: string;
  device?: "cpu" | "gpu";
  publicPath?: string;
  progress?: (key: string, current: number, total: number) => void;
  [key: string]: unknown;
}

export interface ImglyModule {
  removeBackground(
    input: Blob | URL | string | ArrayBuffer | Uint8Array,
    config?: Record<string, unknown>,
  ): Promise<Blob>;
}

export interface ImglyProviderOptions extends ImglyOptions {
  loadModule?: () => Promise<ImglyModule>;
}

async function defaultLoad(): Promise<ImglyModule> {
  try {
    const mod = (await import(
      "@imgly/background-removal" as string
    )) as unknown as ImglyModule;
    if (typeof mod.removeBackground !== "function") {
      throw new Error(
        "@imgly/background-removal does not export removeBackground()",
      );
    }
    return mod;
  } catch (error) {
    throw new ImageToolsError(
      "BACKEND_UNAVAILABLE",
      "The imgly provider requires the optional peer dependency `@imgly/background-removal` " +
        "(npm i @imgly/background-removal). It is loaded lazily on first use.",
      error,
    );
  }
}

async function toPngBlob(image: RawImage): Promise<Blob> {
  const { getBackend } = await import("../codec/backend");
  const backend = await getBackend();
  const canvasBacked = await backend.encode(image, { type: "image/png" });
  if (canvasBacked.type === "image/png") return canvasBacked;
  throw new ImageToolsError(
    "PROVIDER_FAILED",
    "The active backend cannot encode PNG for the imgly provider",
  );
}

async function fromBlob(blob: Blob): Promise<RawImage> {
  const { getBackend } = await import("../codec/backend");
  const backend = await getBackend();
  return backend.decode(blob);
}

export function createImglyProvider(
  options: ImglyProviderOptions = {},
): BackgroundRemovalProvider {
  const { loadModule, ...imglyConfig } = options;
  const load = loadModule ?? defaultLoad;
  let modulePromise: Promise<ImglyModule> | null = null;

  const getModule = (): Promise<ImglyModule> => {
    if (!modulePromise) modulePromise = load();
    return modulePromise;
  };

  return {
    name: "imgly",
    async remove(
      image,
      providerOptions?: BackgroundRemovalOptions,
      signal?: AbortSignal,
    ): Promise<RawImage> {
      if (!image || !image.data)
        throw invalidArgument("imgly provider: expected a RawImage");
      throwIfAborted(signal);
      const mod = await getModule();
      throwIfAborted(signal);

      const config: Record<string, unknown> = { ...imglyConfig };
      const progress = providerOptions?.progress ?? imglyConfig.progress;
      if (progress) config.progress = progress;

      const input = await toPngBlob(image);
      throwIfAborted(signal);
      let output: Blob;
      try {
        output = await mod.removeBackground(input, config);
      } catch (error) {
        throw new ImageToolsError(
          "PROVIDER_FAILED",
          "imgly removeBackground() failed",
          error,
        );
      }
      throwIfAborted(signal);
      const decoded = await fromBlob(output);
      if (decoded.width === image.width && decoded.height === image.height)
        return decoded;
      const mask: MaskImage = {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8ClampedArray(decoded.width * decoded.height),
      };
      for (let p = 0; p < mask.data.length; p++)
        mask.data[p] = decoded.data[p * 4 + 3];
      return mask;
    },
  };
}

/** Default instance factory alias (`createImglyProvider` is preferred). */
export const imglyProvider: typeof createImglyProvider = createImglyProvider;
