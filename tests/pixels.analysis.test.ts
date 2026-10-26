import { describe, expect, it } from 'vitest';
import {
  averageColor,
  averageHash,
  createImage,
  dominantColors,
  hashDistance,
  histogram,
} from '../src/pixels';
import { coordinateImage } from './fixtures/images';

describe('histogram', () => {
  it('counts channels into 256 bins', () => {
    const img = createImage(3, 1);
    img.data.set([0, 0, 0, 255], 0);
    img.data.set([255, 255, 255, 255], 4);
    img.data.set([128, 128, 128, 128], 8);
    const h = histogram(img);
    expect(h.pixels).toBe(3);
    expect(h.r).toHaveLength(256);
    expect(h.r[0]).toBe(1);
    expect(h.r[255]).toBe(1);
    expect(h.r[128]).toBe(1);
    expect(h.a[255]).toBe(2);
    expect(h.a[128]).toBe(1);
    expect(h.luma[0]).toBe(1);
    expect(h.luma[255]).toBe(1); // the white pixel
    expect(h.luma[128]).toBe(1); // the mid-grey pixel
  });

  it('honours the step option', () => {
    const h = histogram(coordinateImage(4, 4), { step: 2 });
    expect(h.pixels).toBe(8);
  });
});

describe('dominantColors', () => {
  it('separates a two-colour image', () => {
    const img = createImage(4, 4, [0, 0, 0, 255]);
    for (let p = 0; p < 4; p++) img.data.set([255, 0, 0, 255], p * 4);
    // Sorted by pixel count, descending.
    const colors = dominantColors(img, { count: 2, sampleStep: 1 });
    expect(colors).toHaveLength(2);
    expect(colors[0].hex).toBe('#000000');
    expect(colors[0].count).toBe(12);
    expect(colors[0].ratio).toBeCloseTo(12 / 16);
    expect(colors[1].hex).toBe('#ff0000');
    expect(colors[1].count).toBe(4);
  });

  it('never averages an outlier into the majority cluster', () => {
    const img = createImage(10, 10, [0, 0, 0, 255]);
    img.data.set([255, 255, 255, 255], 0);
    const colors = dominantColors(img, { count: 2, sampleStep: 1 });
    expect(colors[0].hex).toBe('#000000');
    expect(colors[1].hex).toBe('#ffffff');
  });

  it('kmeans finds the same two clusters', () => {
    const img = createImage(8, 8, [10, 20, 30, 255]);
    for (let p = 0; p < 32; p++) img.data.set([200, 100, 50, 255], p * 4);
    const colors = dominantColors(img, { count: 2, method: 'kmeans', sampleStep: 1 });
    expect(colors.map((c) => c.hex).sort()).toEqual(['#0a141e', '#c86432']);
  });

  it('ignores transparent pixels and respects count', () => {
    const img = createImage(4, 4, [0, 0, 0, 0]);
    img.data.set([255, 0, 0, 255], 0);
    expect(dominantColors(img, { count: 5, sampleStep: 1 })).toHaveLength(1);
  });

  it('returns an empty array for a fully transparent image', () => {
    expect(dominantColors(createImage(2, 2), { sampleStep: 1 })).toEqual([]);
  });
});

describe('averageColor', () => {
  it('averages visible pixels only', () => {
    const img = createImage(2, 1);
    img.data.set([255, 0, 0, 255], 0);
    img.data.set([0, 0, 255, 0], 4); // transparent -> ignored
    expect(averageColor(img)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('reports zero alpha when nothing is visible', () => {
    expect(averageColor(createImage(2, 2))).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe('averageHash', () => {
  it('produces a stable 64-bit hash with the right shape', () => {
    const img = createImage(16, 16, [0, 0, 0, 255]);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
      }
    }
    const hash = averageHash(img);
    expect(hash.width).toBe(8);
    expect(hash.height).toBe(8);
    expect(hash.bits).toHaveLength(64);
    expect(hash.data).toHaveLength(8);
    expect(hash.hex).toHaveLength(16);
    // Top half bright -> first four rows are 1s.
    expect(hash.bits.slice(0, 8)).toBe('11111111');
    expect(hash.bits.slice(32)).toBe('00000000000000000000000000000000');
  });

  it('distance is 0 for identical images and 64 for inverted ones', () => {
    const a = averageHash(coordinateImage(16, 16));
    const b = averageHash(coordinateImage(16, 16));
    expect(hashDistance(a, b)).toBe(0);
    const darker = createImage(16, 16, [0, 0, 0, 255]);
    expect(hashDistance(averageHash(darker), averageHash(createImage(16, 16, [255, 255, 255, 255])))).toBe(0);
  });

  it('supports custom hash sizes', () => {
    const hash = averageHash(createImage(10, 10, [128, 128, 128, 255]), { width: 4, height: 4 });
    expect(hash.bits).toHaveLength(16);
    expect(hash.data).toHaveLength(2);
  });

  it('rejects absurd sizes', () => {
    expect(() => averageHash(createImage(4, 4), { width: 128, height: 128 })).toThrow(/too large/);
  });
});
