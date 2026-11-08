import { crc32, deflateSync } from "node:zlib";

/** Image formats Locke accepts as job inputs and results (what Fooocus and FaceFusion read). */
export type ImageFormat = "png" | "jpeg";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  return null;
}

export const contentType = (f: ImageFormat) => (f === "png" ? "image/png" : "image/jpeg");

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Stored pixel size (PNG IHDR, JPEG SOFn), before any EXIF orientation. Null if the header can't be read. */
export function imageSize(buf: Buffer, f: ImageFormat): { width: number; height: number } | null {
  if (f === "png") {
    if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  for (let i = 2; i + 9 <= buf.length && buf[i] === 0xff; ) {
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (JPEG_SOF.has(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    if (marker === 0xda) return null;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const PNG_METADATA = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

/** Metadata blocks that may carry prompts, locations or device details. Results must have none. */
export function metadataBlocks(buf: Buffer, f: ImageFormat): string[] {
  const found: string[] = [];
  if (f === "png") {
    for (let i = 8; i + 8 <= buf.length; ) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString("latin1", i + 4, i + 8);
      if (PNG_METADATA.has(type)) found.push(type);
      i += 12 + len;
    }
  } else {
    for (let i = 2; i + 4 <= buf.length && buf[i] === 0xff; ) {
      const marker = buf[i + 1]!;
      if (marker === 0xda) break;
      if (marker === 0xe1) found.push("APP1 (EXIF/XMP)");
      else if (marker >= 0xe2 && marker <= 0xef && marker !== 0xee) found.push(`APP${marker - 0xe0}`);
      else if (marker === 0xfe) found.push("COM");
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return found;
}

/**
 * Removes metadata from an input image before it is sealed for a worker: PNG text/EXIF/time chunks; JPEG APP1–APP15
 * (except Adobe APP14, needed for colours) and comments. A JPEG keeps only its EXIF orientation, rewritten as a
 * minimal EXIF block, so photos are not shown rotated. Pixels are untouched.
 */
export function stripMetadata(buf: Buffer, f: ImageFormat): Buffer {
  if (f === "png") {
    const parts: Buffer[] = [PNG_SIG];
    for (let i = 8; i + 8 <= buf.length; ) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString("latin1", i + 4, i + 8);
      if (!PNG_METADATA.has(type)) parts.push(buf.subarray(i, i + 12 + len));
      i += 12 + len;
    }
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let orientation: number | null = null;
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const end = i + 2 + buf.readUInt16BE(i + 2);
    const segment = buf.subarray(i, end);
    if (marker === 0xe1) orientation ??= exifOrientation(segment.subarray(4));
    const drop = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
    if (!drop) parts.push(segment);
    i = end;
  }
  if (orientation && orientation !== 1) parts.splice(1, 0, orientationSegment(orientation));
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

function exifOrientation(app1: Buffer): number | null {
  if (app1.toString("latin1", 0, 6) !== "Exif\0\0") return null;
  const t = app1.subarray(6);
  if (t.length < 8) return null;
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

function orientationSegment(orientation: number): Buffer {
  // "Exif\0\0" + big-endian TIFF header + IFD0 with a single Orientation entry.
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A small synthetic RGB PNG (no faces) for admin test jobs: proves the pipeline end to end. */
export function syntheticPng(width: number, height: number, seed: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2, dy = y - height / 2.4;
      const inside = dx * dx + dy * dy < (width / 4) ** 2;
      const p = row + 1 + x * 3;
      raw[p] = inside ? 230 : (x * 255) / width;
      raw[p + 1] = inside ? 190 : ((y + seed * 40) * 255 / height) % 256;
      raw[p + 2] = inside ? 160 : 140;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
