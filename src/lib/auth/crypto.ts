import crypto from 'node:crypto';
import { env } from '../env';

export const AUTH_VERSION_DOMAIN_PREFIX = 'hall-of-achievements:auth-version:v1:';

/**
 * Validates the user-provided code against OWNER_ACCESS_CODE in strictly constant time.
 * Pre-hashes inputs to SHA-256 digests (guaranteeing 32-byte buffers) to prevent RangeError
 * and eliminate length timing side channels.
 */
export function verifyOwnerAccessCode(
  inputCode: unknown,
  expectedSecret?: string
): boolean {
  const secret = arguments.length > 1 ? expectedSecret : env.OWNER_ACCESS_CODE;
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    console.error('[SECURITY FATAL] OWNER_ACCESS_CODE is missing or below entropy threshold. Failing closed.');
    return false;
  }

  // Treat non-string input safely without branch timing leakage
  const isInputString = typeof inputCode === 'string';
  const sanitizedInput = isInputString ? inputCode : '';

  // SHA-256 produces strictly 32 bytes for any input
  const inputHash = crypto.createHash('sha256').update(sanitizedInput, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(secret, 'utf8').digest();

  // timingSafeEqual executes in constant time on 32-byte buffers
  const matches = crypto.timingSafeEqual(inputHash, expectedHash);

  // Input must be a non-empty string that matched the expected secret
  return matches && isInputString && sanitizedInput.length > 0;
}

/**
 * Compares two strings in constant time by comparing their SHA-256 digests.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Generates a 256-bit CSPRNG session token and its SHA-256 database hash.
 */
export function generateSessionToken(): { rawToken: string; tokenHash: string } {
  // 32 random bytes = 256 bits entropy
  const rawBytes = crypto.randomBytes(32);
  const rawToken = rawBytes.toString('base64url');
  const tokenHash = hashSessionToken(rawToken);
  return { rawToken, tokenHash };
}

/**
 * Computes the SHA-256 hex digest of a session token for secure database lookup.
 */
export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Computes the domain-separated HMAC-SHA256 authentication version string.
 */
export function deriveAuthVersion(
  sessionVersionKey: string = env.SESSION_VERSION_KEY,
  ownerAccessCode: string = env.OWNER_ACCESS_CODE
): string {
  if (!sessionVersionKey || sessionVersionKey.length < 64) {
    throw new Error('SESSION_VERSION_KEY is missing or below entropy threshold (>= 64 hex chars)');
  }
  if (!ownerAccessCode || ownerAccessCode.length < 32) {
    throw new Error('OWNER_ACCESS_CODE is missing or below entropy threshold (>= 32 chars)');
  }

  const message = `${AUTH_VERSION_DOMAIN_PREFIX}${ownerAccessCode}`;
  return crypto
    .createHmac('sha256', sessionVersionKey)
    .update(message, 'utf8')
    .digest('hex');
}

/**
 * Computes a salted HMAC-SHA256 pseudonymized hash of a client IP address.
 */
export function hashClientIp(
  ip: string,
  rateLimitSalt: string = env.RATE_LIMIT_SALT
): string {
  if (!rateLimitSalt || rateLimitSalt.length < 32) {
    throw new Error('RATE_LIMIT_SALT is missing or below required length (>= 32 chars)');
  }
  return crypto
    .createHmac('sha256', rateLimitSalt)
    .update(`ip:${ip}`, 'utf8')
    .digest('hex');
}
