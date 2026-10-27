# ML providers

picopix defines provider interfaces but ships no models. You choose the model,
and it lives in your bundle.

```ts
await processImage(file).removeBackground(provider).toFormat('png').toBlob();
await processImage(file).upscale(upscaler, { scale: 2 }).toBlob();
```

## Built-in providers

| Provider | Model | Status |
| --- | --- | --- |
| `chromaKeyProvider` | None | Tested |
| `createImglyProvider` (`picopix/providers/imgly`) | `@imgly/background-removal` | Tested with a mocked module |
| `createTransformersProvider` (`picopix/providers/transformers`) | `@huggingface/transformers` | Tested with a mocked module |

The model packages are optional peers, loaded with a dynamic `import()` the first
time the provider runs.

### Chroma key

Removes a solid background colour (green screen, studio backdrop, paper scan):

```ts
import { chromaKeyProvider } from 'picopix';

const provider = chromaKeyProvider({ color: '#00b140', tolerance: 45, feather: 12 });
```

Options: `color` (hex, `[r, g, b]`, or `'green'`, `'blue'`, `'white'`, `'black'`),
`tolerance`, `feather`, `chromaSpace` (ignore brightness), `spillSuppression`.

### @imgly/background-removal

```ts
import { createImglyProvider } from 'picopix/providers/imgly';

const provider = createImglyProvider({ model: 'isnet_fp16', device: 'gpu' });
```

Other options are passed through to `@imgly/background-removal`.

### transformers.js

```ts
import { createTransformersProvider } from 'picopix/providers/transformers';

const provider = createTransformersProvider({ model: 'Xenova/modnet' });
```

Works with image-segmentation models such as `Xenova/modnet`,
`briaai/RMBG-1.4` and `onnx-community/BiRefNet-ONNX`. Options:
`foregroundLabels`, `threshold` (default `0.5`), `invert`, `pipelineOptions`.

## Your own model

Wrap any function:

```ts
import { createMaskProvider, createUpscaleProvider } from 'picopix';

const remover = createMaskProvider(async (image) => myModel.mask(image));
const upscaler = createUpscaleProvider(async (image, { scale }) => myModel.run(image, scale), {
  scales: [2, 4],
});
```

A mask provider returns either a single-channel mask (`0` background, `255`
subject) or an RGBA image whose alpha is the cut-out.

## Threads

Providers run on the thread where they were created, because model sessions
can't be sent to another thread. The pixel work around them still runs in the
pipeline's `worker` if you set one. To run a model off the main thread, create
the provider inside your own worker.
