# Web Workers

Large resizes take hundreds of milliseconds of CPU. A worker keeps that off the
main thread.

## Usage

```ts
import { createImageWorker, processImage } from 'picopix';

const worker = createImageWorker();

// Through the pipeline:
const blob = await processImage(file, { worker }).resize({ width: 1600 }).toBlob();

// Or directly:
const raw = await worker.decode(file);
const out = await worker.process(raw, [{ op: 'resize', width: 800 }], {
  signal: controller.signal, // rejects with AbortError
  timeout: 30_000,           // rejects with TimeoutError
  onProgress: (p) => console.log(p.ratio),
});
const webp = await worker.encode(out, { type: 'image/webp', quality: 0.8 });

worker.dispose();
```

Results are identical to running on the main thread; both use the same code.
Your input buffer is copied once before being sent, so it stays usable.

## Pools

```ts
import { createWorkerPool } from 'picopix';

const pool = createWorkerPool({ size: 4 }); // default: min(4, hardwareConcurrency)
await Promise.all(files.map((f) => pool.decode(f)));
```

Requests are spread round-robin. A pool has the same `process`, `decode`,
`encode` and `dispose` methods as a single worker.

## Bundler setup

The worker is created with
`new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`, which
bundlers detect and emit as a separate file.

**Vite**: exclude the package from dependency pre-bundling, which would
otherwise break the relative URL.

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['picopix'] },
});
```

**webpack 5**: detects the same pattern, so no configuration should be needed
(not yet tested in this repository).

**No bundler**: serve `node_modules/picopix/dist/` and pass the URL.

```ts
createImageWorker({ workerUrl: '/node_modules/picopix/dist/worker.js' });
```

## Fallback

If `Worker` isn't available, or the worker script fails to load, the client runs
the same code on the main thread and `worker.mode` becomes `'fallback'`.

| `fallback` option | Behaviour |
| --- | --- |
| `'auto'` (default) | Use a worker when possible |
| `'always'` | Always run on the main thread |
| `'never'` | Throw `BACKEND_UNAVAILABLE` instead |

## Cancellation

Aborting rejects immediately and tells the worker to discard the result. The
worker checks for cancellation between ops, so a single long op still runs to
completion in the background.

## Ops

`worker.process()` and `pipeline.addOps()` take plain JSON ops:

| Op | Fields |
| --- | --- |
| `orient` | `orientation` |
| `resize` | `width?`, `height?`, `fit?`, `kernel?`, `withoutEnlargement?`, `antialias?` |
| `crop` | `x`, `y`, `width?`, `height?` |
| `rotate` | `angle`, `background?` |
| `flip` | `axis` |
| `filter` | `filter: { type, amount? }` |
| `blur` | `radius`, `type?`, `passes?` |
| `sharpen` | `amount?`, `radius?`, `threshold?` |
| `pad` | `padding`, `color?` |
| `trim` | `threshold?`, `color?`, `alpha?` |
| `applyMask` | `mask`, `invert?` |
| `composite` | `source`, `x?`, `y?`, `opacity?`, `blendMode?` |

ML providers can't run inside this worker because model sessions can't be sent
between threads. See [providers](providers.md).
