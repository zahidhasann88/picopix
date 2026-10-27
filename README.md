# picopix

Small, typed, tree-shakeable image processing for the browser and Node.

- Resize, crop, rotate, filter, sharpen and composite pure `RawImage` pixels.
- Compress to a byte budget, convert formats, build `srcset` variants and
  ThumbHash placeholders.
- Fix EXIF orientation and strip metadata losslessly.
- Offload work to a Web Worker or a worker pool, with cancellation.
- Plug in your own ML background removal or upscaling.

![picopix demo: an image is resized, compressed and given srcset variants and a ThumbHash placeholder in a Web Worker](https://raw.githubusercontent.com/zahidhasann88/picopix/main/docs/demo.gif)

## Install

```bash
npm i picopix
```

Optional: `@napi-rs/canvas` for Node, and `@imgly/background-removal` or
`@huggingface/transformers` for the [ML providers](docs/providers.md).

## Quick start

```ts
import { processImage } from 'picopix';

const blob = await processImage(file)
  .resize({ width: 1600, fit: 'inside' })
  .sharpen(0.5)
  .toFormat('webp', { quality: 0.82 })
  .toBlob();
```

Input can be a `Blob`, `ArrayBuffer`, typed array, URL or decoded `RawImage`.
EXIF orientation is applied automatically.

## Helpers

```ts
import {
  compressImage, generateSrcSet, generatePlaceholder,
  generateThumbnail, stripMetadata, getImageInfo,
} from 'picopix';

await compressImage(file, { maxSizeKB: 150 });             // fits the budget
await generateThumbnail(file, 160);                         // 160x160 cover crop
await generateSrcSet(file, { widths: [480, 960, 1920] });   // [{ width, blob, descriptor }]
await generatePlaceholder(file);                            // { base64, dataURL, width, height }
await stripMetadata(file);                                  // lossless, JPEG/PNG
await getImageInfo(file);                                   // size, format, EXIF; no decode
```

## Web Worker

```ts
import { createImageWorker, processImage } from 'picopix';

const worker = createImageWorker();
const blob = await processImage(file, { worker }).resize({ width: 1600 }).toBlob();
```

Vite needs `optimizeDeps: { exclude: ['picopix'] }`; see [workers](docs/workers.md).

## Node

```ts
import { processImage, useNodeBackend } from 'picopix/node';

await useNodeBackend(); // requires @napi-rs/canvas
```

## Entry points

| Import | Contents | min+gzip |
| --- | --- | --- |
| `picopix` | Pipeline, helpers, codecs, metadata, worker client | 22.9 KB |
| `picopix/pixels` | Pure pixel functions, no canvas | 10.2 KB |
| `picopix/node` | Everything, plus the Node backend | 23.8 KB |
| `picopix/worker` | Module worker script | 11.4 KB |

Bundlers drop what you don't import. WebP and AVIF output depend on the browser;
check with `await canEncode('avif')`.

## Documentation

- [API reference](docs/api.md)
- [Web Workers](docs/workers.md)
- [Metadata](docs/metadata.md)
- [ML providers](docs/providers.md)
- [Demo](examples/vanilla-vite)

## License

MIT. ThumbHash code adapted from [evanw/thumbhash](https://github.com/evanw/thumbhash)
(MIT); see [LICENSE](LICENSE).
