import { describe, expect, it } from 'vitest';
import {
  applyOrientation,
  crop,
  flip,
  flipX,
  flipY,
  isBlank,
  pad,
  rotate,
  rotate90,
  rotate180,
  rotate270,
  trim,
  trimImage,
  createImage,
} from '../src/pixels';
import { coordinateImage } from './fixtures/images';

/** Builds an image whose pixels are `index * 10` in red, for exact mapping checks. */
function labelled(width: number, height: number) {
  const image = createImage(width, height);
  for (let p = 0; p < width * height; p++) {
    image.data[p * 4] = p * 10;
    image.data[p * 4 + 1] = p;
    image.data[p * 4 + 3] = 255;
  }
  return image;
}

const red = (image: { data: Uint8ClampedArray }, p: number): number => image.data[p * 4];

describe('crop', () => {
  it('extracts an exact rectangle', () => {
    const src = coordinateImage(4, 4);
    const out = crop(src, { x: 1, y: 2, width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    // coordinateImage encodes x*10 in red and y*10 in green.
    expect(Array.from(out.data)).toEqual([
      10, 20, 0, 255, 20, 20, 0, 255,
      10, 30, 0, 255, 20, 30, 0, 255,
    ]);
  });

  it('clamps to the image bounds and pads with transparency', () => {
    const src = coordinateImage(4, 4);
    const out = crop(src, { x: 3, y: 3, width: 4, height: 4 });
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(Array.from(out.data.slice(0, 4))).toEqual([30, 30, 0, 255]);
    expect(Array.from(out.data.slice(4, 8))).toEqual([0, 0, 0, 0]);
  });

  it('defaults width/height to the remaining area', () => {
    const src = coordinateImage(10, 8);
    const out = crop(src, { x: 2, y: 1 });
    expect(out.width).toBe(8);
    expect(out.height).toBe(7);
  });

  it('rejects empty rectangles', () => {
    expect(() => crop(coordinateImage(4, 4), { x: 4, y: 0, width: 0, height: 1 })).toThrow(/positive/);
    expect(() => crop(coordinateImage(4, 4), { x: 10, y: 10, width: 2, height: 2 })).toThrow(/outside the image/);
  });
});

describe('rotations', () => {
  it('rotate90 maps (x,y) -> (h-1-y, x) and swaps dimensions', () => {
    const src = labelled(3, 2); // 6 pixels: 0..5
    const out = rotate90(src);
    expect(out.width).toBe(2);
    expect(out.height).toBe(3);
    // Expected by hand: source index p sits at x=p%3, y=floor(p/3).
    // destination index = (x)*2 + (h-1-y) where h=2 → dstW=2.
    const expected = [
      3, 0, // row 0: (y=1,x=0)=index 3, (y=0,x=0)=index 0
      4, 1,
      5, 2,
    ];
    expect([0, 1, 2, 3, 4, 5].map((p) => red(out, p))).toEqual(expected.map((i) => i * 10));
  });

  it('rotate180 reverses pixel order', () => {
    const out = rotate180(labelled(3, 2));
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect([0, 1, 2, 3, 4, 5].map((p) => red(out, p))).toEqual([50, 40, 30, 20, 10, 0]);
  });

  it('rotate270 is the inverse of rotate90', () => {
    const src = labelled(3, 2);
    const back = rotate270(rotate90(src));
    expect(back.width).toBe(src.width);
    expect(back.height).toBe(src.height);
    expect(Array.from(back.data)).toEqual(Array.from(src.data));
  });

  it('rotate90 four times is the identity', () => {
    const src = coordinateImage(5, 3);
    let out = src;
    for (let i = 0; i < 4; i++) out = rotate90(out);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('rotate() delegates exactly for multiples of 90', () => {
    const src = coordinateImage(5, 3);
    expect(Array.from(rotate(src, 90).data)).toEqual(Array.from(rotate90(src).data));
    expect(Array.from(rotate(src, 180).data)).toEqual(Array.from(rotate180(src).data));
    expect(Array.from(rotate(src, 270).data)).toEqual(Array.from(rotate270(src).data));
    expect(Array.from(rotate(src, -90).data)).toEqual(Array.from(rotate270(src).data));
    expect(Array.from(rotate(src, 360).data)).toEqual(Array.from(src.data));
  });

  it('rotate(45) grows the canvas and fills corners with the background', () => {
    const src = createImage(4, 4, [255, 255, 255, 255]);
    const out = rotate(src, 45, { r: 0, g: 0, b: 0, a: 255 });
    expect(out.width).toBeGreaterThan(4);
    expect(out.height).toBeGreaterThan(4);
    // Top-left corner is outside the rotated square -> black background.
    expect(Array.from(out.data.slice(0, 4))).toEqual([0, 0, 0, 255]);
    // The centre is still white.
    const centre = (Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2)) * 4;
    expect(Array.from(out.data.slice(centre, centre + 4))).toEqual([255, 255, 255, 255]);
  });

  it('rotate(45) with a transparent background keeps the corners transparent', () => {
    const out = rotate(createImage(4, 4, [10, 20, 30, 255]), 45);
    expect(out.data[3]).toBe(0);
  });
});

describe('flip', () => {
  it('flipX mirrors columns, flipY mirrors rows', () => {
    const src = labelled(3, 2);
    expect([0, 1, 2, 3, 4, 5].map((p) => red(flipX(src), p))).toEqual([20, 10, 0, 50, 40, 30]);
    expect([0, 1, 2, 3, 4, 5].map((p) => red(flipY(src), p))).toEqual([30, 40, 50, 0, 10, 20]);
    expect(Array.from(flip(flipX(src), 'x').data)).toEqual(Array.from(src.data));
  });

  it('rejects unknown axes', () => {
    expect(() => flip(coordinateImage(2, 2), 'z' as 'x')).toThrow(/unknown axis/);
  });
});

describe('EXIF orientation', () => {
  const src = labelled(3, 2);

  it('orientation 1 is the identity', () => {
    expect(Array.from(applyOrientation(src, 1).data)).toEqual(Array.from(src.data));
  });

  it('orientation 3 == rotate180, 2 == flipX, 4 == flipY', () => {
    expect(Array.from(applyOrientation(src, 2).data)).toEqual(Array.from(flipX(src).data));
    expect(Array.from(applyOrientation(src, 3).data)).toEqual(Array.from(rotate180(src).data));
    expect(Array.from(applyOrientation(src, 4).data)).toEqual(Array.from(flipY(src).data));
  });

  it('orientations 5-8 swap the dimensions and match their definitions', () => {
    for (const orientation of [5, 6, 7, 8]) {
      const out = applyOrientation(src, orientation);
      expect(out.width).toBe(src.height);
      expect(out.height).toBe(src.width);
    }
    // 5 = transpose (flip across the main diagonal), 7 = transverse.
    expect(Array.from(applyOrientation(src, 5).data)).toEqual(Array.from(rotate270(flipX(src)).data));
    expect(Array.from(applyOrientation(src, 6).data)).toEqual(Array.from(rotate90(src).data));
    expect(Array.from(applyOrientation(src, 7).data)).toEqual(Array.from(rotate90(flipX(src)).data));
    expect(Array.from(applyOrientation(src, 8).data)).toEqual(Array.from(rotate270(src).data));
  });

  it('5 is the transpose and 7 is the transverse mapping', () => {
    // 3x2 labelled image: red channel = index*10.
    const out5 = applyOrientation(src, 5);
    expect(out5.width).toBe(2);
    expect(out5.height).toBe(3);
    // (x, y) -> (y, x): source index y*3+x lands at destination x*2+y.
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        expect(red(out5, x * 2 + y)).toBe((y * 3 + x) * 10);
      }
    }
    const out7 = applyOrientation(src, 7);
    // (x, y) -> (h-1-y, w-1-x) with w=3, h=2.
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        const dx = 1 - y;
        const dy = 2 - x;
        expect(red(out7, dy * 2 + dx)).toBe((y * 3 + x) * 10);
      }
    }
  });

  it('applying orientation twice for 6/8 undoes the rotation', () => {
    const twice = applyOrientation(applyOrientation(src, 6), 6);
    expect(Array.from(twice.data)).toEqual(Array.from(rotate180(src).data));
  });

  it('rejects out-of-range values', () => {
    expect(() => applyOrientation(src, 0)).toThrow(/1\.\.8/);
    expect(() => applyOrientation(src, 9)).toThrow(/1\.\.8/);
  });
});

describe('pad / trim', () => {
  it('colour trim without a colour uses the top-left pixel as background', () => {
    const src = createImage(4, 3, [255, 255, 255, 255]);
    src.data.set([200, 10, 10, 255], (1 * 4 + 2) * 4); // one red pixel at (2,1)
    expect(trim(src, { alpha: false })).toEqual({ x: 2, y: 1, width: 1, height: 1 });
  });

  it('pad adds a border on each side', () => {
    const src = coordinateImage(2, 2);
    const out = pad(src, 1, { r: 9, g: 8, b: 7, a: 255 });
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(Array.from(out.data.slice(0, 4))).toEqual([9, 8, 7, 255]);
    // Original top-left now sits at (1,1).
    const i = (1 * 4 + 1) * 4;
    expect(Array.from(out.data.slice(i, i + 4))).toEqual([0, 0, 0, 255]);
  });

  it('pad supports per-side padding', () => {
    const out = pad(coordinateImage(2, 2), { top: 1, bottom: 2, left: 3, right: 4 });
    expect(out.width).toBe(2 + 3 + 4);
    expect(out.height).toBe(2 + 1 + 2);
  });

  it('rejects negative padding', () => {
    expect(() => pad(coordinateImage(2, 2), -1)).toThrow(/non-negative/);
  });

  it('trim finds the non-transparent bounding box', () => {
    const src = createImage(6, 6);
    // A 2x3 block at (2,1).
    for (let y = 1; y < 4; y++) {
      for (let x = 2; x < 4; x++) {
        const i = (y * 6 + x) * 4;
        src.data[i] = 255;
        src.data[i + 3] = 255;
      }
    }
    expect(trim(src)).toEqual({ x: 2, y: 1, width: 2, height: 3 });
    const trimmed = trimImage(src);
    expect(trimmed.width).toBe(2);
    expect(trimmed.height).toBe(3);
  });

  it('trim by colour with a threshold', () => {
    const src = createImage(5, 5, [255, 255, 255, 255]);
    const i = (2 * 5 + 2) * 4;
    src.data[i] = 0;
    src.data[i + 1] = 0;
    src.data[i + 2] = 0;
    expect(trim(src, { color: { r: 255, g: 255, b: 255 }, threshold: 10 })).toEqual({
      x: 2,
      y: 2,
      width: 1,
      height: 1,
    });
    // A tiny threshold difference does not change a near-white image.
    const nearWhite = createImage(3, 3, [250, 250, 250, 255]);
    expect(trim(nearWhite, { color: { r: 255, g: 255, b: 255 }, threshold: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 3,
      height: 3,
    });
  });

  it('returns the full size when everything is background', () => {
    const blank = createImage(4, 3);
    expect(trim(blank)).toEqual({ x: 0, y: 0, width: 4, height: 3 });
    expect(isBlank(blank)).toBe(true);
    expect(isBlank(coordinateImage(2, 2))).toBe(false);
  });
});
