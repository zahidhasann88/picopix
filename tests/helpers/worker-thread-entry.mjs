/**
 * A *real* worker thread (not a fake port) running the built worker bundle.
 *
 * Node's `worker_threads` is used as the thread boundary: the wrapper below maps
 * `WorkerGlobalScope`-ish globals (`postMessage` / `addEventListener('message')`)
 * onto `parentPort`, then imports `dist/worker.js` unchanged. That exercises the
 * real message plumbing, structured cloning and buffer transfer of the shipped
 * worker entry — only the browser's `OffscreenCanvas` is swapped for the Node
 * backend (process ops do not need a backend at all).
 */
import { parentPort } from 'node:worker_threads';

if (!parentPort) throw new Error('this file must run inside a worker thread');

const listeners = [];
/** Messages that arrive before the bundle finished importing. */
const pending = [];
let ready = false;

parentPort.on('message', (data) => {
  if (!ready) {
    pending.push(data);
    return;
  }
  for (const listener of listeners) listener({ data });
});

globalThis.postMessage = (message, transfer) => {
  parentPort.postMessage(message, transfer);
};
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') listeners.push(listener);
};
globalThis.start = () => {};

// Importing the built bundle after the globals exist makes it auto-start.
await import('../../dist/worker.js');

ready = true;
for (const data of pending) {
  for (const listener of listeners) listener({ data });
}
pending.length = 0;
