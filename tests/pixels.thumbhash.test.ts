import { describe, expect, it } from 'vitest';
import {
  createImage,
  thumbHash,
  thumbHashAspectRatio,
  thumbHashToAverageColor,
  thumbHashToDataURL,
  thumbHashToImage,
} from '../src/pixels';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function gradient(alpha: boolean) {
  const img = createImage(8, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      img.data.set(
        [Math.floor((x * 255) / 7), Math.floor((y * 255) / 3), 128, alpha && x < 4 ? 0 : 255],
        (y * 8 + x) * 4,
      );
    }
  }
  return img;
}

describe('thumbHash', () => {
  // Expected values come from the reference implementation (npm `thumbhash`).
  it('matches the reference encoder for an opaque image', () => {
    expect(hex(thumbHash(gradient(false)))).toBe('e0f70d44a2818787708877778887817017f888');
  });

  it('matches the reference encoder for an image with alpha', () => {
    expect(hex(thumbHash(gradient(true)))).toBe('268986239058b685c06887b6c067fb73708a8888877878');
  });

  it('downscales images larger than 100x100 and keeps the aspect ratio', () => {
    const wide = thumbHash(createImage(400, 100, [30, 120, 200, 255]));
    expect(wide.length).toBeLessThanOrEqual(25);
    expect(thumbHashAspectRatio(wide)).toBeGreaterThan(2);
    const tall = thumbHash(createImage(50, 300, [30, 120, 200, 255]));
    expect(thumbHashAspectRatio(tall)).toBeLessThan(0.5);
  });

  it('round-trips a solid colour through the average colour and the decoder', () => {
    const hash = thumbHash(createImage(20, 20, [200, 60, 40, 255]));
    const avg = thumbHashToAverageColor(hash);
    expect(Math.abs(avg.r - 200)).toBeLessThanOrEqual(8);
    expect(Math.abs(avg.g - 60)).toBeLessThanOrEqual(8);
    expect(Math.abs(avg.b - 40)).toBeLessThanOrEqual(8);
    expect(avg.a).toBe(255);

    const decoded = thumbHashToImage(hash);
    expect([decoded.width, decoded.height]).toEqual([32, 32]);
    const centre = (16 * 32 + 16) * 4;
    expect(Math.abs(decoded.data[centre] - 200)).toBeLessThanOrEqual(10);
    expect(decoded.data[centre + 3]).toBe(255);
  });

  it('decodes a landscape hash to at most 32px wide', () => {
    const decoded = thumbHashToImage(thumbHash(gradient(false)));
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBeLessThan(32);
  });

  it('keeps transparency', () => {
    const decoded = thumbHashToImage(thumbHash(gradient(true)));
    const row = Math.floor(decoded.height / 2) * decoded.width * 4;
    expect(decoded.data[row + 3]).toBeLessThan(64); // left edge: transparent
    expect(decoded.data[row + (decoded.width - 1) * 4 + 3]).toBeGreaterThan(192);
  });

  it('builds a PNG data URL without a canvas', () => {
    const url = thumbHashToDataURL(thumbHash(gradient(false)));
    expect(url.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(bytes.readUInt32BE(16)).toBe(32);
  });

  it('rejects malformed hashes', () => {
    expect(() => thumbHashToImage(new Uint8Array(2))).toThrow(/at least 5 bytes/);
  });
});
