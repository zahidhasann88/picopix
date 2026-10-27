import type {
  BlendMode,
  CompositeOptions,
  MaskImage,
  RawImage,
} from "../types";
import {
  assertImage,
  clampByte,
  cloneImage,
  createImage,
  normalizeColor,
  toMask,
} from "./util";

export function composite(
  target: RawImage,
  source: RawImage,
  options: CompositeOptions = {},
): RawImage {
  assertImage(target, "target");
  assertImage(source, "source");
  const { x = 0, y = 0, opacity = 1, blendMode = "normal" } = options;
  const out = cloneImage(target);
  const ox = Math.round(x);
  const oy = Math.round(y);
  const op = Math.max(0, Math.min(1, opacity));

  for (let sy = 0; sy < source.height; sy++) {
    const ty = sy + oy;
    if (ty < 0 || ty >= target.height) continue;
    for (let sx = 0; sx < source.width; sx++) {
      const tx = sx + ox;
      if (tx < 0 || tx >= target.width) continue;
      const si = (sy * source.width + sx) * 4;
      const di = (ty * target.width + tx) * 4;
      const srcA = (source.data[si + 3] / 255) * op;
      if (srcA <= 0) continue;
      const dstA = out.data[di + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;

      for (let c = 0; c < 3; c++) {
        const s = source.data[si + c] / 255;
        const d = out.data[di + c] / 255;
        let blended: number;
        switch (blendMode) {
          case "normal":
            blended = s;
            break;
          case "multiply":
            blended = s * d;
            break;
          case "screen":
            blended = s + d - s * d;
            break;
          default:
            blended = s;
        }
        const sourceTerm = (1 - dstA) * s + dstA * blended;
        const mixed = srcA * sourceTerm + (1 - srcA) * dstA * d;
        out.data[di + c] = clampByte((mixed / outA) * 255);
      }
      out.data[di + 3] = clampByte(outA * 255);
    }
  }
  return out;
}

export function applyAlphaMask(
  image: RawImage,
  mask: MaskImage | RawImage,
  invert = false,
): RawImage {
  assertImage(image);
  const m = toMask(mask);
  const out = new Uint8ClampedArray(image.data.length);
  out.set(image.data);
  for (let y = 0; y < image.height; y++) {
    const my =
      m.height === image.height
        ? y
        : Math.min(m.height - 1, Math.floor((y * m.height) / image.height));
    for (let x = 0; x < image.width; x++) {
      const mx =
        m.width === image.width
          ? x
          : Math.min(m.width - 1, Math.floor((x * m.width) / image.width));
      let a = m.data[my * m.width + mx];
      if (invert) a = 255 - a;
      const di = (y * image.width + x) * 4 + 3;
      out[di] = (out[di] * a) / 255;
    }
  }
  return { width: image.width, height: image.height, data: out };
}

export function setAlphaMask(
  image: RawImage,
  mask: MaskImage | RawImage,
  invert = false,
): RawImage {
  assertImage(image);
  const m = toMask(mask);
  const out = new Uint8ClampedArray(image.data.length);
  out.set(image.data);
  for (let y = 0; y < image.height; y++) {
    const my =
      m.height === image.height
        ? y
        : Math.min(m.height - 1, Math.floor((y * m.height) / image.height));
    for (let x = 0; x < image.width; x++) {
      const mx =
        m.width === image.width
          ? x
          : Math.min(m.width - 1, Math.floor((x * m.width) / image.width));
      let a = m.data[my * m.width + mx];
      if (invert) a = 255 - a;
      out[(y * image.width + x) * 4 + 3] = a;
    }
  }
  return { width: image.width, height: image.height, data: out };
}

export function flatten(
  image: RawImage,
  background: { r: number; g: number; b: number; a?: number } = {
    r: 255,
    g: 255,
    b: 255,
  },
): RawImage {
  const bg = createImage(
    image.width,
    image.height,
    normalizeColor([
      background.r,
      background.g,
      background.b,
      background.a ?? 255,
    ]),
  );
  return composite(bg, image);
}
