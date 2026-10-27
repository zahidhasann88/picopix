# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## [0.1.2] — 2026-10-27

- Fix demo GIF not showing on the npm page.

## [0.1.1] — 2026-10-27

- Shorter package description.

## [0.1.0] — 2026-10-27

First release.

- `processImage()` pipeline: orient, resize (four kernels, five fit modes), crop,
  rotate, flip, filters, blur, sharpen, pad, trim, composite.
- Helpers: `resizeImage`, `convertImage`, `cropToAspect`, `generateThumbnail`,
  `compressImage` (fit a byte budget), `generateSrcSet`, `generatePlaceholder`
  (ThumbHash), `stripMetadata`, `getImageInfo`.
- `picopix/pixels`: pure pixel functions with no canvas dependency, including
  ThumbHash encode/decode.
- EXIF orientation for all eight values, and lossless metadata stripping for
  JPEG and PNG.
- Web Worker client and pool with cancellation, timeouts and a main-thread
  fallback.
- Background-removal and upscale provider interfaces, a chroma-key provider,
  and adapters for `@imgly/background-removal` and `@huggingface/transformers`.
- Browser backend, and a Node backend through `@napi-rs/canvas`.
- `ImageToolsError` with stable error codes.
