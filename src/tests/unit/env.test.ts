import { describe, it, expect, vi } from 'vitest';
import { parseEnv, EnvironmentValidationError } from '@/lib/env';

describe('Unit: Environment Boot Validation & Zero-Leak Redactor', () => {
  const validBaseEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/dbname',
    OWNER_ACCESS_CODE: 'valid_access_code_must_be_at_least_32_characters_long',
    SESSION_VERSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    RATE_LIMIT_SALT: 'valid_rate_limit_salt_at_least_32_chars_entropy',
    APP_ORIGIN: 'http://localhost:3000',
  };

  it('parses valid environment variables cleanly', () => {
    const env = parseEnv(validBaseEnv);
    expect(env.NODE_ENV).toBe('test');
    expect(env.DATABASE_URL).toBe(validBaseEnv.DATABASE_URL);
    expect(env.OWNER_ACCESS_CODE).toBe(validBaseEnv.OWNER_ACCESS_CODE);
    expect(env.SESSION_VERSION_KEY).toBe(validBaseEnv.SESSION_VERSION_KEY);
    expect(env.RATE_LIMIT_SALT).toBe(validBaseEnv.RATE_LIMIT_SALT);
    expect(env.APP_ORIGIN).toBe('http://localhost:3000');
  });

  it('rejects missing or short OWNER_ACCESS_CODE (< 32 chars)', () => {
    expect(() =>
      parseEnv({
        ...validBaseEnv,
        OWNER_ACCESS_CODE: 'short_code',
      })
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      parseEnv({
        ...validBaseEnv,
        OWNER_ACCESS_CODE: undefined,
      })
    ).toThrow(EnvironmentValidationError);
  });

  it('rejects SESSION_VERSION_KEY with < 64 hex characters or non-hex characters', () => {
    // Too short
    expect(() =>
      parseEnv({
        ...validBaseEnv,
        SESSION_VERSION_KEY: 'abcdef0123456789',
      })
    ).toThrow(EnvironmentValidationError);

    // Non-hex characters
    expect(() =>
      parseEnv({
        ...validBaseEnv,
        SESSION_VERSION_KEY: 'g'.repeat(64),
      })
    ).toThrow(EnvironmentValidationError);
  });

  it('rejects RATE_LIMIT_SALT < 32 characters', () => {
    expect(() =>
      parseEnv({
        ...validBaseEnv,
        RATE_LIMIT_SALT: 'short_salt',
      })
    ).toThrow(EnvironmentValidationError);
  });

  it('rejects non-PostgreSQL DATABASE_URL', () => {
    expect(() =>
      parseEnv({
        ...validBaseEnv,
        DATABASE_URL: 'mysql://localhost:3306/db',
      })
    ).toThrow(EnvironmentValidationError);

    expect(() =>
      parseEnv({
        ...validBaseEnv,
        DATABASE_URL: 'invalid-url',
      })
    ).toThrow(EnvironmentValidationError);
  });

  it('enforces zero-leak redactor: errors never leak secret values in message or logs', () => {
    const secretLeakedValue = 'super_sensitive_password_that_must_never_be_logged_12345';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() =>
        parseEnv({
          ...validBaseEnv,
          // Intentionally trigger validation error with weak hex secret
          SESSION_VERSION_KEY: secretLeakedValue,
        })
      ).toThrow(EnvironmentValidationError);

      // Verify thrown error message does not contain the sensitive value
      try {
        parseEnv({
          ...validBaseEnv,
          SESSION_VERSION_KEY: secretLeakedValue,
        });
      } catch (err) {
        const error = err as EnvironmentValidationError;
        expect(error.message).not.toContain(secretLeakedValue);
        expect(JSON.stringify(error.issues)).not.toContain(secretLeakedValue);
      }

      // Verify console.error logs do not contain the sensitive value
      for (const call of consoleSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(secretLeakedValue);
        }
      }
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
