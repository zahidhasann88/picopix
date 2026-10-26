import { decodeFailed, encodeFailed, unsupportedFormat, throwIfAborted } from '../errors';
import type { CallOptions, EncodeOptions, ImageInput, RawImage } from '../types';
import type { CanvasBackend } from './backend';
import { assertSupportedInput, inputToBytes, normalizeMime, registerBackendDetector, setBackend } from './backend';
import { sniffFormat } from '../meta/sniff';
import { stripJpegMetadata } from '../meta/strip';

interface MinimalCanvas {
  width: number;
  height: number;
  getContext(id: '2d', options?: { willReadFrequently?: boolean }): {
    drawImage(image: unknown, ...args: number[]): void;
    getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray; width: number; height: number };
    putImageData(data: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number): void;
  } | null;
  convertToBlob?(options: { type: string; quality?: number }): Promise<Blob>;
  toBlob?(cb: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

type CanvasFactory = (width: number, height: number) => MinimalCanvas;

function getDocument(): Document | null {
  return typeof document !== 'undefined' ? document : null;
}

function createCanvas(width: number, height: number): MinimalCanvas {
  const g = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => MinimalCanvas;
    document?: Document;
  };
  if (typeof g.OffscreenCanvas === 'function') {
    return new g.OffscreenCanvas(width, height);
  }
  const doc = getDocument();
  if (doc) {
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as MinimalCanvas;
  }
  throw decodeFailed('No canvas implementation available (no OffscreenCanvas and no document)');
}

const hasOffscreen = (): boolean =>
  typeof (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'function';

const hasDocument = (): boolean => typeof document !== 'undefined';

/** `true` when this module can operate at all in the current environment. */
export function isBrowserBackendAvailable(): boolean {
  return hasOffscreen() || hasDocument();
}

function toImageData(image: RawImage): { data: Uint8ClampedArray; width: number; height: number } {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  }
  return { data: image.data, width: image.width, height: image.height };
}

/**
 * Decodes with `createImageBitmap` (fast path, supports Blob/ArrayBuffer) and
 * draws the result onto a canvas in order to read pixels back.
 */
async function decodeToRaw(input: ImageInput, options: CallOptions = {}): Promise<RawImage> {
  throwIfAborted(options.signal);
  const raw = await inputToBytes(input);
  assertSupportedInput(raw);
  // `createImageBitmap` (and `<img>`) apply EXIF orientation, but `decode()` is
  // documented to return unrotated pixels: drop the EXIF block before decoding.
  const bytes = sniffFormat(raw) === 'jpeg' ? stripJpegMetadata(raw, { keepColorProfile: true }) : raw;
  const blob = typeof Blob !== 'undefined' ? new Blob([bytes as unknown as BlobPart]) : null;

  const g = globalThis as unknown as {
    createImageBitmap?: (source: Blob | ImageData) => Promise<{ width: number; height: number; close?: () => void }>;
    Image?: new () => HTMLImageElement;
  };

  if (typeof g.createImageBitmap === 'function' && blob) {
    let bitmap: { width: number; height: number; close?: () => void } | undefined;
    try {
      bitmap = await g.createImageBitmap(blob);
      throwIfAborted(options.signal);
      const canvas = createCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw decodeFailed('Could not acquire a 2D context');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: data.width, height: data.height, data: new Uint8ClampedArray(data.data) };
    } catch (error) {
      if ((error as { code?: string })?.code === 'ABORTED') throw error;
      if (bytes[0] === 0x89 || bytes[0] === 0xff) {
        // Fall through to the <img> path, which handles a few more corner cases.
      } else {
        throw decodeFailed('Could not decode the image with createImageBitmap', error);
      }
    } finally {
      bitmap?.close?.();
    }
  }

  // Fallback: HTMLImageElement + object URL.
  if (typeof g.Image === 'function' && blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new g.Image!();
        image.onload = () => resolve(image);
        image.onerror = () => reject(decodeFailed('The browser could not decode the image'));
        image.src = url;
      });
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw decodeFailed('Could not acquire a 2D context');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, width, height);
      return { width, height, data: new Uint8ClampedArray(data.data) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  throw decodeFailed('No usable decode path in this environment');
}

const encodeSupportCache = new Map<string, boolean>();

/**
 * Encodes pixels with a canvas. AVIF is probed by actually encoding a 1x1 image,
 * because browsers report `image/avif` support inconsistently.
 */
async function encodeWithCanvas(
  image: RawImage,
  options: EncodeOptions,
  checkOnly = false,
): Promise<Blob | boolean> {
  const type = normalizeMime(options.type);
  const canvas = createCanvas(checkOnly ? 1 : image.width, checkOnly ? 1 : image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: !checkOnly });
  if (!ctx) throw encodeFailed('Could not acquire a 2D context');
  if (!checkOnly) ctx.putImageData(toImageData(image), 0, 0);
  const quality = options.quality === undefined ? undefined : Math.max(0, Math.min(1, options.quality));

  try {
    if (typeof canvas.convertToBlob === 'function') {
      const blob = await canvas.convertToBlob({ type, quality });
      if (checkOnly) return blob.type === type;
      if (blob.type !== type) {
        throw unsupportedFormat(`The canvas could not encode '${type}' (produced '${blob.type}')`);
      }
      return blob;
    }
    if (typeof canvas.toBlob === 'function') {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob!(resolve, type, quality));
      if (!blob) throw encodeFailed(`Canvas.toBlob returned null for '${type}'`);
      if (checkOnly) return blob.type === type;
      if (blob.type !== type) {
        throw unsupportedFormat(`The canvas could not encode '${type}' (produced '${blob.type}')`);
      }
      return blob;
    }
    throw encodeFailed('Canvas implementation has neither convertToBlob() nor toBlob()');
  } catch (error) {
    if (checkOnly) return false;
    if ((error as { code?: string })?.code) throw error;
    throw encodeFailed(`Failed to encode '${type}'`, error);
  }
}

/**
 * Browser canvas backend: `createImageBitmap` + `OffscreenCanvas`
 * (`HTMLCanvasElement` fallback when `OffscreenCanvas` is missing).
 *
 * Canvas output is **not** colour-managed for you: browsers draw into sRGB
 * unless you configure otherwise, and EXIF orientation from the source is
 * applied by `createImageBitmap` (`imageOrientation: 'none'` is not available
 * everywhere, so the pipeline re-applies orientation from the bytes and treats
 * bitmaps as unrotated).
 */
export const browserBackend: CanvasBackend = {
  name: 'browser',
  decode: decodeToRaw,
  async encode(image, options, callOptions = {}) {
    throwIfAborted(callOptions.signal);
    return (await encodeWithCanvas(image, options)) as Blob;
  },
  async canEncode(type) {
    const mime = normalizeMime(type);
    const cached = encodeSupportCache.get(mime);
    if (cached !== undefined) return cached;
    let supported = false;
    try {
      supported = (await encodeWithCanvas({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, { type: mime }, true)) as boolean;
    } catch {
      supported = false;
    }
    encodeSupportCache.set(mime, supported);
    return supported;
  },
};

/** Creates a canvas element/OffscreenCanvas of the given size (exported for advanced use). */
export { createCanvas as createBrowserCanvas, type CanvasFactory };

/**
 * Registers {@link browserBackend} as the process-wide backend (no-op when there
 * is no canvas implementation).
 *
 * Exported as an explicit function — and not only as a module side effect —
 * because `package.json` declares `"sideEffects": false`, so a bare
 * `import './codec/browser'` may be tree-shaken away by bundlers.
 */
export function installBrowserBackend(): boolean {
  if (!isBrowserBackendAvailable()) return false;
  setBackend(browserBackend);
  return true;
}

registerBackendDetector(() => (isBrowserBackendAvailable() ? browserBackend : null));
