import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  detectMagicMime,
  validateImageBuffer,
  MAX_FILE_BYTES,
} from '@/lib/image/validator';
import {
  createTestJpeg,
  createTestPng,
  createTestWebp,
  createOversizedMegapixelJpeg,
  FAKE_SVG_BUFFER,
  FAKE_GIF_BUFFER,
  FAKE_HTML_BUFFER,
  FAKE_PSD_BUFFER,
  TRUNCATED_JPEG_BUFFER,
} from '../helpers/image-fixtures';

describe('Unit: Image Validator & Byte Inspection Pipeline', () => {
  describe('Stage 1: detectMagicMime()', () => {
    it('accurately detects JPEG magic bytes (FF D8 FF)', async () => {
      const jpeg = await createTestJpeg();
      expect(detectMagicMime(jpeg)).toBe('image/jpeg');
    });

    it('accurately detects PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)', async () => {
      const png = await createTestPng();
      expect(detectMagicMime(png)).toBe('image/png');
    });

    it('accurately detects WebP magic bytes (RIFF....WEBP)', async () => {
      const webp = await createTestWebp();
      expect(detectMagicMime(webp)).toBe('image/webp');
    });

    it('strictly rejects SVG files disguised with any extension', () => {
      expect(detectMagicMime(FAKE_SVG_BUFFER)).toBeNull();
    });

    it('strictly rejects GIF files', () => {
      expect(detectMagicMime(FAKE_GIF_BUFFER)).toBeNull();
    });

    it('strictly rejects HTML script files', () => {
      expect(detectMagicMime(FAKE_HTML_BUFFER)).toBeNull();
    });

    it('strictly rejects Photoshop PSD files', () => {
      expect(detectMagicMime(FAKE_PSD_BUFFER)).toBeNull();
    });

    it('returns null on buffers under 12 bytes', () => {
      expect(detectMagicMime(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
      expect(detectMagicMime(Buffer.alloc(0))).toBeNull();
    });
  });

  describe('Stage 2: validateImageBuffer()', () => {
    it('validates a genuine JPEG image and produces exact metadata and SHA-256', async () => {
      const jpeg = await createTestJpeg(250, 180);
      const result = await validateImageBuffer(jpeg);

      expect(result.valid).toBe(true);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.width).toBe(250);
      expect(result.height).toBe(180);
      expect(result.byteLength).toBe(jpeg.length);

      const expectedChecksum = crypto.createHash('sha256').update(jpeg).digest('hex');
      expect(result.checksum).toBe(expectedChecksum);
    });

    it('validates a genuine PNG image', async () => {
      const png = await createTestPng(300, 300);
      const result = await validateImageBuffer(png);

      expect(result.valid).toBe(true);
      expect(result.mimeType).toBe('image/png');
      expect(result.width).toBe(300);
      expect(result.height).toBe(300);
    });

    it('validates a genuine WebP image', async () => {
      const webp = await createTestWebp(150, 120);
      const result = await validateImageBuffer(webp);

      expect(result.valid).toBe(true);
      expect(result.mimeType).toBe('image/webp');
      expect(result.width).toBe(150);
      expect(result.height).toBe(120);
    });

    it('rejects empty 0-byte buffer with EMPTY_FILE', async () => {
      await expect(validateImageBuffer(Buffer.alloc(0))).rejects.toThrowError(
        expect.objectContaining({ code: 'EMPTY_FILE', statusCode: 400 })
      );
    });

    it('rejects files exceeding 10 MiB with FILE_TOO_LARGE', async () => {
      const oversizedBuf = Buffer.alloc(MAX_FILE_BYTES + 1);
      // Put valid JPEG magic bytes at header to test size check priority
      oversizedBuf[0] = 0xff;
      oversizedBuf[1] = 0xd8;
      oversizedBuf[2] = 0xff;

      await expect(validateImageBuffer(oversizedBuf)).rejects.toThrowError(
        expect.objectContaining({ code: 'FILE_TOO_LARGE', statusCode: 400 })
      );
    });

    it('rejects SVG buffer with INVALID_FILE_FORMAT', async () => {
      await expect(validateImageBuffer(FAKE_SVG_BUFFER)).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_FILE_FORMAT', statusCode: 400 })
      );
    });

    it('rejects GIF buffer with INVALID_FILE_FORMAT', async () => {
      await expect(validateImageBuffer(FAKE_GIF_BUFFER)).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_FILE_FORMAT', statusCode: 400 })
      );
    });

    it('rejects HTML buffer with INVALID_FILE_FORMAT', async () => {
      await expect(validateImageBuffer(FAKE_HTML_BUFFER)).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_FILE_FORMAT', statusCode: 400 })
      );
    });

    it('rejects PSD buffer with INVALID_FILE_FORMAT', async () => {
      await expect(validateImageBuffer(FAKE_PSD_BUFFER)).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_FILE_FORMAT', statusCode: 400 })
      );
    });

    it('rejects images exceeding 20 Megapixels with RESOLUTION_EXCEEDED', async () => {
      const hugeImage = await createOversizedMegapixelJpeg();
      await expect(validateImageBuffer(hugeImage)).rejects.toThrowError(
        expect.objectContaining({ code: 'RESOLUTION_EXCEEDED', statusCode: 400 })
      );
    });

    it('rejects truncated/corrupt image data with CORRUPT_IMAGE', async () => {
      await expect(validateImageBuffer(TRUNCATED_JPEG_BUFFER)).rejects.toThrowError(
        expect.objectContaining({ code: 'CORRUPT_IMAGE', statusCode: 400 })
      );
    });
  });
});
