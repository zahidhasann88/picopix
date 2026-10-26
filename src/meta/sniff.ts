import type { ImageFormatId } from '../types';

const ascii = (bytes: Uint8Array, start: number, end: number): string => {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/**
 * Detects the image format from the first bytes of the file (magic numbers).
 *
 * Supports png, jpeg, webp, gif, avif, bmp, ico and svg; returns `'unknown'`
 * otherwise. AVIF/HEIF is detected through the ISO-BMFF `ftyp` box.
 */
export function sniffFormat(bytes: Uint8Array): ImageFormatId {
  if (!bytes || bytes.length < 4) return 'unknown';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  // GIF: 'GIF8'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  // BMP: 'BM'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  // ICO / CUR: 00 00 01 00 / 00 00 02 00
  if (bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) return 'ico';
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  // ISO-BMFF: ....ftyp + brand
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    // HEIC/HEIF brands are NOT avif; report unknown so callers do not assume
    // they can be decoded by an AVIF decoder.
  }
  // SVG: leading whitespace/BOM, then '<svg' or '<?xml ... <svg'
  const head = ascii(bytes, 0, Math.min(bytes.length, 512)).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg[\s>]/i.test(head))) return 'svg';
  return 'unknown';
}

/** MIME type for a sniffed format (`null` for `unknown` and `svg`). */
export function formatToMimeType(format: ImageFormatId): string | null {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'ico':
      return 'image/x-icon';
    default:
      return null;
  }
}
