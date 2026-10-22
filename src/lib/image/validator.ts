import crypto from 'node:crypto';
import sharp from 'sharp';
import { AllowedMimeType, ValidationSuccess } from './types';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10,485,760 bytes (10 MiB)
export const MAX_PIXELS = 20_000_000; // 20 Megapixels

export class ImageValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.name = 'ImageValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Stage 1: Magic byte inspection to detect true raster MIME type.
 * Inspects leading byte sequence. Rejects SVG, GIF, HTML, PSD, or unrecognized formats.
 */
export function detectMagicMime(buffer: Buffer | Uint8Array): AllowedMimeType | null {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  // Explicit check for disallowed formats:
  // SVG: starts with <?xml or <svg
  if (
    (buffer[0] === 0x3c && buffer[1] === 0x3f && buffer[2] === 0x78 && buffer[3] === 0x6d) || // <?xm
    (buffer[0] === 0x3c && buffer[1] === 0x73 && buffer[2] === 0x76 && buffer[3] === 0x67)    // <svg
  ) {
    return null;
  }

  // GIF: GIF87a / GIF89a (47 49 46 38)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return null;
  }

  // PSD: 8BPS (38 42 50 53)
  if (buffer[0] === 0x38 && buffer[1] === 0x42 && buffer[2] === 0x50 && buffer[3] === 0x53) {
    return null;
  }

  // HTML: <!DOCTYPE or <html or <body
  if (
    buffer[0] === 0x3c &&
    (buffer[1] === 0x21 || buffer[1] === 0x68 || buffer[1] === 0x48 || buffer[1] === 0x62 || buffer[1] === 0x42)
  ) {
    return null;
  }

  // Allowed Formats:
  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // 3. WebP: RIFF (bytes 0..3) ... WEBP (bytes 8..11)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Validates an image buffer through Stage 1 (magic bytes and file size)
 * and Stage 2 (bounded sharp decode and pixel bounds).
 */
export async function validateImageBuffer(buffer: Buffer): Promise<ValidationSuccess> {
  // Empty buffer check
  if (!buffer || buffer.length === 0) {
    throw new ImageValidationError('EMPTY_FILE', 'The uploaded image file is empty (0 bytes).', 400);
  }

  // Size limit check (<= 10 MiB)
  if (buffer.length > MAX_FILE_BYTES) {
    throw new ImageValidationError(
      'FILE_TOO_LARGE',
      `File size (${buffer.length} bytes) exceeds the maximum allowed size of 10 MiB (${MAX_FILE_BYTES} bytes).`,
      400
    );
  }

  // Stage 1: Magic byte inspection
  const mimeType = detectMagicMime(buffer);
  if (!mimeType) {
    throw new ImageValidationError(
      'INVALID_FILE_FORMAT',
      'Invalid file format. Only JPEG, PNG, and WebP images are permitted. SVG, GIF, HTML, and other file types are rejected.',
      400
    );
  }

  // Stage 2: Bounded Sharp decode with limitInputPixels: 20_000_000
  let width: number;
  let height: number;

  try {
    const sharpInstance = sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
    });

    const meta = await sharpInstance.metadata();

    if (!meta.width || !meta.height) {
      throw new ImageValidationError('CORRUPT_IMAGE', 'Unable to parse image dimensions from header.', 400);
    }

    width = meta.width;
    height = meta.height;

    // Check pixel bound
    if (width * height > MAX_PIXELS) {
      throw new ImageValidationError(
        'RESOLUTION_EXCEEDED',
        `Image resolution (${width}x${height} = ${width * height} pixels) exceeds the 20 megapixel limit (${MAX_PIXELS} pixels).`,
        400
      );
    }
  } catch (err: unknown) {
    if (err instanceof ImageValidationError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);

    if (
      message.includes('pixel limit') ||
      message.includes('exceeds pixel limit') ||
      message.includes('exceeds the limit')
    ) {
      throw new ImageValidationError(
        'RESOLUTION_EXCEEDED',
        `Image resolution exceeds the 20 megapixel limit (${MAX_PIXELS} pixels).`,
        400
      );
    }

    throw new ImageValidationError(
      'CORRUPT_IMAGE',
      `Failed to decode image data: ${message}`,
      400
    );
  }

  // Compute SHA-256 over raw byte buffer
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    valid: true,
    mimeType,
    byteLength: buffer.length,
    width,
    height,
    checksum,
  };
}
