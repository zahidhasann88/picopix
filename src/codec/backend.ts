import { backendUnavailable, decodeFailed, encodeFailed, invalidArgument, unsupportedFormat } from '../errors';
import type { EncodeOptions, ImageInput, RawImage } from '../types';
import { sniffFormat } from '../meta/sniff';

/**
 * The minimal contract the rest of the library needs in order to turn bytes
 * into pixels and back. Implement this to plug in any canvas implementation
 * (browser `OffscreenCanvas`, `@napi-rs/canvas`, `skia-canvas`, a WASM codec…).
 */
export interface CanvasBackend {
  /** Backend identifier, used for logging/an `ImageInfo` style diagnostics. */
  readonly name: string;
  /**
   * Decodes any supported input into straight-alpha RGBA pixels.
   * Implementations should apply no EXIF orientation (the pipeline does that
   * explicitly so callers stay in control).
   */
  decode(input: ImageInput, options?: { signal?: AbortSignal }): Promise<RawImage>;
  /** Encodes pixels into an `image/*` blob (or accepts a mime type to return a Buffer-compatible blob). */
  encode(image: RawImage, options: EncodeOptions, callOptions?: { signal?: AbortSignal }): Promise<Blob>;
  /** `true` when this backend can produce `type` (e.g. `'image/avif'`). */
  canEncode(type: string): boolean | Promise<boolean>;
}

/** Maps a short format name to a MIME type. */
export function formatToMime(format: string): string {
  const f = format.toLowerCase().replace(/^image\//, '');
  switch (f) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    default:
      throw unsupportedFormat(`Unknown image format '${format}'`);
  }
}

/** Normalises anything mime-ish / format-ish into a canonical MIME type. */
export function normalizeMime(type: string): string {
  return formatToMime(type);
}

/**
 * Backend state lives on a `Symbol.for()`-keyed global.
 *
 * This is not over-engineering: because every entry point is bundled
 * independently (no code splitting for CJS), `picopix` and
 * `picopix/node` would otherwise each own a *separate* copy of this
 * module state, and `setBackend()` in one entry would be invisible to the other.
 * A process-wide registry also makes the ESM+CJS dual-package hazard harmless.
 */
interface BackendRegistry {
  backend: CanvasBackend | null;
  syncDetectors: Array<() => CanvasBackend | null>;
  asyncDetectors: Array<() => Promise<CanvasBackend | null>>;
}

const REGISTRY_KEY = Symbol.for('picopix.backend-registry.v1');

function registry(): BackendRegistry {
  const host = globalThis as unknown as Record<symbol, BackendRegistry | undefined>;
  let state = host[REGISTRY_KEY];
  if (!state) {
    state = { backend: null, syncDetectors: [], asyncDetectors: [] };
    host[REGISTRY_KEY] = state;
  }
  return state;
}

/**
 * Registers the backend used by every high-level API.
 * `setBackend(null)` restores lazy auto-detection.
 */
export function setBackend(backend: CanvasBackend | null): void {
  if (backend !== null && (typeof backend.decode !== 'function' || typeof backend.encode !== 'function')) {
    throw invalidArgument('setBackend: backend must implement decode() and encode()');
  }
  registry().backend = backend;
}

/** Returns the registered backend, or auto-detects one (browser → node). */
export function getDefaultBackend(): CanvasBackend {
  const state = registry();
  if (state.backend) return state.backend;
  const detected = detectBackend();
  if (!detected) {
    throw backendUnavailable(
      'No canvas backend available. In a browser use a window with OffscreenCanvas/HTMLCanvasElement; ' +
        'in Node install the optional peer `@napi-rs/canvas` and import `picopix/node`, ' +
        'or call setBackend() with your own implementation.',
    );
  }
  state.backend = detected;
  return state.backend;
}

/** `true`/`false`/`Promise` — mirrors {@link CanvasBackend.canEncode} for the active backend. */
export async function canEncode(type: string): Promise<boolean> {
  const backend = getDefaultBackend();
  return await backend.canEncode(normalizeMime(type));
}

/** Internal: picks the first backend whose `isAvailable()` returns true. */
type Detector = () => CanvasBackend | null;

/** Internal: registers a lazy sync backend detector (used by the browser entry). */
export function registerBackendDetector(detector: Detector): void {
  registry().syncDetectors.push(detector);
}

/** Internal: registers a lazy async backend detector (the Node addon needs an import). */
export function registerAsyncBackendDetector(detector: () => Promise<CanvasBackend | null>): void {
  registry().asyncDetectors.push(detector);
}

function detectBackend(): CanvasBackend | null {
  for (const detect of registry().syncDetectors) {
    try {
      const backend = detect();
      if (backend) return backend;
    } catch {
      // ignore and try the next detector
    }
  }
  return null;
}

/**
 * Resolves the backend, awaiting async detectors (e.g. loading the optional
 * `@napi-rs/canvas` addon) when no sync detector matched. This is what every
 * async API in this library uses internally.
 */
export async function getBackend(): Promise<CanvasBackend> {
  const state = registry();
  if (state.backend) return state.backend;
  const sync = detectBackend();
  if (sync) {
    state.backend = sync;
    return sync;
  }
  for (const detect of state.asyncDetectors) {
    try {
      const backend = await detect();
      if (backend) {
        state.backend = backend;
        return backend;
      }
    } catch {
      // ignore and try the next detector
    }
  }
  throw backendUnavailable(
    'No canvas backend available. In a browser use a window with OffscreenCanvas/HTMLCanvasElement; ' +
      'in Node install the optional peer `@napi-rs/canvas` and import `picopix/node`, ' +
      'or call setBackend() with your own implementation.',
  );
}

/** Returns `true` when at least one backend can be created in this environment. */
export async function isBackendAvailable(): Promise<boolean> {
  try {
    await getBackend();
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared helper for backend implementations: turns a `Blob`/`ArrayBuffer`/
 * `Uint8Array`/data-URL/URL input into raw bytes.
 */
export async function inputToBytes(input: ImageInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (typeof input === 'string') {
    if (input.startsWith('data:')) {
      const comma = input.indexOf(',');
      if (comma < 0) throw decodeFailed('Malformed data URL');
      const meta = input.slice(5, comma);
      const payload = input.slice(comma + 1);
      if (meta.endsWith(';base64')) {
        return base64ToBytes(payload);
      }
      return new TextEncoder().encode(decodeURIComponent(payload));
    }
    if (typeof fetch !== 'function') {
      throw decodeFailed('Cannot fetch a URL input: `fetch` is not available');
    }
    const response = await fetch(input);
    if (!response.ok) {
      throw decodeFailed(`Failed to fetch ${input}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  throw invalidArgument('Unsupported input: expected Blob, ArrayBuffer, typed array, data URL or URL string');
}

/** Cross-environment base64 decoder (no `atob` in old Node, no `Buffer` in browsers). */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const g = globalThis as unknown as { atob?: (s: string) => string; Buffer?: typeof Buffer };
  if (typeof g.atob === 'function') {
    const bin = g.atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (g.Buffer) {
    const buf = g.Buffer.from(clean, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  throw backendUnavailable('No base64 decoder available');
}

/** Cross-environment base64 encoder. */
export function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as { btoa?: (s: string) => string; Buffer?: typeof Buffer };
  if (typeof g.btoa === 'function') {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return g.btoa(bin);
  }
  if (g.Buffer) {
    return g.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  throw backendUnavailable('No base64 encoder available');
}

/** Validates that the input bytes are a recognisable image before decoding. */
export function assertSupportedInput(bytes: Uint8Array): void {
  const format = sniffFormat(bytes);
  if (format === 'unknown') {
    throw unsupportedFormat('Unrecognised image format (magic bytes did not match png/jpeg/webp/gif/avif/bmp/ico/svg)');
  }
}

export { decodeFailed, encodeFailed };
