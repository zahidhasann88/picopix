import { ImageToolsError, invalidArgument } from '../errors';
import type { RawImage } from '../types';
import { applyOrientation, crop, flip, pad, rotate, trimImage } from '../pixels/transform';
import { resize } from '../pixels/resize';
import { blur, filter } from '../pixels/filters';
import { applyAlphaMask, composite } from '../pixels/composite';
import type { WorkerOp } from './protocol';

export interface ExecuteOptions {
  /** Called after each op with the fraction of completed work. */
  onProgress?: (ratio: number, index: number, total: number, label: string) => void;
  /** Polled between ops; return `true` to stop with an `AbortError`. */
  isCancelled?: () => boolean;
}

/**
 * Applies an ops list to pixels.
 *
 * This is the *entire* worker payload: it is also used verbatim as the
 * main-thread fallback, which is why the fallback and the worker can never
 * diverge behaviourally. Ops are applied in order and the list is never mutated.
 */
export function executeOps(image: RawImage, ops: WorkerOp[], options: ExecuteOptions = {}): RawImage {
  let current = image;
  const total = ops.length;
  for (let i = 0; i < ops.length; i++) {
    if (options.isCancelled?.()) {
      throw new ImageToolsError('ABORTED', 'The operation was aborted');
    }
    const op = ops[i];
    try {
      current = applyOp(current, op);
    } catch (error) {
      if (error instanceof ImageToolsError) throw error;
      throw new ImageToolsError(
        'INVALID_ARGUMENT',
        `Op #${i} ('${(op as { op?: string }).op}') failed: ${(error as Error)?.message ?? String(error)}`,
        error,
      );
    }
    options.onProgress?.((i + 1) / total, i, total, op.op);
  }
  return current;
}

function applyOp(image: RawImage, op: WorkerOp): RawImage {
  switch (op.op) {
    case 'orient':
      return applyOrientation(image, op.orientation);
    case 'resize':
      return resize(image, {
        width: op.width,
        height: op.height,
        fit: op.fit,
        kernel: op.kernel,
        withoutEnlargement: op.withoutEnlargement,
        antialias: op.antialias,
      });
    case 'crop':
      return crop(image, {
        x: op.x,
        y: op.y,
        width: op.width ?? image.width - op.x,
        height: op.height ?? image.height - op.y,
      });
    case 'rotate':
      return rotate(image, op.angle, op.background);
    case 'flip':
      return flip(image, op.axis);
    case 'filter':
      return filter(image, op.filter);
    case 'blur':
      return blur(image, { radius: op.radius, type: op.type, passes: op.passes });
    case 'pad':
      return pad(image, op.padding, op.color);
    case 'trim':
      return trimImage(image, { threshold: op.threshold, color: op.color, alpha: op.alpha });
    case 'applyMask':
      return applyAlphaMask(image, op.mask, op.invert);
    case 'composite':
      return composite(image, op.source, {
        x: op.x,
        y: op.y,
        opacity: op.opacity,
        blendMode: op.blendMode,
      });
    default:
      throw invalidArgument(`Unknown op '${String((op as { op: string }).op)}'`);
  }
}

/** Validates an ops list without running it (used by the client for early errors). */
export function validateOps(ops: WorkerOp[]): void {
  if (!Array.isArray(ops)) throw invalidArgument('ops must be an array');
  for (const [i, op] of ops.entries()) {
    if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') {
      throw invalidArgument(`ops[${i}] must be an object with an 'op' field`);
    }
  }
}
