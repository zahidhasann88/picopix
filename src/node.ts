/**
 * `picopix/node` — Node.js entry point.
 *
 * Import this once (even for its side effects) to register the
 * `@napi-rs/canvas` backend as the default:
 *
 * ```ts
 * import 'picopix/node';
 * import { compressImage } from 'picopix';
 * ```
 *
 * `@napi-rs/canvas` is an **optional peer dependency**; if it is missing, the
 * import still succeeds and the backend reports `BACKEND_UNAVAILABLE` only when
 * you actually try to decode/encode.
 */
import {
  decodeNode,
  encodeNode,
  isNodeBackendAvailable,
  loadNapiCanvas,
  loadNapiCanvasAsync,
  nodeBackend,
} from './codec/node';
import { setBackend } from './codec/backend';

export { decodeNode, encodeNode, isNodeBackendAvailable, loadNapiCanvas, loadNapiCanvasAsync, nodeBackend };
export * from './index';

/**
 * Explicitly installs the Node backend. Called automatically at import time when
 * `@napi-rs/canvas` can be loaded synchronously (CJS); in ESM the async detector
 * registers it on first use.
 */
export function useNodeBackend(): Promise<boolean> {
  return loadNapiCanvasAsync().then((mod) => {
    if (!mod) return false;
    setBackend(nodeBackend);
    return true;
  });
}

if (typeof process !== 'undefined' && process.versions?.node) {
  const sync = loadNapiCanvas();
  if (sync) setBackend(nodeBackend);
}
