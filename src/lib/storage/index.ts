import { StorageAdapter } from './adapter';
import { MemoryStorageAdapter } from './memory';
import { SupabaseStorageAdapter } from './supabase';

let activeStorage: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (activeStorage) {
    return activeStorage;
  }

  // Use MemoryStorageAdapter in tests or when SUPABASE_URL is not configured
  if (process.env.NODE_ENV === 'test' || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    activeStorage = new MemoryStorageAdapter();
    return activeStorage;
  }

  activeStorage = new SupabaseStorageAdapter({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'achievements-private',
  });

  return activeStorage;
}

export function setStorageAdapter(adapter: StorageAdapter | null): void {
  activeStorage = adapter;
}
