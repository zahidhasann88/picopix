import { invalidArgument, throwIfAborted } from '../errors';
import type { MaskImage, RawImage, RGBA } from '../types';
import { assertImage, createMask, normalizeColor } from '../pixels/util';
import type { BackgroundRemovalProvider } from './types';

export interface ChromaKeyOptions {
  /** The background colour to remove. Default green `#00b140`. */
  color?: RGBA | [number, number, number] | string;
  /** Colour distance (0..255) fully treated as background. Default `40`. */
  tolerance?: number;
  /** Extra distance over which alpha ramps from 0 to 255. Default `20`. */
  feather?: number;
  /**
   * Compare in YCbCr chroma space instead of RGB. This is much more forgiving of
   * shadows/lighting variation on a green screen. Default `true`.
   */
  chromaSpace?: boolean;
  /** Optional: also desaturate green fringes. Default `false` (mask only). */
  spillSuppression?: boolean;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  green: [0, 177, 64],
  chroma: [0, 177, 64],
  blue: [0, 71, 187],
  white: [255, 255, 255],
  black: [0, 0, 0],
};

/** Parses `'#00b140'`, `'#0b0'`, a named colour or an `RGBA` object into `[r,g,b]`. */
export function parseColor(
  color: RGBA | [number, number, number] | string | undefined,
  fallback: [number, number, number] = [0, 177, 64],
): [number, number, number] {
  if (color === undefined) return fallback;
  if (typeof color === 'string') {
    const key = color.toLowerCase();
    if (NAMED_COLORS[key]) return NAMED_COLORS[key];
    const hex = key.replace(/^#/, '');
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
    throw invalidArgument(`parseColor: cannot parse colour '${color}'`);
  }
  if (Array.isArray(color)) return [color[0], color[1], color[2]];
  return [color.r, color.g, color.b];
}

/** Squared RGB distance, normalised to `0..255` (i.e. `sqrt` of the mean square). */
function rgbDistance(r: number, g: number, b: number, kr: number, kg: number, kb: number): number {
  const dr = r - kr;
  const dg = g - kg;
  const db = b - kb;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/** YCbCr chroma-plane distance (luma is ignored, so shading does not matter). */
function chromaDistance(r: number, g: number, b: number, kr: number, kg: number, kb: number): number {
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
  const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
  const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const dcb = cb - kcb;
  const dcr = cr - kcr;
  return Math.sqrt(dcb * dcb + dcr * dcr);
}

/**
 * Builds the coverage mask for a chroma key.
 *
 * Pixels within `tolerance` of the key colour get alpha `0`, pixels beyond
 * `tolerance + feather` get `255`, and the band in between is a smooth ramp —
 * which is what keeps hair and motion-blurred edges from looking cut out.
 */
export function chromaKeyMask(image: RawImage, options: ChromaKeyOptions = {}): MaskImage {
  assertImage(image);
  const key = parseColor(options.color, [0, 177, 64]);
  const tolerance = options.tolerance ?? 40;
  const feather = Math.max(0, options.feather ?? 20);
  const useChroma = options.chromaSpace ?? true;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw invalidArgument('chromaKey: tolerance must be a non-negative number');
  }
  const distance = useChroma ? chromaDistance : rgbDistance;
  const mask = createMask(image.width, image.height);
  const d = image.data;
  for (let p = 0, i = 0; p < mask.data.length; p++, i += 4) {
    const dist = distance(d[i], d[i + 1], d[i + 2], key[0], key[1], key[2]);
    let alpha: number;
    if (dist <= tolerance) alpha = 0;
    else if (feather === 0 || dist >= tolerance + feather) alpha = 255;
    else {
      const t = (dist - tolerance) / feather;
      alpha = 255 * (t * t * (3 - 2 * t)); // smoothstep
    }
    // Respect the source alpha: a transparent pixel stays transparent.
    mask.data[p] = (alpha * d[i + 3]) / 255;
  }
  return mask;
}

/**
 * A **model-free** {@link BackgroundRemovalProvider} that keys out a solid
 * background colour (green screen, flat studio backdrop, white paper scan).
 *
 * Fully implemented and tested inside this library — no ML, no downloads, runs
 * anywhere (including inside a Web Worker, if you re-create the provider there).
 *
 * ```ts
 * const provider = chromaKeyProvider({ color: '#00b140', tolerance: 45, feather: 12 });
 * const out = await processImage(file).removeBackground(provider).toRaw();
 * ```
 */
export function chromaKeyProvider(options: ChromaKeyOptions = {}): BackgroundRemovalProvider {
  const normalized = { ...options };
  return {
    name: 'chroma-key',
    async remove(image: RawImage, callOptions, signal) {
      throwIfAborted(signal);
      if (callOptions) {
        // Allow per-call overrides without mutating the provider.
        const merged: ChromaKeyOptions = { ...normalized };
        if (typeof callOptions.tolerance === 'number') merged.tolerance = callOptions.tolerance;
        if (typeof callOptions.feather === 'number') merged.feather = callOptions.feather;
        if (callOptions.color !== undefined) {
          merged.color = callOptions.color as ChromaKeyOptions['color'];
        }
        return chromaKeyMask(image, merged);
      }
      return chromaKeyMask(image, normalized);
    },
  };
}

/** Utility: applies green-spill suppression to an already cut-out image. */
export function suppressSpill(image: RawImage, key: RGBA | string = 'green'): RawImage {
  const [kr, kg, kb] = parseColor(key);
  const out = new Uint8ClampedArray(image.data.length);
  out.set(image.data);
  for (let i = 0; i < out.length; i += 4) {
    const limit = Math.max(kr, kg, kb) === kg ? (out[i] + out[i + 2]) / 2 : out[i + 1];
    if (out[i + 1] > limit) out[i + 1] = limit;
  }
  return { width: image.width, height: image.height, data: out };
}

export { normalizeColor };
