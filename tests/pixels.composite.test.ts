import { describe, expect, it } from 'vitest';
import {
  applyAlphaMask,
  composite,
  createImage,
  createMask,
  flatten,
  maskToImage,
  setAlphaMask,
  toMask,
} from '../src/pixels';

const px = (img: { data: Uint8ClampedArray }, p: number): number[] =>
  Array.from(img.data.slice(p * 4, p * 4 + 4));

describe('composite', () => {
  it('source-over blending of a half-transparent white on black', () => {
    const target = createImage(1, 1, [0, 0, 0, 255]);
    const source = createImage(1, 1, [255, 255, 255, 128]);
    const out = composite(target, source);
    // 0.502*255 + 0*(1-0.502) = 128
    expect(px(out, 0)).toEqual([128, 128, 128, 255]);
  });

  it('opaque source replaces the target entirely', () => {
    const target = createImage(1, 1, [10, 20, 30, 255]);
    const source = createImage(1, 1, [200, 100, 50, 255]);
    expect(px(composite(target, source), 0)).toEqual([200, 100, 50, 255]);
  });

  it('compositing onto a transparent target keeps the source colour', () => {
    const target = createImage(1, 1, [0, 0, 0, 0]);
    const source = createImage(1, 1, [200, 100, 50, 255]);
    expect(px(composite(target, source), 0)).toEqual([200, 100, 50, 255]);
  });

  it('respects the x/y offset and clips outside the target', () => {
    const target = createImage(4, 4, [0, 0, 0, 255]);
    const source = createImage(2, 2, [255, 0, 0, 255]);
    const out = composite(target, source, { x: 2, y: 3 });
    expect(px(out, 3 * 4 + 2)).toEqual([255, 0, 0, 255]);
    expect(px(out, 3 * 4 + 3)).toEqual([255, 0, 0, 255]);
    expect(px(out, 3 * 4 + 1)).toEqual([0, 0, 0, 255]);
    // The top half of the target is untouched (the source starts at y=3).
    expect(px(out, 0)).toEqual([0, 0, 0, 255]);
    // Fully outside (y=4) is a no-op.
    const outside = composite(target, source, { x: 10, y: 10 });
    expect(Array.from(outside.data)).toEqual(Array.from(target.data));
  });

  it('opacity scales the source alpha', () => {
    const target = createImage(1, 1, [0, 0, 0, 255]);
    const source = createImage(1, 1, [255, 255, 255, 255]);
    const out = composite(target, source, { opacity: 0.5 });
    expect(px(out, 0)[0]).toBeGreaterThanOrEqual(127);
    expect(px(out, 0)[0]).toBeLessThanOrEqual(128);
  });

  it('multiply and screen blend modes match their formulas', () => {
    const target = createImage(1, 1, [128, 100, 50, 255]);
    const source = createImage(1, 1, [200, 100, 50, 255]);
    const multiply = px(composite(target, source, { blendMode: 'multiply' }), 0);
    // 0.502 * 0.784 = 0.394 -> 100
    expect(multiply[0]).toBe(100);
    expect(multiply[1]).toBe(39); // 0.392*0.392 = 0.153 -> 39
    const screen = px(composite(target, source, { blendMode: 'screen' }), 0);
    // 0.502 + 0.784 - 0.394 = 0.8926 -> 227.6 -> rounds to 228
    expect(screen[0]).toBe(228);
  });

  it('normal blend matches a fully opaque source-over', () => {
    const target = createImage(1, 1, [10, 20, 30, 255]);
    const source = createImage(1, 1, [10, 20, 30, 255]);
    expect(px(composite(target, source, { blendMode: 'normal' }), 0)).toEqual([10, 20, 30, 255]);
  });

  it('does not bleed the colour of a transparent backdrop into the result', () => {
    const target = createImage(1, 1, [255, 0, 0, 0]);
    const source = createImage(1, 1, [0, 0, 255, 128]);
    for (const blendMode of ['normal', 'multiply', 'screen'] as const) {
      expect(px(composite(target, source, { blendMode }), 0)).toEqual([0, 0, 255, 128]);
    }
  });

  it('weights the backdrop by its alpha (semi-transparent source-over)', () => {
    // a = 128/255 ≈ 0.502 for both; source-over alpha = 0.502 + 0.502 * 0.498 ≈ 0.752 (192),
    // r = 255 * 0.502 * 0.498 / 0.752 ≈ 85, b = 255 * 0.502 / 0.752 ≈ 170.
    const target = createImage(1, 1, [255, 0, 0, 128]);
    const source = createImage(1, 1, [0, 0, 255, 128]);
    expect(px(composite(target, source), 0)).toEqual([85, 0, 170, 192]);
  });

  it('rejects malformed images', () => {
    expect(() => composite(createImage(2, 2), { width: 2, height: 2, data: new Uint8ClampedArray(2) })).toThrow(
      /does not match/,
    );
  });
});

describe('alpha masks', () => {
  it('applyAlphaMask multiplies the alpha channel', () => {
    const img = createImage(2, 1, [255, 0, 0, 255]);
    const mask = createMask(2, 1);
    mask.data[0] = 255;
    mask.data[1] = 0;
    const out = applyAlphaMask(img, mask);
    expect(out.data[3]).toBe(255);
    expect(out.data[7]).toBe(0);
    expect(out.data[4]).toBe(255);
  });

  it('applyAlphaMask accepts an RGBA image as the mask source', () => {
    const img = createImage(1, 1, [255, 0, 0, 255]);
    const maskImage = createImage(1, 1, [0, 0, 0, 64]);
    expect(applyAlphaMask(img, maskImage).data[3]).toBe(64);
  });

  it('setAlphaMask replaces alpha and supports inversion', () => {
    const img = createImage(2, 1, [255, 0, 0, 200]);
    const mask = createMask(2, 1);
    mask.data.set([10, 20]);
    expect(Array.from(setAlphaMask(img, mask).data.filter((_, i) => i % 4 === 3))).toEqual([10, 20]);
    expect(Array.from(setAlphaMask(img, mask, true).data.filter((_, i) => i % 4 === 3))).toEqual([245, 235]);
  });

  it('scales a mismatched mask to the image size', () => {
    const img = createImage(4, 4, [0, 0, 0, 255]);
    const mask = createMask(1, 1, 0);
    const out = applyAlphaMask(img, mask);
    expect(out.data[3]).toBe(0);
    expect(out.data[out.data.length - 1]).toBe(0);
  });

  it('toMask and maskToImage round-trip', () => {
    const mask = createMask(2, 1);
    mask.data.set([0, 255]);
    const asImage = maskToImage(mask);
    // White RGB, mask in alpha: 0 -> invisible, 255 -> opaque.
    expect(Array.from(asImage.data)).toEqual([255, 255, 255, 0, 255, 255, 255, 255]);
    const back = toMask(asImage);
    expect(Array.from(back.data)).toEqual([0, 255]);
  });

  it('flatten composites onto a solid background', () => {
    const img = createImage(1, 1, [0, 0, 0, 0]);
    const out = flatten(img, { r: 255, g: 255, b: 255 });
    expect(px(out, 0)).toEqual([255, 255, 255, 255]);
  });
});
