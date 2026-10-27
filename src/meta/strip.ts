import { unsupportedFormat } from "../errors";
import type { ImageFormatId } from "../types";
import { sniffFormat } from "./sniff";

export interface StripOptions {
  keepColorProfile?: boolean;
}

const ICC_PROFILE_BYTES = [
  0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
];

function startsWith(bytes: Uint8Array, needle: number[], at: number): boolean {
  if (at + needle.length > bytes.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (bytes[at + i] !== needle[i]) return false;
  }
  return true;
}

export function stripJpegMetadata(
  bytes: Uint8Array,
  options: StripOptions = {},
): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw unsupportedFormat("stripJpegMetadata: not a JPEG");
  }
  const keepColorProfile = options.keepColorProfile ?? false;
  const out: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      out.push(bytes.subarray(i));
      break;
    }
    let markerStart = i;
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) {
      out.push(bytes.subarray(markerStart));
      break;
    }
    const marker = bytes[i];
    i++;
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      out.push(bytes.subarray(markerStart, i));
      continue;
    }
    if (marker === 0xd9) {
      out.push(bytes.subarray(markerStart));
      break;
    }
    if (marker === 0xda) {
      out.push(bytes.subarray(markerStart));
      break;
    }
    if (i + 1 >= bytes.length) {
      out.push(bytes.subarray(markerStart));
      break;
    }
    const length = view.getUint16(i, false);
    if (length < 2) {
      out.push(bytes.subarray(markerStart));
      break;
    }
    const segEnd = i + length;
    const isApp = marker >= 0xe1 && marker <= 0xef && marker !== 0xee;
    const isCom = marker === 0xfe;
    const keepIcc =
      keepColorProfile &&
      marker === 0xe2 &&
      startsWith(bytes, ICC_PROFILE_BYTES, i + 2);
    if (!isApp && !isCom) {
      out.push(bytes.subarray(markerStart, segEnd));
    } else if (keepIcc) {
      out.push(bytes.subarray(markerStart, segEnd));
    }
    i = segEnd;
    markerStart = i;
  }

  let total = 0;
  for (const part of out) total += part.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of out) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const PNG_METADATA_CHUNKS = new Set([
  "tEXt",
  "iTXt",
  "zTXt",
  "eXIf",
  "tIME",
  "pCAL",
  "sTER",
]);

export function stripPngMetadata(
  bytes: Uint8Array,
  options: StripOptions = {},
): Uint8Array {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw unsupportedFormat("stripPngMetadata: not a PNG");
  }
  const keepColorProfile = options.keepColorProfile ?? false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = view.getUint32(i, false);
    const type = String.fromCharCode(
      bytes[i + 4],
      bytes[i + 5],
      bytes[i + 6],
      bytes[i + 7],
    );
    const end = i + 12 + length;
    if (end > bytes.length) {
      chunks.push(bytes.subarray(i));
      break;
    }
    const drop =
      PNG_METADATA_CHUNKS.has(type) || (type === "iCCP" && !keepColorProfile);
    if (!drop) chunks.push(bytes.subarray(i, end));
    if (type === "IEND") break;
    i = end;
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function strippableFormat(bytes: Uint8Array): ImageFormatId {
  return sniffFormat(bytes);
}

export function stripMetadataBytes(
  bytes: Uint8Array,
  options: StripOptions = {},
): Uint8Array {
  switch (sniffFormat(bytes)) {
    case "jpeg":
      return stripJpegMetadata(bytes, options);
    case "png":
      return stripPngMetadata(bytes, options);
    default:
      return bytes;
  }
}
