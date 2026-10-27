# Metadata

## Reading

`getImageInfo` reads only the file header, without decoding pixels:

```ts
import { getImageInfo } from 'picopix';

const info = await getImageInfo(file);
// { width, height, displayWidth, displayHeight, format, mimeType, size,
//   hasAlpha, orientation, hasColorProfile, hasExif, exif }
```

`displayWidth`/`displayHeight` account for EXIF rotation. `exif` contains
Make, Model, DateTime, DateTimeOriginal and whether GPS data is present.
Supported formats: PNG, JPEG, WebP, GIF, AVIF, BMP, ICO and SVG.

Lower-level: `sniffFormat(bytes)`, `parseExif(bytes)`, `readOrientation(bytes)`.

## Orientation

Phone photos are often stored sideways with an EXIF orientation tag. The
pipeline applies it once, automatically:

```ts
await processImage(file).toBlob();                   // upright
await processImage(file, { orient: false }).toRaw(); // as stored
```

Browsers and skia rotate images themselves while decoding. The built-in
backends remove the EXIF block before decoding so the rotation is never applied
twice. A custom `CanvasBackend` should do the same.

For raw pixels, use `applyOrientation(image, orientation)` from
`picopix/pixels`; it supports all eight values.

## Stripping

`stripMetadata` removes metadata without re-encoding, so the pixels are
unchanged:

```ts
import { stripMetadata } from 'picopix';

const clean = await stripMetadata(file);                              // drops the ICC profile too
const keepIcc = await stripMetadata(file, { keepColorProfile: true });
```

| Format | Removed | Kept |
| --- | --- | --- |
| JPEG | EXIF/XMP (APP1–APP13, APP15), comments, ICC (APP2) | JFIF, Adobe APP14, image data |
| PNG | `tEXt`, `iTXt`, `zTXt`, `eXIf`, `tIME`, `pCAL`, `sTER`, `iCCP` | Image data, palette, transparency |

Other formats are returned unchanged. To strip while encoding, pass
`stripMetadata: true` to `toBlob()` or any helper.
