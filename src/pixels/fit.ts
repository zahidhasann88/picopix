import { invalidArgument } from '../errors';
import type { FitMode, Size } from '../types';

export interface FitSizeOptions {
  width?: number;
  height?: number;
  fit?: FitMode;
  /** Never return a size larger than the source. */
  withoutEnlargement?: boolean;
  /** Round the result to integers (default `true`). */
  round?: boolean;
}

/**
 * Pure fit math — no pixels involved.
 *
 * Mirrors CSS `object-fit` semantics:
 *
 * | fit       | behaviour                                                          |
 * |-----------|--------------------------------------------------------------------|
 * | `fill`    | stretch to the exact box (aspect ratio is *not* preserved)          |
 * | `contain` | largest size that fits *inside* the box (letterbox the rest)        |
 * | `cover`   | smallest size that *covers* the box (crop the overflow)             |
 * | `inside`  | like `contain`, but the result is not padded to the box size        |
 * | `outside` | like `cover`, but the result is not cropped to the box size         |
 *
 * With `fit: 'fill'` and only one dimension given, the other one is derived
 * from the source aspect ratio.
 */
export function computeFitSize(
  srcWidth: number,
  srcHeight: number,
  options: FitSizeOptions = {},
): Size {
  if (!(srcWidth > 0) || !(srcHeight > 0)) {
    throw invalidArgument(`computeFitSize: invalid source size ${srcWidth}x${srcHeight}`);
  }
  const { fit = 'fill', withoutEnlargement = false, round = true } = options;
  let boxW = options.width;
  let boxH = options.height;
  if (boxW !== undefined && boxW <= 0) throw invalidArgument('computeFitSize: width must be > 0');
  if (boxH !== undefined && boxH <= 0) throw invalidArgument('computeFitSize: height must be > 0');
  if (boxW === undefined && boxH === undefined) {
    throw invalidArgument('computeFitSize: width or height is required');
  }

  const aspect = srcWidth / srcHeight;

  // A single dimension behaves identically for every fit mode: preserve aspect.
  const bw: number = boxW ?? (boxH as number) * aspect;
  const bh: number = boxH ?? bw / aspect;

  const scaleX = bw / srcWidth;
  const scaleY = bh / srcHeight;

  let scale: number;
  let w: number;
  let h: number;

  switch (fit) {
    case 'fill':
      w = bw;
      h = bh;
      scale = Math.max(scaleX, scaleY);
      if (withoutEnlargement) {
        const s = Math.min(1, scaleX, scaleY);
        if (s < 1) {
          w = srcWidth * s;
          h = srcHeight * s;
        } else {
          w = srcWidth;
          h = srcHeight;
        }
        scale = s < 1 ? s : 1;
      }
      break;
    case 'contain':
    case 'inside': {
      scale = Math.min(scaleX, scaleY);
      if (withoutEnlargement) scale = Math.min(scale, 1);
      w = srcWidth * scale;
      h = srcHeight * scale;
      break;
    }
    case 'cover':
    case 'outside': {
      scale = Math.max(scaleX, scaleY);
      if (withoutEnlargement) scale = Math.min(scale, 1);
      w = srcWidth * scale;
      h = srcHeight * scale;
      break;
    }
    default:
      throw invalidArgument(`computeFitSize: unknown fit mode '${String(fit)}'`);
  }

  const outW = round ? Math.max(1, Math.round(w)) : w;
  const outH = round ? Math.max(1, Math.round(h)) : h;

  // `contain`/`cover` are defined against the exact box, so they report the box.
  if (fit === 'contain' || fit === 'cover') {
    return {
      width: round ? Math.max(1, Math.round(bw)) : bw,
      height: round ? Math.max(1, Math.round(bh)) : bh,
    };
  }
  return { width: outW, height: outH };
}

/** Scale factor that {@link computeFitSize} would apply for `fit: 'inside'`. */
export function containScale(srcWidth: number, srcHeight: number, boxWidth: number, boxHeight: number): number {
  return Math.min(boxWidth / srcWidth, boxHeight / srcHeight);
}

/** Scale factor that {@link computeFitSize} would apply for `fit: 'cover'`. */
export function coverScale(srcWidth: number, srcHeight: number, boxWidth: number, boxHeight: number): number {
  return Math.max(boxWidth / srcWidth, boxHeight / srcHeight);
}

/** Top-left offset that centres `inner` inside `outer`. */
export function centerOffset(outer: Size, inner: Size): { x: number; y: number } {
  return {
    x: Math.floor((outer.width - inner.width) / 2),
    y: Math.floor((outer.height - inner.height) / 2),
  };
}

/** Centre-crop rectangle of `box` aspect ratio covering the whole source. */
export function coverCropRect(
  srcWidth: number,
  srcHeight: number,
  boxWidth: number,
  boxHeight: number,
): { x: number; y: number; width: number; height: number } {
  const scale = coverScale(srcWidth, srcHeight, boxWidth, boxHeight);
  const w = Math.min(srcWidth, Math.round(boxWidth / scale));
  const h = Math.min(srcHeight, Math.round(boxHeight / scale));
  return { x: Math.floor((srcWidth - w) / 2), y: Math.floor((srcHeight - h) / 2), width: w, height: h };
}

/** Rectangle of `aspect` (w/h) centred in the source: used by `cropToAspect`. */
export function aspectCropRect(
  srcWidth: number,
  srcHeight: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  if (!(aspect > 0)) throw invalidArgument('aspect must be > 0');
  let w = srcWidth;
  let h = Math.round(srcWidth / aspect);
  if (h > srcHeight) {
    h = srcHeight;
    w = Math.round(srcHeight * aspect);
  }
  w = Math.max(1, Math.min(srcWidth, w));
  h = Math.max(1, Math.min(srcHeight, h));
  return { x: Math.floor((srcWidth - w) / 2), y: Math.floor((srcHeight - h) / 2), width: w, height: h };
}

/** `true` when the box is larger than the source in both axes. */
export function isEnlargement(src: Size, box: Size): boolean {
  return box.width > src.width && box.height > src.height;
}
