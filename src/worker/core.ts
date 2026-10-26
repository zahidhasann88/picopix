import { ImageToolsError } from '../errors';
import type { CanvasBackend } from '../codec/backend';
import { getBackend } from '../codec/backend';
import type { RawImage } from '../types';
import { executeOps } from './execute';
import type { WorkerOp, WorkerRequest, WorkerResponse } from './protocol';
import { transferablesFor } from './protocol';

/** The tiny slice of a worker scope (or `MessagePort`) that the core needs. */
export interface WorkerMessagePort {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  on?(type: 'message', listener: (event: { data: unknown }) => void): void;
  start?(): void;
}

export interface WorkerCoreOptions {
  /** Resolves the canvas backend used for `decode`/`encode` requests. */
  backend?: () => Promise<CanvasBackend>;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface WorkerCore {
  /** Handles one decoded message; resolves once the response has been posted. */
  handle(data: unknown): Promise<void>;
  /** Marks a request as cancelled (its result will be dropped). */
  cancel(id: number): void;
  /** Number of requests seen so far (diagnostics/tests). */
  readonly processed: number;
  dispose(): void;
}

/**
 * The worker's message handler, written as a plain function so it can be driven
 * in-process by tests with a fake port (no `Worker` global required).
 *
 * Protocol (see `src/worker/protocol.ts`):
 * - `process` → runs the ops list on the transferred pixels, transfers them back
 * - `decode`  → decodes an `ArrayBuffer` with the canvas backend, returns pixels
 * - `encode`  → encodes pixels, returns an `ArrayBuffer`
 * - `cancel`  → marks an id as cancelled
 * - `ping`    → liveness check
 *
 * Ops are synchronous and CPU-bound, so cancellation is cooperative: the flag is
 * checked between ops and before responding. A single resize of a huge image
 * cannot be interrupted mid-kernel — that limitation is documented in the README.
 */
export function createWorkerCore(port: WorkerMessagePort, options: WorkerCoreOptions = {}): WorkerCore {
  const cancelled = new Set<number>();
  let processed = 0;
  const now = options.now ?? (() => Date.now());
  const resolveBackend = options.backend ?? (() => getBackend());

  const post = (message: WorkerResponse): void => {
    port.postMessage(message, transferablesFor(message));
  };

  async function handleProcess(request: Extract<WorkerRequest, { kind: 'process' }>): Promise<void> {
    const started = now();
    const progressEvery = request.progressEvery ?? 0;
    const image = executeOps(request.image, request.ops, {
      isCancelled: () => cancelled.has(request.id),
      onProgress:
        progressEvery > 0
          ? (ratio, index, total, label) => {
              if ((index + 1) % progressEvery !== 0 && index + 1 !== total) return;
              post({ id: request.id, kind: 'progress', phase: label, ratio, index, total });
            }
          : undefined,
    });
    if (cancelled.has(request.id)) {
      cancelled.delete(request.id);
      post({ id: request.id, kind: 'cancelled' });
      return;
    }
    post({ id: request.id, kind: 'result', image, durationMs: now() - started });
  }

  async function handleDecode(request: Extract<WorkerRequest, { kind: 'decode' }>): Promise<void> {
    const started = now();
    const backend = await resolveBackend();
    const image = await backend.decode(new Blob([request.bytes]));
    if (cancelled.has(request.id)) {
      cancelled.delete(request.id);
      post({ id: request.id, kind: 'cancelled' });
      return;
    }
    post({ id: request.id, kind: 'result', image, durationMs: now() - started });
  }

  async function handleEncode(request: Extract<WorkerRequest, { kind: 'encode' }>): Promise<void> {
    const started = now();
    const backend = await resolveBackend();
    const blob = await backend.encode(request.image, {
      type: request.type,
      quality: request.quality,
    });
    const bytes = await blob.arrayBuffer();
    if (cancelled.has(request.id)) {
      cancelled.delete(request.id);
      post({ id: request.id, kind: 'cancelled' });
      return;
    }
    const response: WorkerResponse = {
      id: request.id,
      kind: 'result',
      bytes,
      type: blob.type || request.type,
      durationMs: now() - started,
    };
    if (request.returnImage) response.image = request.image;
    port.postMessage(response, transferablesFor(response));
  }

  return {
    get processed() {
      return processed;
    },
    cancel(id) {
      cancelled.add(id);
    },
    dispose() {
      cancelled.clear();
    },
    async handle(data) {
      const request = data as WorkerRequest;
      if (!request || typeof request !== 'object' || typeof request.id !== 'number') {
        post({
          id: -1,
          kind: 'error',
          code: 'INVALID_ARGUMENT',
          message: 'Malformed worker request: expected { id: number, kind: string }',
        });
        return;
      }
      processed++;
      const id = request.id;
      try {
        switch (request.kind) {
          case 'process':
            await handleProcess(request);
            return;
          case 'decode':
            await handleDecode(request);
            return;
          case 'encode':
            await handleEncode(request);
            return;
          case 'cancel':
            cancelled.add(id);
            return;
          case 'ping':
            post({ id, kind: 'pong' });
            return;
          default:
            post({
              id,
              kind: 'error',
              code: 'INVALID_ARGUMENT',
              message: `Unknown request kind '${String((request as { kind: string }).kind)}'`,
            });
        }
      } catch (error) {
        const err = error as { code?: string; message?: string };
        // A cancelled op surfaces as ABORTED -> report it as a cancellation.
        if (err?.code === 'ABORTED') {
          cancelled.delete(id);
          post({ id, kind: 'cancelled' });
          return;
        }
        post({
          id,
          kind: 'error',
          code: err?.code ?? (error instanceof ImageToolsError ? 'PROVIDER_FAILED' : 'INTERNAL'),
          message: err?.message ?? String(error),
        });
      }
    },
  };
}

/** Wires a core to a worker global scope (`self`) — used by the `image-tools-core/worker` entry. */
export function serveWorkerScope(scope: WorkerMessagePort, options: WorkerCoreOptions = {}): WorkerCore {
  const core = createWorkerCore(scope, options);
  const listener = (event: { data: unknown }): void => {
    void core.handle(event.data);
  };
  if (typeof scope.addEventListener === 'function') {
    scope.addEventListener('message', listener);
  } else if (typeof scope.on === 'function') {
    scope.on('message', listener);
  }
  scope.start?.();
  return core;
}

/** Convenience for tests/benchmarks: run an ops list without any worker. */
export function runOpsInProcess(image: RawImage, ops: WorkerOp[]): RawImage {
  return executeOps(image, ops);
}
