# API reference

- [Pipeline](#pipeline)
- [Helpers](#helpers)
- [Pixel functions](#pixel-functions)
- [Codecs](#codecs)
- [Errors](#errors)
- [Browser support](#browser-support)
- [Limitations](#limitations)

Every async function accepts `signal?: AbortSignal` and
`onProgress?: ({ phase, ratio, loaded?, total? }) => void`.

## Pipeline

```ts
import { processImage } from 'picopix';

const blob = await processImage(input, { worker, format: 'webp', quality: 0.8 })
  .crop({ x: 40, y: 40, width: 800, height: 800 })
  .resize({ width: 512, height: 512, fit: 'cover' })
  .filter('contrast', 1.15)
  .toBlob({ stripMetadata: true });
```

EXIF orientation is applied automatically; pass `{ orient: false }` or call
`.orient(false)` to keep the raw pixels.

### Options

| Option | Default | |
| --- | --- | --- |
| `backend` | auto-detected | A custom `CanvasBackend` |
| `worker` | none | Run the ops in an `ImageWorker` |
| `format`, `quality` | input format, or PNG | Output format and 0–1 quality |
| `orient` | `'auto'` | `false`, or a forced orientation 1–8 |
| `stripMetadata`, `keepColorProfile` | `false` | Strip EXIF/text chunks from the output |

### Steps

| Method | |
| --- | --- |
| `.orient(value?)` | `true` (file's orientation), `false`, or 1–8 |
| `.resize({ width?, height?, fit?, kernel?, withoutEnlargement?, antialias? })` | `fit`: `fill` (default), `contain`, `cover`, `inside`, `outside` |
| `.crop({ x, y, width?, height? })` | Clamped to the image |
| `.rotate(angle, background?)` | Exact for multiples of 90° |
| `.flip('x' \| 'y')` | |
| `.filter(name, amount?)` | `grayscale`, `brightness`, `contrast`, `saturate`, `invert`, `threshold` |
| `.blur(radius \| { radius, type?, passes? })` | `gaussian` (default) or `box` |
| `.sharpen(amount \| { amount?, radius?, threshold? })` | Unsharp mask; defaults `1`, `1`, `0` |
| `.pad(padding, color?)`, `.trim(options?)` | `trim` removes borders matching the top-left pixel by default |
| `.composite(image, { x?, y?, opacity?, blendMode? })` | `normal`, `multiply`, `screen` |
| `.removeBackground(provider)`, `.upscale(provider, { scale })` | See [providers](providers.md) |
| `.toFormat(format, { quality? })` | Sets the output format |
| `.addOps(ops)`, `.toOps()` | Append or inspect the raw [worker ops](workers.md#ops) |

### Output

| Method | Returns |
| --- | --- |
| `.toBlob({ type?, quality?, stripMetadata? })` | `Blob` |
| `.toArrayBuffer()` | `ArrayBuffer` |
| `.toDataURL()` | `string` |
| `.toObjectURL()` | `string`; revoke it when done |
| `.toRaw()` | `RawImage` |

When no format is set, the output keeps the input format. Inputs that can't be
re-encoded (GIF, BMP, ICO, SVG) become PNG. An explicitly requested format the
environment can't encode throws `UNSUPPORTED_FORMAT`.

### Resize kernels

| Kernel | Use for |
| --- | --- |
| `lanczos3` (default) | Final output |
| `catmull-rom` | Good quality, ~20% faster |
| `bilinear` | Previews and thumbnails, ~2× faster |
| `nearest` | Masks and pixel art |

Downscaling is anti-aliased and done in premultiplied alpha, so transparent
edges don't get dark fringes. A 12 MPix downscale takes roughly 0.5 s; run it in a
[worker](workers.md).

## Helpers

All helpers return a `Promise` and accept `backend`, `worker`, `format`,
`quality` and `stripMetadata` in their options.

| Function | Returns |
| --- | --- |
| `resizeImage(input, { width?, height?, fit?, kernel?, withoutEnlargement? })` | `Blob` |
| `convertImage(input, format, { quality? })` | `Blob` |
| `cropToAspect(input, aspect, { anchor? })` | `Blob`; anchor `center`, `top`, `bottom`, `left`, `right` |
| `generateThumbnail(input, size, { fit? })` | `Blob`; `cover` crop by default |
| `compressImage(input, options)` | `Blob`; see below |
| `generateSrcSet(input, { widths?, kernel?, withoutEnlargement? })` | `{ width, height, blob, descriptor }[]` |
| `generatePlaceholder(input)` | `{ hash, base64, dataURL, width, height, averageColor }` |
| `stripMetadata(input, { keepColorProfile? })` | `Blob`; see [metadata](metadata.md) |
| `getImageInfo(input)` | `ImageInfo`; see [metadata](metadata.md) |

### compressImage

```ts
await compressImage(file, { maxSizeKB: 150, maxWidthOrHeight: 2000 });
```

| Option | Default |
| --- | --- |
| `maxSizeKB` | none (encodes once at `maxQuality`) |
| `minQuality`, `maxQuality` | `0.4`, `0.92` |
| `maxWidthOrHeight` | none |
| `downscaleStep`, `maxDownscaleSteps`, `minWidthOrHeight` | `0.8`, `6`, `256` |

It binary-searches the quality, then downscales if even `minQuality` is too
large. If the budget can't be met, the smallest result is returned rather than
throwing. Without `format`, the output is the input format when it is JPEG, WebP or AVIF,
otherwise JPEG.

### generateSrcSet

`widths` defaults to `[320, 640, 960, 1280, 1920]`. The input is decoded once.
With `withoutEnlargement` (default `true`) widths above the source width become
the source width, and duplicates are removed.

```ts
const variants = await generateSrcSet(file, { widths: [480, 960, 1920], format: 'webp' });
img.srcset = variants.map((v) => `${URL.createObjectURL(v.blob)} ${v.descriptor}`).join(', ');
```

### generatePlaceholder

Returns a ~25-byte [ThumbHash](https://evanw.github.io/thumbhash/), compatible
with any ThumbHash decoder. Store `base64`, `width` and `height`, then render the
placeholder without a canvas (works during SSR):

```ts
import { thumbHashToDataURL } from 'picopix/pixels';

const hash = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
img.style.backgroundImage = `url(${thumbHashToDataURL(hash)})`;
```

## Pixel functions

`picopix/pixels` has no canvas or codec code. Every function takes and returns
a `RawImage`:

```ts
interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, straight alpha, width * height * 4
}
```

It is compatible with `ImageData` and can be transferred to workers.

| Group | Functions |
| --- | --- |
| Resize | `resize`, `resizeTo`, `resizeWithKernel`, `resizeNearest`, `computeFitSize` |
| Geometry | `crop`, `rotate`, `rotate90`, `rotate180`, `rotate270`, `flip`, `flipX`, `flipY`, `applyOrientation`, `pad`, `trim`, `trimImage`, `isBlank` |
| Filters | `blur`, `sharpen`, `grayscale`, `brightness`, `contrast`, `saturate`, `invert`, `threshold`, `filter` |
| Compositing | `composite`, `flatten`, `applyAlphaMask`, `setAlphaMask` |
| Analysis | `histogram`, `dominantColors`, `averageColor`, `averageHash`, `hashDistance` |
| ThumbHash | `thumbHash`, `thumbHashToImage`, `thumbHashToDataURL`, `thumbHashToAverageColor`, `thumbHashAspectRatio` |
| Utilities | `createImage`, `cloneImage`, `getPixel`, `setPixel`, `createMask`, `toMask`, `maskToImage`, `toPremultiplied`, `fromPremultiplied` |
| Fit math | `coverCropRect`, `aspectCropRect`, `containScale`, `coverScale`, `centerOffset`, `isEnlargement` |

`thumbHash` downscales images larger than 100×100 before hashing.

## Codecs

The browser backend is used automatically. To use another one:

```ts
import { setBackend } from 'picopix';
setBackend(myBackend); // implements CanvasBackend: decode, encode, canEncode
```

| Function | |
| --- | --- |
| `canEncode(format)` | Probes by encoding a 1×1 image |
| `getBackend()`, `setBackend(backend)` | Read or replace the active backend |
| `sniffFormat(bytes)` | Format from magic bytes |

## Errors

Errors are `ImageToolsError` instances with a stable `code`:

| Code | When |
| --- | --- |
| `UNSUPPORTED_FORMAT` | Unknown input, or an output format the environment can't encode |
| `DECODE_FAILED`, `ENCODE_FAILED` | The backend failed |
| `ABORTED` | The `signal` was aborted (`AbortError`) |
| `TIMEOUT` | A worker request timed out (`TimeoutError`) |
| `BACKEND_UNAVAILABLE` | No canvas implementation (e.g. Node without `@napi-rs/canvas`) |
| `INVALID_ARGUMENT` | Bad options |
| `PROVIDER_FAILED` | A background-removal or upscale provider threw |

```ts
import { isImageToolsError } from 'picopix';

try { /* ... */ } catch (e) {
  if (isImageToolsError(e) && e.code === 'ABORTED') return;
}
```

## Browser support

Decoding uses `createImageBitmap`; encoding uses `OffscreenCanvas`, falling back
to `<canvas>`.

| Encode | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| PNG, JPEG | ✅ | ✅ | ✅ |
| WebP | ✅ | 96+ | 14+ |
| AVIF | 85+ (not all Linux builds) | ❌ | 16.4+ |

Node supports PNG, JPEG, WebP and AVIF output.

## Limitations

- Pixels are treated as sRGB; there is no ICC colour conversion.
- Only the first frame of animated GIF/WebP is processed.
- `stripMetadata` rewrites JPEG and PNG; other formats are returned unchanged.
- Cancellation is checked between operations; a single large resize can't be
  interrupted.
