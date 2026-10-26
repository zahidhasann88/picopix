import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createImageWorker, createWorkerPool, type ImageWorker } from '../src/worker/client';
import { createWorkerCore } from '../src/worker/core';
import type { WorkerRequest, WorkerResponse } from '../src/worker/protocol';
import { coordinateImage } from './fixtures/images';
import { createImage } from '../src/pixels';
import { nodeBackend, useNodeBackend } from '../src/node';

/**
 * A `Worker`-compatible fake that runs the real worker core in-process and
 * delivers messages asynchronously, exactly like a module worker would.
 *
 * This is the simulation harness for the worker path: the message protocol,
 * request ids, transferables, cancellation and timeouts are all exercised for
 * real; only the thread boundary itself is simulated.
 */
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly requests: WorkerRequest[] = [];
  terminated = false;
  private core: ReturnType<typeof createWorkerCore>;
  /** Records what the client asked to transfer, then strips it (structured clone). */
  readonly transfers: Transferable[][] = [];

  constructor() {
    super();
    FakeWorker.instances.push(this);
    this.core = createWorkerCore(
      {
        postMessage: (message: WorkerResponse, transfer?: Transferable[]) => {
          // Simulate the structured clone: deep copies, buffers not detached.
          const cloned = structuredClone(message);
          queueMicrotask(() => {
            this.dispatchEvent(new MessageEvent('message', { data: cloned }));
          });
          void transfer;
        },
      },
      { backend: async () => nodeBackend },
    );
  }

  postMessage(request: WorkerRequest, transfer?: Transferable[]): void {
    this.requests.push(request);
    this.transfers.push(transfer ?? []);
    const cloned = structuredClone(request);
    queueMicrotask(() => {
      void this.core.handle(cloned);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

beforeAll(async () => {
  await useNodeBackend();
});

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function withFakeWorker(): ImageWorker {
  return createImageWorker({ workerFactory: () => new FakeWorker() as unknown as Worker });
}

describe('createImageWorker (worker mode, simulated boundary)', () => {
  it('runs an ops list and returns the resized image', async () => {
    const worker = withFakeWorker();
    expect(worker.mode).toBe('worker');
    const out = await worker.process(coordinateImage(8, 4), [
      { op: 'resize', width: 4, height: 4, fit: 'fill' },
    ]);
    expect([out.width, out.height]).toEqual([4, 4]);
    worker.dispose();
  });

  it('does not detach or corrupt the caller image', async () => {
    const worker = withFakeWorker();
    const image = coordinateImage(6, 6);
    const before = Array.from(image.data);
    await worker.process(image, [{ op: 'flip', axis: 'x' }]);
    expect(Array.from(image.data)).toEqual(before);
    // The request carried a copy, and the copy's buffer was offered for transfer.
    const fake = FakeWorker.instances[0];
    expect(fake.requests[0].kind).toBe('process');
    expect(fake.transfers[0]).toHaveLength(1);
    worker.dispose();
  });

  it('correlates concurrent requests by id', async () => {
    const worker = withFakeWorker();
    const [a, b, c] = await Promise.all([
      worker.process(coordinateImage(8, 8), [{ op: 'resize', width: 2, height: 2, fit: 'fill' }]),
      worker.process(coordinateImage(8, 8), [{ op: 'resize', width: 3, height: 3, fit: 'fill' }]),
      worker.process(coordinateImage(8, 8), [{ op: 'resize', width: 4, height: 4, fit: 'fill' }]),
    ]);
    expect([a.width, b.width, c.width]).toEqual([2, 3, 4]);
    const ids = FakeWorker.instances[0].requests.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    worker.dispose();
  });

  it('streams progress callbacks', async () => {
    const worker = withFakeWorker();
    const ratios: number[] = [];
    await worker.process(
      coordinateImage(6, 6),
      [{ op: 'flip', axis: 'x' }, { op: 'flip', axis: 'y' }],
      { onProgress: (p) => ratios.push(p.ratio ?? 0) },
    );
    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios.at(-1)).toBeGreaterThan(0.4);
    worker.dispose();
  });

  it('rejects with AbortError when the signal fires, and tells the worker to cancel', async () => {
    const worker = withFakeWorker();
    const controller = new AbortController();
    const promise = worker.process(coordinateImage(4, 4), [{ op: 'blur', radius: 1 }], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(FakeWorker.instances[0].requests.some((r) => r.kind === 'cancel')).toBe(true);
    worker.dispose();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const worker = withFakeWorker();
    const controller = new AbortController();
    controller.abort();
    await expect(
      worker.process(coordinateImage(2, 2), [{ op: 'flip', axis: 'x' }], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    worker.dispose();
  });

  it('times out hanging requests', async () => {
    // A worker that never answers.
    class SilentWorker extends EventTarget {
      postMessage(): void {}
      terminate(): void {}
    }
    const worker = createImageWorker({
      workerFactory: () => new SilentWorker() as unknown as Worker,
      timeout: 20,
    });
    await expect(worker.process(coordinateImage(2, 2), [{ op: 'flip', axis: 'x' }])).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    worker.dispose();
  });

  it('decodes and encodes through the worker', async () => {
    const worker = withFakeWorker();
    const png = await nodeBackend.encode(createImage(4, 3, [9, 9, 9, 255]), { type: 'image/png' });
    const raw = await worker.decode(png);
    expect([raw.width, raw.height]).toEqual([4, 3]);
    const webp = await worker.encode(raw, { type: 'image/webp', quality: 0.7 });
    expect(webp.type).toBe('image/webp');
    expect(webp.size).toBeGreaterThan(0);
    worker.dispose();
  });

  it('rejects invalid images before sending anything', async () => {
    const worker = withFakeWorker();
    await expect(
      worker.process({ width: 2, height: 2, data: new Uint8ClampedArray(2) } as never, []),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    worker.dispose();
  });

  it('fails pending work and refuses new work after dispose', async () => {
    const worker = withFakeWorker();
    const pending = worker.process(coordinateImage(4, 4), [{ op: 'flip', axis: 'x' }]);
    worker.dispose();
    await expect(pending).rejects.toBeTruthy();
    await expect(worker.process(coordinateImage(2, 2), [])).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('falls back to the main thread when Worker construction throws', async () => {
    const worker = createImageWorker({
      workerFactory: () => {
        throw new Error('no workers here');
      },
    });
    expect(worker.mode).toBe('fallback');
    const out = await worker.process(coordinateImage(8, 4), [
      { op: 'resize', width: 4, height: 2, fit: 'fill' },
    ]);
    expect([out.width, out.height]).toEqual([4, 2]);
  });

  it('throws when fallback is disabled and no Worker global exists', () => {
    const original = (globalThis as { Worker?: unknown }).Worker;
    delete (globalThis as { Worker?: unknown }).Worker;
    try {
      expect(() => createImageWorker({ fallback: 'never' })).toThrow(/Web Workers are not available/);
    } finally {
      (globalThis as { Worker?: unknown }).Worker = original;
    }
  });
});

describe('fallback mode', () => {
  it('produces byte-identical results to the worker path', async () => {
    const image = coordinateImage(12, 9);
    const ops = [
      { op: 'resize' as const, width: 7, height: 5, fit: 'fill' as const, kernel: 'lanczos3' as const },
      { op: 'filter' as const, filter: { type: 'contrast' as const, amount: 1.2 } },
    ];
    const viaWorker = await withFakeWorker().process(image, ops);
    const viaFallback = await createImageWorker({ fallback: 'always' }).process(image, ops);
    expect(Array.from(viaFallback.data)).toEqual(Array.from(viaWorker.data));
  });

  it('supports decode/encode/ping', async () => {
    const worker = createImageWorker({ fallback: 'always' });
    expect(worker.mode).toBe('fallback');
    expect(await worker.ping()).toBe(0);
    const png = await nodeBackend.encode(createImage(2, 2, [5, 5, 5, 255]), { type: 'image/png' });
    const raw = await worker.decode(png);
    expect([raw.width, raw.height]).toEqual([2, 2]);
    const encoded = await worker.encode(raw, { type: 'image/png' });
    expect(encoded.type).toBe('image/png');
  });

  it('honours signals in fallback mode', async () => {
    const worker = createImageWorker({ fallback: 'always' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      worker.process(coordinateImage(2, 2), [{ op: 'flip', axis: 'x' }], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('createWorkerPool', () => {
  it('creates `size` workers and round-robins requests', async () => {
    FakeWorker.instances = [];
    const pool = createWorkerPool({
      size: 3,
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    expect(pool.size).toBe(3);
    expect(pool.mode).toBe('worker');
    const results = await Promise.all(
      [2, 3, 4, 5].map((w) => pool.process(coordinateImage(8, 8), [{ op: 'resize', width: w, height: w, fit: 'fill' }])),
    );
    expect(results.map((r) => r.width)).toEqual([2, 3, 4, 5]);
    // 4 requests across 3 workers: the first worker gets requests 1 and 4.
    const counts = FakeWorker.instances.map((fake) => fake.requests.filter((r) => r.kind === 'process').length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
    expect(counts[0]).toBe(2);
    pool.dispose();
    expect(FakeWorker.instances.every((fake) => fake.terminated)).toBe(true);
  });

  it('schedules a burst of work without losing results', async () => {
    const pool = createWorkerPool({ size: 2, workerFactory: () => new FakeWorker() as unknown as Worker });
    const jobs = Array.from({ length: 12 }, (_, i) =>
      pool.process(coordinateImage(16, 16), [{ op: 'resize', width: 4 + (i % 4), height: 4, fit: 'fill' }]),
    );
    const out = await Promise.all(jobs);
    expect(out).toHaveLength(12);
    expect(out.every((image) => image.height === 4)).toBe(true);
    pool.dispose();
  });

  it('reports fallback mode when workers are unavailable', () => {
    const pool = createWorkerPool({ size: 2, fallback: 'always' });
    expect(pool.mode).toBe('fallback');
    expect(pool.size).toBe(2);
    pool.dispose();
  });

  it('defaults to a sane size', () => {
    const pool = createWorkerPool({ fallback: 'always' });
    expect(pool.size).toBeGreaterThanOrEqual(1);
    expect(pool.size).toBeLessThanOrEqual(4);
    pool.dispose();
  });
});
