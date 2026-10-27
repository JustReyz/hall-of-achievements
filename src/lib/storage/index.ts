import { StorageAdapter } from './adapter';
import { MemoryStorageAdapter } from './memory';
import { SupabaseStorageAdapter } from './supabase';
import { PostgresStorageAdapter } from './postgres';
import { env } from '../env';

let activeStorage: StorageAdapter | null = null;

// Next dev re-evaluates route modules when a new route compiles. Keeping the
// adapter on globalThis preserves in-memory uploads across those reloads; a
// process restart still starts with empty storage.
const globalForStorage = globalThis as typeof globalThis & {
  __hallOfAchievementsStorage?: StorageAdapter;
};

export function getStorage(): StorageAdapter {
  if (activeStorage) {
    return activeStorage;
  }

  const cached = globalForStorage.__hallOfAchievementsStorage;
  if (cached) {
    activeStorage = cached;
    return cached;
  }

  // 1. If Supabase is explicitly configured, use SupabaseStorageAdapter
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    activeStorage = new SupabaseStorageAdapter({
      url: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET || 'achievements-private',
    });
    globalForStorage.__hallOfAchievementsStorage = activeStorage;
    return activeStorage;
  }

  // 2. In unit/integration tests or offline environments with in-memory DB, use MemoryStorageAdapter
  if (process.env.NODE_ENV === 'test' || !env.DATABASE_URL || env.DATABASE_URL.includes('localhost:5432/test_db')) {
    activeStorage = new MemoryStorageAdapter();
    globalForStorage.__hallOfAchievementsStorage = activeStorage;
    return activeStorage;
  }

  // 3. In live serverless deployment (Vercel + Neon PostgreSQL), use durable PostgresStorageAdapter
  activeStorage = new PostgresStorageAdapter(env.DATABASE_URL);
  globalForStorage.__hallOfAchievementsStorage = activeStorage;
  return activeStorage;
}

export function setStorageAdapter(adapter: StorageAdapter | null): void {
  activeStorage = adapter;
  if (adapter) {
    globalForStorage.__hallOfAchievementsStorage = adapter;
  } else {
    delete globalForStorage.__hallOfAchievementsStorage;
  }
}
