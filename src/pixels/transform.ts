import { invalidArgument } from "../errors";
import type { CropOptions, RawImage, Rect, RGBA } from "../types";
import {
  assertImage,
  createImage,
  normalizeColor,
  sampleBilinear,
} from "./util";

export function crop(image: RawImage, options: CropOptions): RawImage {
  assertImage(image);
  const x = Math.round(options.x ?? 0);
  const y = Math.round(options.y ?? 0);
  const width = Math.round(options.width ?? image.width - x);
  const height = Math.round(options.height ?? image.height - y);
  if (width <= 0 || height <= 0) {
    throw invalidArgument(
      `crop: resulting size must be positive (got ${width}x${height})`,
    );
  }
  const srcX = Math.max(0, x);
  const srcY = Math.max(0, y);
  const srcW = Math.min(width, image.width - srcX);
  const srcH = Math.min(height, image.height - srcY);
  if (srcW <= 0 || srcH <= 0) {
    throw invalidArgument("crop: rectangle is outside the image");
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const dx = srcX - x;
  const dy = srcY - y;
  for (let row = 0; row < srcH; row++) {
    const srcStart = ((srcY + row) * image.width + srcX) * 4;
    const dstStart = ((dy + row) * width + dx) * 4;
    out.set(image.data.subarray(srcStart, srcStart + srcW * 4), dstStart);
  }
  return { width, height, data: out };
}

export function rotate90(image: RawImage): RawImage {
  assertImage(image);
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  const dstW = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = height - 1 - y;
      const dy = x;
      const si = (y * width + x) * 4;
      const di = (dy * dstW + dx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { width: height, height: width, data: out };
}

export function rotate180(image: RawImage): RawImage {
  assertImage(image);
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  const n = width * height;
  for (let p = 0; p < n; p++) {
    const si = p * 4;
    const di = (n - 1 - p) * 4;
    out[di] = data[si];
    out[di + 1] = data[si + 1];
    out[di + 2] = data[si + 2];
    out[di + 3] = data[si + 3];
  }
  return { width, height, data: out };
}

export function rotate270(image: RawImage): RawImage {
  assertImage(image);
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  const dstW = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = y;
      const dy = width - 1 - x;
      const si = (y * width + x) * 4;
      const di = (dy * dstW + dx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { width: height, height: width, data: out };
}

export function flip(image: RawImage, axis: "x" | "y" = "x"): RawImage {
  assertImage(image);
  if (axis !== "x" && axis !== "y")
    throw invalidArgument(`flip: unknown axis '${String(axis)}'`);
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = axis === "x" ? width - 1 - x : x;
      const sy = axis === "y" ? height - 1 - y : y;
      const si = (sy * width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { width, height, data: out };
}

export function flipX(image: RawImage): RawImage {
  return flip(image, "x");
}

export function flipY(image: RawImage): RawImage {
  return flip(image, "y");
}

export function rotate(
  image: RawImage,
  angle: number,
  background?: RGBA,
): RawImage {
  assertImage(image);
  if (!Number.isFinite(angle))
    throw invalidArgument("rotate: angle must be a finite number");
  const norm = ((angle % 360) + 360) % 360;
  if (norm === 0)
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
    };
  if (norm === 90) return rotate90(image);
  if (norm === 180) return rotate180(image);
  if (norm === 270) return rotate270(image);

  const rad = (norm * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { width: sw, height: sh } = image;
  const dw = Math.max(1, Math.round(Math.abs(sw * cos) + Math.abs(sh * sin)));
  const dh = Math.max(1, Math.round(Math.abs(sw * sin) + Math.abs(sh * cos)));
  const out = createImage(dw, dh, normalizeColor(background));
  const cx = sw / 2;
  const cy = sh / 2;
  const dcx = dw / 2;
  const dcy = dh / 2;
  const px: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const dx = x + 0.5 - dcx;
      const dy = y + 0.5 - dcy;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
      sampleBilinear(image, sx / sw, sy / sh, px);
      const di = (y * dw + x) * 4;
      const sa = px[3] / 255;
      if (sa >= 1) {
        out.data[di] = px[0];
        out.data[di + 1] = px[1];
        out.data[di + 2] = px[2];
        out.data[di + 3] = 255;
      } else if (sa > 0) {
        const ba = out.data[di + 3] / 255;
        const oa = sa + ba * (1 - sa);
        const f = oa === 0 ? 0 : 1 / oa;
        out.data[di] = (px[0] * sa + out.data[di] * ba * (1 - sa)) * f;
        out.data[di + 1] = (px[1] * sa + out.data[di + 1] * ba * (1 - sa)) * f;
        out.data[di + 2] = (px[2] * sa + out.data[di + 2] * ba * (1 - sa)) * f;
        out.data[di + 3] = oa * 255;
      }
    }
  }
  return out;
}

export function applyOrientation(
  image: RawImage,
  orientation: number,
): RawImage {
  assertImage(image);
  switch (orientation) {
    case 1:
      return {
        width: image.width,
        height: image.height,
        data: new Uint8ClampedArray(image.data),
      };
    case 2:
      return flipX(image);
    case 3:
      return rotate180(image);
    case 4:
      return flipY(image);
    case 5:
      return rotate270(flipX(image));
    case 6:
      return rotate90(image);
    case 7:
      return rotate90(flipX(image));
    case 8:
      return rotate270(image);
    default:
      throw invalidArgument(
        `applyOrientation: orientation must be 1..8 (got ${orientation})`,
      );
  }
}

export function pad(
  image: RawImage,
  padding:
    | number
    | { top?: number; right?: number; bottom?: number; left?: number },
  color?: RGBA,
): RawImage {
  assertImage(image);
  const padTop = typeof padding === "number" ? padding : (padding.top ?? 0);
  const padRight = typeof padding === "number" ? padding : (padding.right ?? 0);
  const padBottom =
    typeof padding === "number" ? padding : (padding.bottom ?? 0);
  const padLeft = typeof padding === "number" ? padding : (padding.left ?? 0);
  for (const v of [padTop, padRight, padBottom, padLeft]) {
    if (!Number.isInteger(v) || v < 0)
      throw invalidArgument("pad: padding must be non-negative integers");
  }
  const width = image.width + padLeft + padRight;
  const height = image.height + padTop + padBottom;
  const out = createImage(width, height, normalizeColor(color));
  for (let y = 0; y < image.height; y++) {
    const srcStart = y * image.width * 4;
    const dstStart = ((y + padTop) * width + padLeft) * 4;
    out.data.set(
      image.data.subarray(srcStart, srcStart + image.width * 4),
      dstStart,
    );
  }
  return out;
}

export function trim(
  image: RawImage,
  options: { threshold?: number; color?: RGBA; alpha?: boolean } = {},
): Rect {
  assertImage(image);
  const useAlpha = options.alpha ?? options.color === undefined;
  const threshold = options.threshold ?? (useAlpha ? 0 : 10);
  const { width, height, data } = image;

  const refR = options.color ? options.color.r : data[0];
  const refG = options.color ? options.color.g : data[1];
  const refB = options.color ? options.color.b : data[2];

  const isContent = (i: number): boolean => {
    if (useAlpha) return data[i + 3] > threshold;
    const dr = data[i] - refR;
    const dg = data[i + 1] - refG;
    const db = data[i + 2] - refB;
    return Math.sqrt(dr * dr + dg * dg + db * db) > threshold;
  };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isContent((y * width + x) * 4)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width, height };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function isBlank(image: RawImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 0) return false;
  }
  return true;
}

export function trimImage(
  image: RawImage,
  options: { threshold?: number; color?: RGBA; alpha?: boolean } = {},
): RawImage {
  const rect = trim(image, options);
  if (
    rect.x === 0 &&
    rect.y === 0 &&
    rect.width === image.width &&
    rect.height === image.height
  ) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
    };
  }
  return crop(image, rect);
}
