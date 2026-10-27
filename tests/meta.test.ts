import { describe, expect, it } from 'vitest';
import { buildExifApp1, buildTiff } from './fixtures/exif';
import { makeJpeg, makeJpegWithOrientation, makePng, makePngWithMetadata } from './fixtures/images';
import { findJpegExif, parseExif, parseTiff, readOrientation } from '../src/meta/exif';
import { formatToMimeType, sniffFormat } from '../src/meta/sniff';
import { readImageInfo } from '../src/meta/info';
import {
  stripJpegMetadata,
  stripMetadataBytes,
  stripPngMetadata,
  strippableFormat,
} from '../src/meta/strip';

describe('EXIF parser (hand-built fixtures)', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('reads orientation %i from little-endian TIFF', (orientation) => {
    const parsed = parseTiff(buildTiff({ orientation }));
    expect(parsed?.orientation).toBe(orientation);
  });

  it('reads big-endian TIFF headers too', () => {
    const parsed = parseTiff(buildTiff({ orientation: 7, littleEndian: false, make: 'Nikon', model: 'Z8' }));
    expect(parsed).toMatchObject({ orientation: 7, make: 'Nikon', model: 'Z8' });
  });

  it('extracts make, model, dates and the GPS flag', () => {
    const parsed = parseTiff(
      buildTiff({ make: 'Fujifilm', model: 'X-T5', dateTime: '2026:05:06 07:08:09', gps: true }),
    );
    expect(parsed?.make).toBe('Fujifilm');
    expect(parsed?.model).toBe('X-T5');
    expect(parsed?.dateTime).toBe('2026:05:06 07:08:09');
    expect(parsed?.dateTimeOriginal).toBe('2025:12:31 23:59:58');
    expect(parsed?.hasGps).toBe(true);
    expect(parsed?.tags[0x0112]).toBe(1);
    expect(parsed?.tags[0x010f]).toBe('Fujifilm');
  });

  it('reports hasGps false without a GPS pointer', () => {
    expect(parseTiff(buildTiff({ gps: false }))?.hasGps).toBe(false);
  });

  it('returns null for non-TIFF and truncated input', () => {
    expect(parseTiff(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseTiff(new Uint8Array(32))).toBeNull();
    expect(parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(parseExif(new Uint8Array(0))).toBeNull();
  });

  it('finds APP1 in a real JPEG and reads its orientation', () => {
    for (const orientation of [1, 3, 6, 8]) {
      const jpeg = makeJpegWithOrientation(orientation);
      const exif = parseExif(jpeg);
      expect(exif?.orientation).toBe(orientation);
      expect(readOrientation(jpeg)).toBe(orientation);
      expect(findJpegExif(jpeg)?.tiffStart).toBeGreaterThan(0);
    }
  });

  it('reads EXIF from a PNG eXIf chunk', () => {
    const { png } = makePngWithMetadata({ orientation: 5, make: 'PNGCam' });
    expect(parseExif(png)).toMatchObject({ orientation: 5, make: 'PNGCam' });
  });

  it('returns orientation 1 for a JPEG without EXIF', () => {
    expect(readOrientation(makeJpeg())).toBe(1);
    expect(parseExif(makeJpeg())).toBeNull();
  });
});

describe('format sniffing', () => {
  it('detects the formats the library supports', () => {
    expect(sniffFormat(makePng())).toBe('png');
    expect(sniffFormat(makeJpeg())).toBe('jpeg');
    expect(sniffFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
    expect(sniffFormat(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('bmp');
    expect(sniffFormat(new Uint8Array([0, 0, 1, 0, 1, 0]))).toBe('ico');
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffFormat(webp)).toBe('webp');
    const avif = new Uint8Array(16);
    avif.set([0, 0, 0, 0x20], 0);
    avif.set([0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4);
    expect(sniffFormat(avif)).toBe('avif');
    expect(sniffFormat(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg');
    expect(
      sniffFormat(new TextEncoder().encode('  <?xml version="1.0"?>\n<svg width="10" height="10"/>')),
    ).toBe('svg');
  });

  it('returns unknown for junk', () => {
    expect(sniffFormat(new Uint8Array([1, 2, 3, 4]))).toBe('unknown');
    expect(sniffFormat(new Uint8Array(0))).toBe('unknown');
  });

  it('maps formats to MIME types', () => {
    expect(formatToMimeType('jpeg')).toBe('image/jpeg');
    expect(formatToMimeType('png')).toBe('image/png');
    expect(formatToMimeType('ico')).toBe('image/x-icon');
    expect(formatToMimeType('svg')).toBeNull();
    expect(formatToMimeType('unknown')).toBeNull();
  });
});

describe('getImageInfo (structure sniffing, no decode)', () => {
  it('reads PNG dimensions, alpha and format', () => {
    const info = readImageInfo(makePng(20, 10));
    expect(info).toMatchObject({
      width: 20,
      height: 10,
      format: 'png',
      mimeType: 'image/png',
      hasAlpha: true,
      orientation: 1,
      displayWidth: 20,
      displayHeight: 10,
      hasExif: false,
    });
    expect(info.size).toBeGreaterThan(0);
  });

  it('reads JPEG dimensions, EXIF and swaps display size for orientation 6', () => {
    const jpeg = makeJpegWithOrientation(6, 8, 4);
    const info = readImageInfo(jpeg);
    expect(info.format).toBe('jpeg');
    expect(info.width).toBe(8);
    expect(info.height).toBe(4);
    expect(info.orientation).toBe(6);
    expect(info.displayWidth).toBe(4);
    expect(info.displayHeight).toBe(8);
    expect(info.hasAlpha).toBe(false);
    expect(info.exif?.make).toBe('ArenaCam');
  });

  it('detects an embedded ICC profile', () => {
    // @napi-rs/canvas writes an ICC profile into JPEGs.
    const jpeg = makeJpeg();
    expect(readImageInfo(jpeg).hasColorProfile).toBe(true);
  });

  it('reports WebP size via VP8/VP8L/VP8X', () => {
    // RIFF....WEBP + a VP8X chunk carrying the alpha flag and 24-bit sizes.
    const webp = new Uint8Array(34);
    webp.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    webp.set([0x22, 0, 0, 0], 4); // RIFF size
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
    webp.set([0x56, 0x50, 0x38, 0x58], 12); // 'VP8X'
    webp.set([0x0a, 0, 0, 0], 16); // chunk size = 10
    webp[20] = 0x10; // flags: alpha present
    webp.set([0x09, 0, 0], 24); // width-1 = 9
    webp.set([0x05, 0, 0], 27); // height-1 = 5
    const info = readImageInfo(webp);
    expect(info.format).toBe('webp');
    expect(info.width).toBe(10);
    expect(info.height).toBe(6);
    expect(info.hasAlpha).toBe(true);
  });

  it('reads GIF and SVG dimensions', () => {
    const gif = new Uint8Array(20);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    gif[6] = 12;
    gif[8] = 7;
    expect(readImageInfo(gif)).toMatchObject({ width: 12, height: 7, format: 'gif' });
    const svg = new TextEncoder().encode('<svg width="120" height="80"><rect/></svg>');
    expect(readImageInfo(svg)).toMatchObject({ width: 120, height: 80, format: 'svg' });
    const svgViewBox = new TextEncoder().encode('<svg viewBox="0 0 640 480"></svg>');
    expect(readImageInfo(svgViewBox)).toMatchObject({ width: 640, height: 480 });
  });
});

describe('lossless metadata stripping', () => {
  it('removes APP1/EXIF from a JPEG without touching the image data', () => {
    const jpeg = makeJpegWithOrientation(6, 16, 12);
    expect(parseExif(jpeg)).not.toBeNull();
    const stripped = stripJpegMetadata(jpeg);
    expect(stripped.length).toBeLessThan(jpeg.length);
    expect(parseExif(stripped)).toBeNull();
    // Image data (from SOS to EOI) must be byte-identical.
    const scanOf = (bytes: Uint8Array): Uint8Array => {
      for (let i = 0; i < bytes.length - 1; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xda) return bytes.subarray(i);
      }
      return new Uint8Array(0);
    };
    expect(Array.from(scanOf(stripped))).toEqual(Array.from(scanOf(jpeg)));
    expect(sniffFormat(stripped)).toBe('jpeg');
  });

  it('drops the ICC profile by default but can keep it', () => {
    const jpeg = makeJpeg();
    expect(readImageInfo(jpeg).hasColorProfile).toBe(true);
    expect(readImageInfo(stripJpegMetadata(jpeg)).hasColorProfile).toBe(false);
    expect(readImageInfo(stripJpegMetadata(jpeg, { keepColorProfile: true })).hasColorProfile).toBe(true);
  });

  it('removes PNG text/EXIF chunks and keeps pixels intact', () => {
    const { png } = makePngWithMetadata({ orientation: 1 });
    const types = (bytes: Uint8Array): string[] => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const list: string[] = [];
      let i = 8;
      while (i + 8 <= bytes.length) {
        const length = view.getUint32(i, false);
        const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
        list.push(type);
        if (type === 'IEND') break;
        i += length + 12;
      }
      return list;
    };
    const before = types(png);
    expect(before).toContain('tEXt');
    expect(before).toContain('iTXt');
    expect(before).toContain('zTXt');
    expect(before).toContain('eXIf');
    const stripped = stripPngMetadata(png);
    const after = types(stripped);
    expect(after).not.toContain('tEXt');
    expect(after).not.toContain('iTXt');
    expect(after).not.toContain('zTXt');
    expect(after).not.toContain('eXIf');
    expect(after).toContain('IHDR');
    expect(after).toContain('IDAT');
    expect(after).toContain('IEND');
    const idatOf = (bytes: Uint8Array): number[] => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let i = 8;
      while (i + 8 <= bytes.length) {
        const length = view.getUint32(i, false);
        const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
        if (type === 'IDAT') return Array.from(bytes.subarray(i, i + length + 12));
        i += length + 12;
      }
      return [];
    };
    expect(idatOf(stripped)).toEqual(idatOf(png));
    expect(stripped.length).toBeLessThan(png.length);
  });

  it('stripMetadataBytes dispatches by sniffed format', () => {
    expect(strippableFormat(makeJpegWithOrientation(3))).toBe('jpeg');
    expect(strippableFormat(makePng())).toBe('png');
    const webpLike = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4]);
    expect(stripMetadataBytes(webpLike)).toBe(webpLike); // untouched, same reference
  });

  it('rejects the wrong input type', () => {
    expect(() => stripJpegMetadata(makePng())).toThrow(/not a JPEG/);
    expect(() => stripPngMetadata(makeJpeg())).toThrow(/not a PNG/);
  });

  it('keeps an APP1 that is not EXIF out of the way but valid', () => {
    const jpeg = makeJpeg();
    // APP1 with a non-EXIF payload ('http:///…'): length 10 = 2 + 8 payload bytes.
    const xmp = new Uint8Array([0xff, 0xe1, 0, 10, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x2f]);
    const withXmp = new Uint8Array(jpeg.length + xmp.length);
    withXmp.set(jpeg.subarray(0, 2));
    withXmp.set(xmp, 2);
    withXmp.set(jpeg.subarray(2), 2 + xmp.length);
    // Keep the ICC profile so the only difference is the dropped APP1.
    const stripped = stripJpegMetadata(withXmp, { keepColorProfile: true });
    expect(stripped.length).toBe(jpeg.length);
    expect(Array.from(stripped)).toEqual(Array.from(jpeg));
    expect(buildExifApp1().length).toBeGreaterThan(20);
  });
});
