import crypto from 'node:crypto';
import { env } from '../env';
import { constantTimeCompare } from '../auth/crypto';

export type CapabilityAction = 'read' | 'write';

/**
 * Derives a domain-separated HMAC key from SESSION_VERSION_KEY for storage capability tokens.
 */
export function deriveCapabilitySecret(): string {
  return crypto
    .createHmac('sha256', env.SESSION_VERSION_KEY)
    .update('hall-of-achievements:storage-capability:v1', 'utf8')
    .digest('hex');
}

/**
 * Cryptographically signs a storage action capability (read/write) for a specific key and expiry.
 */
export function signStorageCapability(params: {
  action: CapabilityAction;
  key: string;
  expiresAt: number; // Unix epoch ms
  downloadFilename?: string | undefined;
}): string {
  const cleanKey = params.key.replace(/^\/+/, '');
  const message = [
    'v1',
    params.action,
    cleanKey,
    params.expiresAt.toString(),
    params.downloadFilename || '',
  ].join(':');

  return crypto
    .createHmac('sha256', deriveCapabilitySecret())
    .update(message, 'utf8')
    .digest('hex');
}

/**
 * Verifies a storage action capability token against expiration and cryptographic signature.
 */
export function verifyStorageCapability(params: {
  action: CapabilityAction;
  key: string;
  expiresAt: number;
  signature: string;
  downloadFilename?: string | undefined;
}): { valid: boolean; reason?: string } {
  if (!params.signature || typeof params.signature !== 'string') {
    return { valid: false, reason: 'Missing capability signature' };
  }
  if (!params.expiresAt || Number.isNaN(params.expiresAt)) {
    return { valid: false, reason: 'Invalid capability expiration' };
  }
  if (Date.now() > params.expiresAt) {
    return { valid: false, reason: 'Capability expired' };
  }

  const expected = signStorageCapability({
    action: params.action,
    key: params.key,
    expiresAt: params.expiresAt,
    downloadFilename: params.downloadFilename,
  });

  if (!constantTimeCompare(params.signature, expected)) {
    return { valid: false, reason: 'Invalid capability signature' };
  }

  return { valid: true };
}
