import {
  ImageToolsError,
  invalidArgument,
  unsupportedFormat,
  throwIfAborted,
} from "../errors";
import type { CanvasBackend } from "../codec/backend";
import { formatToMime, getBackend } from "../codec/backend";
import { bytesToBase64 } from "../codec/backend";
import { inputToBytes } from "../codec/backend";
import { sniffFormat } from "../meta/sniff";
import { parseExif } from "../meta/exif";
import { stripMetadataBytes } from "../meta/strip";
import type {
  BlendMode,
  BlurOptions,
  CallOptions,
  CropOptions,
  FitMode,
  ImageFormat,
  ImageInput,
  MaskImage,
  ProgressInfo,
  RawImage,
  ResizeKernel,
  RGBA,
  SharpenOptions,
} from "../types";
import { executeOps } from "../worker/execute";
import type { WorkerOp } from "../worker/protocol";
import type { ImageWorker } from "../worker/client";
import type {
  BackgroundRemovalProvider,
  UpscaleProvider,
} from "../providers/types";

export interface PipelineOptions extends CallOptions {
  backend?: CanvasBackend;
  worker?: ImageWorker;
  format?: ImageFormat | string;
  quality?: number;
  orient?: "auto" | boolean | number;
  stripMetadata?: boolean;
  keepColorProfile?: boolean;
}

export interface OutputOptions extends CallOptions {
  type?: string;
  quality?: number;
  stripMetadata?: boolean;
}

type Step =
  | { kind: "op"; op: WorkerOp }
  | {
      kind: "provider";
      label: string;
      run: (image: RawImage) => Promise<RawImage>;
    };

/**
 * Chainable image pipeline returned by {@link processImage}.
 *
 * Steps are recorded, not executed: nothing is decoded until a terminal method
 * (`toBlob`, `toRaw`, `toDataURL`, …) is awaited, which lets you build the same
 * pipeline from config, log it, or send it to a worker.
 */
export class ImagePipeline {
  readonly input: ImageInput;
  private readonly options: PipelineOptions;
  private readonly steps: Step[] = [];
  private formatOverride?: string;
  private inferredType?: string;
  private qualityOverride?: number;
  private stripRequested?: boolean;
  private orientation: "auto" | false | number;

  constructor(input: ImageInput, options: PipelineOptions = {}) {
    if (!isSupportedInput(input)) {
      throw invalidArgument(
        "processImage(): expected a Blob, ArrayBuffer, typed array, data URL/URL string or RawImage",
      );
    }
    this.input = input;
    this.options = options;
    if (options.format !== undefined)
      this.formatOverride = formatToMime(options.format);
    this.qualityOverride = options.quality;
    this.stripRequested = options.stripMetadata;
    this.orientation =
      options.orient === undefined
        ? "auto"
        : options.orient === true
          ? "auto"
          : options.orient === false
            ? false
            : options.orient;
  }

  get length(): number {
    return this.steps.length;
  }

  toOps(): WorkerOp[] {
    return this.steps
      .filter((s): s is { kind: "op"; op: WorkerOp } => s.kind === "op")
      .map((s) => s.op);
  }

  /**
   * Applies (or removes) EXIF orientation.
   *
   * - `orient()` / `orient(true)`: use the orientation recorded in the file
   *   (applied at decode time, so `.toOps()` does not include it).
   * - `orient(false)`: keep the raw, unrotated pixels.
   * - `orient(6)`: force a specific transform; this becomes an explicit
   *   `orient` op, inserted first so it always runs before other geometry.
   */
  orient(value: boolean | number = true): this {
    if (typeof value === "number") {
      if (value < 1 || value > 8)
        throw invalidArgument("orient(): a numeric orientation must be 1..8");
      this.orientation = false;
      this.steps.unshift({
        kind: "op",
        op: { op: "orient", orientation: value },
      });
      return this;
    }
    this.orientation = value ? "auto" : false;
    return this;
  }

  /** Resizes to a box; see {@link resize} for fit/kernel semantics. */
  resize(options: {
    width?: number;
    height?: number;
    fit?: FitMode;
    kernel?: ResizeKernel;
    withoutEnlargement?: boolean;
    antialias?: boolean;
  }): this {
    if (options.width === undefined && options.height === undefined) {
      throw invalidArgument(
        "resize(): at least one of width/height is required",
      );
    }
    this.steps.push({ kind: "op", op: { op: "resize", ...options } });
    return this;
  }

  crop(options: CropOptions): this {
    this.steps.push({
      kind: "op",
      op: {
        op: "crop",
        x: options.x ?? 0,
        y: options.y ?? 0,
        width: options.width,
        height: options.height,
      },
    });
    return this;
  }

  rotate(angle: number, background?: RGBA): this {
    this.steps.push({ kind: "op", op: { op: "rotate", angle, background } });
    return this;
  }

  flip(axis: "x" | "y" = "x"): this {
    this.steps.push({ kind: "op", op: { op: "flip", axis } });
    return this;
  }

  filter(spec: FilterSpecLike, amount?: number): this {
    const filterSpec =
      typeof spec === "string"
        ? ({ type: spec, amount } as FilterSpecLike)
        : spec;
    this.steps.push({
      kind: "op",
      op: { op: "filter", filter: filterSpec as never },
    });
    return this;
  }

  blur(options: number | BlurOptions): this {
    const opts = typeof options === "number" ? { radius: options } : options;
    this.steps.push({ kind: "op", op: { op: "blur", ...opts } });
    return this;
  }

  sharpen(options: number | SharpenOptions = {}): this {
    const opts = typeof options === "number" ? { amount: options } : options;
    this.steps.push({ kind: "op", op: { op: "sharpen", ...opts } });
    return this;
  }

  pad(
    padding:
      | number
      | { top?: number; right?: number; bottom?: number; left?: number },
    color?: RGBA,
  ): this {
    this.steps.push({ kind: "op", op: { op: "pad", padding, color } });
    return this;
  }

  trim(
    options: { threshold?: number; color?: RGBA; alpha?: boolean } = {},
  ): this {
    this.steps.push({ kind: "op", op: { op: "trim", ...options } });
    return this;
  }

  addOps(ops: WorkerOp[]): this {
    for (const op of ops) this.steps.push({ kind: "op", op });
    return this;
  }

  composite(
    source: RawImage,
    options: {
      x?: number;
      y?: number;
      opacity?: number;
      blendMode?: BlendMode;
    } = {},
  ): this {
    this.steps.push({
      kind: "op",
      op: { op: "composite", source, ...options },
    });
    return this;
  }

  /**
   * Removes the background using a {@link BackgroundRemovalProvider}.
   *
   * The provider runs **on the thread that created it** (ML models and their
   * sessions are not structured-cloneable), the pixel work around it can still be
   * offloaded to a worker.
   */
  removeBackground(
    provider: BackgroundRemovalProvider,
    providerOptions?: Record<string, unknown>,
    callOptions?: CallOptions,
  ): this {
    if (!provider || typeof provider.remove !== "function") {
      throw invalidArgument(
        "removeBackground(): provider must implement remove()",
      );
    }
    this.steps.push({
      kind: "provider",
      label: `removeBackground:${provider.name}`,
      run: async (image) => {
        throwIfAborted(callOptions?.signal);
        const result = await provider.remove(
          image,
          providerOptions,
          callOptions?.signal,
        );
        return normalizeProviderResult(image, result);
      },
    });
    return this;
  }

  /** Upscales with an {@link UpscaleProvider} (runs where the provider was created). */
  upscale(
    provider: UpscaleProvider,
    options: { scale: number } & Record<string, unknown>,
    callOptions?: CallOptions,
  ): this {
    if (!provider || typeof provider.upscale !== "function") {
      throw invalidArgument("upscale(): provider must implement upscale()");
    }
    if (!provider.scales.includes(options.scale)) {
      throw invalidArgument(
        `upscale(): provider '${provider.name}' supports scales ${provider.scales.join(", ")} (got ${options.scale})`,
      );
    }
    this.steps.push({
      kind: "provider",
      label: `upscale:${provider.name}`,
      run: async (image) => {
        throwIfAborted(callOptions?.signal);
        const result = await provider.upscale(
          image,
          options,
          callOptions?.signal,
          callOptions?.onProgress,
        );
        if (
          !result ||
          !result.data ||
          result.data.length !== result.width * result.height * 4
        ) {
          throw new ImageToolsError(
            "PROVIDER_FAILED",
            `upscale(): provider '${provider.name}' returned an invalid image`,
          );
        }
        return result;
      },
    });
    return this;
  }

  toFormat(
    format: ImageFormat | string,
    options: { quality?: number } = {},
  ): this {
    const mime = formatToMime(format);
    this.formatOverride = mime;
    if (options.quality !== undefined) this.qualityOverride = options.quality;
    return this;
  }

  async toBlob(options: OutputOptions = {}): Promise<Blob> {
    const callOptions = mergeCallOptions(this.options, options);
    const image = await this.run(callOptions);
    const backend = await this.backend();
    let type = this.resolveType(options.type);
    const quality = options.quality ?? this.qualityOverride;
    callOptions.onProgress?.({ phase: "encode", ratio: 0 });
    if (!(await backend.canEncode(type))) {
      const explicit =
        options.type !== undefined || this.formatOverride !== undefined;
      if (explicit || type === "image/png") {
        throw unsupportedFormat(`This environment cannot encode '${type}'`);
      }
      type = "image/png";
    }
    let blob = await backend.encode(
      image,
      { type, quality },
      { signal: callOptions.signal },
    );
    const strip = options.stripMetadata ?? this.stripRequested ?? false;
    if (strip) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const stripped = stripMetadataBytes(bytes, {
        keepColorProfile: this.options.keepColorProfile,
      });
      blob = new Blob([stripped as unknown as BlobPart], {
        type: blob.type || type,
      });
    }
    callOptions.onProgress?.({ phase: "encode", ratio: 1 });
    return blob;
  }

  async toArrayBuffer(options: OutputOptions = {}): Promise<ArrayBuffer> {
    const blob = await this.toBlob(options);
    return blob.arrayBuffer();
  }

  async toDataURL(options: OutputOptions = {}): Promise<string> {
    const blob = await this.toBlob(options);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${blob.type || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
  }

  async toObjectURL(options: OutputOptions = {}): Promise<string> {
    if (
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      throw new ImageToolsError(
        "BACKEND_UNAVAILABLE",
        "URL.createObjectURL is not available in this environment",
      );
    }
    return URL.createObjectURL(await this.toBlob(options));
  }

  async toRaw(options: CallOptions = {}): Promise<RawImage> {
    return this.run(mergeCallOptions(this.options, options));
  }

  private resolveType(explicit?: string): string {
    if (explicit) return formatToMime(explicit);
    if (this.formatOverride) return formatToMime(this.formatOverride);
    return this.inferredType ?? "image/png";
  }

  private async backend(): Promise<CanvasBackend> {
    return this.options.backend ?? getBackend();
  }

  private async run(callOptions: CallOptions): Promise<RawImage> {
    const signal = callOptions.signal;
    throwIfAborted(signal);
    const onProgress = callOptions.onProgress;
    let image: RawImage;
    let sourceFormat: string | null = null;

    if (isRawImage(this.input)) {
      image = this.input;
      onProgress?.({ phase: "decode", ratio: 1 });
    } else {
      const backend = await this.backend();
      onProgress?.({ phase: "decode", ratio: 0 });
      let bytes: Uint8Array | null = null;
      try {
        bytes = await inputToBytes(this.input);
      } catch {
        bytes = null;
      }
      if (bytes) {
        sourceFormat = sniffFormat(bytes);
        if (this.orientation === "auto") {
          const orientation = parseExif(bytes)?.orientation ?? 1;
          if (orientation !== 1) this.orientation = orientation;
        }
      }
      image = await backend.decode(bytes ?? this.input, { signal });
      onProgress?.({ phase: "decode", ratio: 1 });
    }

    if (sourceFormat && REENCODABLE.has(sourceFormat)) {
      this.inferredType = formatToMime(sourceFormat);
    }

    const opsPrefix: WorkerOp[] =
      this.orientation === "auto" || this.orientation === false
        ? []
        : [{ op: "orient", orientation: this.orientation }];

    const totalSteps = this.steps.length + opsPrefix.length;
    let done = 0;
    const reportOp = (
      ratio: number,
      index: number,
      total: number,
      label: string,
    ): void => {
      onProgress?.({
        phase: label,
        ratio: (done + ratio) / Math.max(1, totalSteps),
      });
      void index;
      void total;
    };

    if (opsPrefix.length) {
      image = await this.runOps(image, opsPrefix, callOptions, reportOp);
      done += opsPrefix.length;
    }

    let batch: WorkerOp[] = [];
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const ops = batch;
      batch = [];
      image = await this.runOps(image, ops, callOptions, reportOp);
      done += ops.length;
    };

    for (const step of this.steps) {
      if (step.kind === "op") {
        batch.push(step.op);
      } else {
        await flush();
        throwIfAborted(signal);
        image = await step.run(image);
        done++;
      }
    }
    await flush();
    onProgress?.({ phase: "ops", ratio: 1 });
    return image;
  }

  private async runOps(
    image: RawImage,
    ops: WorkerOp[],
    callOptions: CallOptions,
    onProgress: (
      ratio: number,
      index: number,
      total: number,
      label: string,
    ) => void,
  ): Promise<RawImage> {
    const signal = callOptions.signal;
    if (this.options.worker) {
      return this.options.worker.process(image, ops, {
        signal,
        onProgress: (progress: ProgressInfo) =>
          onProgress(progress.ratio ?? 0, 0, ops.length, progress.phase),
      });
    }
    return executeOps(image, ops, {
      isCancelled: () => signal?.aborted === true,
      onProgress: (ratio, index, total, label) =>
        onProgress(ratio, index, total, label),
    });
  }
}

type FilterSpecLike =
  | { type: string; amount?: number; value?: number }
  | string;

const REENCODABLE = new Set(["png", "jpeg", "webp", "avif"]);

function mergeCallOptions(
  base: CallOptions,
  override: CallOptions,
): CallOptions {
  const merged: CallOptions = {};
  const signal = override.signal ?? base.signal;
  if (signal) merged.signal = signal;
  const onProgress = override.onProgress ?? base.onProgress;
  if (onProgress) merged.onProgress = onProgress;
  return merged;
}

function isRawImage(value: unknown): value is RawImage {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as RawImage).width === "number" &&
    typeof (value as RawImage).height === "number" &&
    (value as RawImage).data instanceof Uint8ClampedArray
  );
}

function isSupportedInput(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!value || typeof value !== "object") return false;
  if (isRawImage(value)) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  return false;
}

function normalizeProviderResult(
  image: RawImage,
  result: MaskImage | RawImage,
): RawImage {
  if (
    !result ||
    typeof result !== "object" ||
    !("width" in result) ||
    !("height" in result)
  ) {
    throw new ImageToolsError(
      "PROVIDER_FAILED",
      "The provider returned an invalid mask/image",
    );
  }
  const total = result.width * result.height;
  if (result.data.length === total) {
    const mask: MaskImage = {
      width: result.width,
      height: result.height,
      data: result.data,
    };
    const out = new Uint8ClampedArray(image.data.length);
    out.set(image.data);
    for (let y = 0; y < image.height; y++) {
      const my =
        mask.height === image.height
          ? y
          : Math.min(
              mask.height - 1,
              Math.floor((y * mask.height) / image.height),
            );
      for (let x = 0; x < image.width; x++) {
        const mx =
          mask.width === image.width
            ? x
            : Math.min(
                mask.width - 1,
                Math.floor((x * mask.width) / image.width),
              );
        const i = (y * image.width + x) * 4 + 3;
        out[i] = (out[i] * mask.data[my * mask.width + mx]) / 255;
      }
    }
    return { width: image.width, height: image.height, data: out };
  }
  if (result.data.length === total * 4) {
    const rgba = result as RawImage;
    if (rgba.width === image.width && rgba.height === image.height) {
      return {
        width: rgba.width,
        height: rgba.height,
        data: new Uint8ClampedArray(rgba.data),
      };
    }
    const out = new Uint8ClampedArray(image.data.length);
    out.set(image.data);
    for (let y = 0; y < image.height; y++) {
      const sy = Math.min(
        rgba.height - 1,
        Math.floor((y * rgba.height) / image.height),
      );
      for (let x = 0; x < image.width; x++) {
        const sx = Math.min(
          rgba.width - 1,
          Math.floor((x * rgba.width) / image.width),
        );
        out[(y * image.width + x) * 4 + 3] =
          rgba.data[(sy * rgba.width + sx) * 4 + 3];
      }
    }
    return { width: image.width, height: image.height, data: out };
  }
  throw new ImageToolsError(
    "PROVIDER_FAILED",
    "The provider returned a mask with an unexpected data length",
  );
}

export function processImage(
  input: ImageInput,
  options: PipelineOptions = {},
): ImagePipeline {
  return new ImagePipeline(input, options);
}
