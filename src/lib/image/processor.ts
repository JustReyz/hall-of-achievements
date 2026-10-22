import sharp from 'sharp';
import { MAX_PIXELS } from './validator';
import { ProcessedDerivatives } from './types';

export const DISPLAY_MAX_EDGE = 1600;
export const THUMBNAIL_MAX_EDGE = 400;

export const DISPLAY_QUALITY = 85;
export const THUMBNAIL_QUALITY = 80;

/**
 * Image Processor:
 * Generates orientation-corrected, EXIF-sanitized WebP display and thumbnail derivatives.
 */
export async function processImageDerivatives(buffer: Buffer): Promise<ProcessedDerivatives> {
  // 1. Display Derivative: max 1600px inside bounding box, auto-rotated, EXIF stripped, WebP quality 85
  const displayTransformer = sharp(buffer, {
    failOn: 'error',
    limitInputPixels: MAX_PIXELS,
  })
    .rotate() // Automatically rotates according to EXIF orientation, strips orientation tag
    .resize({
      width: DISPLAY_MAX_EDGE,
      height: DISPLAY_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({
      quality: DISPLAY_QUALITY,
      effort: 4,
    });

  const displayBuffer = await displayTransformer.toBuffer();
  const displayMeta = await sharp(displayBuffer).metadata();

  // 2. Thumbnail Derivative: max 400px inside bounding box, auto-rotated, EXIF stripped, WebP quality 80
  const thumbnailTransformer = sharp(buffer, {
    failOn: 'error',
    limitInputPixels: MAX_PIXELS,
  })
    .rotate()
    .resize({
      width: THUMBNAIL_MAX_EDGE,
      height: THUMBNAIL_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({
      quality: THUMBNAIL_QUALITY,
      effort: 4,
    });

  const thumbnailBuffer = await thumbnailTransformer.toBuffer();
  const thumbnailMeta = await sharp(thumbnailBuffer).metadata();

  return {
    displayBuffer,
    displayWidth: displayMeta.width ?? 0,
    displayHeight: displayMeta.height ?? 0,
    displayBytes: displayBuffer.length,
    thumbnailBuffer,
    thumbnailWidth: thumbnailMeta.width ?? 0,
    thumbnailHeight: thumbnailMeta.height ?? 0,
    thumbnailBytes: thumbnailBuffer.length,
  };
}
