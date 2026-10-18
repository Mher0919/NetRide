// backend/src/security/image-content.ts
//
// Content-based image validation. Client-supplied MIME types and filename
// extensions are trivially spoofable, so business-image uploads verify the
// actual bytes against the magic headers of the formats the platform accepts
// (JPEG/PNG/WebP/HEIC/HEIF — the same allowlist as validateUploadMime).
// SVG is deliberately NOT accepted: it is active content (scripts) and must
// never be served from the storage origin.

export type DetectedImageMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/heic'
  | 'image/heif';

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString('latin1');
}

/**
 * Sniff the real image format from the buffer's magic bytes.
 * Returns null for anything that is not an accepted raster image.
 */
export function detectImageMime(buffer: Buffer | Uint8Array | null | undefined): DetectedImageMime | null {
  if (!buffer || buffer.length < 12) return null;
  const bytes: Buffer = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // RIFF....WEBP
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }

  // ISO-BMFF brands for HEIC/HEIF: box size + 'ftyp' at offset 4.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (brand === 'heic' || brand === 'heix') return 'image/heic';
    if (brand === 'heif' || brand === 'mif1' || brand === 'msf1') return 'image/heif';
  }

  return null;
}

/**
 * True when the declared (client) MIME is compatible with the detected
 * content MIME. `image/jpg` is accepted as JPEG; HEIC/HEIF are treated as a
 * family because encoders label both inconsistently.
 */
export function imageMimeMatches(declared: string, detected: DetectedImageMime): boolean {
  const d = declared.trim().toLowerCase();
  if (detected === 'image/jpeg') return d === 'image/jpeg' || d === 'image/jpg';
  if (detected === 'image/heic' || detected === 'image/heif') {
    return d === 'image/heic' || d === 'image/heif';
  }
  return d === detected;
}
