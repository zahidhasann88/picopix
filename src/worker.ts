import { serveWorkerScope } from "./worker/core";
import { installBrowserBackend } from "./codec/browser";

installBrowserBackend();

export * from "./worker/protocol";
export { executeOps } from "./worker/execute";
export {
  createWorkerCore,
  serveWorkerScope,
  type WorkerCore,
  type WorkerCoreOptions,
  type WorkerMessagePort,
} from "./worker/core";
export {
  createImageWorker,
  createWorkerPool,
  type ImageWorker,
  type ImageWorkerOptions,
  type ImageWorkerPool,
  type RunOptions,
  type WorkerPoolOptions,
} from "./worker/client";

const scope = globalThis as unknown as {
  WorkerGlobalScope?: unknown;
  importScripts?: unknown;
  postMessage?: unknown;
  addEventListener?: unknown;
};

const isWorkerScope =
  typeof scope.importScripts === "function" ||
  (typeof scope.postMessage === "function" &&
    typeof window === "undefined" &&
    typeof scope.addEventListener === "function");

if (isWorkerScope) {
  serveWorkerScope(scope as unknown as Parameters<typeof serveWorkerScope>[0]);
}
