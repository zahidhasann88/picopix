import type { ExifData } from '../types';

/** Marker bytes for the start of an EXIF payload inside an APP1 segment. */
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // 'Exif\0\0'

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Offset of the value relative to the start of the TIFF header. */
  valueOffset: number;
  /** Raw inline bytes when the value fits in 4 bytes. */
  inline: boolean;
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

function decodeAscii(bytes: Uint8Array, start: number, length: number): string {
  let s = '';
  for (let i = 0; i < length && start + i < bytes.length; i++) {
    const c = bytes[start + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Parses a TIFF header at `tiffStart` inside `bytes` and returns IFD0 tags plus
 * the EXIF orientation, camera strings and a GPS-present flag.
 *
 * This is a small, dependency-free reader: it understands the handful of tags
 * this library exposes (orientation, Make, Model, DateTime, DateTimeOriginal and
 * the GPS pointer) and additionally collects every IFD0 tag whose value is an
 * ASCII string or a single integer into `tags`.
 */
export function parseTiff(bytes: Uint8Array, tiffStart = 0): ExifData | null {
  if (bytes.length < tiffStart + 8) return null;
  const b0 = bytes[tiffStart];
  const b1 = bytes[tiffStart + 1];
  let little: boolean;
  if (b0 === 0x49 && b1 === 0x49) little = true;
  else if (b0 === 0x4d && b1 === 0x4d) little = false;
  else return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (off: number): number => view.getUint16(off, little);
  const u32 = (off: number): number => view.getUint32(off, little);

  if (u16(tiffStart + 2) !== 42) return null;
  const ifd0Offset = u32(tiffStart + 4);
  if (!Number.isFinite(ifd0Offset)) return null;

  const readIfd = (offset: number): { entries: IfdEntry[]; next: number } | null => {
    const base = tiffStart + offset;
    if (base + 2 > bytes.length) return null;
    const count = u16(base);
    if (count === 0 || base + 2 + count * 12 > bytes.length) return null;
    const entries: IfdEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = base + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      entries.push({
        tag,
        type,
        count: n,
        valueOffset: size <= 4 ? e + 8 : u32(e + 8),
        inline: size <= 4,
      });
    }
    const nextOffsetPos = base + 2 + count * 12;
    const next = nextOffsetPos + 4 <= bytes.length ? u32(nextOffsetPos) : 0;
    return { entries, next };
  };

  const ifd0 = readIfd(ifd0Offset);
  if (!ifd0) return null;

  const valueStart = (entry: IfdEntry): number =>
    entry.inline ? entry.valueOffset : tiffStart + entry.valueOffset;

  const asString = (entry: IfdEntry): string =>
    decodeAscii(bytes, valueStart(entry), entry.count);

  const asUint = (entry: IfdEntry): number => {
    const start = valueStart(entry);
    switch (entry.type) {
      case 1:
      case 7:
        return bytes[start] ?? 0;
      case 3:
        return u16(start);
      case 4:
        return u32(start);
      case 9:
        return view.getInt32(start, little);
      default:
        return 0;
    }
  };

  const tags: Record<number, string | number> = {};
  let orientation = 1;
  let make: string | undefined;
  let model: string | undefined;
  let dateTime: string | undefined;
  let exifIfdOffset = 0;
  let hasGps = false;

  for (const entry of ifd0.entries) {
    switch (entry.tag) {
      case TAG_ORIENTATION:
        orientation = asUint(entry) || 1;
        break;
      case TAG_MAKE:
        make = asString(entry).trim() || undefined;
        break;
      case TAG_MODEL:
        model = asString(entry).trim() || undefined;
        break;
      case TAG_DATETIME:
        dateTime = asString(entry).trim() || undefined;
        break;
      case TAG_EXIF_IFD:
        exifIfdOffset = asUint(entry);
        break;
      case TAG_GPS_IFD:
        hasGps = true;
        break;
      default:
        break;
    }
    const size = (TYPE_SIZE[entry.type] ?? 0) * entry.count;
    if (entry.type === 2 && size <= 1024) {
      tags[entry.tag] = asString(entry);
    } else if (entry.count === 1 && [1, 3, 4, 7, 9].includes(entry.type)) {
      tags[entry.tag] = asUint(entry);
    }
  }

  let dateTimeOriginal: string | undefined;
  if (exifIfdOffset > 0) {
    const exifIfd = readIfd(exifIfdOffset);
    if (exifIfd) {
      for (const entry of exifIfd.entries) {
        if (entry.tag === TAG_DATETIME_ORIGINAL) {
          dateTimeOriginal = asString(entry).trim() || undefined;
        } else if (entry.tag === TAG_GPS_IFD) {
          hasGps = true;
        }
      }
    }
  }

  if (orientation < 1 || orientation > 8) orientation = 1;

  const data: ExifData = { orientation, hasGps, tags };
  if (make) data.make = make;
  if (model) data.model = model;
  if (dateTime) data.dateTime = dateTime;
  if (dateTimeOriginal) data.dateTimeOriginal = dateTimeOriginal;
  return data;
}

/** Iterates JPEG segments, invoking `visit` for each marker with its payload. */
export function forEachJpegSegment(
  bytes: Uint8Array,
  visit: (marker: number, payload: Uint8Array, start: number, end: number) => void,
): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let i = 2;
  while (i < bytes.length) {
    while (i < bytes.length && bytes[i] !== 0xff) i++;
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) break;
    const marker = bytes[i];
    i++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows, stop segment iteration.
      visit(marker, bytes.subarray(i - 2), i - 2, bytes.length);
      break;
    }
    if (i + 1 >= bytes.length) break;
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2) break;
    const start = i - 2;
    const end = start + 2 + length;
    visit(marker, bytes.subarray(i + 2, Math.min(bytes.length, i + length)), start, end);
    i += length;
  }
}

/** Finds the raw `Exif\0\0…` APP1 payload of a JPEG, or `null`. */
export function findJpegExif(bytes: Uint8Array): { tiffStart: number; length: number } | null {
  let found: { tiffStart: number; length: number } | null = null;
  forEachJpegSegment(bytes, (marker, payload, start) => {
    if (found || marker !== 0xe1 || payload.length < 6) return;
    let isExif = true;
    for (let k = 0; k < 6; k++) {
      if (payload[k] !== EXIF_HEADER[k]) {
        isExif = false;
        break;
      }
    }
    if (isExif) {
      // payload starts right after the 2-byte length field at `start + 4`.
      found = { tiffStart: start + 4 + 6, length: payload.length - 6 };
    }
  });
  return found;
}

/**
 * Parses EXIF metadata from a JPEG (APP1) or PNG (`eXIf` chunk) byte stream.
 * Returns `null` when there is no EXIF block. Never throws on malformed data.
 */
export function parseExif(bytes: Uint8Array): ExifData | null {
  try {
    if (bytes.length > 8 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      const exif = findJpegExif(bytes);
      if (!exif) return null;
      return parseTiff(bytes, exif.tiffStart);
    }
    // PNG eXIf chunk: TIFF header starts right after the 8 byte signature.
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let i = 8;
      while (i + 8 <= bytes.length) {
        const len = view.getUint32(i, false);
        const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
        const dataStart = i + 8;
        if (type === 'eXIf') return parseTiff(bytes, dataStart);
        if (type === 'IEND') break;
        i = dataStart + len + 4;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Reads the EXIF orientation (`1..8`; `1` when absent/invalid). */
export function readOrientation(bytes: Uint8Array): number {
  return parseExif(bytes)?.orientation ?? 1;
}
