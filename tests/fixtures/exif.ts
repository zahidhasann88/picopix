export type TagType = 1 | 2 | 3 | 4 | 7;

export interface TagSpec {
  tag: number;
  type: TagType;
  value: string | number | number[];
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

function encodeValue(
  spec: TagSpec,
  little: boolean,
): { count: number; bytes: number[] } {
  const values = Array.isArray(spec.value)
    ? spec.value
    : typeof spec.value === "number"
      ? [spec.value]
      : null;
  switch (spec.type) {
    case 2: {
      const bytes = Array.from(
        String(spec.value),
        (c) => c.charCodeAt(0) & 0xff,
      );
      if (bytes.length === 0 || bytes[bytes.length - 1] !== 0) bytes.push(0);
      return { count: bytes.length, bytes };
    }
    case 1:
    case 7:
      return { count: values!.length, bytes: values!.map((v) => v & 0xff) };
    case 3: {
      const bytes: number[] = [];
      for (const v of values!) {
        bytes.push(
          ...(little
            ? [v & 0xff, (v >> 8) & 0xff]
            : [(v >> 8) & 0xff, v & 0xff]),
        );
      }
      return { count: values!.length, bytes };
    }
    case 4: {
      const bytes: number[] = [];
      for (const v of values!) {
        bytes.push(
          ...(little
            ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
            : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]),
        );
      }
      return { count: values!.length, bytes };
    }
    default:
      throw new Error(`unsupported tag type ${spec.type}`);
  }
}

interface IfdPlan {
  tableSize: number;
  dataSize: number;
}

function planIfd(tags: TagSpec[], little: boolean): IfdPlan {
  let dataSize = 0;
  for (const tag of tags) {
    const enc = encodeValue(tag, little);
    const size = TYPE_SIZE[tag.type] * enc.count;
    if (size > 4) dataSize += size + (size % 2);
  }
  return { tableSize: 2 + tags.length * 12 + 4, dataSize };
}

export interface ExifFixtureOptions {
  orientation?: number;
  make?: string;
  model?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  gps?: boolean;
  littleEndian?: boolean;
}

function u16(v: number, little: boolean): number[] {
  return little ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff];
}

function u32(v: number, little: boolean): number[] {
  return little
    ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
    : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

export function buildTiff(options: ExifFixtureOptions = {}): Uint8Array {
  const little = options.littleEndian ?? true;

  const ifd0: TagSpec[] = [
    {
      tag: 0x010e,
      type: 2,
      value: "Hand-built EXIF fixture used by the test suite",
    },
    { tag: 0x010f, type: 2, value: options.make ?? "ArenaCam" },
    { tag: 0x0110, type: 2, value: options.model ?? "Model X" },
    { tag: 0x0112, type: 3, value: options.orientation ?? 1 },
    { tag: 0x0132, type: 2, value: options.dateTime ?? "2026:01:02 03:04:05" },
  ];
  const exifIfd: TagSpec[] = [
    {
      tag: 0x9003,
      type: 2,
      value: options.dateTimeOriginal ?? "2025:12:31 23:59:58",
    },
  ];
  const gpsIfd: TagSpec[] = options.gps
    ? [{ tag: 0x0000, type: 1, value: [2, 3, 0, 0] }]
    : [];

  const pointerTags: TagSpec[] = [{ tag: 0x8769, type: 4, value: 0 }];
  if (options.gps) pointerTags.push({ tag: 0x8825, type: 4, value: 0 });
  const ifd0All = [...ifd0, ...pointerTags].sort((a, b) => a.tag - b.tag);

  const ifd0Plan = planIfd(ifd0All, little);
  const exifOffset = 8 + ifd0Plan.tableSize + ifd0Plan.dataSize;
  const exifPlan = planIfd(exifIfd, little);
  const gpsOffset = exifOffset + exifPlan.tableSize + exifPlan.dataSize;

  for (const tag of ifd0All) {
    if (tag.tag === 0x8769) tag.value = exifOffset;
    if (tag.tag === 0x8825) tag.value = gpsOffset;
  }

  const out: number[] = [];
  out.push(little ? 0x49 : 0x4d, little ? 0x49 : 0x4d);
  out.push(...u16(42, little));
  out.push(...u32(8, little));

  const writeIfd = (tags: TagSpec[], nextIfd = 0): void => {
    out.push(...u16(tags.length, little));
    const blobs: number[][] = [];
    const placeholders: number[] = [];
    for (const tag of tags) {
      const enc = encodeValue(tag, little);
      const size = TYPE_SIZE[tag.type] * enc.count;
      out.push(
        ...u16(tag.tag, little),
        ...u16(tag.type, little),
        ...u32(enc.count, little),
      );
      if (size <= 4) {
        const inline = [...enc.bytes];
        while (inline.length < 4) inline.push(0);
        out.push(...inline);
      } else {
        placeholders.push(out.length);
        out.push(0, 0, 0, 0);
        blobs.push(enc.bytes);
      }
    }
    out.push(...u32(nextIfd, little));
    for (let i = 0; i < blobs.length; i++) {
      if (out.length % 2 === 1) out.push(0);
      const offset = out.length;
      const patch = u32(offset, little);
      out[placeholders[i]] = patch[0];
      out[placeholders[i] + 1] = patch[1];
      out[placeholders[i] + 2] = patch[2];
      out[placeholders[i] + 3] = patch[3];
      out.push(...blobs[i]);
    }
  };

  writeIfd(ifd0All, 0);
  if (out.length < exifOffset)
    out.push(...new Array(exifOffset - out.length).fill(0));
  writeIfd(exifIfd, 0);
  if (options.gps) {
    if (out.length < gpsOffset)
      out.push(...new Array(gpsOffset - out.length).fill(0));
    writeIfd(gpsIfd, 0);
  }
  return new Uint8Array(out);
}

export function buildExifApp1(options: ExifFixtureOptions = {}): Uint8Array {
  const tiff = buildTiff(options);
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  const bytes = new Uint8Array(4 + body.length);
  bytes[0] = 0xff;
  bytes[1] = 0xe1;
  bytes[2] = (length >> 8) & 0xff;
  bytes[3] = length & 0xff;
  bytes.set(body, 4);
  return bytes;
}

export function buildMinimalOrientationTiff(
  orientation: number,
  littleEndian = true,
): Uint8Array {
  return buildTiff({ orientation, littleEndian });
}
