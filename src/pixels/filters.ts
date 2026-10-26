import { invalidArgument } from '../errors';
import type { BlurOptions, RawImage } from '../types';
import { assertImage, clampByte, toPremultiplied } from './util';

/** Per-pixel filter name accepted by {@link filter}. */
export type FilterName =
  | 'grayscale'
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'invert'
  | 'threshold';

/**
 * Converts to grayscale using Rec.601 luma. Alpha is preserved.
 * `grayscale(image)` and `grayscale(image, 1)` are identical.
 */
export function grayscale(image: RawImage, amount = 1): RawImage {
  assertImage(image);
  const t = clamp01(amount);
  const out = new Uint8ClampedArray(image.data.length);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    out[i] = d[i] + (y - d[i]) * t;
    out[i + 1] = d[i + 1] + (y - d[i + 1]) * t;
    out[i + 2] = d[i + 2] + (y - d[i + 2]) * t;
    out[i + 3] = d[i + 3];
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Multiplies every colour channel by `amount` (`1` = unchanged).
 * Alpha is never touched.
 */
export function brightness(image: RawImage, amount = 1): RawImage {
  assertImage(image);
  if (!Number.isFinite(amount)) throw invalidArgument('brightness: amount must be a finite number');
  const out = new Uint8ClampedArray(image.data.length);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    out[i] = d[i] * amount;
    out[i + 1] = d[i + 1] * amount;
    out[i + 2] = d[i + 2] * amount;
    out[i + 3] = d[i + 3];
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Adjusts contrast around mid-grey. `1` = unchanged, `0` = flat grey `128`,
 * `2` = doubled contrast. Uses the standard `c * (x - 128) + 128` formula.
 */
export function contrast(image: RawImage, amount = 1): RawImage {
  assertImage(image);
  if (!Number.isFinite(amount)) throw invalidArgument('contrast: amount must be a finite number');
  const out = new Uint8ClampedArray(image.data.length);
  const d = image.data;
  const off = 128 * (1 - amount);
  for (let i = 0; i < d.length; i += 4) {
    out[i] = d[i] * amount + off;
    out[i + 1] = d[i + 1] * amount + off;
    out[i + 2] = d[i + 2] * amount + off;
    out[i + 3] = d[i + 3];
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Saturation multiplier. `0` = grayscale, `1` = unchanged, `2` = vivid.
 * Uses the luma-preserving `c + (pixel - luma) * s` form.
 */
export function saturate(image: RawImage, amount = 1): RawImage {
  assertImage(image);
  if (!Number.isFinite(amount)) throw invalidArgument('saturate: amount must be a finite number');
  const out = new Uint8ClampedArray(image.data.length);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    out[i] = l + (d[i] - l) * amount;
    out[i + 1] = l + (d[i + 1] - l) * amount;
    out[i + 2] = l + (d[i + 2] - l) * amount;
    out[i + 3] = d[i + 3];
  }
  return { width: image.width, height: image.height, data: out };
}

/** Inverts RGB (`255 - x`). Alpha is preserved. */
export function invert(image: RawImage): RawImage {
  assertImage(image);
  const out = new Uint8ClampedArray(image.data.length);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    out[i] = 255 - d[i];
    out[i + 1] = 255 - d[i + 1];
    out[i + 2] = 255 - d[i + 2];
    out[i + 3] = d[i + 3];
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Binarises the image: channels `>= threshold` become 255, the rest 0.
 * The comparison is done on luma, alpha is preserved.
 */
export function threshold(image: RawImage, value = 128): RawImage {
  assertImage(image);
  if (!Number.isFinite(value)) throw invalidArgument('threshold: value must be a number');
  const out = new Uint8ClampedArray(image.data.length);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const on = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] >= value ? 255 : 0;
    out[i] = on;
    out[i + 1] = on;
    out[i + 2] = on;
    out[i + 3] = d[i + 3];
  }
  return { width: image.width, height: image.height, data: out };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Union type for the {@link filter} driver. */
export type FilterSpec =
  | { type: 'grayscale'; amount?: number }
  | { type: 'brightness'; amount?: number }
  | { type: 'contrast'; amount?: number }
  | { type: 'saturate'; amount?: number }
  | { type: 'invert' }
  | { type: 'threshold'; value?: number };

/**
 * Applies one filter by name. Used by the serialisable worker op protocol:
 * `filter: { type: 'contrast', amount: 1.2 }`.
 */
export function filter(image: RawImage, spec: FilterSpec): RawImage;
export function filter(image: RawImage, type: FilterName, amount?: number): RawImage;
export function filter(
  image: RawImage,
  specOrType: FilterSpec | FilterName,
  amount?: number,
): RawImage {
  const spec: FilterSpec =
    typeof specOrType === 'string' ? ({ type: specOrType, amount } as FilterSpec) : specOrType;
  switch (spec.type) {
    case 'grayscale':
      return grayscale(image, spec.amount ?? 1);
    case 'brightness':
      return brightness(image, spec.amount ?? 1);
    case 'contrast':
      return contrast(image, spec.amount ?? 1);
    case 'saturate':
      return saturate(image, spec.amount ?? 1);
    case 'invert':
      return invert(image);
    case 'threshold':
      return threshold(image, spec.value ?? 128);
    default:
      throw invalidArgument(`filter: unknown filter '${String((spec as { type: string }).type)}'`);
  }
}

/** Box blur of the alpha-premultiplied image (two horizontal/vertical passes). */
function boxPass(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = radius * 2 + 1;
  // Horizontal
  for (let y = 0; y < height; y++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      const rowStart = y * width * 4;
      for (let k = -radius; k <= radius; k++) {
        const x = Math.min(width - 1, Math.max(0, k));
        acc += src[rowStart + x * 4 + c];
      }
      for (let x = 0; x < width; x++) {
        tmp[rowStart + x * 4 + c] = acc / win;
        const outX = Math.min(width - 1, Math.max(0, x - radius));
        const inX = Math.min(width - 1, x + radius + 1);
        acc += src[rowStart + inX * 4 + c] - src[rowStart + outX * 4 + c];
      }
    }
  }
  // Vertical
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const y = Math.min(height - 1, Math.max(0, k));
        acc += tmp[(y * width + x) * 4 + c];
      }
      for (let y = 0; y < height; y++) {
        out[(y * width + x) * 4 + c] = acc / win;
        const outY = Math.min(height - 1, Math.max(0, y - radius));
        const inY = Math.min(height - 1, y + radius + 1);
        acc += tmp[(inY * width + x) * 4 + c] - tmp[(outY * width + x) * 4 + c];
      }
    }
  }
  return out;
}

/**
 * Blurs the image.
 *
 * - `type: 'box'` performs a single box blur of `radius` pixels (edge-clamped).
 * - `type: 'gaussian'` (default) approximates a gaussian of `sigma = radius`
 *   with `passes` box blurs (default 3), the standard fast approximation.
 *
 * Filtering happens in premultiplied space so transparent pixels do not bleed
 * colour into the subject.
 */
export function blur(image: RawImage, options: number | BlurOptions): RawImage {
  assertImage(image);
  const opts: BlurOptions = typeof options === 'number' ? { radius: options } : options;
  const radius = Math.round(opts.radius);
  const type = opts.type ?? 'gaussian';
  if (!Number.isFinite(radius) || radius < 0) throw invalidArgument('blur: radius must be >= 0');
  if (radius === 0) return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };

  const pre = toPremultiplied(image);
  let buf = pre;
  if (type === 'box') {
    buf = boxPass(pre, image.width, image.height, radius);
  } else {
    const passes = Math.max(1, opts.passes ?? 3);
    // Box width approximating a gaussian of the given sigma.
    const sigma = opts.radius;
    const boxRadius = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / passes + 1) / 2 - 0.5) || 1);
    for (let p = 0; p < passes; p++) {
      buf = boxPass(buf, image.width, image.height, boxRadius);
    }
  }
  const out = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = buf[i + 3];
    if (a <= 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    const f = 255 / a;
    out[i] = clampByte(buf[i] * f);
    out[i + 1] = clampByte(buf[i + 1] * f);
    out[i + 2] = clampByte(buf[i + 2] * f);
    out[i + 3] = clampByte(a);
  }
  return { width: image.width, height: image.height, data: out };
}
