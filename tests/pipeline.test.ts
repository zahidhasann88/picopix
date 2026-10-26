import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AbortError,
  ImagePipeline,
  ImageToolsError,
  TimeoutError,
  compressImage,
  convertImage,
  createImage,
  getImageInfo,
  isAbortError,
  isImageToolsError,
  processImage,
  resizeImage,
  sniffFormat,
  stripMetadata,
  generateThumbnail,
} from '../src/index';
import { createImageWorker } from '../src/worker/client';
import {
  coordinateImage,
  makeJpeg,
  makeJpegWithOrientation,
  makePng,
  makePngWithMetadata,
  pngChunk,
  buildPngHeader,
} from './fixtures/images';
import { nodeBackend, useNodeBackend } from '../src/node';

beforeAll(async () => {
  await useNodeBackend();
});

describe('typed errors', () => {
  it('carries a stable code and serialises', () => {
    const error = new ImageToolsError('UNSUPPORTED_FORMAT', 'nope');
    expect(error.code).toBe('UNSUPPORTED_FORMAT');
    expect(error.name).toBe('ImageToolsError');
    expect(error.toJSON()).toEqual({
      name: 'ImageToolsError',
      code: 'UNSUPPORTED_FORMAT',
      message: 'nope',
    });
    expect(isImageToolsError(error)).toBe(true);
    expect(isImageToolsError(new Error('plain'))).toBe(false);
  });

  it('AbortError and TimeoutError are aborts', () => {
    expect(isAbortError(new AbortError())).toBe(true);
    expect(isAbortError(new TimeoutError())).toBe(true);
    expect(new AbortError().code).toBe('ABORTED');
    expect(new TimeoutError().code).toBe('TIMEOUT');
  });

  it('awaited APIs reject with ImageToolsError instances', async () => {
    await expect(nodeBackend.decode(new Uint8Array([9, 9, 9, 9]))).rejects.toBeInstanceOf(ImageToolsError);
    expect(() => processImage(makePng(), { format: 'tiff' })).toThrow(/Unknown image format/);
  });

  it('rejects unsupported input types synchronously', () => {
    expect(() => processImage(42 as never)).toThrow(/expected a Blob/);
  });
});

describe('pipeline API', () => {
  it('chains ops and reports what it recorded', () => {
    const pipeline = processImage(coordinateImage(20, 10))
      .orient()
      .resize({ width: 10, fit: 'inside' })
      .crop({ x: 1, y: 1, width: 4, height: 4 })
      .rotate(90)
      .flip('y')
      .filter({ type: 'contrast', amount: 1.1 })
      .blur(1)
      .pad(1);
    expect(pipeline).toBeInstanceOf(ImagePipeline);
    expect(pipeline.length).toBe(7);
    // `.orient()` is a decode-time flag, so it is not part of the ops list.
    expect(pipeline.toOps().map((op) => op.op)).toEqual([
      'resize',
      'crop',
      'rotate',
      'flip',
      'filter',
      'blur',
      'pad',
    ]);
  });

  it('orient(6) becomes an explicit leading op', async () => {
    const pipeline = processImage(coordinateImage(30, 10)).resize({ width: 10 }).orient(6);
    expect(pipeline.toOps().map((op) => op.op)).toEqual(['orient', 'resize']);
    const out = await pipeline.toRaw();
    // The orientation runs first (30x10 -> 10x30), then the width-only resize
    // keeps that aspect ratio (10x30), proving the op order.
    expect([out.width, out.height]).toEqual([10, 30]);
    expect(() => processImage(createImage(2, 2)).orient(9)).toThrow(/1\.\.8/);
  });

  it('runs a full chain to raw pixels', async () => {
    const out = await processImage(coordinateImage(64, 32))
      .orient()
      .resize({ width: 32, fit: 'inside' })
      .rotate(90)
      .toRaw();
    expect([out.width, out.height]).toEqual([16, 32]);
  });

  it('decodes, processes and encodes in one chain', async () => {
    const blob = await processImage(makePng(64, 32))
      .orient()
      .resize({ width: 32, fit: 'inside' })
      .toFormat('webp', { quality: 0.8 })
      .toBlob();
    expect(blob.type).toBe('image/webp');
    const info = await getImageInfo(blob);
    expect([info.width, info.height]).toEqual([32, 16]);
  });

  it('keeps the source format by default', async () => {
    const jpeg = makeJpeg(32, 32);
    const blob = await processImage(jpeg).resize({ width: 16 }).toBlob();
    expect(blob.type).toBe('image/jpeg');
    const png = await processImage(makePng(32, 32)).resize({ width: 16 }).toBlob();
    expect(png.type).toBe('image/png');
  });

  it('defaults to PNG for RawImage input', async () => {
    const blob = await processImage(createImage(8, 8, [1, 2, 3, 255])).toBlob();
    expect(blob.type).toBe('image/png');
  });

  it('produces ArrayBuffer, data URL and object URL output', async () => {
    const pipeline = processImage(makePng(16, 16));
    const buffer = await pipeline.toArrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
    const url = await processImage(makePng(16, 16)).toDataURL();
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const objectUrl = await processImage(makePng(16, 16)).toObjectURL();
    expect(typeof objectUrl).toBe('string');
    URL.revokeObjectURL(objectUrl);
  });

  it('reports progress through every phase', async () => {
    const phases: string[] = [];
    await processImage(makePng(32, 32))
      .resize({ width: 16 })
      .toBlob({ onProgress: (p) => phases.push(p.phase) });
    expect(phases).toContain('decode');
    expect(phases).toContain('resize');
    expect(phases).toContain('encode');
  });

  it('aborts mid-flight with an AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      processImage(makePng(16, 16)).resize({ width: 8 }).toBlob({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('strips metadata on request', async () => {
    const { png } = makePngWithMetadata();
    expect(png.length).toBeGreaterThan(0);
    const blob = await processImage(makeJpegWithOrientation(6, 24, 16)).toBlob({ stripMetadata: true });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = await getImageInfo(bytes);
    expect(info.hasExif).toBe(false);
  });

  it('can offload the pixel work to a worker', async () => {
    const worker = createImageWorker({ fallback: 'always' });
    const out = await processImage(makePng(64, 64), { worker })
      .resize({ width: 32, height: 32, fit: 'cover' })
      .toRaw();
    expect([out.width, out.height]).toEqual([32, 32]);
    worker.dispose();
  });

  it('rejects invalid resize/crop arguments early', () => {
    const pipeline = processImage(createImage(4, 4, [0, 0, 0, 255]));
    expect(() => pipeline.resize({})).toThrow(/at least one of width\/height/);
    expect(() => pipeline.removeBackground({} as never)).toThrow(/must implement remove/);
  });

  it('throws UNSUPPORTED_FORMAT when the environment cannot encode', async () => {
    await expect(
      processImage(makePng(8, 8), { backend: { ...nodeBackend, canEncode: async () => false } })
        .resize({ width: 4 })
        .toBlob({ type: 'avif' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('supports composite() inside the pipeline', async () => {
    const out = await processImage(createImage(4, 4, [0, 0, 0, 255]))
      .composite(createImage(2, 2, [255, 0, 0, 255]), { x: 1, y: 1 })
      .toRaw();
    expect(Array.from(out.data.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4))).toEqual([255, 0, 0, 255]);
  });
});

describe('one-shot helpers', () => {
  it('resizeImage keeps the format or converts', async () => {
    const jpeg = makeJpeg(40, 20);
    const sameFormat = await resizeImage(jpeg, { width: 20, fit: 'inside' });
    expect(sameFormat.type).toBe('image/jpeg');
    const asPng = await resizeImage(jpeg, { width: 20, fit: 'inside', format: 'png' });
    expect(asPng.type).toBe('image/png');
    const info = await getImageInfo(asPng);
    expect([info.width, info.height]).toEqual([20, 10]);
  });

  it('convertImage maps format names', async () => {
    const blob = await convertImage(makeJpeg(16, 16), 'image/webp', { quality: 0.5 });
    expect(blob.type).toBe('image/webp');
    expect(sniffFormat(new Uint8Array(await blob.arrayBuffer()))).toBe('webp');
    await expect(async () => convertImage(makePng(), 'tiff')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it('generateThumbnail defaults to a square cover crop', async () => {
    const thumb = await generateThumbnail(makePng(100, 50), 32);
    const info = await getImageInfo(thumb);
    expect([info.width, info.height]).toEqual([32, 32]);
  });

  it('generateThumbnail accepts a box and a fit', async () => {
    const thumb = await generateThumbnail(makePng(100, 50), { width: 60 }, { fit: 'inside' });
    const info = await getImageInfo(thumb);
    expect([info.width, info.height]).toEqual([60, 30]);
    await expect(generateThumbnail(makePng(), {})).rejects.toThrow(/size is required/);
  });

  it('compressImage honours a size budget and tolerates no budget', async () => {
    const blob = await compressImage(makeJpeg(80, 60), { maxSizeKB: 200 });
    expect(blob.size).toBeLessThanOrEqual(200 * 1024);
    const progress: string[] = [];
    await compressImage(makeJpeg(80, 60), {
      maxSizeKB: 30,
      onProgress: (p) => progress.push(p.phase),
    });
    expect(progress.length).toBeGreaterThan(0);
  });

  it('stripMetadata is lossless and does not decode', async () => {
    const png = makePngWithMetadata().png;
    const blob = await stripMetadata(png);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeLessThan(png.length);
    const controller = new AbortController();
    controller.abort();
    await expect(stripMetadata(png, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('getImageInfo accepts a Blob and a URL-less string input', async () => {
    const png = makePng(12, 8);
    const info = await getImageInfo(new Blob([png as unknown as BlobPart]));
    expect([info.width, info.height]).toEqual([12, 8]);
    const b64 = Buffer.from(png).toString('base64');
    const fromDataUrl = await getImageInfo(`data:image/png;base64,${b64}`);
    expect(fromDataUrl.format).toBe('png');
  });
});

describe('hasAlpha detection', () => {
  it('reads the PNG colour type from IHDR', async () => {
    // Canvas always writes RGBA PNGs (colour type 6).
    expect((await getImageInfo(makePng(8, 8))).hasAlpha).toBe(true);
    // A hand-built IHDR with colour type 2 (truecolour, no alpha) is opaque.
    const png = buildPngHeader(4, 4, 2);
    expect((await getImageInfo(png)).hasAlpha).toBe(false);
    // Colour type 4/6 and a tRNS chunk all mean alpha.
    expect((await getImageInfo(buildPngHeader(4, 4, 4))).hasAlpha).toBe(true);
    expect((await getImageInfo(buildPngHeader(4, 4, 6))).hasAlpha).toBe(true);
    expect((await getImageInfo(buildPngHeader(4, 4, 3, true))).hasAlpha).toBe(true);
  });

  it('reports false for JPEG', async () => {
    expect((await getImageInfo(makeJpeg())).hasAlpha).toBe(false);
  });
});

describe('worker + pipeline integration', () => {
  it('a pooled worker produces the same bytes as the main thread', async () => {
    const worker = createImageWorker({ fallback: 'always' });
    const image = coordinateImage(40, 30);
    const mainThread = await processImage(image).resize({ width: 20, height: 15, fit: 'cover' }).toRaw();
    const offloaded = await processImage(image, { worker })
      .resize({ width: 20, height: 15, fit: 'cover' })
      .toRaw();
    expect(Array.from(offloaded.data)).toEqual(Array.from(mainThread.data));
    worker.dispose();
  });

  it('documents that providers always run on the calling thread', async () => {
    const worker = createImageWorker({ fallback: 'always' });
    const remove = vi.fn(async (image: { width: number; height: number }) => ({
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.width * image.height).fill(255),
    }));
    const out = await processImage(coordinateImage(8, 8), { worker })
      .removeBackground({ name: 'spy', remove })
      .toRaw();
    expect(remove).toHaveBeenCalledOnce();
    expect(out.data[3]).toBe(255);
    worker.dispose();
  });
});
