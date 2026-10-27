import {
  decodeNode,
  encodeNode,
  isNodeBackendAvailable,
  loadNapiCanvas,
  loadNapiCanvasAsync,
  nodeBackend,
} from "./codec/node";
import { setBackend } from "./codec/backend";

export {
  decodeNode,
  encodeNode,
  isNodeBackendAvailable,
  loadNapiCanvas,
  loadNapiCanvasAsync,
  nodeBackend,
};
export * from "./index";

export function useNodeBackend(): Promise<boolean> {
  return loadNapiCanvasAsync().then((mod) => {
    if (!mod) return false;
    setBackend(nodeBackend);
    return true;
  });
}

if (typeof process !== "undefined" && process.versions?.node) {
  const sync = loadNapiCanvas();
  if (sync) setBackend(nodeBackend);
}
