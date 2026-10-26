import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImageWorker } from '../src/worker/client';
import { coordinateImage } from './fixtures/images';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'helpers', 'worker-thread-entry.mjs');
const distWorker = join(here, '..', 'dist', 'worker.js');

/**
 * These tests need `dist/worker.js`, so they only run after `npm run build`.
 * `npm test` runs before the build in CI, so the suite skips rather than fails —
 * `npm run prepublishOnly` and the CI "verify build" job run them for real.
 */
const built = existsSync(distWorker);

describe.skipIf(!built)('real worker thread (node:worker_threads + dist/worker.js)', () => {
  // The client uses DOM-style `addEventListener`; Node's Worker exposes `on()`.
  // A thin adapter keeps the shipped client untouched.
  const adapter = createImageWorker({
    workerFactory: () => {
      const thread = new NodeWorker(entry, { type: 'module' } as never);
      const listeners: Array<(event: { data: unknown }) => void> = [];
      const errorListeners: Array<(event: { message?: string }) => void> = [];
      (thread as unknown as { on: (event: string, cb: (arg: unknown) => void) => void }).on(
        'message',
        (data: unknown) => {
          for (const listener of listeners) listener({ data });
        },
      );
      thread.on('error', (error: Error) => {
        for (const listener of errorListeners) listener({ message: error.message });
      });
      return {
        postMessage: (message: unknown, transfer?: unknown[]) => thread.postMessage(message, transfer as never),
        addEventListener: (type: string, listener: never) => {
          if (type === 'message') listeners.push(listener);
          if (type === 'error') errorListeners.push(listener);
        },
        terminate: () => void thread.terminate(),
      } as unknown as globalThis.Worker;
    },
  });

  beforeAll(() => {
    /* the worker starts lazily on the first request */
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('reports worker mode', () => {
    expect(adapter.mode).toBe('worker');
  });

  it('runs an ops list across a real thread boundary', async () => {
    const out = await adapter.process(coordinateImage(16, 8), [
      { op: 'resize', width: 8, height: 4, fit: 'fill' },
      { op: 'flip', axis: 'y' },
    ]);
    expect([out.width, out.height]).toEqual([8, 4]);
  });

  it('answers ping', async () => {
    expect(await adapter.ping()).toBeGreaterThanOrEqual(0);
  });

  it('keeps the caller buffer intact (transfer uses a copy)', async () => {
    const image = coordinateImage(4, 4);
    const before = Array.from(image.data);
    await adapter.process(image, [{ op: 'flip', axis: 'x' }]);
    expect(Array.from(image.data)).toEqual(before);
  });

  it('surfaces op errors as typed errors', async () => {
    await expect(adapter.process(coordinateImage(4, 4), [{ op: 'resize', width: 0, height: 2 }])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
