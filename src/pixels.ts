/**
 * `image-tools-core/pixels` — pure, DOM-free pixel functions.
 *
 * Importing from this subpath pulls in **zero** canvas/codec/browser code: the
 * bundle only contains arithmetic on typed arrays (verified by
 * `tests/treeshake.test.ts`).
 */
export {
  assertImage,
  clampByte,
  clamp,
  cloneImage,
  createImage,
  createMask,
  fromPremultiplied,
  getPixel,
  luma,
  maskToImage,
  normalizeColor,
  sampleBilinear,
  sameSize,
  setPixel,
  toMask,
  toPremultiplied,
} from './pixels/util';

export {
  computeTaps,
  resize,
  resizeNearest,
  resizeTo,
  resizeWithKernel,
  type ResampleTaps,
} from './pixels/resize';

export {
  aspectCropRect,
  centerOffset,
  computeFitSize,
  containScale,
  coverCropRect,
  coverScale,
  isEnlargement,
  type FitSizeOptions,
} from './pixels/fit';

export {
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
} from './pixels/transform';

export {
  blur,
  brightness,
  contrast,
  filter,
  grayscale,
  invert,
  saturate,
  threshold,
  type FilterName,
  type FilterSpec,
} from './pixels/filters';

export {
  applyAlphaMask,
  composite,
  flatten,
  setAlphaMask,
} from './pixels/composite';

export {
  averageColor,
  averageHash,
  dominantColors,
  hashDistance,
  histogram,
} from './pixels/analysis';

export type * from './types';
