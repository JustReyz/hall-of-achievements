// Vitest test setup
const envObj = process.env as Record<string, string | undefined>;
envObj.NODE_ENV = 'test';
envObj.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
envObj.OWNER_ACCESS_CODE = 'test_owner_access_code_32_characters_long_entropy!';
envObj.SESSION_VERSION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
envObj.RATE_LIMIT_SALT = 'test_rate_limit_salt_32_characters_long!';
envObj.APP_ORIGIN = 'http://localhost:3000';
