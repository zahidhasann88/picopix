import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorkerCore, serveWorkerScope, type WorkerMessagePort } from '../src/worker/core';
import { executeOps, validateOps } from '../src/worker/execute';
import {
  cloneImageForTransfer,
  requestTransferables,
  transferablesFor,
  type WorkerOp,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/worker/protocol';
import { createImage } from '../src/pixels';
import { coordinateImage } from './fixtures/images';
import { nodeBackend, useNodeBackend } from '../src/node';

/**
 * A fake `MessagePort` that records posted messages and delivers them
 * asynchronously (like a real port) to any listener.
 */
function createFakePort(): {
  port: WorkerMessagePort;
  sent: Array<{ message: WorkerResponse; transfer: Transferable[] }>;
  log: Array<{ message: WorkerResponse; transfer: Transferable[] }>;
  deliver: (data: unknown) => void;
  next: () => Promise<WorkerResponse>;
} {
  const sent: Array<{ message: WorkerResponse; transfer: Transferable[] }> = [];
  const log: Array<{ message: WorkerResponse; transfer: Transferable[] }> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const waiters: Array<(message: WorkerResponse) => void> = [];
  const port: WorkerMessagePort = {
    postMessage(message, transfer = []) {
      sent.push({ message, transfer });
      log.push({ message, transfer });
      const waiter = waiters.shift();
      if (waiter) waiter(message);
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
  };
  return {
    port,
    sent,
    log,
    deliver(data) {
      for (const listener of listeners) listener({ data });
    },
    next() {
      return new Promise<WorkerResponse>((resolve) => {
        const existing = sent.shift();
        if (existing) {
          resolve(existing.message);
          return;
        }
        waiters.push(resolve);
      });
    },
  };
}

beforeAll(async () => {
  await useNodeBackend();
});

describe('executeOps', () => {
  it('applies an ops list in order and never mutates the input', () => {
    const src = coordinateImage(8, 6);
    const copy = new Uint8ClampedArray(src.data);
    const out = executeOps(src, [
      { op: 'resize', width: 4, height: 3, fit: 'fill' },
      { op: 'flip', axis: 'x' },
      { op: 'filter', filter: { type: 'invert' } },
    ]);
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
    expect(Array.from(src.data)).toEqual(Array.from(copy));
  });

  it('supports every op in the protocol', () => {
    const src = coordinateImage(10, 8);
    const ops: WorkerOp[] = [
      { op: 'orient', orientation: 1 },
      { op: 'crop', x: 1, y: 1, width: 8, height: 6 },
      { op: 'rotate', angle: 90 },
      { op: 'flip', axis: 'y' },
      { op: 'pad', padding: 1 },
      { op: 'filter', filter: { type: 'grayscale' } },
      { op: 'blur', radius: 1 },
      { op: 'resize', width: 5, height: 5, fit: 'cover', kernel: 'bilinear' },
      { op: 'trim' },
    ];
    const out = executeOps(src, ops);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
    expect(out.data.length).toBe(out.width * out.height * 4);
  });

  it('supports applyMask and composite ops', () => {
    const src = createImage(4, 4, [255, 0, 0, 255]);
    const mask = { width: 4, height: 4, data: new Uint8ClampedArray(16).fill(0) };
    const masked = executeOps(src, [{ op: 'applyMask', mask }]);
    expect(masked.data[3]).toBe(0);
    const composed = executeOps(src, [
      { op: 'composite', source: createImage(2, 2, [0, 0, 255, 255]), x: 1, y: 1 },
    ]);
    expect(Array.from(composed.data.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4))).toEqual([0, 0, 255, 255]);
  });

  it('reports progress and honours cancellation', () => {
    const ratios: number[] = [];
    executeOps(coordinateImage(4, 4), [{ op: 'flip', axis: 'x' }, { op: 'flip', axis: 'y' }], {
      onProgress: (ratio) => ratios.push(ratio),
    });
    expect(ratios).toEqual([0.5, 1]);
    expect(() =>
      executeOps(coordinateImage(4, 4), [{ op: 'flip', axis: 'x' }], { isCancelled: () => true }),
    ).toThrow(/aborted/i);
  });

  it('rejects malformed ops with a helpful message', () => {
    expect(() => executeOps(coordinateImage(2, 2), [{ op: 'nope' } as unknown as WorkerOp])).toThrow(/Unknown op/);
    expect(() => validateOps([{} as WorkerOp])).toThrow(/must be an object with an 'op' field/);
    expect(() => validateOps('nope' as unknown as WorkerOp[])).toThrow(/must be an array/);
  });
});

describe('worker core (in-process, fake port)', () => {
  it('answers ping', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port);
    await core.handle({ id: 7, kind: 'ping' });
    expect((await fake.next()).kind).toBe('pong');
  });

  it('processes an ops list and transfers the result buffer', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port);
    const image = coordinateImage(8, 4);
    await core.handle({ id: 1, kind: 'process', image, ops: [{ op: 'resize', width: 4, height: 4, fit: 'fill' }] });
    const response = (await fake.next()) as Extract<WorkerResponse, { kind: 'result' }>;
    expect(response.kind).toBe('result');
    expect(response.image?.width).toBe(4);
    expect(response.image?.height).toBe(4);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(fake.log[0].transfer).toHaveLength(1);
    expect(fake.log[0].transfer[0]).toBe(response.image!.data.buffer);
  });

  it('streams progress messages when progressEvery is set', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port);
    await core.handle({
      id: 2,
      kind: 'process',
      image: coordinateImage(6, 6),
      ops: [{ op: 'flip', axis: 'x' }, { op: 'flip', axis: 'y' }],
      progressEvery: 1,
    });
    // 2 progress messages then the result.
    const first = await fake.next();
    expect(first.kind).toBe('progress');
    expect((first as Extract<WorkerResponse, { kind: 'progress' }>).ratio).toBeCloseTo(0.5);
    const second = await fake.next();
    expect(second.kind).toBe('progress');
    const third = await fake.next();
    expect(third.kind).toBe('result');
  });

  it('cancels by id and returns a cancelled message', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port);
    core.cancel(9);
    await core.handle({
      id: 9,
      kind: 'process',
      image: coordinateImage(4, 4),
      ops: [{ op: 'flip', axis: 'x' }],
    });
    expect((await fake.next()).kind).toBe('cancelled');
  });

  it('reports op failures as error responses with a code', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port);
    await core.handle({
      id: 3,
      kind: 'process',
      image: coordinateImage(4, 4),
      ops: [{ op: 'resize', width: 0, height: 0 }],
    });
    const response = (await fake.next()) as Extract<WorkerResponse, { kind: 'error' }>;
    expect(response.kind).toBe('error');
    expect(response.code).toBe('INVALID_ARGUMENT');
    expect(response.message).toMatch(/positive integer/);
  });

  it('reports malformed requests', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port);
    await core.handle({ kind: 'process' });
    const response = (await fake.next()) as Extract<WorkerResponse, { kind: 'error' }>;
    expect(response.kind).toBe('error');
    expect(response.code).toBe('INVALID_ARGUMENT');
    await core.handle({ id: 4, kind: 'nonsense' });
    expect(((await fake.next()) as Extract<WorkerResponse, { kind: 'error' }>).message).toMatch(/Unknown request kind/);
  });

  it('decodes bytes and encodes pixels through the backend', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port, { backend: async () => nodeBackend });
    const png = (await nodeBackend.encode(createImage(5, 3, [1, 2, 3, 255]), { type: 'image/png' })).arrayBuffer();
    await core.handle({ id: 11, kind: 'decode', bytes: await png });
    const decoded = (await fake.next()) as Extract<WorkerResponse, { kind: 'result' }>;
    expect([decoded.image?.width, decoded.image?.height]).toEqual([5, 3]);

    await core.handle({
      id: 12,
      kind: 'encode',
      image: decoded.image!,
      type: 'image/jpeg',
      quality: 0.8,
      returnImage: true,
    });
    const encoded = (await fake.next()) as Extract<WorkerResponse, { kind: 'result' }>;
    expect(encoded.bytes!.byteLength).toBeGreaterThan(0);
    expect(encoded.type).toBe('image/jpeg');
    expect(encoded.image).toBeDefined();
    expect(fake.log.at(-1)!.transfer.length).toBe(2);
  });

  it('serveWorkerScope wires a listener and starts the port', async () => {
    const fake = createFakePort();
    const start = vi.fn();
    const core = serveWorkerScope({ ...fake.port, start });
    expect(start).toHaveBeenCalled();
    fake.deliver({ id: 21, kind: 'ping' } as WorkerRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await fake.next()).kind).toBe('pong');
    expect(core.processed).toBe(1);
  });

  it('counts handled requests and clears state on dispose', async () => {
    const fake = createFakePort();
    const core = createWorkerCore(fake.port);
    await core.handle({ id: 1, kind: 'ping' });
    await core.handle({ id: 2, kind: 'ping' });
    expect(core.processed).toBe(2);
    core.dispose();
    await core.handle({ id: 3, kind: 'ping' });
    expect((await fake.next()).kind).toBe('pong'); // not cancelled after dispose
  });
});

describe('protocol helpers', () => {
  it('collects transferables for each request kind', () => {
    const image = coordinateImage(2, 2);
    const processRequest: WorkerRequest = { id: 1, kind: 'process', image, ops: [{ op: 'flip', axis: 'x' }] };
    expect(requestTransferables(processRequest)).toEqual([image.data.buffer]);
    const decodeRequest: WorkerRequest = { id: 2, kind: 'decode', bytes: new ArrayBuffer(8) };
    expect(requestTransferables(decodeRequest)).toHaveLength(1);
    const maskData = new Uint8ClampedArray(4);
    const withMask: WorkerRequest = {
      id: 3,
      kind: 'process',
      image,
      ops: [{ op: 'applyMask', mask: { width: 2, height: 2, data: maskData } }],
    };
    // Op buffers belong to the caller (often reused) and must not be detached.
    expect(requestTransferables(withMask)).toEqual([image.data.buffer]);
  });

  it('collects transferables for result responses only', () => {
    expect(transferablesFor({ id: 1, kind: 'pong' })).toEqual([]);
    const image = coordinateImage(2, 2);
    expect(transferablesFor({ id: 1, kind: 'result', image, durationMs: 0 })).toEqual([image.data.buffer]);
    const bytes = new ArrayBuffer(4);
    expect(transferablesFor({ id: 1, kind: 'result', bytes, durationMs: 0 })).toEqual([bytes]);
  });

  it('cloneImageForTransfer produces an independent buffer', () => {
    const image = coordinateImage(3, 3);
    const clone = cloneImageForTransfer(image);
    expect(Array.from(clone.data)).toEqual(Array.from(image.data));
    expect(clone.data).not.toBe(image.data);
    expect(clone.data.buffer).not.toBe(image.data.buffer);
  });
});
