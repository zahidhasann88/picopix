# Vite demo

Drop an image to resize, sharpen, convert and compress it in a Web Worker, and
to see its `srcset` variants and ThumbHash placeholder.

```bash
# from the repository root
pnpm install && pnpm build

cd examples/vanilla-vite
pnpm install --ignore-workspace
pnpm dev   # http://localhost:5173
```

The demo uses the built package (`file:../..`), and CI builds it on every push.
`vite.config.js` sets `optimizeDeps.exclude: ['picopix']` so Vite can bundle the
worker (see [docs/workers.md](../../docs/workers.md#bundler-setup)).
