/**
 * `image-tools-core/worker` — the worker entry point.
 *
 * Import this file from a `new Worker(..., { type: 'module' })` call; it wires
 * the message handler to the worker global scope. It is a separate bundle so the
 * main thread never pays for it.
 *
 * ```ts
 * // app.ts
 * const worker = new Worker(new URL('image-tools-core/worker', import.meta.url), { type: 'module' });
 * ```
 */
import { serveWorkerScope } from './worker/core';
import { installBrowserBackend } from './codec/browser';

// Registers the browser canvas backend inside the worker so that `decode` and
// `encode` requests work with `OffscreenCanvas` (no-op outside a browser).
// Called explicitly because `sideEffects: false` would let bundlers drop a bare
// side-effect import.
installBrowserBackend();

export * from './worker/protocol';
export { executeOps } from './worker/execute';
export { createWorkerCore, serveWorkerScope, type WorkerCore, type WorkerCoreOptions, type WorkerMessagePort } from './worker/core';
export {
  createImageWorker,
  createWorkerPool,
  type ImageWorker,
  type ImageWorkerOptions,
  type ImageWorkerPool,
  type RunOptions,
  type WorkerPoolOptions,
} from './worker/client';

// Auto-start only when actually running inside a worker global scope. Importing
// this module from a normal page (e.g. for the types) is therefore a no-op.
const scope = globalThis as unknown as {
  WorkerGlobalScope?: unknown;
  importScripts?: unknown;
  postMessage?: unknown;
  addEventListener?: unknown;
};

const isWorkerScope =
  typeof scope.importScripts === 'function' ||
  (typeof scope.postMessage === 'function' && typeof window === 'undefined' && typeof scope.addEventListener === 'function');

if (isWorkerScope) {
  serveWorkerScope(scope as unknown as Parameters<typeof serveWorkerScope>[0]);
}
