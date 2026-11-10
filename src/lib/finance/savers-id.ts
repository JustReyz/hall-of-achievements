import { createHash } from 'node:crypto';

export function saversImportId(kind: string, legacyId: string): string {
  const bytes = createHash('sha256').update(`hall-savers-v1:${kind}:${legacyId.toLowerCase()}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
