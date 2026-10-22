import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  processImageDerivatives,
  DISPLAY_MAX_EDGE,
  THUMBNAIL_MAX_EDGE,
} from '@/lib/image/processor';
import {
  createTestJpeg,
  createJpegWithExif,
} from '../helpers/image-fixtures';

describe('Unit: Image Processor & Derivative Pipeline', () => {
  it('generates display and thumbnail WebP derivatives with bounded dimensions', async () => {
    // 2000 x 1000 original image
    const largeOriginal = await createTestJpeg(2000, 1000);
    const result = await processImageDerivatives(largeOriginal);

    expect(result.displayBuffer).toBeInstanceOf(Buffer);
    expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);

    // Display derivative bounds: max 1600px along longest edge (2000 -> 1600, 1000 -> 800)
    expect(result.displayWidth).toBe(DISPLAY_MAX_EDGE);
    expect(result.displayHeight).toBe(800);
    expect(result.displayBytes).toBe(result.displayBuffer.length);

    // Thumbnail derivative bounds: max 400px along longest edge (2000 -> 400, 1000 -> 200)
    expect(result.thumbnailWidth).toBe(THUMBNAIL_MAX_EDGE);
    expect(result.thumbnailHeight).toBe(200);
    expect(result.thumbnailBytes).toBe(result.thumbnailBuffer.length);

    // Verify actual formats are WebP
    const displayMeta = await sharp(result.displayBuffer).metadata();
    expect(displayMeta.format).toBe('webp');

    const thumbMeta = await sharp(result.thumbnailBuffer).metadata();
    expect(thumbMeta.format).toBe('webp');
  });

  it('preserves native dimensions without artificial enlargement if smaller than bounds', async () => {
    // 300 x 150 image (smaller than 1600 and 400)
    const smallOriginal = await createTestJpeg(300, 150);
    const result = await processImageDerivatives(smallOriginal);

    // Display should remain 300 x 150 without enlargement
    expect(result.displayWidth).toBe(300);
    expect(result.displayHeight).toBe(150);

    // Thumbnail should remain 300 x 150 without enlargement
    expect(result.thumbnailWidth).toBe(300);
    expect(result.thumbnailHeight).toBe(150);
  });

  it('applies auto-orientation and strips all EXIF metadata from derivatives', async () => {
    const exifImage = await createJpegWithExif();

    // Verify original has EXIF orientation metadata
    const originalMeta = await sharp(exifImage).metadata();
    expect(originalMeta.orientation).toBe(6);

    const result = await processImageDerivatives(exifImage);

    // Verify derived WebP metadata has zero EXIF tags
    const derivedDisplayMeta = await sharp(result.displayBuffer).metadata();
    expect(derivedDisplayMeta.exif).toBeUndefined();
    expect(derivedDisplayMeta.orientation).toBeUndefined();

    const derivedThumbMeta = await sharp(result.thumbnailBuffer).metadata();
    expect(derivedThumbMeta.exif).toBeUndefined();
    expect(derivedThumbMeta.orientation).toBeUndefined();
  });

  it('keeps thumbnail byte size within performance budget (< 50 KiB)', async () => {
    const original = await createTestJpeg(800, 600);
    const result = await processImageDerivatives(original);

    // Thumbnail should be well under 50 KiB
    expect(result.thumbnailBytes).toBeLessThan(50 * 1024);
  });
});
