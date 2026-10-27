import { invalidArgument } from "../errors";
import type {
  AverageHash,
  DominantColor,
  DominantColorsOptions,
  Histogram,
  RawImage,
  RGBA,
} from "../types";
import { assertImage, luma } from "./util";
import { resizeWithKernel } from "./resize";

export function histogram(
  image: RawImage,
  options: { step?: number } = {},
): Histogram {
  assertImage(image);
  const step = Math.max(1, Math.floor(options.step ?? 1));
  const r = new Array<number>(256).fill(0);
  const g = new Array<number>(256).fill(0);
  const b = new Array<number>(256).fill(0);
  const a = new Array<number>(256).fill(0);
  const l = new Array<number>(256).fill(0);
  const d = image.data;
  let pixels = 0;
  const stride = step * 4;
  for (let i = 0; i < d.length; i += stride) {
    r[d[i]]++;
    g[d[i + 1]]++;
    b[d[i + 2]]++;
    a[d[i + 3]]++;
    l[Math.min(255, Math.round(luma(d[i], d[i + 1], d[i + 2])))]++;
    pixels++;
  }
  return { r, g, b, a, luma: l, pixels };
}

function toHex(r: number, g: number, b: number): string {
  const h = (1 << 24) | (r << 16) | (g << 8) | b;
  return `#${h.toString(16).slice(1).padStart(6, "0")}`;
}

interface Sample {
  r: number;
  g: number;
  b: number;
}

function collectSamples(
  image: RawImage,
  step: number,
  alphaThreshold: number,
): Sample[] {
  const d = image.data;
  const total = image.width * image.height;
  const stride = Math.max(1, Math.floor(step));
  const out: Sample[] = [];
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (d[i + 3] < alphaThreshold) continue;
    out.push({ r: d[i], g: d[i + 1], b: d[i + 2] });
  }
  return out;
}

function medianCut(samples: Sample[], count: number): DominantColor[] {
  const total = samples.length;
  interface Bucket {
    items: Sample[];
  }
  let buckets: Bucket[] = [{ items: samples }];

  while (buckets.length < count) {
    let best = -1;
    let bestRange = -1;
    let bestChannel: "r" | "g" | "b" = "r";
    for (let i = 0; i < buckets.length; i++) {
      const items = buckets[i].items;
      if (items.length < 2) continue;
      for (const c of ["r", "g", "b"] as const) {
        let min = 255;
        let max = 0;
        for (const s of items) {
          const v = s[c];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const range = max - min;
        if (range > bestRange) {
          bestRange = range;
          best = i;
          bestChannel = c;
        }
      }
    }
    if (best < 0 || bestRange <= 0) break;
    const bucket = buckets[best];
    const ch = bestChannel;
    const sorted = [...bucket.items].sort((p, q) => p[ch] - q[ch]);
    let mid = sorted.length >> 1;
    if (mid < 1) mid = 1;
    if (mid >= sorted.length) mid = sorted.length - 1;
    let back = mid;
    while (back > 0 && sorted[back - 1][ch] === sorted[mid][ch]) back--;
    if (back === 0) {
      let fwd = mid;
      while (fwd < sorted.length && sorted[fwd][ch] === sorted[mid][ch]) fwd++;
      mid = fwd;
    } else {
      mid = back;
    }
    if (mid <= 0 || mid >= sorted.length) break;
    buckets = [
      ...buckets.slice(0, best),
      { items: sorted.slice(0, mid) },
      { items: sorted.slice(mid) },
      ...buckets.slice(best + 1),
    ];
  }

  return buckets
    .filter((bk) => bk.items.length > 0)
    .map((bk) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const s of bk.items) {
        r += s.r;
        g += s.g;
        b += s.b;
      }
      const n = bk.items.length;
      const R = Math.round(r / n);
      const G = Math.round(g / n);
      const B = Math.round(b / n);
      return {
        r: R,
        g: G,
        b: B,
        hex: toHex(R, G, B),
        count: n,
        ratio: n / total,
      };
    })
    .sort((p, q) => q.count - p.count);
}

function kmeans(samples: Sample[], count: number): DominantColor[] {
  const total = samples.length;
  const k = Math.min(count, total);
  const centroids: Sample[] = [];
  for (let i = 0; i < k; i++) {
    const s = samples[Math.floor(((i + 0.5) / k) * total)];
    centroids.push({ r: s.r, g: s.g, b: s.b });
  }
  const assign = new Int32Array(total);
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < total; i++) {
      const s = samples[i];
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = s.r - centroids[c].r;
        const dg = s.g - centroids[c].g;
        const db = s.b - centroids[c].b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    const sums = Array.from({ length: k }, () => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (let i = 0; i < total; i++) {
      const a = sums[assign[i]];
      a.r += samples[i].r;
      a.g += samples[i].g;
      a.b += samples[i].b;
      a.n++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c].n === 0) continue;
      centroids[c] = {
        r: sums[c].r / sums[c].n,
        g: sums[c].g / sums[c].n,
        b: sums[c].b / sums[c].n,
      };
    }
    if (!moved && iter > 0) break;
  }
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < total; i++) counts[assign[i]]++;
  return centroids
    .map((c, i) => {
      const R = Math.round(c.r);
      const G = Math.round(c.g);
      const B = Math.round(c.b);
      return {
        r: R,
        g: G,
        b: B,
        hex: toHex(R, G, B),
        count: counts[i],
        ratio: counts[i] / total,
      };
    })
    .filter((c) => c.count > 0)
    .sort((p, q) => q.count - p.count);
}

export function dominantColors(
  image: RawImage,
  options: DominantColorsOptions = {},
): DominantColor[] {
  assertImage(image);
  const count = Math.max(1, Math.floor(options.count ?? 5));
  const alphaThreshold = options.alphaThreshold ?? 16;
  const target = 40_000;
  const autoStep = Math.max(
    1,
    Math.ceil(Math.sqrt((image.width * image.height) / target)),
  );
  const step =
    options.sampleStep && options.sampleStep > 0
      ? Math.floor(options.sampleStep)
      : autoStep;
  const samples = collectSamples(image, step, alphaThreshold);
  if (samples.length === 0) return [];
  return options.method === "kmeans"
    ? kmeans(samples, count)
    : medianCut(samples, count);
}

export function averageColor(image: RawImage, alphaThreshold = 1): RGBA {
  assertImage(image);
  const d = image.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < alphaThreshold) continue;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  if (n === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: Math.round(r / n),
    g: Math.round(g / n),
    b: Math.round(b / n),
    a: 255,
  };
}

export function averageHash(
  image: RawImage,
  size: { width: number; height: number } = { width: 8, height: 8 },
): AverageHash {
  assertImage(image);
  const w = Math.max(1, Math.floor(size.width));
  const h = Math.max(1, Math.floor(size.height));
  if (w * h > 4096)
    throw invalidArgument("averageHash: hash size is too large");
  const small = resizeWithKernel(
    image,
    { width: w, height: h },
    "bilinear",
    true,
  );
  const lumas: number[] = new Array(w * h);
  let sum = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const v = luma(small.data[i], small.data[i + 1], small.data[i + 2]);
    lumas[p] = v;
    sum += v;
  }
  const mean = sum / (w * h);
  let bits = "";
  const bytes = new Uint8Array(Math.ceil((w * h) / 8));
  for (let p = 0; p < w * h; p++) {
    const bit = lumas[p] >= mean ? 1 : 0;
    bits += bit ? "1" : "0";
    if (bit) bytes[p >> 3] |= 0x80 >> (p & 7);
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return { width: w, height: h, bits, hex, data: bytes };
}

export function hashDistance(a: AverageHash, b: AverageHash): number {
  let dist = 0;
  for (let i = 0; i < a.data.length; i++) {
    let x = a.data[i] ^ b.data[i];
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
