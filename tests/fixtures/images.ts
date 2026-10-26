/**
 * Fixture builders for encoded images.
 *
 * `@napi-rs/canvas` (a devDependency) produces *valid* JPEG/PNG bytes, and the
 * helpers below splice real metadata segments into them — EXIF APP1 for JPEG and
 * tEXt/iTXt/zTXt/eXIf chunks for PNG. That gives us files a decoder accepts while
 * still letting the tests assert on byte-level rewriting.
 */
import { createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import type { RawImage } from '../../src/types';
import { buildExifApp1, buildTiff, type ExifFixtureOptions } from './exif';

/** Builds a simple gradient image and returns its canvas (unencoded). */
export function gradientCanvas(width = 32, height = 24): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#ff0000');
  gradient.addColorStop(0.5, '#00ff00');
  gradient.addColorStop(1, '#0000ff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

/** A gradient PNG. */
export function makePng(width = 32, height = 24): Uint8Array {
  return new Uint8Array(gradientCanvas(width, height).encodeSync('png'));
}

/** A gradient JPEG (quality default 0.9). */
export function makeJpeg(width = 32, height = 24, quality = 0.9): Uint8Array {
  return new Uint8Array(gradientCanvas(width, height).encodeSync('jpeg', quality));
}

/**
 * A deterministic noise PNG: incompressible enough that reaching a small byte
 * budget genuinely requires downscaling.
 */
export function makeNoisePng(width = 64, height = 64): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    // xorshift32 keeps the fixture deterministic across runs.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % 256;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = rand();
    image.data[i + 1] = rand();
    image.data[i + 2] = rand();
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return new Uint8Array(canvas.encodeSync('png'));
}

/** A gradient WebP. */
export function makeWebp(width = 32, height = 24, quality = 0.9): Uint8Array {
  return new Uint8Array(gradientCanvas(width, height).encodeSync('webp', quality));
}

/**
 * A JPEG of `width x height` that stores `orientation` in EXIF.
 *
 * The pixel content is a horizontal red→blue gradient with a green marker in the
 * top-left corner, which makes it possible to verify that the orientation
 * transform really moved the pixels around.
 */
export function makeJpegWithOrientation(
  orientation: number,
  width = 30,
  height = 18,
  options: ExifFixtureOptions = {},
): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#ff0000');
  gradient.addColorStop(1, '#0000ff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  // A green marker in the top-left corner. It covers a third of each axis so it
  // survives JPEG chroma subsampling well enough to be located unambiguously.
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, Math.max(2, Math.round(width / 3)), Math.max(2, Math.round(height / 3)));
  const base = new Uint8Array(canvas.encodeSync('jpeg', 0.98));
  return insertJpegSegment(base, buildExifApp1({ orientation, ...options }));
}

/** Inserts a raw segment (marker + length + payload) right after the SOI. */
export function insertJpegSegment(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0); // SOI
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

/** Builds a PNG chunk with a correct CRC. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as specified for PNG chunks. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function textChunk(keyword: string, text: string): Uint8Array {
  const data = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
  data[keyword.length] = 0;
  for (let i = 0; i < text.length; i++) data[keyword.length + 1 + i] = text.charCodeAt(i);
  return pngChunk('tEXt', data);
}

function itxtChunk(keyword: string, text: string): Uint8Array {
  // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
  const parts = [
    ...Array.from(keyword, (c) => c.charCodeAt(0)),
    0,
    0,
    0,
    0,
    0,
    ...Array.from(text, (c) => c.charCodeAt(0)),
  ];
  return pngChunk('iTXt', new Uint8Array(parts));
}

function ztxtChunk(keyword: string): Uint8Array {
  // keyword \0 method 0 + deliberately invalid zlib data: we never decompress it.
  const data = new Uint8Array(keyword.length + 1 + 1 + 8);
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
  data[keyword.length] = 0;
  data[keyword.length + 1] = 0;
  for (let i = 0; i < 8; i++) data[keyword.length + 2 + i] = 0x78;
  return pngChunk('zTXt', data);
}

/**
 * A PNG carrying `tEXt`, `iTXt`, `zTXt` and `eXIf` chunks (inserted before IDAT,
 * which is where PNG requires ancillary metadata to live).
 */
export function makePngWithMetadata(options: ExifFixtureOptions = {}): {
  png: Uint8Array;
  chunks: { type: string; length: number }[];
} {
  const base = makePng(16, 12);
  const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
  // Find IDAT start.
  let i = 8;
  let idatStart = -1;
  const chunks: { type: string; length: number }[] = [];
  while (i + 8 <= base.length) {
    const length = view.getUint32(i, false);
    const type = String.fromCharCode(base[i + 4], base[i + 5], base[i + 6], base[i + 7]);
    chunks.push({ type, length });
    if (type === 'IDAT') {
      idatStart = i;
      break;
    }
    i += length + 12;
  }
  const extra = [
    textChunk('Comment', 'hello from the test suite'),
    textChunk('Software', 'picopix'),
    itxtChunk('Description', 'international text'),
    ztxtChunk('Compressed'),
    pngChunk('eXIf', buildTiffForPng(options)),
  ];
  const extraLength = extra.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(base.length + extraLength);
  out.set(base.subarray(0, idatStart), 0);
  let offset = idatStart;
  for (const chunk of extra) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  out.set(base.subarray(idatStart), offset);
  return { png: out, chunks: [...chunks, ...extra.map((c, idx) => ({ type: ['tEXt', 'tEXt', 'iTXt', 'zTXt', 'eXIf'][idx], length: c.length - 12 }))] };
}

function buildTiffForPng(options: ExifFixtureOptions): Uint8Array {
  return buildTiff({ orientation: 1, ...options });
}

/**
 * A structurally valid PNG header (signature + IHDR + optional tRNS + IEND) for
 * testing `getImageInfo` without decoding anything. The IDAT is intentionally
 * absent: metadata readers must not care.
 */
export function buildPngHeader(width: number, height: number, colorType: number, withTrns = false): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(withTrns ? [pngChunk('tRNS', new Uint8Array([0, 4, 0, 4, 0, 4]))] : []),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A `RawImage` from a canvas-rendered pattern. */
export function rawFromCanvas(canvas: Canvas): RawImage {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, data: new Uint8ClampedArray(data.data) };
}

/** A solid `RawImage`. */
export function solidImage(width: number, height: number, rgba: [number, number, number, number]): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

/** A `RawImage` whose red channel encodes `x` and green channel encodes `y`. */
export function coordinateImage(width: number, height: number): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x * 10;
      data[i + 1] = y * 10;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}
