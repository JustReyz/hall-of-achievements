import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyOwnerAccessCode,
  constantTimeCompare,
  generateSessionToken,
  hashSessionToken,
  deriveAuthVersion,
  hashClientIp,
  AUTH_VERSION_DOMAIN_PREFIX,
} from '@/lib/auth/crypto';

describe('Unit: Cryptography & Secrets Architecture', () => {
  const validSecret = 'test_owner_access_code_32_characters_long_entropy!';

  describe('verifyOwnerAccessCode', () => {
    it('returns true for exact match', () => {
      expect(verifyOwnerAccessCode(validSecret, validSecret)).toBe(true);
    });

    it('returns false for mismatched code of equal length', () => {
      const wrong = 'test_owner_access_code_32_characters_long_wrong!!';
      expect(verifyOwnerAccessCode(wrong, validSecret)).toBe(false);
    });

    it('returns false for mismatched codes of different lengths without throwing RangeError', () => {
      const shortCodes = ['', 'a', '123', 'short'];
      for (const code of shortCodes) {
        expect(() => verifyOwnerAccessCode(code, validSecret)).not.toThrow();
        expect(verifyOwnerAccessCode(code, validSecret)).toBe(false);
      }

      const longCodes = [
        'a'.repeat(31),
        'b'.repeat(33),
        'c'.repeat(100),
        'd'.repeat(1000),
      ];
      for (const code of longCodes) {
        expect(() => verifyOwnerAccessCode(code, validSecret)).not.toThrow();
        expect(verifyOwnerAccessCode(code, validSecret)).toBe(false);
      }
    });

    it('does not silently trim or normalize input (preserves whitespace)', () => {
      expect(verifyOwnerAccessCode(` ${validSecret}`, validSecret)).toBe(false);
      expect(verifyOwnerAccessCode(`${validSecret} `, validSecret)).toBe(false);
      expect(verifyOwnerAccessCode(`\t${validSecret}\n`, validSecret)).toBe(false);
    });

    it('handles non-string inputs safely without throwing', () => {
      const invalidInputs = [null, undefined, 12345, {}, [], true, Symbol('code')];
      for (const input of invalidInputs) {
        expect(() => verifyOwnerAccessCode(input, validSecret)).not.toThrow();
        expect(verifyOwnerAccessCode(input, validSecret)).toBe(false);
      }
    });

    it('fails closed when server secret is missing, empty, or below entropy threshold', () => {
      expect(verifyOwnerAccessCode(validSecret, '')).toBe(false);
      expect(verifyOwnerAccessCode(validSecret, 'short_secret_under_32_chars')).toBe(false);
      expect(verifyOwnerAccessCode(validSecret, undefined as unknown as string)).toBe(false);
    });
  });

  describe('constantTimeCompare', () => {
    it('returns true for matching strings', () => {
      expect(constantTimeCompare('secret-version-12345', 'secret-version-12345')).toBe(true);
    });

    it('returns false for mismatched strings of any length without throwing', () => {
      expect(constantTimeCompare('abc', 'abcd')).toBe(false);
      expect(constantTimeCompare('version-1', 'version-2')).toBe(false);
      expect(constantTimeCompare('', 'non-empty')).toBe(false);
    });
  });

  describe('Session Token Generation & Hashing', () => {
    it('generates high-entropy 256-bit base64url tokens', () => {
      const { rawToken, tokenHash } = generateSessionToken();

      expect(typeof rawToken).toBe('string');
      // 32 bytes in base64url is 43 characters
      expect(rawToken.length).toBe(43);
      expect(/^[A-Za-z0-9_-]+$/.test(rawToken)).toBe(true);

      // SHA-256 hex digest is 64 characters
      expect(tokenHash.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(tokenHash)).toBe(true);
    });

    it('generates unique tokens on subsequent calls (CSPRNG)', () => {
      const token1 = generateSessionToken();
      const token2 = generateSessionToken();

      expect(token1.rawToken).not.toBe(token2.rawToken);
      expect(token1.tokenHash).not.toBe(token2.tokenHash);
    });

    it('deterministically hashes session tokens with SHA-256', () => {
      const raw = 'test_token_string_for_hash_verification_12345678';
      const expected = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

      expect(hashSessionToken(raw)).toBe(expected);
    });
  });

  describe('deriveAuthVersion', () => {
    const versionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    it('derives a 64-character hex HMAC using domain separation', () => {
      const version = deriveAuthVersion(versionKey, validSecret);
      expect(version.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(version)).toBe(true);

      const expected = crypto
        .createHmac('sha256', versionKey)
        .update(`${AUTH_VERSION_DOMAIN_PREFIX}${validSecret}`, 'utf8')
        .digest('hex');
      expect(version).toBe(expected);
    });

    it('changes version when access code changes', () => {
      const otherCode = 'different_owner_access_code_32_characters_long!!';
      const v1 = deriveAuthVersion(versionKey, validSecret);
      const v2 = deriveAuthVersion(versionKey, otherCode);
      expect(v1).not.toBe(v2);
    });

    it('changes version when version key changes', () => {
      const otherKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const v1 = deriveAuthVersion(versionKey, validSecret);
      const v2 = deriveAuthVersion(otherKey, validSecret);
      expect(v1).not.toBe(v2);
    });

    it('throws when secrets are below entropy threshold', () => {
      expect(() => deriveAuthVersion('short_key', validSecret)).toThrow();
      expect(() => deriveAuthVersion(versionKey, 'short_code')).toThrow();
    });
  });

  describe('hashClientIp', () => {
    const salt = 'test_rate_limit_salt_32_characters_long!';

    it('produces a deterministic HMAC-SHA256 pseudonymized hash', () => {
      const h1 = hashClientIp('192.168.1.1', salt);
      const h2 = hashClientIp('192.168.1.1', salt);
      expect(h1).toBe(h2);
      expect(h1.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(h1)).toBe(true);
    });

    it('produces distinct hashes for different IPs', () => {
      const h1 = hashClientIp('192.168.1.1', salt);
      const h2 = hashClientIp('192.168.1.2', salt);
      expect(h1).not.toBe(h2);
    });

    it('produces distinct hashes when salt changes', () => {
      const otherSalt = 'different_rate_limit_salt_32_characters_long!!';
      const h1 = hashClientIp('192.168.1.1', salt);
      const h2 = hashClientIp('192.168.1.1', otherSalt);
      expect(h1).not.toBe(h2);
    });
  });
});
