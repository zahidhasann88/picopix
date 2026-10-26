import { decodeFailed, encodeFailed, unsupportedFormat, throwIfAborted } from '../errors';
import type { CallOptions, EncodeOptions, ImageInput, RawImage } from '../types';
import type { CanvasBackend } from './backend';
import { assertSupportedInput, inputToBytes, normalizeMime, registerAsyncBackendDetector } from './backend';
import { sniffFormat } from '../meta/sniff';
import { stripJpegMetadata } from '../meta/strip';

/**
 * Minimal shape of the bits of `@napi-rs/canvas` we use. Declared here so the
 * optional peer never becomes a hard type dependency.
 */
interface NapiCanvasModule {
  createCanvas(width: number, height: number): {
    width: number;
    height: number;
    getContext(type: '2d'): {
      drawImage(image: unknown, x: number, y: number, w?: number, h?: number): void;
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
      putImageData(data: unknown, x: number, y: number): void;
    };
    encodeSync?(format: string, quality?: number): Uint8Array;
    toBuffer?(mime: string, quality?: number): Uint8Array;
  };
  loadImage(source: Uint8Array | ArrayBuffer | string | { src: unknown }): Promise<{
    width: number;
    height: number;
    close?: () => void;
  }>;
  ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => unknown;
  Image?: new () => {
    width: number;
    height: number;
    src: unknown;
    onload: (() => void) | null;
    onerror: ((error: unknown) => void) | null;
  };
}

const MIME_TO_NAPI: Record<string, 'png' | 'jpeg' | 'webp' | 'avif'> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

let cachedModule: NapiCanvasModule | undefined;
let syncAttemptFailed = false;
let asyncAttempt: Promise<NapiCanvasModule | null> | null = null;

/**
 * Returns `@napi-rs/canvas` if the optional peer is already resolvable through a
 * CommonJS `require` (i.e. when this library is loaded from CJS).
 */
export function loadNapiCanvas(): NapiCanvasModule | null {
  if (cachedModule) return cachedModule;
  if (syncAttemptFailed) return null;
  try {
    const req = typeof require === 'function' ? (require as (id: string) => unknown) : null;
    if (!req) {
      syncAttemptFailed = true;
      return null;
    }
    cachedModule = req('@napi-rs/canvas') as NapiCanvasModule;
    return cachedModule ?? null;
  } catch {
    syncAttemptFailed = true;
    return null;
  }
}

/**
 * Async loader that works in ESM as well: dynamically imports the optional peer.
 * Returns `null` when the peer is not installed (no throw: it is optional).
 */
export function loadNapiCanvasAsync(): Promise<NapiCanvasModule | null> {
  if (cachedModule) return Promise.resolve(cachedModule);
  if (asyncAttempt) return asyncAttempt;
  asyncAttempt = (async () => {
    try {
      const mod = (await import('@napi-rs/canvas' as string)) as unknown as NapiCanvasModule & {
        default?: NapiCanvasModule;
      };
      cachedModule = (mod.default ?? mod) as NapiCanvasModule;
      if (typeof cachedModule.createCanvas !== 'function') {
        cachedModule = undefined;
        return null;
      }
      return cachedModule;
    } catch {
      return null;
    }
  })();
  return asyncAttempt;
}

/** `true` when `@napi-rs/canvas` can be loaded in this process. */
export async function isNodeBackendAvailable(): Promise<boolean> {
  return (await loadNapiCanvasAsync()) !== null;
}

async function requireNapi(): Promise<NapiCanvasModule> {
  const mod = await loadNapiCanvasAsync();
  if (!mod) {
    throw decodeFailed(
      'The Node backend requires the optional peer dependency `@napi-rs/canvas` (npm i @napi-rs/canvas)',
    );
  }
  return mod;
}

function copyData(data: Uint8ClampedArray, width: number, height: number): RawImage {
  return { width, height, data: new Uint8ClampedArray(data) };
}

/** Decodes using `@napi-rs/canvas`'s `loadImage`. */
export async function decodeNode(input: ImageInput, options: CallOptions = {}): Promise<RawImage> {
  throwIfAborted(options.signal);
  const mod = await requireNapi();
  const bytes = await inputToBytes(input);
  assertSupportedInput(bytes);

  // SVG needs to go through the string/`Image` path rather than a buffer.
  const format = sniffFormat(bytes);
  // Decoders auto-apply EXIF orientation (skia does; so do most browsers).
  // `decode()` is documented to return unrotated pixels, so the EXIF block is
  // removed from the bytes we hand to the decoder and the pipeline applies the
  // orientation exactly once. The ICC profile is kept for colour fidelity.
  const decodable = format === 'jpeg' ? stripJpegMetadata(bytes, { keepColorProfile: true }) : bytes;
  try {
    const source = format === 'svg' ? new TextDecoder().decode(bytes) : Buffer.from(decodable);
    const image = await mod.loadImage(source as unknown as Uint8Array);
    throwIfAborted(options.signal);
    const canvas = mod.createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height);
    image.close?.();
    return copyData(data.data, data.width, data.height);
  } catch (error) {
    if ((error as { code?: string })?.code === 'ABORTED') throw error;
    throw decodeFailed('Could not decode the image with @napi-rs/canvas', error);
  }
}

/** Encodes using `@napi-rs/canvas`, which supports png/jpeg/webp/avif. */
export async function encodeNode(
  image: RawImage,
  options: EncodeOptions,
  callOptions: CallOptions = {},
): Promise<Blob> {
  throwIfAborted(callOptions.signal);
  const mod = await requireNapi();
  const type = normalizeMime(options.type);
  const napiFormat = MIME_TO_NAPI[type];
  if (!napiFormat) throw unsupportedFormat(`The Node backend cannot encode '${type}'`);

  const canvas = mod.createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  // `@napi-rs/canvas` only accepts its own ImageData implementation.
  const Ctor = mod.ImageData ?? (typeof ImageData !== 'undefined' ? ImageData : null);
  if (!Ctor) throw encodeFailed('No ImageData constructor available for the Node backend');
  ctx.putImageData(new Ctor(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  // The library talks in 0..1; `@napi-rs/canvas` wants 0..100.
  const quality =
    options.quality === undefined ? undefined : Math.round(Math.max(0, Math.min(1, options.quality)) * 100);
  try {
    const bytes = canvas.encodeSync
      ? canvas.encodeSync(napiFormat, quality)
      : canvas.toBuffer!(type, quality);
    return new Blob([bytes as unknown as BlobPart], { type });
  } catch (error) {
    throw encodeFailed(`Failed to encode '${type}' with @napi-rs/canvas`, error);
  }
}

const nodeEncodeSupport = new Map<string, boolean>();

/**
 * Node canvas backend built on the optional peer `@napi-rs/canvas`.
 *
 * Import it from `image-tools-core/node` (which also registers it as the
 * auto-detected backend in Node). Encoding supports png/jpeg/webp/avif; there is
 * no gif encoder.
 */
export const nodeBackend: CanvasBackend = {
  name: 'node',
  decode: decodeNode,
  encode: encodeNode,
  async canEncode(type) {
    const mime = normalizeMime(type);
    const cached = nodeEncodeSupport.get(mime);
    if (cached !== undefined) return cached;
    const supported = mime in MIME_TO_NAPI;
    nodeEncodeSupport.set(mime, supported);
    return supported;
  },
};

registerAsyncBackendDetector(async () => {
  if (typeof process === 'undefined' || !process.versions?.node) return null;
  const mod = await loadNapiCanvasAsync();
  return mod ? nodeBackend : null;
});
