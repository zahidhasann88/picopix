import type { BlendMode, FitMode, RGBA, RawImage, ResizeKernel } from '../types';
import type { FilterSpec } from '../pixels/filters';

/**
 * One entry of the serialisable ops list sent to the worker.
 *
 * Every op is plain JSON — no functions, no class instances — so the same list
 * can be persisted, logged, replayed or sent over `postMessage`/HTTP.
 */
export type WorkerOp =
  | {
      op: 'orient';
      orientation: number;
    }
  | {
      op: 'resize';
      width?: number;
      height?: number;
      fit?: FitMode;
      kernel?: ResizeKernel;
      withoutEnlargement?: boolean;
      antialias?: boolean;
    }
  | {
      op: 'crop';
      x: number;
      y: number;
      width?: number;
      height?: number;
    }
  | {
      op: 'rotate';
      angle: number;
      background?: RGBA;
    }
  | {
      op: 'flip';
      axis: 'x' | 'y';
    }
  | {
      op: 'filter';
      filter: FilterSpec;
    }
  | {
      op: 'blur';
      radius: number;
      type?: 'box' | 'gaussian';
      passes?: number;
    }
  | {
      op: 'pad';
      padding:
        | number
        | { top?: number; right?: number; bottom?: number; left?: number };
      color?: RGBA;
    }
  | {
      op: 'trim';
      threshold?: number;
      color?: RGBA;
      alpha?: boolean;
    }
  | {
      op: 'applyMask';
      /** Single-channel mask; must match the current image size. */
      mask: { width: number; height: number; data: Uint8ClampedArray };
      invert?: boolean;
    }
  | {
      op: 'composite';
      source: RawImage;
      x?: number;
      y?: number;
      opacity?: number;
      blendMode?: BlendMode;
    };

/** Requests sent **to** the worker. */
export type WorkerRequest =
  | {
      id: number;
      kind: 'process';
      image: RawImage;
      ops: WorkerOp[];
      /** Report progress every N ops. `0` disables progress messages. */
      progressEvery?: number;
    }
  | {
      id: number;
      kind: 'decode';
      bytes: ArrayBuffer;
    }
  | {
      id: number;
      kind: 'encode';
      image: RawImage;
      type: string;
      quality?: number;
      /** When `true`, the (possibly unmodified) image is transferred back too. */
      returnImage?: boolean;
    }
  | {
      id: number;
      kind: 'cancel';
    }
  | {
      id: number;
      kind: 'ping';
    };

/** Responses sent **from** the worker. */
export type WorkerResponse =
  | {
      id: number;
      kind: 'result';
      image?: RawImage;
      bytes?: ArrayBuffer;
      type?: string;
      durationMs: number;
    }
  | {
      id: number;
      kind: 'progress';
      phase: string;
      ratio: number;
      index?: number;
      total?: number;
    }
  | {
      id: number;
      kind: 'error';
      code: string;
      message: string;
    }
  | {
      id: number;
      kind: 'pong';
    }
  | {
      id: number;
      kind: 'cancelled';
    };

/** Collects the transferable buffers of a response (buffers move, not copy). */
export function transferablesFor(response: WorkerResponse): Transferable[] {
  const list: Transferable[] = [];
  if (response.kind !== 'result') return list;
  if (response.image) list.push(response.image.data.buffer as ArrayBuffer);
  if (response.bytes) list.push(response.bytes);
  return list;
}

/** Collects the transferable buffers of a request. */
export function requestTransferables(request: WorkerRequest): Transferable[] {
  const list: Transferable[] = [];
  switch (request.kind) {
    case 'process':
    case 'encode':
      list.push(request.image.data.buffer as ArrayBuffer);
      if (request.kind === 'process') {
        for (const op of request.ops) {
          if (op.op === 'applyMask') list.push(op.mask.data.buffer as ArrayBuffer);
          if (op.op === 'composite') list.push(op.source.data.buffer as ArrayBuffer);
        }
      }
      break;
    case 'decode':
      list.push(request.bytes);
      break;
    default:
      break;
  }
  return list;
}

/** Deep-ish clone of a request so transferring its buffers cannot corrupt the caller's copy. */
export function cloneImageForTransfer(image: RawImage): RawImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}
