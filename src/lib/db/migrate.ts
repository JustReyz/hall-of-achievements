import { Pool } from '@neondatabase/serverless';
import { env } from '../env';
import { initTables } from './index';

const MIGRATION_LOCK_ID = 827419204;

export async function runMigrations(databaseUrl: string = env.DATABASE_URL) {
  console.log('[Migration] Starting idempotent database migrations...');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();

  try {
    console.log('[Migration] Acquiring pg_advisory_lock...');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    console.log('[Migration] Advisory lock acquired.');

    await initTables(client);

    console.log('[Migration] Idempotent table schemas verified.');
  } catch (err) {
    console.error('[Migration] Migration error:', err);
    throw err;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch {
      // ignore unlock error on teardown
    }
    client.release();
    await pool.end();
  }
}

// Allow direct CLI execution: tsx src/lib/db/migrate.ts
if (process.argv[1]?.includes('migrate.ts')) {
  runMigrations()
    .then(() => {
      console.log('[Migration] Successfully finished.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] Fatal error during migration:', err);
      process.exit(1);
    });
}
