import type { CallOptions, ImageInfo, ImageInput, Size } from '../types';
import { inputToBytes } from '../codec/backend';
import { formatToMimeType, sniffFormat } from './sniff';
import { parseExif } from './exif';

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Reads JPEG dimensions from the first SOFn marker. */
export function readJpegSize(bytes: Uint8Array): Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = view.getUint16(i + 2, false);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(i + 5, false);
      const width = view.getUint16(i + 7, false);
      return { width, height };
    }
    i += 2 + length;
  }
  return null;
}

/** Reads PNG dimensions from IHDR and its colour type. */
function readPngInfo(bytes: Uint8Array): { size: Size; alpha: boolean | null; colorProfile: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const colorType = bytes[25];
  let alpha: boolean | null = colorType === 4 || colorType === 6;
  let colorProfile = false;
  // Walk chunks for tRNS / iCCP.
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = view.getUint32(i, false);
    const type = ascii(bytes, i + 4, i + 8);
    if (type === 'tRNS') alpha = true;
    if (type === 'iCCP') colorProfile = true;
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return { size: { width, height }, alpha, colorProfile };
}

/** Reads WebP dimensions (VP8, VP8L or VP8X) plus its alpha/ICC flags. */
function readWebpInfo(bytes: Uint8Array): { size: Size | null; alpha: boolean | null; colorProfile: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size: Size | null = null;
  let alpha: boolean | null = null;
  let colorProfile = false;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i, i + 4);
    const len = view.getUint32(i + 4, true);
    const data = i + 8;
    if (type === 'VP8X' && data + 10 <= bytes.length) {
      const flags = bytes[data];
      alpha = (flags & 0x10) !== 0;
      colorProfile = (flags & 0x20) !== 0;
      const w = 1 + (bytes[data + 4] | (bytes[data + 5] << 8) | (bytes[data + 6] << 16));
      const h = 1 + (bytes[data + 7] | (bytes[data + 8] << 8) | (bytes[data + 9] << 16));
      size = { width: w, height: h };
    } else if (type === 'VP8 ' && data + 10 <= bytes.length) {
      // Lossy: 3-byte frame tag, then 3-byte sync code 9D 01 2A, then 14-bit dims.
      const w = view.getUint16(data + 6, true) & 0x3fff;
      const h = view.getUint16(data + 8, true) & 0x3fff;
      if (!size) size = { width: w, height: h };
    } else if (type === 'VP8L' && data + 5 <= bytes.length) {
      const b = bytes[data + 1] | (bytes[data + 2] << 8) | (bytes[data + 3] << 16) | (bytes[data + 4] << 24);
      const w = (b & 0x3fff) + 1;
      const h = ((b >> 14) & 0x3fff) + 1;
      if (!size) size = { width: w, height: h };
      if (bytes[data] !== 0x2f) alpha = true;
    } else if (type === 'ICCP') {
      colorProfile = true;
    }
    i = data + len + (len & 1);
  }
  return { size, alpha, colorProfile };
}

/** Reads GIF dimensions; transparency is reported when a GCE enables it. */
function readGifInfo(bytes: Uint8Array): { size: Size; alpha: boolean | null; colorProfile: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  let alpha: boolean | null = false;
  for (let i = 13; i + 8 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && (bytes[i + 3] & 0x01) === 0x01) {
      alpha = true;
      break;
    }
  }
  return { size: { width, height }, alpha, colorProfile: false };
}

/** Reads BMP dimensions. */
function readBmpInfo(bytes: Uint8Array): { size: Size; alpha: boolean | null; colorProfile: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt32(18, true);
  const height = Math.abs(view.getInt32(22, true));
  const bitCount = view.getUint16(28, true);
  return { size: { width, height }, alpha: bitCount === 32 ? true : false, colorProfile: false };
}

/** Reads ICO dimensions from the first directory entry. */
function readIcoInfo(bytes: Uint8Array): { size: Size; alpha: boolean | null; colorProfile: boolean } {
  const w = bytes[6] === 0 ? 256 : bytes[6];
  const h = bytes[7] === 0 ? 256 : bytes[7];
  return { size: { width: w, height: h }, alpha: true, colorProfile: false };
}

/** Reads `ispe` dimensions out of an AVIF/HEIF `meta` box (best effort). */
function readAvifInfo(bytes: Uint8Array): { size: Size | null; alpha: boolean | null; colorProfile: boolean } {
  const text = ascii(bytes, 0, Math.min(bytes.length, 4096));
  const idx = text.indexOf('ispe');
  let size: Size | null = null;
  if (idx >= 0 && idx + 16 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = view.getUint32(idx + 8, false);
    const h = view.getUint32(idx + 12, false);
    if (w > 0 && h > 0 && w < 100000 && h < 100000) size = { width: w, height: h };
  }
  return { size, alpha: null, colorProfile: text.includes('colr') || text.includes('icc') };
}

/** Reads SVG dimensions from `width`/`height` or `viewBox`. */
function readSvgInfo(bytes: Uint8Array): { size: Size | null; alpha: boolean | null; colorProfile: boolean } {
  const text = ascii(bytes, 0, Math.min(bytes.length, 8192));
  const svgTag = text.match(/<svg[^>]*>/i)?.[0] ?? '';
  const num = (s: string | undefined): number | null => {
    if (!s) return null;
    const m = s.match(/(-?[\d.]+)\s*(px)?/);
    return m ? Math.round(parseFloat(m[1])) : null;
  };
  let width = num(svgTag.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1]);
  let height = num(svgTag.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1]);
  if (!width || !height) {
    const vb = svgTag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1];
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        width = width ?? Math.round(parts[2]);
        height = height ?? Math.round(parts[3]);
      }
    }
  }
  if (width && height) return { size: { width, height }, alpha: null, colorProfile: false };
  return { size: null, alpha: null, colorProfile: false };
}

const ICC_IN_JPEG = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46]; // 'ICC_PROFILE'

function jpegHasColorProfile(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = view.getUint16(i + 2, false);
    if (marker === 0xe2) {
      let match = true;
      for (let k = 0; k < ICC_IN_JPEG.length; k++) {
        if (bytes[i + 4 + k] !== ICC_IN_JPEG[k]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
    i += 2 + length;
  }
  return false;
}

/**
 * Reads structural metadata (dimensions, format, alpha, EXIF orientation, colour
 * profile presence) from the encoded bytes — **without decoding pixels**.
 *
 * JPEG/PNG/WebP/GIF/BMP/ICO/AVIF/SVG are handled; anything else throws
 * `UNSUPPORTED_FORMAT`.
 */
export async function getImageInfo(input: ImageInput, options: CallOptions = {}): Promise<ImageInfo> {
  if (options.signal?.aborted) {
    const { AbortError } = await import('../errors');
    throw new AbortError();
  }
  const bytes = await inputToBytes(input);
  return readImageInfo(bytes);
}

/** Synchronous variant of {@link getImageInfo} for callers that already have bytes. */
export function readImageInfo(bytes: Uint8Array): ImageInfo {
  const format = sniffFormat(bytes);
  const mimeType = formatToMimeType(format);
  const size = bytes.byteLength;
  let dims: Size | null = null;
  let hasAlpha: boolean | null = null;
  let hasColorProfile = false;
  let info: { size: Size | null; alpha: boolean | null; colorProfile: boolean } | null = null;

  switch (format) {
    case 'png': {
      const png = readPngInfo(bytes);
      info = { size: png.size, alpha: png.alpha, colorProfile: png.colorProfile };
      break;
    }
    case 'jpeg':
      info = { size: readJpegSize(bytes), alpha: false, colorProfile: jpegHasColorProfile(bytes) };
      break;
    case 'webp':
      info = readWebpInfo(bytes);
      break;
    case 'gif':
      info = readGifInfo(bytes);
      break;
    case 'bmp':
      info = readBmpInfo(bytes);
      break;
    case 'ico':
      info = readIcoInfo(bytes);
      break;
    case 'avif':
      info = readAvifInfo(bytes);
      break;
    case 'svg':
      info = readSvgInfo(bytes);
      break;
    default:
      info = null;
  }

  if (info) {
    dims = info.size;
    hasAlpha = info.alpha;
    hasColorProfile = info.colorProfile;
  }

  const exif = parseExif(bytes);
  const orientation = exif?.orientation ?? 1;
  const swapped = orientation >= 5 && orientation <= 8;
  const width = dims?.width ?? 0;
  const height = dims?.height ?? 0;

  return {
    width,
    height,
    displayWidth: swapped ? height : width,
    displayHeight: swapped ? width : height,
    format,
    mimeType,
    size,
    hasAlpha,
    orientation,
    hasColorProfile,
    hasExif: exif !== null,
    exif,
  };
}
