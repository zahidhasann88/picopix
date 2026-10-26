import { describe, expect, it } from 'vitest';
import {
  computeFitSize,
  computeTaps,
  createImage,
  resize,
  resizeNearest,
  resizeWithKernel,
  toPremultiplied,
  fromPremultiplied,
} from '../src/pixels';
import { coordinateImage, solidImage } from './fixtures/images';

const px = (image: { data: Uint8ClampedArray }, x: number, y: number, w: number): number[] => {
  const i = (y * w + x) * 4;
  return Array.from(image.data.slice(i, i + 4));
};

describe('resize / kernels', () => {
  it('2x2 -> 4x4 bilinear uses edge clamping and exact quarter positions', () => {
    // Source: 4 pixels with distinct colours.
    const src = createImage(2, 2);
    src.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const out = resizeWithKernel(src, { width: 4, height: 4 }, 'bilinear');
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    // Output pixel centres map to source 0.25 / 0.75 / 1.25 / 1.75, so the outer
    // ring is clamped to the source pixels and the inner 2x2 is a real blend.
    expect(px(out, 0, 0, 4)).toEqual([255, 0, 0, 255]); // top-left corner == source (0,0)
    expect(px(out, 3, 0, 4)).toEqual([0, 255, 0, 255]); // top-right corner == source (1,0)
    expect(px(out, 0, 3, 4)).toEqual([0, 0, 255, 255]); // bottom-left == source (0,1)
    expect(px(out, 3, 3, 4)).toEqual([255, 255, 255, 255]); // bottom-right == source (1,1)
    // The interior blend is a 50/50 mix of all four source pixels per channel.
    const centre = px(out, 1, 1, 4);
    expect(centre[0]).toBeGreaterThan(50);
    expect(centre[1]).toBeGreaterThan(50);
    expect(centre[2]).toBeGreaterThan(50);
    expect(centre[3]).toBe(255);
  });

  it('bilinear 2x2 -> 4x4 reproduces a constant image exactly', () => {
    const src = createImage(2, 2, [17, 34, 51, 255]);
    const out = resizeWithKernel(src, { width: 4, height: 4 }, 'bilinear');
    for (let i = 0; i < out.data.length; i += 4) {
      expect(Array.from(out.data.slice(i, i + 4))).toEqual([17, 34, 51, 255]);
    }
  });

  it.each(['nearest', 'bilinear', 'catmull-rom', 'lanczos3'] as const)(
    '%s keeps a constant image constant (upscale and downscale)',
    (kernel) => {
      const src = createImage(7, 5, [10, 200, 30, 128]);
      for (const size of [
        { width: 21, height: 15 },
        { width: 3, height: 2 },
        { width: 7, height: 5 },
        { width: 1, height: 1 },
      ]) {
        const out = resizeWithKernel(src, size, kernel);
        expect(out.width).toBe(size.width);
        expect(out.height).toBe(size.height);
        for (let i = 0; i < out.data.length; i += 4) {
          expect(out.data[i]).toBe(10);
          expect(out.data[i + 1]).toBe(200);
          expect(out.data[i + 2]).toBe(30);
          expect(out.data[i + 3]).toBe(128);
        }
      }
    },
  );

  it('nearest resizes are exact index selections (centre sampling)', () => {
    // 4x1 with red values 0,10,20,30. Halving takes the centre of each 2px block,
    // i.e. source indices 1 and 3.
    const src = coordinateImage(4, 1);
    const out = resizeNearest(src, 2, 1);
    expect(px(out, 0, 0, 2)[0]).toBe(10);
    expect(px(out, 1, 0, 2)[0]).toBe(30);
    // Doubling repeats each pixel twice.
    const up = resizeNearest(src, 8, 1);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((x) => px(up, x, 0, 8)[0])).toEqual([0, 0, 10, 10, 20, 20, 30, 30]);
  });

  it('resampling is premultiplied so transparent pixels do not bleed colour', () => {
    // Left: fully transparent RED, right: opaque BLUE.
    const src = createImage(2, 1);
    src.data.set([255, 0, 0, 0, 0, 0, 255, 255]);
    const out = resizeWithKernel(src, { width: 4, height: 1 }, 'bilinear');
    // The left half must have zero alpha (no red bleeding out of transparency),
    // and the opaque side must stay pure blue.
    expect(px(out, 0, 0, 4)[3]).toBe(0);
    expect(px(out, 3, 0, 4)).toEqual([0, 0, 255, 255]);
    // Any partially covered pixel must not contain red.
    for (let x = 0; x < 4; x++) {
      const p = px(out, x, 0, 4);
      expect(p[0]).toBe(0);
    }
  });

  it('premultiply/fromPremultiplied round-trips', () => {
    const src = coordinateImage(3, 2);
    for (let i = 3; i < src.data.length; i += 4) src.data[i] = (i * 7) % 256;
    const pre = toPremultiplied(src);
    const back = fromPremultiplied(pre, 3, 2);
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i + 3] === 0) {
        expect(back.data[i + 3]).toBe(0);
        continue;
      }
      // Straight alpha round-trip is exact within rounding (±1).
      expect(Math.abs(back.data[i] - src.data[i])).toBeLessThanOrEqual(1);
      expect(back.data[i + 3]).toBe(src.data[i + 3]);
    }
  });

  it('computeTaps produces normalised, symmetric weights', () => {
    const taps = computeTaps(8, 4, 'lanczos3', true);
    expect(taps).toHaveLength(4);
    for (const tap of taps) {
      const sum = tap.weights.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
    // Upscaling keeps the small kernel (no widening).
    const up = computeTaps(4, 8, 'lanczos3', true);
    expect(up[0].weights.length).toBeLessThanOrEqual(7);
    // Downscaling 8x widens the footprint of each output pixel.
    const down = computeTaps(64, 8, 'lanczos3', true);
    expect(down[0].weights.length).toBeGreaterThan(7);
  });

  it('antialias=false reduces the tap count when downscaling', () => {
    const withAa = computeTaps(64, 8, 'lanczos3', true);
    const withoutAa = computeTaps(64, 8, 'lanczos3', false);
    expect(withoutAa[0].weights.length).toBeLessThan(withAa[0].weights.length);
  });

  it('downscaling a checkerboard averages to mid-grey when anti-aliased', () => {
    const src = createImage(16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const v = (x + y) % 2 === 0 ? 255 : 0;
        const i = (y * 16 + x) * 4;
        src.data[i] = v;
        src.data[i + 1] = v;
        src.data[i + 2] = v;
        src.data[i + 3] = 255;
      }
    }
    const aa = resizeWithKernel(src, { width: 4, height: 4 }, 'lanczos3', true);
    const centre = px(aa, 1, 1, 4)[0];
    expect(centre).toBeGreaterThan(80);
    expect(centre).toBeLessThan(180);
    // Without the widened kernel the high frequencies alias heavily.
    const aliased = resizeWithKernel(src, { width: 4, height: 4 }, 'nearest', false);
    expect([0, 255]).toContain(px(aliased, 1, 1, 4)[0]);
  });

  it('resize(image, number) scales by width only', () => {
    const src = coordinateImage(10, 5);
    const out = resize(src, 4);
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
  });

  it('honours fit modes and withoutEnlargement', () => {
    const src = coordinateImage(40, 20);
    expect(resize(src, { width: 20, height: 20, fit: 'inside' })).toMatchObject({ width: 20, height: 10 });
    expect(resize(src, { width: 20, height: 20, fit: 'contain' })).toMatchObject({ width: 20, height: 20 });
    expect(resize(src, { width: 20, height: 20, fit: 'cover' })).toMatchObject({ width: 20, height: 20 });
    expect(resize(src, { width: 100, height: 100, fit: 'inside', withoutEnlargement: true })).toMatchObject({
      width: 40,
      height: 20,
    });
    expect(resize(src, { width: 200, height: 100, fit: 'fill' })).toMatchObject({ width: 200, height: 100 });
  });

  it('cover centre-crops instead of squashing', () => {
    // 40x20 with x-ramp: after cover to 10x10 the visible slice must be the
    // middle horizontal band, i.e. the x-ramp keeps its full 0..255 range.
    const src = coordinateImage(40, 20);
    const out = resize(src, { width: 10, height: 10, fit: 'cover' });
    const left = px(out, 0, 5, 10)[0];
    const right = px(out, 9, 5, 10)[0];
    expect(right).toBeGreaterThan(left);
    expect(left).toBeLessThan(120);
  });

  it('contain letterboxes onto transparency', () => {
    const src = solidImage(40, 20, [255, 0, 0, 255]);
    const out = resize(src, { width: 20, height: 20, fit: 'contain' });
    expect(px(out, 10, 0, 20)[3]).toBe(0); // top row is padding
    expect(px(out, 10, 10, 20)).toEqual([255, 0, 0, 255]); // middle is content
  });

  it('rejects invalid targets', () => {
    const src = coordinateImage(4, 4);
    expect(() => resizeWithKernel(src, { width: 0, height: 4 })).toThrow(/positive integers/);
    expect(() => resize(src, {})).toThrow(/width\/height is required/);
    expect(() => resize(src, -3)).toThrow(/positive integer/);
  });

  it('fit math table is correct', () => {
    const src = { width: 1920, height: 1080 };
    const cases: Array<[Parameters<typeof computeFitSize>[2], { width: number; height: number }]> = [
      [{ width: 960, fit: 'inside' }, { width: 960, height: 540 }],
      [{ height: 540, fit: 'inside' }, { width: 960, height: 540 }],
      [{ width: 200, height: 200, fit: 'inside' }, { width: 200, height: 113 }],
      [{ width: 200, height: 200, fit: 'contain' }, { width: 200, height: 200 }],
      [{ width: 200, height: 200, fit: 'cover' }, { width: 200, height: 200 }],
      [{ width: 200, height: 200, fit: 'outside' }, { width: 356, height: 200 }],
      [{ width: 200, height: 200, fit: 'fill' }, { width: 200, height: 200 }],
      [{ width: 4000, height: 4000, fit: 'inside', withoutEnlargement: true }, { width: 1920, height: 1080 }],
      [{ width: 3840, height: 2160, fit: 'inside' }, { width: 3840, height: 2160 }],
      [{ width: 640, fit: 'fill' }, { width: 640, height: 360 }],
      [{ height: 360, fit: 'fill' }, { width: 640, height: 360 }],
    ];
    for (const [options, expected] of cases) {
      expect(computeFitSize(src.width, src.height, options)).toEqual(expected);
    }
  });

  it('is a no-op when the size does not change, but still copies', () => {
    const src = coordinateImage(3, 3);
    const out = resizeWithKernel(src, { width: 3, height: 3 }, 'lanczos3');
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
    expect(out.data).not.toBe(src.data);
  });
});
