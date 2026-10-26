import { invalidArgument } from '../errors';
import type { RawImage, ResizeKernel, ResizeOptions } from '../types';
import { assertImage, clampByte, fromPremultiplied, toPremultiplied } from './util';
import { computeFitSize, coverCropRect } from './fit';
import { crop } from './transform';

/** Kernel support radius in *source* pixels (before any downscale widening). */
const KERNEL_SUPPORT: Record<Exclude<ResizeKernel, 'nearest'>, number> = {
  bilinear: 1,
  'catmull-rom': 2,
  lanczos3: 3,
};

const BILINEAR_KEYS: Float64Array = new Float64Array([1]);

const CATMULL_ROM_KEYS: Float64Array = (() => {
  const k = new Float64Array(5);
  for (let j = 0; j < 5; j++) {
    const x = Math.abs(j - 2);
    if (x < 1) k[j] = 1.5 * x * x * x - 2.5 * x * x + 1;
    else if (x < 2) k[j] = -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
    else k[j] = 0;
  }
  return k;
})();

/** Normalised value of the Lanczos-3 kernel at integer offsets -3..3. */
const LANCZOS3_KEYS: Float64Array = (() => {
  const k = new Float64Array(7);
  for (let j = 0; j < 7; j++) {
    const x = Math.abs(j - 3);
    if (x === 0) {
      k[j] = 1;
    } else if (x < 3) {
      const px = Math.PI * x;
      k[j] = (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
    } else {
      k[j] = 0;
    }
  }
  return k;
})();

/**
 * Taps used for one output pixel.
 * - `first` is the index of the first contributing source pixel.
 * - `weights` holds normalised weights for `first .. first + weights.length - 1`.
 */
export interface ResampleTaps {
  first: number;
  weights: Float64Array;
}

type KernelFn = (x: number) => number;

function bilinearFn(x: number): number {
  const ax = Math.abs(x);
  return ax < 1 ? 1 - ax : 0;
}

function catmullRomFn(x: number): number {
  const ax = Math.abs(x);
  if (ax < 1) return 1.5 * ax * ax * ax - 2.5 * ax * ax + 1;
  if (ax < 2) return -0.5 * ax * ax * ax + 2.5 * ax * ax - 4 * ax + 2;
  return 0;
}

function lanczos3Fn(x: number): number {
  const ax = Math.abs(x);
  if (ax === 0) return 1;
  if (ax >= 3) return 0;
  const px = Math.PI * ax;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

function kernelFn(kernel: Exclude<ResizeKernel, 'nearest'>): KernelFn {
  switch (kernel) {
    case 'bilinear':
      return bilinearFn;
    case 'catmull-rom':
      return catmullRomFn;
    case 'lanczos3':
      return lanczos3Fn;
  }
}

/**
 * Pre-computes the resampling taps for one axis.
 *
 * When `antialias` is on and we are downscaling, the kernel is stretched by the
 * scale factor (a "widened kernel"), which is what makes the downscale
 * anti-aliased: every source pixel inside the footprint contributes, so no high
 * frequency detail is skipped.
 *
 * For an **integer upscale** with a symmetric kernel the result is an exactly
 * phase-aligned interpolation, i.e. `resize(constant, k)` returns the same
 * constant — this is asserted in the tests.
 */
export function computeTaps(
  srcSize: number,
  dstSize: number,
  kernel: Exclude<ResizeKernel, 'nearest'>,
  antialias = true,
): ResampleTaps[] {
  const scale = dstSize / srcSize;
  const widen = antialias && scale < 1 ? 1 / scale : 1;
  const support = KERNEL_SUPPORT[kernel] * widen;
  const fn = kernelFn(kernel);
  const taps: ResampleTaps[] = new Array(dstSize);

  for (let d = 0; d < dstSize; d++) {
    // Centre of output pixel `d` mapped into source coordinates.
    const center = (d + 0.5) / scale;
    const lo = Math.floor(center - support + 0.5);
    const hi = Math.ceil(center + support - 0.5);
    const first = lo;
    const count = Math.max(1, hi - lo + 1);
    const weights = new Float64Array(count);
    let sum = 0;
    for (let t = 0; t < count; t++) {
      const srcIndex = first + t;
      const w = fn((srcIndex + 0.5 - center) / widen);
      weights[t] = w;
      sum += w;
    }
    if (sum !== 0) {
      for (let t = 0; t < count; t++) weights[t] /= sum;
    } else {
      // Degenerate (should not happen): fall back to nearest neighbour.
      weights.fill(0);
      weights[Math.min(count - 1, Math.round(center - first - 0.5))] = 1;
    }
    taps[d] = { first, weights };
  }
  return taps;
}

/**
 * Resamples a premultiplied float image along one axis.
 * `horizontal = true` resizes width, otherwise height.
 */
function resampleAxis(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstSize: number,
  horizontal: boolean,
  taps: ResampleTaps[],
): Float32Array {
  const otherLen = horizontal ? srcH : srcW;
  const srcLineLen = horizontal ? srcW : srcH;
  const dstW = horizontal ? dstSize : srcW;
  const dstH = horizontal ? srcH : dstSize;
  const out = new Float32Array(dstW * dstH * 4);

  for (let other = 0; other < otherLen; other++) {
    for (let d = 0; d < dstSize; d++) {
      const { first, weights } = taps[d];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < weights.length; t++) {
        const w = weights[t];
        if (w === 0) continue;
        let si = first + t;
        if (si < 0) si = 0;
        else if (si >= srcLineLen) si = srcLineLen - 1;
        const idx = horizontal ? (other * srcW + si) * 4 : (si * srcW + other) * 4;
        r += src[idx] * w;
        g += src[idx + 1] * w;
        b += src[idx + 2] * w;
        a += src[idx + 3] * w;
      }
      const di = horizontal ? (other * dstW + d) * 4 : (d * dstW + other) * 4;
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a;
    }
  }
  return out;
}

/** Nearest-neighbour resize (premultiplied-alpha aware for consistency). */
export function resizeNearest(image: RawImage, width: number, height: number): RawImage {
  assertImage(image);
  const src = image;
  const out = new Uint8ClampedArray(width * height * 4);
  const data = src.data;
  const xRatio = src.width / width;
  const yRatio = src.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) * yRatio));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x + 0.5) * xRatio));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { width, height, data: out };
}

/**
 * Resizes an image with a separable kernel.
 *
 * The image is converted to premultiplied alpha before filtering, so
 * transparent pixels never bleed colour into their neighbours; it is converted
 * back to straight alpha at the end.
 *
 * @param image source image
 * @param target target width/height — plain numbers
 * @param kernel one of `nearest | bilinear | catmull-rom | lanczos3`
 * @param antialias widen the kernel when downscaling (default `true`)
 */
export function resizeWithKernel(
  image: RawImage,
  target: { width: number; height: number },
  kernel: ResizeKernel = 'lanczos3',
  antialias = true,
): RawImage {
  assertImage(image);
  const { width, height } = target;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw invalidArgument(`resize: target size must be positive integers (got ${width}x${height})`);
  }
  if (width === image.width && height === image.height) {
    return { width, height, data: new Uint8ClampedArray(image.data) };
  }
  if (kernel === 'nearest') return resizeNearest(image, width, height);

  const pre = toPremultiplied(image);
  const needX = width !== image.width;
  const needY = height !== image.height;

  let buf = pre;
  let curW = image.width;
  let curH = image.height;
  if (needX) {
    const taps = computeTaps(curW, width, kernel, antialias);
    buf = resampleAxis(buf, curW, curH, width, true, taps);
    curW = width;
  }
  if (needY) {
    const taps = computeTaps(curH, height, kernel, antialias);
    buf = resampleAxis(buf, curW, curH, height, false, taps);
    curH = height;
  }
  return fromPremultiplied(buf, width, height);
}

/**
 * The pixel-resampling entry point.
 *
 * `resize(image, number)` scales to a width, keeping the aspect ratio.
 * `resize(image, { width, height, fit, kernel })` uses the full option set; the
 * target box is reconciled with the source aspect ratio by {@link computeFitSize}
 * and, for `'contain'`/`'cover'`-style letterboxing, the result is the exact
 * box size with the background left transparent.
 */
export function resize(image: RawImage, options: number | ResizeOptions): RawImage {
  const opts: ResizeOptions =
    typeof options === 'number' ? { width: options } : { ...options };
  const { width: boxW, height: boxH, fit = 'fill', kernel = 'lanczos3' } = opts;
  const withoutEnlargement = opts.withoutEnlargement ?? false;
  const antialias = opts.antialias ?? true;

  if (boxW === undefined && boxH === undefined) {
    throw invalidArgument('resize: at least one of width/height is required');
  }
  if (boxW !== undefined && (!Number.isInteger(boxW) || boxW < 1)) {
    throw invalidArgument(`resize: width must be a positive integer (got ${boxW})`);
  }
  if (boxH !== undefined && (!Number.isInteger(boxH) || boxH < 1)) {
    throw invalidArgument(`resize: height must be a positive integer (got ${boxH})`);
  }

  if (fit === 'fill' || fit === 'inside' || fit === 'outside') {
    const size = computeFitSize(image.width, image.height, {
      width: boxW,
      height: boxH,
      fit,
      withoutEnlargement,
      round: true,
    });
    return resizeWithKernel(image, size, kernel, antialias);
  }

  // `contain` / `cover` are defined against an exact box: resolve it first.
  const box = computeFitSize(image.width, image.height, {
    width: boxW,
    height: boxH,
    fit: 'fill',
    withoutEnlargement: false,
    round: true,
  });

  if (fit === 'contain') {
    const scaled = computeFitSize(image.width, image.height, {
      width: box.width,
      height: box.height,
      fit: 'inside',
      withoutEnlargement,
      round: true,
    });
    const resized = resizeWithKernel(image, scaled, kernel, antialias);
    if (resized.width === box.width && resized.height === box.height) return resized;
    const out = new Uint8ClampedArray(box.width * box.height * 4);
    const offX = Math.floor((box.width - resized.width) / 2);
    const offY = Math.floor((box.height - resized.height) / 2);
    for (let y = 0; y < resized.height; y++) {
      const dy = y + offY;
      if (dy < 0 || dy >= box.height) continue;
      const srcStart = y * resized.width * 4;
      const dstStart = (dy * box.width + offX) * 4;
      out.set(resized.data.subarray(srcStart, srcStart + resized.width * 4), dstStart);
    }
    return { width: box.width, height: box.height, data: out };
  }

  // cover: scale so the source covers the box, then centre-crop the overflow.
  const rect = coverCropRect(image.width, image.height, box.width, box.height);
  const cropped = crop(image, rect);
  const scaled = computeFitSize(cropped.width, cropped.height, {
    width: box.width,
    height: box.height,
    fit: 'fill',
    withoutEnlargement,
    round: true,
  });
  return resizeWithKernel(cropped, scaled, kernel, antialias);
}

/** Convenience wrapper: `resizeTo(image, w, h)` is `resizeWithKernel` with defaults. */
export function resizeTo(image: RawImage, width: number, height: number, kernel: ResizeKernel = 'lanczos3'): RawImage {
  return resizeWithKernel(image, { width, height }, kernel);
}

export { BILINEAR_KEYS, CATMULL_ROM_KEYS, LANCZOS3_KEYS };
export const __kernelInternals = { clampByte };
