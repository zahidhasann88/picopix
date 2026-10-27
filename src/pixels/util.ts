import { invalidArgument } from "../errors";
import type { MaskImage, RawImage, RGBA } from "../types";

export function clampByte(value: number): number {
  const v = value + 0.5;
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function assertImage(image: RawImage, name = "image"): RawImage {
  if (!image || typeof image !== "object") {
    throw invalidArgument(`${name} must be a RawImage object`);
  }
  const { width, height, data } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw invalidArgument(
      `${name} must have positive integer width/height (got ${width}x${height})`,
    );
  }
  if (!data || typeof data.length !== "number") {
    throw invalidArgument(`${name}.data must be a Uint8ClampedArray`);
  }
  if (data.length !== width * height * 4) {
    throw invalidArgument(
      `${name}.data length ${data.length} does not match ${width}x${height}x4 = ${width * height * 4}`,
    );
  }
  return image;
}

export function createImage(
  width: number,
  height: number,
  fill: RGBA | number[] = [0, 0, 0, 0],
): RawImage {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw invalidArgument(`createImage: invalid size ${width}x${height}`);
  }
  const r = (fill as number[])[0] ?? 0;
  const g = (fill as number[])[1] ?? 0;
  const b = (fill as number[])[2] ?? 0;
  const a = (fill as number[])[3] ?? 255;
  const data = new Uint8ClampedArray(width * height * 4);
  if (!(r === 0 && g === 0 && b === 0 && a === 0)) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

export function createMask(width: number, height: number, fill = 0): MaskImage {
  const data = new Uint8ClampedArray(width * height);
  if (fill) data.fill(fill);
  return { width, height, data };
}

export function cloneImage(image: RawImage): RawImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

export function sameSize(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return a.width === b.width && a.height === b.height;
}

export function getPixel(
  image: RawImage,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  const d = image.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

export function setPixel(
  image: RawImage,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const i = (y * image.width + x) * 4;
  const d = image.data;
  d[i] = r;
  d[i + 1] = g;
  d[i + 2] = b;
  d[i + 3] = a;
}

export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function toPremultiplied(image: RawImage): Float32Array {
  const { data } = image;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    const f = a / 255;
    out[i] = data[i] * f;
    out[i + 1] = data[i + 1] * f;
    out[i + 2] = data[i + 2] * f;
    out[i + 3] = a;
  }
  return out;
}

export function fromPremultiplied(
  data: Float32Array,
  width: number,
  height: number,
): RawImage {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = data[i + 3];
    if (a <= 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    const f = 255 / a;
    out[i] = clampByte(data[i] * f);
    out[i + 1] = clampByte(data[i + 1] * f);
    out[i + 2] = clampByte(data[i + 2] * f);
    out[i + 3] = clampByte(a);
  }
  return { width, height, data: out };
}

export function normalizeColor(
  color?: RGBA | number[],
): [number, number, number, number] {
  if (!color) return [0, 0, 0, 0];
  if (Array.isArray(color)) {
    return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, color[3] ?? 255];
  }
  return [color.r ?? 0, color.g ?? 0, color.b ?? 0, color.a ?? 255];
}

export function maskToImage(mask: MaskImage): RawImage {
  const { width, height, data } = mask;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < data.length; p++, i += 4) {
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = data[p];
  }
  return { width, height, data: out };
}

export function toMask(
  input:
    | MaskImage
    | RawImage
    | { width: number; height: number; data: Uint8ClampedArray },
): MaskImage {
  const { width, height, data } = input as {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };
  if (data.length === width * height) {
    return { width, height, data };
  }
  if (data.length === width * height * 4) {
    const out = new Uint8ClampedArray(width * height);
    for (let p = 0, i = 3; p < out.length; p++, i += 4) out[p] = data[i];
    return { width, height, data: out };
  }
  throw invalidArgument("toMask: unsupported mask data length");
}

export function sampleBilinear(
  image: RawImage,
  u: number,
  v: number,
  out: [number, number, number, number],
): void {
  const { width, height, data } = image;
  const x = clamp(u * width - 0.5, 0, width - 1);
  const y = clamp(v * height - 0.5, 0, height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const a =
    data[i00 + 3] * w00 +
    data[i10 + 3] * w10 +
    data[i01 + 3] * w01 +
    data[i11 + 3] * w11;
  if (a <= 0) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  const p = (i: number) => (data[i] * data[i + 3]) / 255;
  const r = p(i00) * w00 + p(i10) * w10 + p(i01) * w01 + p(i11) * w11;
  const g =
    p(i00 + 1) * w00 + p(i10 + 1) * w10 + p(i01 + 1) * w01 + p(i11 + 1) * w11;
  const b =
    p(i00 + 2) * w00 + p(i10 + 2) * w10 + p(i01 + 2) * w01 + p(i11 + 2) * w11;

  const f = 255 / a;
  out[0] = clampByte(r * f);
  out[1] = clampByte(g * f);
  out[2] = clampByte(b * f);
  out[3] = clampByte(a);
}
