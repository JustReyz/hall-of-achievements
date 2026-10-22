import sharp from 'sharp';

/**
 * Creates genuine image buffers for test suites.
 */
export async function createTestJpeg(width = 200, height = 200): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 100, b: 50 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function createTestPng(width = 200, height = 200): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 50, g: 150, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

export async function createTestWebp(width = 200, height = 200): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 200, b: 100 },
    },
  })
    .webp({ quality: 85 })
    .toBuffer();
}

/**
 * Generates an image that exceeds 20 Megapixels (e.g. 5000 x 4001 = 20,005,000 pixels).
 */
export async function createOversizedMegapixelJpeg(): Promise<Buffer> {
  return await sharp({
    create: {
      width: 5000,
      height: 4001,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .jpeg()
    .toBuffer();
}

/**
 * Generates an image with simulated EXIF metadata (Make, Model, Orientation).
 */
export async function createJpegWithExif(): Promise<Buffer> {
  return await sharp({
    create: {
      width: 300,
      height: 200,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .withMetadata({
      orientation: 6, // 90 degrees CW rotation needed
    })
    .jpeg()
    .toBuffer();
}

/**
 * Non-allowlisted format byte buffers.
 */
export const FAKE_SVG_BUFFER = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="red"/></svg>',
  'utf-8'
);

export const FAKE_GIF_BUFFER = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from([0x64, 0x00, 0x64, 0x00, 0x80, 0x00, 0x00]),
]);

export const FAKE_HTML_BUFFER = Buffer.from(
  '<!DOCTYPE html><html><body><script>alert("xss")</script></body></html>',
  'utf-8'
);

export const FAKE_PSD_BUFFER = Buffer.concat([
  Buffer.from('8BPS', 'ascii'),
  Buffer.alloc(20, 0),
]);

export const TRUNCATED_JPEG_BUFFER = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]),
  Buffer.alloc(20, 0),
]);
