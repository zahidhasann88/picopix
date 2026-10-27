/*!
 * ThumbHash encoder/decoder, adapted from https://github.com/evanw/thumbhash
 * Copyright (c) 2023 Evan Wallace. @license MIT
 * For images up to 100x100 the hash is byte-identical to the reference encoder.
 */
import { invalidArgument } from "../errors";
import type { RawImage, RGBA } from "../types";
import { resizeWithKernel } from "./resize";
import { assertImage } from "./util";

const MAX_SIZE = 100;

/**
 * Encodes a ~25-byte ThumbHash: a tiny placeholder that keeps the image's
 * colours, aspect ratio and alpha. Images larger than 100x100 are downscaled
 * first (the format's own limit).
 */
export function thumbHash(image: RawImage): Uint8Array {
  assertImage(image);
  let source = image;
  if (image.width > MAX_SIZE || image.height > MAX_SIZE) {
    const scale = MAX_SIZE / Math.max(image.width, image.height);
    source = resizeWithKernel(
      image,
      {
        width: Math.max(1, Math.round(image.width * scale)),
        height: Math.max(1, Math.round(image.height * scale)),
      },
      "bilinear",
    );
  }
  return encode(source.width, source.height, source.data);
}

function encode(w: number, h: number, rgba: Uint8ClampedArray): Uint8Array {
  const { PI, round, max, cos, abs } = Math;
  const n = w * h;

  let avgR = 0;
  let avgG = 0;
  let avgB = 0;
  let avgA = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    avgR += (alpha / 255) * rgba[j];
    avgG += (alpha / 255) * rgba[j + 1];
    avgB += (alpha / 255) * rgba[j + 2];
    avgA += alpha;
  }
  if (avgA) {
    avgR /= avgA;
    avgG /= avgA;
    avgB /= avgA;
  }

  const hasAlpha = avgA < n;
  const lLimit = hasAlpha ? 5 : 7;
  const lx = max(1, round((lLimit * w) / max(w, h)));
  const ly = max(1, round((lLimit * h) / max(w, h)));
  const l = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  const a = new Float64Array(n);

  // RGBA -> LPQA, composited over the average colour.
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    const r = avgR * (1 - alpha) + (alpha / 255) * rgba[j];
    const g = avgG * (1 - alpha) + (alpha / 255) * rgba[j + 1];
    const b = avgB * (1 - alpha) + (alpha / 255) * rgba[j + 2];
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }

  const encodeChannel = (
    channel: Float64Array,
    nx: number,
    ny: number,
  ): [number, number[], number] => {
    let dc = 0;
    let scale = 0;
    const ac: number[] = [];
    const fx = new Float64Array(w);
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < w; x++) fx[x] = cos((PI / w) * cx * (x + 0.5));
        for (let y = 0; y < h; y++) {
          const fy = cos((PI / h) * cy * (y + 0.5));
          for (let x = 0; x < w; x++) f += channel[x + y * w] * fx[x] * fy;
        }
        f /= n;
        if (cx || cy) {
          ac.push(f);
          scale = max(scale, abs(f));
        } else {
          dc = f;
        }
      }
    }
    if (scale) {
      for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * ac[i];
    }
    return [dc, ac, scale];
  };

  const [lDc, lAc, lScale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, 3, 3);
  const alphaChannel = hasAlpha ? encodeChannel(a, 5, 5) : null;

  const isLandscape = w > h;
  const header24 =
    round(63 * lDc) |
    (round(31.5 + 31.5 * pDc) << 6) |
    (round(31.5 + 31.5 * qDc) << 12) |
    (round(31 * lScale) << 18) |
    ((hasAlpha ? 1 : 0) << 23);
  const header16 =
    (isLandscape ? ly : lx) |
    (round(63 * pScale) << 3) |
    (round(63 * qScale) << 9) |
    ((isLandscape ? 1 : 0) << 15);

  const acs = alphaChannel ? [lAc, pAc, qAc, alphaChannel[1]] : [lAc, pAc, qAc];
  const acStart = hasAlpha ? 6 : 5;
  const acCount = acs.reduce((sum, ac) => sum + ac.length, 0);
  const hash = new Uint8Array(acStart + Math.ceil(acCount / 2));
  hash[0] = header24 & 255;
  hash[1] = (header24 >> 8) & 255;
  hash[2] = header24 >> 16;
  hash[3] = header16 & 255;
  hash[4] = header16 >> 8;
  if (alphaChannel) {
    hash[5] = round(15 * alphaChannel[0]) | (round(15 * alphaChannel[2]) << 4);
  }
  let acIndex = 0;
  for (const ac of acs) {
    for (const f of ac) {
      hash[acStart + (acIndex >> 1)] |= round(15 * f) << ((acIndex & 1) << 2);
      acIndex++;
    }
  }
  return hash;
}

function assertHash(hash: Uint8Array): void {
  if (!(hash instanceof Uint8Array) || hash.length < 5) {
    throw invalidArgument("thumbHash: expected a Uint8Array of at least 5 bytes");
  }
}

/** Width / height of the original image, as stored in the hash (approximate). */
export function thumbHashAspectRatio(hash: Uint8Array): number {
  assertHash(hash);
  const header = hash[3];
  const hasAlpha = hash[2] & 0x80;
  const isLandscape = hash[4] & 0x80;
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7;
  return lx / ly;
}

/** The average colour stored in the hash, as 0–255 RGBA. */
export function thumbHashToAverageColor(hash: Uint8Array): RGBA {
  assertHash(hash);
  const header = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const l = (header & 63) / 63;
  const p = ((header >> 6) & 63) / 31.5 - 1;
  const q = ((header >> 12) & 63) / 31.5 - 1;
  const hasAlpha = header >> 23;
  const a = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const b = l - (2 / 3) * p;
  const r = (3 * l - b + q) / 2;
  const g = r - q;
  const byte = (v: number): number =>
    Math.round(255 * Math.max(0, Math.min(1, v)));
  return { r: byte(r), g: byte(g), b: byte(b), a: byte(a) };
}

/** Decodes a ThumbHash into a small (max 32px) RGBA image. */
export function thumbHashToImage(hash: Uint8Array): RawImage {
  assertHash(hash);
  const { PI, min, max, cos, round } = Math;

  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = (header24 >> 23) !== 0;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const isLandscape = header16 >> 15;
  const lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7);
  const aDc = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const aScale = (hash[5] >> 4) / 15;

  // Saturation is boosted by 1.25x to compensate for quantization.
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  const decodeChannel = (nx: number, ny: number, scale: number): number[] => {
    const ac: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) {
        const nibble =
          ((hash[acStart + (acIndex >> 1)] ?? 0) >> ((acIndex & 1) << 2)) & 15;
        ac.push((nibble / 7.5 - 1) * scale);
        acIndex++;
      }
    }
    return ac;
  };
  const lAc = decodeChannel(lx, ly, lScale);
  const pAc = decodeChannel(3, 3, pScale * 1.25);
  const qAc = decodeChannel(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? decodeChannel(5, 5, aScale) : [];

  const ratio = thumbHashAspectRatio(hash);
  const w = round(ratio > 1 ? 32 : 32 * ratio);
  const h = round(ratio > 1 ? 32 / ratio : 32);
  const data = new Uint8ClampedArray(w * h * 4);
  const fx = new Float64Array(max(lx, hasAlpha ? 5 : 3));
  const fy = new Float64Array(max(ly, hasAlpha ? 5 : 3));
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc;
      let p = pDc;
      let q = qDc;
      let a = aDc;
      for (let cx = 0; cx < fx.length; cx++) fx[cx] = cos((PI / w) * (x + 0.5) * cx);
      for (let cy = 0; cy < fy.length; cy++) fy[cy] = cos((PI / h) * (y + 0.5) * cy);

      for (let cy = 0, j = 0; cy < ly; cy++) {
        const fy2 = fy[cy] * 2;
        for (let cx = cy ? 0 : 1; cx * ly < lx * (ly - cy); cx++, j++) {
          l += lAc[j] * fx[cx] * fy2;
        }
      }
      for (let cy = 0, j = 0; cy < 3; cy++) {
        const fy2 = fy[cy] * 2;
        for (let cx = cy ? 0 : 1; cx < 3 - cy; cx++, j++) {
          const f = fx[cx] * fy2;
          p += pAc[j] * f;
          q += qAc[j] * f;
        }
      }
      if (hasAlpha) {
        for (let cy = 0, j = 0; cy < 5; cy++) {
          const fy2 = fy[cy] * 2;
          for (let cx = cy ? 0 : 1; cx < 5 - cy; cx++, j++) {
            a += aAc[j] * fx[cx] * fy2;
          }
        }
      }

      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      const g = r - q;
      data[i] = max(0, 255 * min(1, r));
      data[i + 1] = max(0, 255 * min(1, g));
      data[i + 2] = max(0, 255 * min(1, b));
      data[i + 3] = max(0, 255 * min(1, a));
    }
  }
  return { width: w, height: h, data };
}

/**
 * Decodes a ThumbHash straight to a `data:image/png;base64,...` URL. Needs no
 * canvas, so it also works during server-side rendering.
 */
export function thumbHashToDataURL(hash: Uint8Array): string {
  const image = thumbHashToImage(hash);
  return `data:image/png;base64,${base64(encodeRawPng(image))}`;
}

/** Minimal uncompressed (stored-deflate) RGBA PNG writer for tiny images. */
function encodeRawPng(image: RawImage): Uint8Array {
  const { width: w, height: h, data } = image;
  const row = w * 4 + 1;
  const raw = row * h;
  // zlib header + one stored block per 65535 bytes + adler32.
  const blocks = Math.ceil(raw / 0xffff) || 1;
  const idatLength = 2 + raw + blocks * 5 + 4;
  const out = new Uint8Array(8 + 25 + 12 + idatLength + 12);
  const view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

  let pos = 8;
  const chunk = (type: string, length: number, fill: () => void): void => {
    view.setUint32(pos, length);
    const start = pos + 4;
    for (let i = 0; i < 4; i++) out[start + i] = type.charCodeAt(i);
    pos = start + 4;
    fill();
    view.setUint32(pos, crc32(out, start, pos));
    pos += 4;
  };

  chunk("IHDR", 13, () => {
    view.setUint32(pos, w);
    view.setUint32(pos + 4, h);
    out.set([8, 6, 0, 0, 0], pos + 8);
    pos += 13;
  });
  chunk("IDAT", idatLength, () => {
    out[pos++] = 0x78;
    out[pos++] = 0x01;
    let s1 = 1;
    let s2 = 0;
    let written = 0;
    let rowOffset = 0;
    const emit = (byte: number): void => {
      if (written % 0xffff === 0) {
        const len = Math.min(0xffff, raw - written);
        out[pos++] = written + len >= raw ? 1 : 0;
        out[pos++] = len & 255;
        out[pos++] = len >> 8;
        out[pos++] = ~len & 255;
        out[pos++] = (~len >> 8) & 255;
      }
      out[pos++] = byte;
      s1 = (s1 + byte) % 65521;
      s2 = (s2 + s1) % 65521;
      written++;
    };
    for (let y = 0; y < h; y++) {
      emit(0); // filter: none
      for (let x = 0; x < w * 4; x++) emit(data[rowOffset + x]);
      rowOffset += w * 4;
    }
    view.setUint32(pos, ((s2 << 16) | s1) >>> 0);
    pos += 4;
  });
  chunk("IEND", 0, () => {});
  return out;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Dependency-free base64, so the pixels layer needs no `btoa`/`Buffer`. */
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}
