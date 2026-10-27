import {
  AbortError,
  ImageToolsError,
  TimeoutError,
  invalidArgument,
  throwIfAborted,
} from "../errors";
import { getBackend } from "../codec/backend";
import type { CallOptions, ProgressInfo, RawImage } from "../types";
import { executeOps } from "./execute";
import type { WorkerOp, WorkerRequest, WorkerResponse } from "./protocol";
import { cloneImageForTransfer, requestTransferables } from "./protocol";

export interface ImageWorkerOptions {
  workerUrl?: string | URL;
  workerFactory?: () => Worker;
  timeout?: number;
  fallback?: "auto" | "always" | "never";
  defaults?: RunOptions;
}

export interface RunOptions extends CallOptions {
  /** Overrides {@link ImageWorkerOptions.timeout} for this call. */
  timeout?: number;
}

export interface ImageWorker {
  readonly mode: "worker" | "fallback";
  readonly pending: number;
  process(
    image: RawImage,
    ops: WorkerOp[],
    options?: RunOptions,
  ): Promise<RawImage>;
  decode(
    input: Blob | ArrayBuffer | Uint8Array,
    options?: RunOptions,
  ): Promise<RawImage>;
  encode(
    image: RawImage,
    encodeOptions: { type: string; quality?: number },
    options?: RunOptions,
  ): Promise<Blob>;
  ping(options?: RunOptions): Promise<number>;
  dispose(): void;
}

interface Pending {
  resolve(value: {
    image?: RawImage;
    bytes?: ArrayBuffer;
    type?: string;
    durationMs: number;
  }): void;
  reject(error: unknown): void;
  onProgress?: (progress: ProgressInfo) => void;
  timer?: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

const hasWorkerGlobal = (): boolean =>
  typeof Worker !== "undefined" && typeof URL !== "undefined";

/**
 * Creates a client for the `picopix/worker` bundle.
 *
 * ```ts
 * const worker = createImageWorker();
 * const raw = await worker.process(image, [{ op: 'resize', width: 800 }]);
 * worker.dispose();
 * ```
 *
 * Design notes:
 * - request ids correlate responses; buffers are **transferred** (zero-copy) in
 *   both directions, so the caller's pixel buffer is copied once before sending.
 * - `signal` aborts reject with `AbortError` and ask the worker to drop the result;
 *   `timeout` rejects with `TimeoutError`.
 * - when `Worker`/`module workers` are unavailable the ops run in-process, which
 *   produces byte-identical results because both paths share {@link executeOps}.
 */
export function createImageWorker(
  options: ImageWorkerOptions = {},
): ImageWorker {
  const mode = resolveMode(options);
  if (mode === "fallback") return createFallbackWorker(options);

  let worker: Worker;
  try {
    worker = options.workerFactory
      ? options.workerFactory()
      : defaultWorkerFactory(options.workerUrl);
  } catch (error) {
    if (options.fallback === "never") {
      throw new ImageToolsError(
        "BACKEND_UNAVAILABLE",
        "Could not create a Web Worker",
        error,
      );
    }
    return createFallbackWorker(options);
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;
  const defaultTimeout = options.timeout ?? 60_000;
  let degraded: ImageWorker | null = null;

  worker.addEventListener("message", (event: MessageEvent) => {
    const response = event.data as WorkerResponse;
    if (!response || typeof response.id !== "number") return;
    const entry = pending.get(response.id);
    if (!entry) return;
    switch (response.kind) {
      case "progress":
        entry.onProgress?.({
          phase: response.phase,
          ratio: response.ratio,
          ...(response.index !== undefined ? { loaded: response.index } : {}),
          ...(response.total !== undefined ? { total: response.total } : {}),
        });
        return;
      case "result":
        pending.delete(response.id);
        entry.cleanup();
        entry.resolve({
          image: response.image,
          bytes: response.bytes,
          type: response.type,
          durationMs: response.durationMs,
        });
        return;
      case "error":
        pending.delete(response.id);
        entry.cleanup();
        entry.reject(
          new ImageToolsError(mapCode(response.code), response.message),
        );
        return;
      case "cancelled":
        pending.delete(response.id);
        entry.cleanup();
        entry.reject(new AbortError("The operation was aborted"));
        return;
      case "pong":
        pending.delete(response.id);
        entry.cleanup();
        entry.resolve({ durationMs: 0 });
        return;
      default:
        return;
    }
  });

  const failAll = (error: unknown): void => {
    for (const [, entry] of pending) {
      entry.cleanup();
      entry.reject(error);
    }
    pending.clear();
  };

  worker.addEventListener("error", (event: ErrorEvent) => {
    failAll(
      new ImageToolsError(
        "BACKEND_UNAVAILABLE",
        `Worker error: ${event.message ?? "unknown"}`,
      ),
    );
    if (options.fallback !== "never" && !degraded) {
      degraded = createFallbackWorker(options);
      worker.terminate();
    }
  });

  function send(
    build: (id: number) => WorkerRequest,
    callOptions: RunOptions,
    timeoutOverride?: number,
  ): Promise<{
    image?: RawImage;
    bytes?: ArrayBuffer;
    type?: string;
    durationMs: number;
  }> {
    if (disposed) {
      return Promise.reject(
        new ImageToolsError(
          "BACKEND_UNAVAILABLE",
          "This worker has been disposed",
        ),
      );
    }
    const request = build(nextId++);
    const id = request.id;
    const timeout = timeoutOverride ?? defaultTimeout;
    return new Promise((resolve, reject) => {
      if (callOptions.signal?.aborted) {
        reject(new AbortError("The operation was aborted"));
        return;
      }
      const onAbort = (): void => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cleanup();
        try {
          worker.postMessage({ id, kind: "cancel" } satisfies WorkerRequest);
        } catch {
          // worker already gone
        }
        reject(new AbortError("The operation was aborted"));
      };
      const timer =
        timeout > 0
          ? setTimeout(() => {
              const entry = pending.get(id);
              if (!entry) return;
              pending.delete(id);
              entry.cleanup();
              try {
                worker.postMessage({
                  id,
                  kind: "cancel",
                } satisfies WorkerRequest);
              } catch {
                // worker already gone
              }
              reject(
                new TimeoutError(
                  `The worker did not respond within ${timeout}ms`,
                ),
              );
            }, timeout)
          : undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        callOptions.signal?.removeEventListener("abort", onAbort);
      };
      pending.set(id, {
        resolve,
        reject,
        onProgress: callOptions.onProgress,
        timer,
        cleanup,
      });
      callOptions.signal?.addEventListener("abort", onAbort);
      try {
        worker.postMessage(request, requestTransferables(request));
      } catch (error) {
        pending.delete(id);
        cleanup();
        reject(
          new ImageToolsError(
            "BACKEND_UNAVAILABLE",
            "Failed to post a message to the worker",
            error,
          ),
        );
      }
    });
  }

  return {
    get mode() {
      return degraded ? "fallback" : "worker";
    },
    get pending() {
      return pending.size;
    },
    async process(image, ops, callOptions = {}) {
      if (degraded) return degraded.process(image, ops, callOptions);
      validateImage(image);
      const copy = cloneImageForTransfer(image);
      const result = await send(
        (id) => ({
          id,
          kind: "process",
          image: copy,
          ops,
          progressEvery: callOptions.onProgress ? 1 : 0,
        }),
        { ...options.defaults, ...callOptions },
      );
      if (!result.image)
        throw new ImageToolsError(
          "BACKEND_UNAVAILABLE",
          "Worker returned no image",
        );
      return result.image;
    },
    async decode(input, callOptions = {}) {
      if (degraded) return degraded.decode(input, callOptions);
      const bytes = await toArrayBuffer(input);
      const result = await send((id) => ({ id, kind: "decode", bytes }), {
        ...options.defaults,
        ...callOptions,
      });
      if (!result.image)
        throw new ImageToolsError(
          "BACKEND_UNAVAILABLE",
          "Worker returned no image",
        );
      return result.image;
    },
    async encode(image, encodeOptions, callOptions = {}) {
      if (degraded) return degraded.encode(image, encodeOptions, callOptions);
      validateImage(image);
      const copy = cloneImageForTransfer(image);
      const result = await send(
        (id) => ({
          id,
          kind: "encode",
          image: copy,
          type: encodeOptions.type,
          quality: encodeOptions.quality,
        }),
        { ...options.defaults, ...callOptions },
      );
      if (!result.bytes)
        throw new ImageToolsError(
          "BACKEND_UNAVAILABLE",
          "Worker returned no bytes",
        );
      return new Blob([result.bytes], {
        type: result.type ?? encodeOptions.type,
      });
    },
    async ping(callOptions = {}) {
      if (degraded) return degraded.ping(callOptions);
      const started = Date.now();
      await send(
        (id) => ({ id, kind: "ping" }),
        { ...options.defaults, ...callOptions },
        callOptions.timeout ?? 5000,
      );
      return Date.now() - started;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      failAll(new ImageToolsError("ABORTED", "The worker was disposed"));
      worker.terminate();
    },
  };
}

function mapCode(code: string): ImageToolsError["code"] {
  const known = [
    "UNSUPPORTED_FORMAT",
    "DECODE_FAILED",
    "ENCODE_FAILED",
    "ABORTED",
    "TIMEOUT",
    "BACKEND_UNAVAILABLE",
    "INVALID_ARGUMENT",
    "PROVIDER_FAILED",
  ];
  return (
    known.includes(code) ? code : "BACKEND_UNAVAILABLE"
  ) as ImageToolsError["code"];
}

function validateImage(image: RawImage): void {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    !image.data ||
    image.data.length !== image.width * image.height * 4
  ) {
    throw invalidArgument(
      "process(): expected a RawImage { width, height, data }",
    );
  }
}

async function toArrayBuffer(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
  if (input instanceof ArrayBuffer) return input.slice(0);
  if (typeof Blob !== "undefined" && input instanceof Blob)
    return input.arrayBuffer();
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(
      input.byteOffset,
      input.byteOffset + input.byteLength,
    ) as ArrayBuffer;
  }
  throw invalidArgument("decode(): expected a Blob, ArrayBuffer or Uint8Array");
}

function defaultWorkerFactory(workerUrl?: string | URL): Worker {
  if (workerUrl)
    return new Worker(workerUrl, { type: "module", name: "picopix" });
  return new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
    name: "picopix",
  });
}

function resolveMode(options: ImageWorkerOptions): "worker" | "fallback" {
  if (options.fallback === "always") return "fallback";
  if (options.workerFactory) return "worker";
  if (!hasWorkerGlobal()) {
    if (options.fallback === "never") {
      throw new ImageToolsError(
        "BACKEND_UNAVAILABLE",
        'Web Workers are not available in this environment; pass fallback: "auto" to run in-process',
      );
    }
    return "fallback";
  }
  return "worker";
}

function createFallbackWorker(options: ImageWorkerOptions): ImageWorker {
  return {
    mode: "fallback",
    get pending() {
      return 0;
    },
    async process(image, ops, callOptions = {}) {
      validateImage(image);
      const merged = { ...options.defaults, ...callOptions };
      if (merged.signal?.aborted) throw new AbortError();
      return executeOps(cloneImageForTransfer(image), ops, {
        isCancelled: () => merged.signal?.aborted === true,
        onProgress: merged.onProgress
          ? (ratio, index, total, label) => {
              merged.onProgress?.({
                phase: label,
                ratio,
                loaded: index,
                total,
              });
            }
          : undefined,
      });
    },
    async decode(input, callOptions = {}) {
      const merged = { ...options.defaults, ...callOptions };
      throwIfAborted(merged.signal);
      const backend = await getBackend();
      const bytes = new Uint8Array(await toArrayBuffer(input));
      return backend.decode(bytes, { signal: merged.signal });
    },
    async encode(image, encodeOptions, callOptions = {}) {
      const merged = { ...options.defaults, ...callOptions };
      throwIfAborted(merged.signal);
      const backend = await getBackend();
      return backend.encode(image, encodeOptions, { signal: merged.signal });
    },
    async ping() {
      return 0;
    },
    dispose() {},
  };
}

export interface WorkerPoolOptions extends ImageWorkerOptions {
  size?: number;
}

export interface ImageWorkerPool {
  readonly size: number;
  readonly mode: "worker" | "fallback";
  readonly pending: number;
  process(
    image: RawImage,
    ops: WorkerOp[],
    options?: RunOptions,
  ): Promise<RawImage>;
  decode(
    input: Blob | ArrayBuffer | Uint8Array,
    options?: RunOptions,
  ): Promise<RawImage>;
  encode(
    image: RawImage,
    encodeOptions: { type: string; quality?: number },
    options?: RunOptions,
  ): Promise<Blob>;
  dispose(): void;
}

export function createWorkerPool(
  options: WorkerPoolOptions = {},
): ImageWorkerPool {
  const detected =
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency - 1
      : 2;
  const size = Math.max(
    1,
    Math.floor(options.size ?? Math.min(4, Math.max(1, detected))),
  );
  const workers: ImageWorker[] = [];
  for (let i = 0; i < size; i++) {
    workers.push(createImageWorker({ ...options, defaults: options.defaults }));
  }
  let cursor = 0;
  const pick = (): ImageWorker => {
    const worker = workers[cursor % workers.length];
    cursor++;
    return worker;
  };

  return {
    size,
    get mode() {
      return workers.some((w) => w.mode === "worker") ? "worker" : "fallback";
    },
    get pending() {
      return workers.reduce((sum, w) => sum + w.pending, 0);
    },
    process(image, ops, callOptions) {
      return pick().process(image, ops, callOptions);
    },
    decode(input, callOptions) {
      return pick().decode(input, callOptions);
    },
    encode(image, encodeOptions, callOptions) {
      return pick().encode(image, encodeOptions, callOptions);
    },
    dispose() {
      for (const worker of workers) worker.dispose();
    },
  };
}
