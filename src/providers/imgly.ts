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
import { ImageToolsError, invalidArgument, throwIfAborted } from '../errors';
import type { MaskImage, RawImage } from '../types';
import type { BackgroundRemovalOptions, BackgroundRemovalProvider } from './types';

/** Options forwarded to `@imgly/background-removal`. */
export interface ImglyOptions {
  /** Force a model variant, e.g. `'isnet_fp16'` or `'isnet_quint8'`. */
  model?: string;
  /** Use the GPU (WebGPU/WebGL) backend when available. Default `true`. */
  device?: 'cpu' | 'gpu';
  /** Directory/CDN base URL for the model assets. */
  publicPath?: string;
  /** Progress callback: `(key, current, total)`. */
  progress?: (key: string, current: number, total: number) => void;
  /** Anything else is passed straight through. */
  [key: string]: unknown;
}

/** The subset of the `@imgly/background-removal` API this adapter uses. */
export interface ImglyModule {
  removeBackground(
    input: Blob | URL | string | ArrayBuffer | Uint8Array,
    config?: Record<string, unknown>,
  ): Promise<Blob>;
}

export interface ImglyProviderOptions extends ImglyOptions {
  /** Override the import (mainly for tests / non-standard bundlers). */
  loadModule?: () => Promise<ImglyModule>;
}

async function defaultLoad(): Promise<ImglyModule> {
  try {
    const mod = (await import('@imgly/background-removal' as string)) as unknown as ImglyModule;
    if (typeof mod.removeBackground !== 'function') {
      throw new Error('@imgly/background-removal does not export removeBackground()');
    }
    return mod;
  } catch (error) {
    throw new ImageToolsError(
      'BACKEND_UNAVAILABLE',
      'The imgly provider requires the optional peer dependency `@imgly/background-removal` ' +
        '(npm i @imgly/background-removal). It is loaded lazily on first use.',
      error,
    );
  }
}

/** Encodes a `RawImage` into a PNG blob so the model gets a lossless input. */
async function toPngBlob(image: RawImage): Promise<Blob> {
  // Local import keeps the codec out of this module's top-level graph.
  const { getBackend } = await import('../codec/backend');
  const backend = await getBackend();
  const canvasBacked = await backend.encode(image, { type: 'image/png' });
  if (canvasBacked.type === 'image/png') return canvasBacked;
  throw new ImageToolsError('PROVIDER_FAILED', 'The active backend cannot encode PNG for the imgly provider');
}

/** Decodes the returned cut-out PNG back into pixels. */
async function fromBlob(blob: Blob): Promise<RawImage> {
  const { getBackend } = await import('../codec/backend');
  const backend = await getBackend();
  return backend.decode(blob);
}

/**
 * Creates a {@link BackgroundRemovalProvider} backed by
 * `@imgly/background-removal` (ISNet segmentation, ~40 MB model on first use).
 *
 * The adapter converts pixels → PNG → the library's `removeBackground()` → PNG →
 * pixels, and returns the cut-out RGBA image (alpha carries the mask).
 */
export function createImglyProvider(options: ImglyProviderOptions = {}): BackgroundRemovalProvider {
  const { loadModule, ...imglyConfig } = options;
  const load = loadModule ?? defaultLoad;
  let modulePromise: Promise<ImglyModule> | null = null;

  const getModule = (): Promise<ImglyModule> => {
    if (!modulePromise) modulePromise = load();
    return modulePromise;
  };

  return {
    name: 'imgly',
    async remove(image, providerOptions?: BackgroundRemovalOptions, signal?: AbortSignal): Promise<RawImage> {
      if (!image || !image.data) throw invalidArgument('imgly provider: expected a RawImage');
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
        throw new ImageToolsError('PROVIDER_FAILED', 'imgly removeBackground() failed', error);
      }
      throwIfAborted(signal);
      const decoded = await fromBlob(output);
      // Most builds return the subject on a transparent background at the same
      // size, in which case the cut-out *is* the answer. If the model ran at a
      // different resolution, return an alpha-only mask so the pipeline can map
      // it back onto the original image without resampling the colours.
      if (decoded.width === image.width && decoded.height === image.height) return decoded;
      const mask: MaskImage = {
        width: decoded.width,
        height: decoded.height,
        data: new Uint8ClampedArray(decoded.width * decoded.height),
      };
      for (let p = 0; p < mask.data.length; p++) mask.data[p] = decoded.data[p * 4 + 3];
      return mask;
    },
  };
}

/** Default instance factory alias (`createImglyProvider` is preferred). */
export const imglyProvider = createImglyProvider;
