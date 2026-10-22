import * as schema from './schema';
import { env } from '../env';

// For offline / hermetic testing and development without live PostgreSQL
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';

// For production Neon / PostgreSQL
import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';

export type AppDatabase = ReturnType<typeof drizzlePglite<typeof schema>>;

let globalClient: unknown = null;
let globalDb: AppDatabase | null = null;
let isDbOutageSimulated = false;

/**
 * Simulates a database outage for testing fail-closed resilience.
 */
export function setSimulatedDbOutage(enabled: boolean) {
  isDbOutageSimulated = enabled;
}

export function isDbOutageActive(): boolean {
  return isDbOutageSimulated;
}

/**
 * Creates or retrieves the hermetic in-memory PGlite database.
 */
export async function createInMemoryDb(): Promise<{ db: AppDatabase; pglite: PGlite }> {
  const pglite = new PGlite();
  const memoryDb = drizzlePglite(pglite, { schema });
  await initTables(pglite);
  return { db: memoryDb, pglite };
}

/**
 * Idempotently initializes database tables on a PGlite instance or client.
 */
export async function initTables(client: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  exec?: (sql: string) => Promise<unknown>;
}) {
  if (typeof client.exec === 'function') {
    await client.exec(`
      CREATE TABLE IF NOT EXISTS auth_state (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        current_version TEXT NOT NULL,
        rotation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO auth_state (id, current_version, rotation_metadata, updated_at)
      VALUES (1, 'initial_unconfigured', '{"initialized": true}'::jsonb, NOW())
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        auth_state_version TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        idle_expires_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT FALSE,
        revoked_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_expires_revoked ON sessions (expires_at, revoked);
      CREATE INDEX IF NOT EXISTS idx_sessions_auth_version ON sessions (auth_state_version);

      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'login_ip',
        attempt_count INTEGER NOT NULL DEFAULT 1,
        window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        blocked_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
    `);
    return;
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS auth_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      current_version TEXT NOT NULL,
      rotation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `INSERT INTO auth_state (id, current_version, rotation_metadata, updated_at)
    VALUES (1, 'initial_unconfigured', '{"initialized": true}'::jsonb, NOW())
    ON CONFLICT (id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      auth_state_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      idle_expires_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires_revoked ON sessions (expires_at, revoked)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_auth_version ON sessions (auth_state_version)`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'login_ip',
      attempt_count INTEGER NOT NULL DEFAULT 1,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      blocked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start)`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }
}

/**
 * Gets or initializes the database instance.
 * Automatically falls back to hermetic in-memory PGlite in test mode or when DATABASE_URL is not accessible.
 */
export async function getDb(): Promise<AppDatabase> {
  if (isDbOutageSimulated) {
    throw new Error('Database connection failed: simulated outage');
  }

  if (globalDb) {
    return globalDb;
  }

  // In test environment or offline execution, use hermetic PGlite WASM Postgres
  if (process.env.NODE_ENV === 'test' || !env.DATABASE_URL || env.DATABASE_URL.includes('localhost:5432/test_db')) {
    const { db: memoryDb, pglite } = await createInMemoryDb();
    globalClient = pglite;
    globalDb = memoryDb;
    return globalDb;
  }

  // In production / live environment, use Neon pooled serverless connection
  try {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 3000,
    });
    globalClient = pool;
    globalDb = drizzleNeon(pool, { schema }) as unknown as AppDatabase;
    return globalDb;
  } catch (err) {
    console.error('[DB FATAL] Failed to connect to PostgreSQL pool:', err);
    throw new Error('Database connection failed');
  }
}

/**
 * Resets the in-memory database for fresh test isolation.
 */
export async function resetDatabase(): Promise<AppDatabase> {
  if (globalClient && typeof (globalClient as { close?: () => Promise<void> }).close === 'function') {
    try {
      await (globalClient as { close: () => Promise<void> }).close();
    } catch {
      // ignore
    }
  }
  globalClient = null;
  globalDb = null;
  isDbOutageSimulated = false;
  return getDb();
}

export { schema };
