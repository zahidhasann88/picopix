# Vanilla Vite demo

A single-page demo of `image-tools-core`: drop an image, and it is oriented,
resized, converted and compressed to a byte budget — with the pixel work running
in a Web Worker. Before/after dimensions and file sizes are shown side by side.

This folder is **source only**: it is not built by the library's CI, and it
depends on the parent package via `file:../..`.

## Run it

```bash
cd image-tools-core        # repository root
npm install
npm run build              # the demo consumes the built package

cd examples/vanilla-vite
npm install
npm run dev                # http://localhost:5173
```

## What to look at

- `main.js` — worker creation (`createImageWorker()`), `worker.decode()` +
  `worker.process()` with an ops list, `compressImage()` for the byte budget,
  `stripMetadata()` on the encoded result, and `AbortSignal` cancellation when a
  new file replaces the previous run.
- `index.html` / `style.css` — the UI; no framework, no build magic.

Note that **no worker configuration is needed in `vite.config.js`**: the default
worker factory uses the `new Worker(new URL('./worker.js', import.meta.url))`
pattern that Vite (and webpack 5) resolve automatically.
