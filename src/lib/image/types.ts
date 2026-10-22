export type AllowedMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ValidationSuccess {
  valid: true;
  mimeType: AllowedMimeType;
  byteLength: number;
  width: number;
  height: number;
  checksum: string;
}

export interface ProcessedDerivatives {
  displayBuffer: Buffer;
  displayWidth: number;
  displayHeight: number;
  displayBytes: number;
  thumbnailBuffer: Buffer;
  thumbnailWidth: number;
  thumbnailHeight: number;
  thumbnailBytes: number;
}
