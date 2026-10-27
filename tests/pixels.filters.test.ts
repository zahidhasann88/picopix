import { describe, expect, it } from 'vitest';
import {
  blur,
  brightness,
  contrast,
  createImage,
  filter,
  grayscale,
  invert,
  saturate,
  sharpen,
  threshold,
} from '../src/pixels';
import { executeOps } from '../src/worker/execute';

function image(pixels: number[][], width: number, height: number) {
  const out = createImage(width, height);
  pixels.forEach((p, i) => out.data.set(p, i * 4));
  return out;
}

const first = (img: { data: Uint8ClampedArray }): number[] => Array.from(img.data.slice(0, 4));

describe('per-pixel filters', () => {
  it('grayscale uses Rec.601 luma and preserves alpha', () => {
    const src = image([[255, 0, 0, 255]], 1, 1);
    expect(first(grayscale(src))).toEqual([76, 76, 76, 255].map((v, i) => (i === 3 ? 255 : Math.round(0.299 * 255))));
    const green = image([[0, 255, 0, 128]], 1, 1);
    expect(first(grayscale(green))).toEqual([150, 150, 150, 128]);
  });

  it('grayscale amount is interpolated', () => {
    const src = image([[255, 0, 0, 255]], 1, 1);
    expect(first(grayscale(src, 0))).toEqual([255, 0, 0, 255]);
    const half = first(grayscale(src, 0.5));
    expect(half[0]).toBeGreaterThan(76);
    expect(half[0]).toBeLessThan(255);
    expect(half[3]).toBe(255);
  });

  it('brightness multiplies channels and clamps', () => {
    const src = image([[100, 50, 200, 255]], 1, 1);
    expect(first(brightness(src, 2))).toEqual([200, 100, 255, 255]);
    expect(first(brightness(src, 0))).toEqual([0, 0, 0, 255]);
    expect(first(brightness(src, 1))).toEqual([100, 50, 200, 255]);
  });

  it('contrast pivots around 128', () => {
    const src = image([[128, 128, 128, 255]], 1, 1);
    expect(first(contrast(src, 3))).toEqual([128, 128, 128, 255]);
    const lighter = image([[200, 200, 200, 255]], 1, 1);
    // 200*2 + 128*(1-2) = 272 -> clamped to 255
    expect(first(contrast(lighter, 2))).toEqual([255, 255, 255, 255]);
    // 200*0.5 + 64 = 164
    expect(first(contrast(lighter, 0.5))).toEqual([164, 164, 164, 255]);
    // 0.5 -> mid grey
    const grey = image([[0, 0, 0, 255]], 1, 1);
    expect(first(contrast(grey, 0))).toEqual([128, 128, 128, 255]);
  });

  it('saturate(0) equals grayscale and saturate(1) is the identity', () => {
    const src = image([[200, 30, 90, 255]], 1, 1);
    const desaturated = first(saturate(src, 0));
    const grey = first(grayscale(src));
    expect(desaturated.map(Math.round)).toEqual(grey);
    expect(first(saturate(src, 1))).toEqual([200, 30, 90, 255]);
  });

  it('saturate > 1 pushes colours away from luma', () => {
    const src = image([[200, 30, 90, 255]], 1, 1);
    const out = first(saturate(src, 2));
    expect(out[0]).toBeGreaterThan(200);
    expect(out[1]).toBeLessThan(30);
  });

  it('invert flips RGB only', () => {
    expect(first(invert(image([[10, 20, 30, 77]], 1, 1)))).toEqual([245, 235, 225, 77]);
  });

  it('threshold binarises on luma', () => {
    const dark = image([[10, 10, 10, 5]], 1, 1);
    const bright = image([[250, 250, 250, 5]], 1, 1);
    expect(first(threshold(dark, 128))).toEqual([0, 0, 0, 5]);
    expect(first(threshold(bright, 128))).toEqual([255, 255, 255, 5]);
    expect(first(threshold(bright, 300))).toEqual([0, 0, 0, 5]);
  });

  it('filter() dispatches by name and by spec', () => {
    const src = image([[100, 50, 200, 255]], 1, 1);
    expect(first(filter(src, 'invert'))).toEqual(first(invert(src)));
    expect(first(filter(src, { type: 'brightness', amount: 2 }))).toEqual(first(brightness(src, 2)));
    expect(() => filter(src, 'nope' as 'invert')).toThrow(/unknown filter/);
  });

  it('rejects non-finite amounts', () => {
    const src = image([[1, 2, 3, 4]], 1, 1);
    expect(() => brightness(src, Number.NaN)).toThrow(/finite/);
    expect(() => contrast(src, Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe('blur', () => {
  it('box blur of a 2px image matches the edge-clamped window average', () => {
    const src = image([[255, 0, 0, 255], [0, 0, 255, 255]], 2, 1);
    const out = blur(src, { radius: 1, type: 'box' });
    // Window of 3 (edge clamped) -> red: (255+255+0)/3 = 170, blue: (0+0+255)/3 = 85
    expect(Array.from(out.data.slice(0, 4))).toEqual([170, 0, 85, 255]);
    expect(Array.from(out.data.slice(4, 8))).toEqual([85, 0, 170, 255]);
  });

  it('radius 0 is a no-op copy', () => {
    const src = image([[1, 2, 3, 4]], 1, 1);
    const out = blur(src, 0);
    expect(Array.from(out.data)).toEqual([1, 2, 3, 4]);
    expect(out.data).not.toBe(src.data);
  });

  it('gaussian blur of a constant image stays constant', () => {
    const src = createImage(9, 7, [40, 80, 120, 255]);
    const out = blur(src, { radius: 3 });
    for (let i = 0; i < out.data.length; i += 4) {
      expect(Array.from(out.data.slice(i, i + 4))).toEqual([40, 80, 120, 255]);
    }
  });

  it('gaussian blur spreads a single bright pixel', () => {
    const src = createImage(9, 9);
    const centre = (4 * 9 + 4) * 4;
    src.data.set([255, 255, 255, 255], centre);
    const out = blur(src, { radius: 2, type: 'gaussian' });
    const neighbour = (4 * 9 + 5) * 4;
    expect(out.data[neighbour + 3]).toBeGreaterThan(0);
    expect(out.data[neighbour + 3]).toBeLessThan(255);
    expect(out.data[centre + 3]).toBeLessThan(255);
  });

  it('does not bleed colour out of transparent pixels', () => {
    const src = createImage(3, 1);
    src.data.set([255, 0, 0, 0], 0); // transparent red
    src.data.set([0, 0, 255, 255], 8); // opaque blue
    const out = blur(src, { radius: 1, type: 'box' });
    expect(out.data[3]).toBe(0);
    expect(out.data[8]).toBe(0);
    expect(out.data[10]).toBe(255);
  });

  it('rejects negative radii', () => {
    expect(() => blur(createImage(2, 2), -2)).toThrow(/radius/);
  });
});

describe('sharpen', () => {
  const edge = () =>
    image(
      [
        [50, 50, 50, 255],
        [50, 50, 50, 255],
        [50, 50, 50, 255],
        [200, 200, 200, 255],
        [200, 200, 200, 255],
        [200, 200, 200, 255],
      ],
      6,
      1,
    );

  it('increases contrast across an edge', () => {
    const out = sharpen(edge(), { amount: 1, radius: 1 });
    expect(out.data[2 * 4]).toBeLessThan(50);
    expect(out.data[3 * 4]).toBeGreaterThan(200);
    expect(out.data[2 * 4 + 3]).toBe(255);
  });

  it('leaves flat areas and amount 0 unchanged', () => {
    const flat = createImage(5, 5, [90, 120, 30, 255]);
    expect(Array.from(sharpen(flat).data)).toEqual(Array.from(flat.data));
    expect(Array.from(sharpen(edge(), 0).data)).toEqual(Array.from(edge().data));
  });

  it('skips differences below the threshold', () => {
    const out = sharpen(edge(), { amount: 1, radius: 1, threshold: 255 });
    expect(Array.from(out.data)).toEqual(Array.from(edge().data));
  });

  it('keeps alpha and does not touch fully transparent pixels', () => {
    const img = edge();
    img.data[3] = 0;
    img.data[4 * 4 + 3] = 128;
    const out = sharpen(img, 2);
    expect(out.data[3]).toBe(0);
    expect(Array.from(out.data.slice(0, 3))).toEqual([50, 50, 50]);
    expect(out.data[4 * 4 + 3]).toBe(128);
  });

  it('rejects negative options', () => {
    expect(() => sharpen(edge(), { amount: -1 })).toThrow(/amount/);
    expect(() => sharpen(edge(), { radius: -1 })).toThrow(/radius/);
  });

  it('runs as a worker op', () => {
    const viaOp = executeOps(edge(), [{ op: 'sharpen', amount: 1, radius: 1 }]);
    expect(Array.from(viaOp.data)).toEqual(Array.from(sharpen(edge(), { amount: 1, radius: 1 }).data));
  });
});
