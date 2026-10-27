import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  chromaKeyMask,
  chromaKeyProvider,
  parseColor,
  suppressSpill,
} from "../src/providers/chroma";
import {
  createMaskProvider,
  createUpscaleProvider,
} from "../src/providers/factory";
import { createMaskProvider as createMaskProviderFromIndex } from "../src/index";
import { createImglyProvider } from "../src/providers/imgly";
import {
  createTransformersProvider,
  maskFromSegmentation,
} from "../src/providers/transformers";
import { createImage } from "../src/pixels";
import { processImage } from "../src/api/pipeline";
import { nodeBackend, useNodeBackend } from "../src/node";
import { solidImage } from "./fixtures/images";

beforeAll(async () => {
  await useNodeBackend();
});

const GREEN: [number, number, number, number] = [0, 177, 64, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];

describe("chromaKeyProvider (real, model-free)", () => {
  it("parses colours from hex, named colours and objects", () => {
    expect(parseColor("#00b140")).toEqual([0, 177, 64]);
    expect(parseColor("#0b0")).toEqual([0, 187, 0]);
    expect(parseColor("green")).toEqual([0, 177, 64]);
    expect(parseColor({ r: 1, g: 2, b: 3 })).toEqual([1, 2, 3]);
    expect(parseColor(undefined)).toEqual([0, 177, 64]);
    expect(() => parseColor("not-a-colour")).toThrow(/cannot parse/);
  });

  it("masks the key colour and keeps the subject", async () => {
    const image = createImage(4, 1);
    image.data.set(GREEN, 0);
    image.data.set(GREEN, 4);
    image.data.set(WHITE, 8);
    image.data.set(WHITE, 12);
    const provider = chromaKeyProvider({ color: "#00b140" });
    const mask = await provider.remove(image);
    expect(Array.from(mask.data)).toEqual([0, 0, 255, 255]);
  });

  it("the pipeline turns the mask into transparency", async () => {
    const image = createImage(2, 1);
    image.data.set(GREEN, 0);
    image.data.set([200, 0, 0, 255], 4);
    const out = await processImage(image)
      .removeBackground(chromaKeyProvider())
      .toRaw();
    expect(out.data[3]).toBe(0);
    expect(out.data[7]).toBe(255);
    expect(out.data[4]).toBe(200);
  });

  it("feather creates a soft alpha ramp", () => {
    const image = createImage(6, 1);
    for (let x = 0; x < 6; x++) {
      const t = x / 5;
      image.data.set(
        [
          Math.round(0 + t * 255),
          Math.round(177 + t * 78),
          Math.round(64 + t * 191),
          255,
        ],
        x * 4,
      );
    }
    const hard = chromaKeyMask(image, {
      color: "#00b140",
      tolerance: 30,
      feather: 0,
    });
    const soft = chromaKeyMask(image, {
      color: "#00b140",
      tolerance: 30,
      feather: 120,
    });
    expect(hard.data[0]).toBe(0);
    expect(hard.data[5]).toBe(255);
    // With feathering there is at least one partially transparent pixel that is
    // fully transparent in the hard mask.
    const partial = Array.from(soft.data).filter((a) => a > 0 && a < 255);
    expect(partial.length).toBeGreaterThan(0);
    for (let i = 0; i < soft.data.length; i++) {
      expect(soft.data[i]).toBeLessThanOrEqual(
        hard.data[i] === 0 ? 255 : hard.data[i],
      );
    }
  });

  it("respects source alpha (transparent pixels stay transparent)", async () => {
    const image = createImage(2, 1);
    image.data.set([0, 177, 64, 0], 0); // already transparent green
    image.data.set([255, 255, 255, 255], 4);
    const mask = await chromaKeyProvider().remove(image);
    expect(mask.data[0]).toBe(0);
    expect(mask.data[1]).toBe(255);
  });

  it("supports RGB space and per-call overrides", async () => {
    const image = createImage(2, 1);
    image.data.set([0, 177, 64, 255], 0);
    image.data.set([10, 170, 70, 255], 4);
    const rgbStrict = chromaKeyMask(image, {
      color: "#00b140",
      tolerance: 5,
      feather: 0,
      chromaSpace: false,
    });
    expect(rgbStrict.data[0]).toBe(0);
    expect(rgbStrict.data[1]).toBe(255);
    // Chroma-space comparison ignores luma, so a darker green also matches.
    const chromaLenient = chromaKeyMask(image, {
      color: "#00b140",
      tolerance: 40,
      chromaSpace: true,
    });
    expect(chromaLenient.data[0]).toBe(0);
    const provider = chromaKeyProvider({ tolerance: 5 });
    const overridden = await provider.remove(image, {
      tolerance: 200,
      chromaSpace: false,
    });
    expect(Array.from(overridden.data)).toEqual([0, 0]);
  });

  it("rejects invalid tolerances", () => {
    expect(() => chromaKeyMask(createImage(2, 2), { tolerance: -1 })).toThrow(
      /tolerance/,
    );
  });

  it("honours an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      chromaKeyProvider().remove(
        createImage(2, 2),
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("suppressSpill reduces green fringing", () => {
    const image = createImage(1, 1, [100, 200, 100, 255]);
    const out = suppressSpill(image);
    expect(out.data[1]).toBeLessThan(200);
    expect(out.data[0]).toBe(100);
  });
});

describe("createMaskProvider / createUpscaleProvider", () => {
  it("wraps a function into a provider", async () => {
    const provider = createMaskProvider(
      (image) => ({
        width: image.width,
        height: image.height,
        data: new Uint8ClampedArray(image.width * image.height).fill(128),
      }),
      "constant",
    );
    expect(provider.name).toBe("constant");
    const mask = await provider.remove(createImage(2, 2));
    expect(Array.from(mask.data)).toEqual([128, 128, 128, 128]);
    // The same factory is exported from the package root.
    const fromIndex = createMaskProviderFromIndex(() => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([9]),
    }));
    expect((await fromIndex.remove(createImage(1, 1))).data[0]).toBe(9);
  });

  it("rejects non-functions and bad return values", async () => {
    expect(() => createMaskProvider(null as never)).toThrow(
      /must be a function/,
    );
    const provider = createMaskProvider(() => null as never);
    await expect(provider.remove(createImage(1, 1))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("validates upscale scales", async () => {
    const provider = createUpscaleProvider(
      (image) => createImage(image.width * 2, image.height * 2, [1, 2, 3, 255]),
      { name: "x2", scales: [2] },
    );
    expect(provider.scales).toEqual([2]);
    const out = await processImage(createImage(2, 2))
      .upscale(provider, { scale: 2 })
      .toRaw();
    expect([out.width, out.height]).toEqual([4, 4]);
    expect(() =>
      processImage(createImage(2, 2)).upscale(provider, { scale: 4 }),
    ).toThrow(/supports scales/);
  });
});

describe("imgly provider (mocked module)", () => {
  it("converts pixels to PNG, calls removeBackground and returns the cutout", async () => {
    const cutout = await nodeBackend.encode(
      (() => {
        const img = createImage(2, 1, [10, 20, 30, 255]);
        img.data[3] = 0; // first pixel transparent in the result
        return img;
      })(),
      { type: "image/png" },
    );
    const removeBackground = vi.fn(async () => cutout);
    const provider = createImglyProvider({
      loadModule: async () => ({ removeBackground }),
    });
    expect(provider.name).toBe("imgly");
    const out = await provider.remove(createImage(2, 1, [10, 20, 30, 255]));
    expect(removeBackground).toHaveBeenCalledOnce();
    const [input, config] = removeBackground.mock.calls[0] as unknown as [
      Blob,
      Record<string, unknown>,
    ];
    expect(input).toBeInstanceOf(Blob);
    expect(input.type).toBe("image/png");
    expect(config).toEqual({});
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(out.data[3]).toBe(0);
  });

  it("forwards config and progress callbacks", async () => {
    const cutout = await nodeBackend.encode(createImage(1, 1, [0, 0, 0, 255]), {
      type: "image/png",
    });
    const progress = vi.fn();
    const removeBackground = vi.fn(async () => cutout);
    const provider = createImglyProvider({
      model: "isnet_fp16",
      device: "cpu",
      progress,
      loadModule: async () => ({ removeBackground }),
    });
    await provider.remove(createImage(1, 1), { progress });
    const [, config] = removeBackground.mock.calls[0] as unknown as [
      Blob,
      Record<string, unknown>,
    ];
    expect(config.model).toBe("isnet_fp16");
    expect(config.progress).toBe(progress);
  });

  it("loads the module only once", async () => {
    const cutout = await nodeBackend.encode(createImage(1, 1, [0, 0, 0, 255]), {
      type: "image/png",
    });
    const loadModule = vi.fn(async () => ({
      removeBackground: async () => cutout,
    }));
    const provider = createImglyProvider({ loadModule });
    await provider.remove(createImage(1, 1));
    await provider.remove(createImage(1, 1));
    expect(loadModule).toHaveBeenCalledOnce();
  });

  it("returns a scaled mask when the model runs at a different resolution", async () => {
    // A 1x1 cut-out for a 4x2 source: the provider must produce a mask instead.
    const tinyCutout = await nodeBackend.encode(
      createImage(1, 1, [0, 0, 0, 0]),
      { type: "image/png" },
    );
    const provider = createImglyProvider({
      loadModule: async () => ({ removeBackground: async () => tinyCutout }),
    });
    const result = await provider.remove(createImage(4, 2, [1, 2, 3, 255]));
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.data.length).toBe(1); // single channel mask
    // Applied through the pipeline it removes the whole background.
    const out = await processImage(createImage(4, 2, [1, 2, 3, 255]))
      .removeBackground(provider)
      .toRaw();
    expect(out.data[3]).toBe(0);
  });

  it("surfaces model failures as PROVIDER_FAILED", async () => {
    const provider = createImglyProvider({
      loadModule: async () => ({
        removeBackground: async () => {
          throw new Error("model exploded");
        },
      }),
    });
    await expect(provider.remove(createImage(1, 1))).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
    });
  });

  it("reports BACKEND_UNAVAILABLE when the optional peer is missing", async () => {
    // No loadModule override: the real dynamic import fails in this sandbox.
    const provider = createImglyProvider();
    await expect(provider.remove(createImage(1, 1))).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
  });

  it("honours an aborted signal before loading the model", async () => {
    const loadModule = vi.fn();
    const provider = createImglyProvider({ loadModule });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.remove(createImage(1, 1), undefined, controller.signal),
    ).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(loadModule).not.toHaveBeenCalled();
  });
});

describe("transformers provider (mocked pipeline)", () => {
  const maskOf = (width: number, height: number, fill: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height).fill(fill),
  });

  it("maskFromSegmentation picks the non-background label", () => {
    const result = [
      { label: "background", mask: maskOf(2, 1, 0) },
      { label: "cat", mask: maskOf(2, 1, 255) },
    ];
    const mask = maskFromSegmentation(result, { threshold: 2 });
    expect(Array.from(mask.data)).toEqual([255, 255]);
  });

  it("maskFromSegmentation merges several foreground labels and honours invert", () => {
    const result = [
      { label: "cat", mask: maskOf(2, 1, 255) },
      { label: "dog", mask: maskOf(2, 1, 255) },
      { label: "background", mask: maskOf(2, 1, 0) },
    ];
    expect(
      Array.from(maskFromSegmentation(result, { threshold: 2 }).data),
    ).toEqual([255, 255]);
    expect(
      Array.from(
        maskFromSegmentation(result, { threshold: 2, invert: true }).data,
      ),
    ).toEqual([0, 0]);
  });

  it("maskFromSegmentation rejects empty results", () => {
    expect(() => maskFromSegmentation([], {})).toThrow(/no masks/);
    expect(() => maskFromSegmentation([{ label: "x" }], {})).toThrow(
      /no mask data/,
    );
  });

  it("runs the segmentation pipeline and applies the mask", async () => {
    const pipeline = vi.fn(async () => [
      { label: "background", score: 0.9, mask: maskOf(2, 1, 0) },
      { label: "subject", score: 0.8, mask: maskOf(2, 1, 255) },
    ]);
    const provider = createTransformersProvider({
      model: "Xenova/modnet",
      loadModule: async () => ({ pipeline: async () => pipeline }),
    });
    expect(provider.name).toBe("transformers:Xenova/modnet");
    const image = createImage(2, 1, [50, 60, 70, 255]);
    const mask = await provider.remove(image);
    expect(Array.from(mask.data)).toEqual([255, 255]);
    expect(pipeline).toHaveBeenCalledOnce();

    const out = await processImage(image).removeBackground(provider).toRaw();
    expect(out.data[3]).toBe(255);
  });

  it("feeds raw RGBA through transformers.js RawImage and loads the module once", async () => {
    class FakeRawImage {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
        readonly channels: number,
      ) {}
    }
    const pipeline = vi.fn(async (input: unknown) => {
      expect(input).toBeInstanceOf(FakeRawImage);
      expect((input as FakeRawImage).channels).toBe(4);
      return [{ label: "subject", mask: maskOf(2, 1, 255) }];
    });
    const loadModule = vi.fn(async () => ({
      pipeline: async () => pipeline,
      RawImage: FakeRawImage,
    }));
    const provider = createTransformersProvider({
      model: "Xenova/modnet",
      loadModule,
    });
    const image = createImage(2, 1, [50, 60, 70, 255]);
    await provider.remove(image);
    await provider.remove(image);
    expect(loadModule).toHaveBeenCalledOnce();
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it("reports BACKEND_UNAVAILABLE when the optional peer is missing", async () => {
    const provider = createTransformersProvider({ model: "Xenova/modnet" });
    await expect(provider.remove(createImage(1, 1))).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
  });

  it("requires a model id", () => {
    expect(() => createTransformersProvider({} as never)).toThrow(/model/);
  });

  it("runs inside a pipeline with a real background + subject split", async () => {
    const image = solidImage(4, 2, [0, 177, 64, 255]);
    // Paint the right half as "subject".
    for (let y = 0; y < 2; y++) {
      for (let x = 2; x < 4; x++)
        image.data.set([80, 40, 20, 255], (y * 4 + x) * 4);
    }
    const blob = await processImage(image)
      .removeBackground(chromaKeyProvider({ tolerance: 30 }))
      .toFormat("png")
      .toBlob();
    const decoded = await nodeBackend.decode(blob);
    // Left half removed, right half kept.
    expect(decoded.data[3]).toBe(0);
    expect(decoded.data[(0 * 4 + 3) * 4 + 3]).toBe(255);
  });
});
