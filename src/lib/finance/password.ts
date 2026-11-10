import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashFinancePassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 256) {
    throw new Error('Password must be at least 12 characters and at most 256 bytes.');
  }
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyFinancePassword(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 256) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '131072' || parts[2] !== '8' || parts[3] !== '1' || !/^[0-9a-f]{32}$/.test(parts[4] ?? '') || !/^[0-9a-f]{128}$/.test(parts[5] ?? '')) return false;
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}
