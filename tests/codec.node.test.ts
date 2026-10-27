import { beforeAll, describe, expect, it } from 'vitest';
import { nodeBackend, useNodeBackend } from '../src/node';
import {
  canEncode,
  compressImage,
  convertImage,
  cropToAspect,
  generatePlaceholder,
  generateSrcSet,
  generateThumbnail,
  getImageInfo,
  isBackendAvailable,
  processImage,
  resizeImage,
  sniffFormat,
  stripMetadata,
  setBackend,
  ImageToolsError,
  thumbHashToImage,
} from '../src/index';
import {
  makeJpeg,
  makeJpegWithOrientation,
  makeNoisePng,
  makePng,
  makePngWithMetadata,
  makeWebp,
  solidImage,
} from './fixtures/images';
import { parseExif } from '../src/meta/exif';

beforeAll(async () => {
  const ok = await useNodeBackend();
  expect(ok).toBe(true);
  setBackend(nodeBackend);
});

describe('Node backend (@napi-rs/canvas)', () => {
  it('is available and reports its name', async () => {
    expect(await isBackendAvailable()).toBe(true);
    expect(nodeBackend.name).toBe('node');
  });

  it('advertises encoders it can actually use', async () => {
    expect(await canEncode('png')).toBe(true);
    expect(await canEncode('image/jpeg')).toBe(true);
    expect(await canEncode('webp')).toBe(true);
    expect(await canEncode('avif')).toBe(true);
    expect(await nodeBackend.canEncode('image/gif')).toBe(false);
    await expect(nodeBackend.canEncode('image/tiff')).rejects.toThrow(/Unknown image format/);
  });

  it('decodes a PNG to the right dimensions and pixels', async () => {
    const png = makePng(24, 16);
    const raw = await nodeBackend.decode(png);
    expect(raw.width).toBe(24);
    expect(raw.height).toBe(16);
    expect(raw.data.length).toBe(24 * 16 * 4);
    // Gradient from red to blue: left is red-ish, right is blue-ish.
    expect(raw.data[0]).toBeGreaterThan(200);
    expect(raw.data[(23 * 4)]).toBeLessThan(60);
  });

  it('round-trips PNG -> decode -> encode -> decode identically', async () => {
    const png = makePng(20, 10);
    const raw = await nodeBackend.decode(png);
    const blob = await nodeBackend.encode(raw, { type: 'image/png' });
    expect(blob.type).toBe('image/png');
    const again = await nodeBackend.decode(new Uint8Array(await blob.arrayBuffer()));
    expect(again.width).toBe(raw.width);
    expect(again.height).toBe(raw.height);
    expect(Array.from(again.data)).toEqual(Array.from(raw.data));
  });

  it('round-trips JPEG and WebP', async () => {
    const jpeg = makeJpeg(32, 24);
    const raw = await nodeBackend.decode(jpeg);
    const jpegBlob = await nodeBackend.encode(raw, { type: 'image/jpeg', quality: 0.9 });
    expect(jpegBlob.type).toBe('image/jpeg');
    const jpegAgain = await nodeBackend.decode(jpegBlob);
    expect([jpegAgain.width, jpegAgain.height]).toEqual([32, 24]);

    const webpBlob = await nodeBackend.encode(raw, { type: 'image/webp', quality: 0.8 });
    expect(webpBlob.type).toBe('image/webp');
    const webpAgain = await nodeBackend.decode(webpBlob);
    expect([webpAgain.width, webpAgain.height]).toEqual([32, 24]);
    let maxDelta = 0;
    for (let i = 0; i < raw.data.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(raw.data[i] - webpAgain.data[i]));
    }
    expect(maxDelta).toBeLessThan(90);
    expect(sniffFormat(new Uint8Array(await webpBlob.arrayBuffer()))).toBe('webp');
    expect(sniffFormat(makeWebp())).toBe('webp');
  });

  it('encodes AVIF', async () => {
    const raw = await nodeBackend.decode(makePng(16, 16));
    const avif = await nodeBackend.encode(raw, { type: 'image/avif', quality: 0.7 });
    expect(avif.type).toBe('image/avif');
    expect(sniffFormat(new Uint8Array(await avif.arrayBuffer()))).toBe('avif');
  });

  it('decodes from a Blob, ArrayBuffer, data URL and RawImage input', async () => {
    const png = makePng(8, 8);
    const fromBlob = await nodeBackend.decode(new Blob([png as unknown as BlobPart]));
    const fromBuffer = await nodeBackend.decode(png.buffer.slice(0) as ArrayBuffer);
    const b64 = Buffer.from(png).toString('base64');
    const fromDataUrl = await nodeBackend.decode(`data:image/png;base64,${b64}`);
    for (const raw of [fromBlob, fromBuffer, fromDataUrl]) {
      expect([raw.width, raw.height]).toEqual([8, 8]);
    }
    // RawImage inputs short-circuit decoding entirely.
    const viaPipeline = await processImage(fromBlob).resize({ width: 4 }).toRaw();
    expect([viaPipeline.width, viaPipeline.height]).toEqual([4, 4]);
  });

  it('rejects junk bytes with DECODE_FAILED / UNSUPPORTED_FORMAT', async () => {
    await expect(nodeBackend.decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
    await expect(nodeBackend.decode(new Uint8Array(0))).rejects.toBeInstanceOf(ImageToolsError);
  });
});

describe('encode / convert', () => {
  it('converts between all supported formats', async () => {
    const png = makePng(40, 30);
    for (const format of ['jpeg', 'webp', 'avif', 'png'] as const) {
      const blob = await convertImage(png, format, { quality: 0.8 });
      expect(blob.type).toBe(`image/${format}`);
      expect(blob.size).toBeGreaterThan(0);
      expect(sniffFormat(new Uint8Array(await blob.arrayBuffer()))).toBe(format);
    }
  });

  it('resizes and crops through the helpers', async () => {
    const png = makePng(100, 50);
    const resized = await resizeImage(png, { width: 25, fit: 'inside' });
    const info = await getImageInfo(resized);
    expect([info.width, info.height]).toEqual([25, 13]);

    const square = await cropToAspect(png, 1);
    const squareInfo = await getImageInfo(square);
    expect(squareInfo.width).toBe(squareInfo.height);
    expect(squareInfo.width).toBe(50);
    expect(squareInfo.format).toBe('png');

    // The input format is kept (the crop runs on decoded pixels internally).
    const jpegSquare = await getImageInfo(await cropToAspect(makeJpeg(40, 20), 1));
    expect([jpegSquare.format, jpegSquare.width, jpegSquare.height]).toEqual(['jpeg', 20, 20]);

    const thumb = await generateThumbnail(png, 16);
    const thumbInfo = await getImageInfo(thumb);
    expect([thumbInfo.width, thumbInfo.height]).toEqual([16, 16]);
  });

  it('compresses to a byte target by searching quality', async () => {
    // Noise at 240x180 is ~200 KB as PNG and cannot fit 40 KB without a quality dive.
    const png = makeNoisePng(240, 180);
    const original = png.length;
    const compressed = await compressImage(png, { maxSizeKB: 40, maxWidthOrHeight: 240 });
    expect(compressed.size).toBeLessThanOrEqual(40 * 1024);
    expect(compressed.size).toBeLessThan(original);
    expect(sniffFormat(new Uint8Array(await compressed.arrayBuffer()))).toBe('jpeg');
  });

  it('compresses to a very small target by downscaling', async () => {
    const png = makeNoisePng(400, 300);
    const tiny = await compressImage(png, {
      maxSizeKB: 12,
      minQuality: 0.4,
      maxWidthOrHeight: 400,
      minWidthOrHeight: 64,
    });
    expect(tiny.size).toBeLessThanOrEqual(12 * 1024);
    const info = await getImageInfo(tiny);
    // Hitting a 12 KB budget required a downscale, so the longest edge shrank.
    expect(Math.max(info.width, info.height)).toBeLessThan(400);
  });

  it('compresses without a size target in one pass', async () => {
    const png = makePng(64, 64);
    const blob = await compressImage(png, { maxQuality: 0.7 });
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('strips metadata without re-encoding', async () => {
    const jpeg = makeJpegWithOrientation(6, 32, 24);
    const blob = await stripMetadata(jpeg);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(blob.type).toBe('image/jpeg');
    expect(bytes.length).toBeLessThan(jpeg.length);
    expect(parseExif(bytes)).toBeNull();
    const { png } = makePngWithMetadata();
    const pngBlob = await stripMetadata(png);
    expect(pngBlob.type).toBe('image/png');
    expect((await pngBlob.arrayBuffer()).byteLength).toBeLessThan(png.length);
  });
});

describe('EXIF orientation fixes real pixels (orientations 1..8)', () => {
  it('gives an upright result for every orientation value', async () => {
    // Source pixels: red on the left, blue on the right, green marker top-left.
    const results: Record<number, { width: number; height: number }> = {};
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const jpeg = makeJpegWithOrientation(orientation, 30, 18);
      const info = await getImageInfo(jpeg);
      expect(info.orientation).toBe(orientation);
      expect(info.width).toBe(30);
      expect(info.height).toBe(18);

      const oriented = await processImage(jpeg).orient().toRaw();
      expect(oriented.width).toBe(info.displayWidth);
      expect(oriented.height).toBe(info.displayHeight);
      results[orientation] = { width: oriented.width, height: oriented.height };

      const raw = await processImage(jpeg).orient(false).toRaw();
      expect([raw.width, raw.height]).toEqual([30, 18]);
    }
    // Orientations 5..8 swap the axes; 1..4 do not.
    for (const o of [1, 2, 3, 4]) expect(results[o]).toEqual({ width: 30, height: 18 });
    for (const o of [5, 6, 7, 8]) expect(results[o]).toEqual({ width: 18, height: 30 });
  });

  it('moves the green marker to the expected corner', async () => {
    // "Greenest corner": robust against JPEG chroma smearing.
    const greenestCorner = (img: { width: number; height: number; data: Uint8ClampedArray }): string => {
      const { width: w, height: h, data } = img;
      const patch = (x: number, y: number): number => {
        let score = 0;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            const i = (Math.min(h - 1, y + dy) * w + Math.min(w - 1, x + dx)) * 4;
            score += data[i + 1] - Math.max(data[i], data[i + 2]);
          }
        }
        return score;
      };
      const corners = {
        tl: patch(1, 1),
        tr: patch(w - 5, 1),
        bl: patch(1, h - 5),
        br: patch(w - 5, h - 5),
      };
      return Object.entries(corners).sort((a, b) => b[1] - a[1])[0][0];
    };
    const cornerChecks: Array<{ orientation: number; corner: 'tl' | 'tr' | 'bl' | 'br' }> = [
      { orientation: 1, corner: 'tl' },
      { orientation: 2, corner: 'tr' },
      { orientation: 3, corner: 'br' },
      { orientation: 4, corner: 'bl' },
      { orientation: 5, corner: 'tl' },
      { orientation: 6, corner: 'tr' },
      { orientation: 7, corner: 'br' },
      { orientation: 8, corner: 'bl' },
    ];
    for (const { orientation, corner } of cornerChecks) {
      const jpeg = makeJpegWithOrientation(orientation, 30, 18);
      const img = await processImage(jpeg).orient().toRaw();
      expect(greenestCorner(img), `orientation ${orientation} should put the marker at ${corner}`).toBe(corner);
    }
  });

  it('auto-orients one-shot helpers too', async () => {
    const jpeg = makeJpegWithOrientation(6, 60, 30);
    const blob = await resizeImage(jpeg, { width: 20, fit: 'inside' });
    const info = await getImageInfo(blob);
    // After orientation the image is 30x60, so fitting to width 20 gives 20x40.
    expect(info.width).toBe(20);
    expect(info.height).toBe(40);
  });
});

describe('backend registration', () => {
  it('setBackend rejects malformed implementations', () => {
    expect(() => setBackend({ name: 'bad' } as never)).toThrow(/must implement decode/);
    setBackend(nodeBackend);
  });

  it('a custom backend can be plugged in', async () => {
    const calls: string[] = [];
    setBackend({
      name: 'recording',
      async decode(input) {
        calls.push('decode');
        return solidImage(2, 2, [1, 2, 3, 255]);
      },
      async encode() {
        calls.push('encode');
        return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
      },
      canEncode: () => true,
    });
    const raw = await processImage(makePng(4, 4)).toRaw();
    expect(raw.width).toBe(2);
    expect(calls).toEqual(['decode']);
    setBackend(nodeBackend);
  });
});

describe('generateSrcSet', () => {
  it('emits one file per width, capped at the source width', async () => {
    const entries = await generateSrcSet(makePng(400, 200), { widths: [800, 100, 200, 200] });
    expect(entries.map((e) => [e.width, e.height, e.descriptor])).toEqual([
      [100, 50, '100w'],
      [200, 100, '200w'],
      [400, 200, '400w'],
    ]);
    for (const entry of entries) {
      expect(entry.blob.type).toBe('image/png');
      const info = await getImageInfo(entry.blob);
      expect([info.width, info.height]).toEqual([entry.width, entry.height]);
    }
  });

  it('keeps JPEG input as JPEG and honours format and withoutEnlargement', async () => {
    const jpeg = await generateSrcSet(makeJpeg(60, 30), { widths: [30] });
    expect(jpeg[0].blob.type).toBe('image/jpeg');

    const webp = await generateSrcSet(makePng(60, 30), {
      widths: [120],
      format: 'webp',
      withoutEnlargement: false,
    });
    expect(webp[0].blob.type).toBe('image/webp');
    expect([webp[0].width, webp[0].height]).toEqual([120, 60]);
  });

  it('rejects an empty or invalid width list', async () => {
    await expect(generateSrcSet(makePng(10, 10), { widths: [] })).rejects.toThrow(/widths/);
    await expect(generateSrcSet(makePng(10, 10), { widths: [0] })).rejects.toThrow(/widths/);
  });
});

describe('generatePlaceholder', () => {
  it('returns a ThumbHash, its base64 form and a decodable data URL', async () => {
    const placeholder = await generatePlaceholder(makePng(300, 150));
    expect([placeholder.width, placeholder.height]).toEqual([300, 150]);
    expect(Buffer.from(placeholder.base64, 'base64')).toEqual(Buffer.from(placeholder.hash));
    expect(placeholder.averageColor.a).toBe(255);

    const decoded = await processImage(placeholder.dataURL).toRaw();
    const expected = thumbHashToImage(placeholder.hash);
    expect([decoded.width, decoded.height]).toEqual([expected.width, expected.height]);
    expect(Array.from(decoded.data)).toEqual(Array.from(expected.data));
  });

  it('applies EXIF orientation before hashing', async () => {
    const placeholder = await generatePlaceholder(makeJpegWithOrientation(6));
    expect(placeholder.height).toBeGreaterThan(placeholder.width);
  });
});
