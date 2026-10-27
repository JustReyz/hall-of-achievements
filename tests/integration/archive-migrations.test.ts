import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { initTables } from '@/lib/db';

const poolState = vi.hoisted(() => ({
  client: null as null | {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    release: () => void;
  },
  endCalls: 0,
}));

vi.mock('@neondatabase/serverless', () => ({
  Pool: class {
    async connect() {
      return poolState.client;
    }
    async end() {
      poolState.endCalls++;
    }
  },
}));

const LEGACY_ACHIEVEMENTS_DDL = `
  CREATE TABLE achievements (
    id UUID PRIMARY KEY,
    title VARCHAR(120) NOT NULL,
    completion_date DATE NOT NULL,
    notes TEXT,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'deleting')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const LEGACY_ROW_ID = '11111111-1111-4111-8111-111111111111';

async function insertLegacyRow(pg: PGlite) {
  await pg.query(
    `INSERT INTO achievements (id, title, completion_date, tags, state)
     VALUES ($1, 'Legacy work', '2026-09-01', '[]'::jsonb, 'ready')`,
    [LEGACY_ROW_ID]
  );
}

async function readFramingColumns(pg: PGlite) {
  const result = await pg.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = 'achievements'
       AND column_name IN ('thumbnail_position_x', 'thumbnail_position_y')
     ORDER BY column_name`
  );
  return result.rows;
}

async function readFramingConstraints(pg: PGlite) {
  const result = await pg.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'achievements'::regclass
       AND contype = 'c'
       AND conname LIKE 'achievements_thumbnail_position_%'
     ORDER BY conname`
  );
  return result.rows.map((row) => row.conname);
}

async function expectRangeConstraints(pg: PGlite) {
  expect(await readFramingConstraints(pg)).toEqual([
    'achievements_thumbnail_position_x_check',
    'achievements_thumbnail_position_y_check',
  ]);

  const probeId = crypto.randomUUID();
  await pg.query(
    `INSERT INTO achievements (id, title, completion_date, state)
     VALUES ($1, 'Constraint probe', '2026-01-01', 'ready')`,
    [probeId]
  );

  try {
    await expect(
      pg.query(`UPDATE achievements SET thumbnail_position_x = 1.01`)
    ).rejects.toThrow(/check constraint/);
    await expect(
      pg.query(`UPDATE achievements SET thumbnail_position_y = -0.01`)
    ).rejects.toThrow(/check constraint/);
  } finally {
    await pg.query(`DELETE FROM achievements WHERE id = $1`, [probeId]);
  }
}

const openDatabases: PGlite[] = [];

function createPglite(): PGlite {
  const pg = new PGlite();
  openDatabases.push(pg);
  return pg;
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((pg) => pg.close()));
  poolState.client = null;
  poolState.endCalls = 0;
});

describe('Integration: additive archive schema migrations', () => {
  it('upgrades a pre-feature database without dropping existing rows', async () => {
    const pg = createPglite();
    await pg.query(LEGACY_ACHIEVEMENTS_DDL);
    await insertLegacyRow(pg);

    await initTables(pg);

    const columns = await readFramingColumns(pg);
    expect(columns).toEqual([
      {
        column_name: 'thumbnail_position_x',
        data_type: 'real',
        is_nullable: 'NO',
        column_default: '0.5',
      },
      {
        column_name: 'thumbnail_position_y',
        data_type: 'real',
        is_nullable: 'NO',
        column_default: '0.5',
      },
    ]);

    await expectRangeConstraints(pg);

    const row = await pg.query<{
      title: string;
      thumbnail_position_x: number;
      thumbnail_position_y: number;
    }>(
      `SELECT title, thumbnail_position_x, thumbnail_position_y
       FROM achievements WHERE id = $1`,
      [LEGACY_ROW_ID]
    );
    expect(row.rows).toEqual([
      { title: 'Legacy work', thumbnail_position_x: 0.5, thumbnail_position_y: 0.5 },
    ]);
  });

  it('repeats the upgrade safely on an already-upgraded database', async () => {
    const pg = createPglite();
    await pg.query(LEGACY_ACHIEVEMENTS_DDL);
    await insertLegacyRow(pg);

    await initTables(pg);
    await initTables(pg);
    await initTables(pg);

    expect(await readFramingColumns(pg)).toHaveLength(2);
    await expectRangeConstraints(pg);

    const count = await pg.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM achievements');
    expect(count.rows[0]?.count).toBe(1);
  });

  it('initializes a fresh database with defaulted and constrained framing columns', async () => {
    const pg = createPglite();
    await initTables(pg);

    expect(await readFramingColumns(pg)).toEqual([
      {
        column_name: 'thumbnail_position_x',
        data_type: 'real',
        is_nullable: 'NO',
        column_default: '0.5',
      },
      {
        column_name: 'thumbnail_position_y',
        data_type: 'real',
        is_nullable: 'NO',
        column_default: '0.5',
      },
    ]);
    await expectRangeConstraints(pg);
  });

  it('runs upgrades through a pooled-style client that only exposes query()', async () => {
    const pg = createPglite();
    const executed: string[] = [];
    const pooledClient = {
      query: async (sql: string, params?: unknown[]) => {
        executed.push(sql);
        return pg.query(sql, params);
      },
    };

    await initTables(pooledClient);

    expect(executed.some((sql) => sql.trimStart().startsWith('ALTER TABLE achievements'))).toBe(
      true
    );
    expect(await readFramingColumns(pg)).toHaveLength(2);
    await expectRangeConstraints(pg);
  });

  it('propagates an upgrade failure from the pooled initialization path', async () => {
    const pg = createPglite();
    await initTables(pg);

    const failingClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trimStart().startsWith('ALTER TABLE achievements')) {
          throw new Error('simulated pooled upgrade failure');
        }
        return pg.query(sql, params);
      },
    };

    await expect(initTables(failingClient)).rejects.toThrow('simulated pooled upgrade failure');
  });

  it('executes and fails upgrades through the locked db:migrate entry point', async () => {
    const pg = createPglite();
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock')) {
          return { rows: [] };
        }
        return pg.query(sql, params);
      },
      release: () => {},
    };
    poolState.client = client;

    const { runMigrations } = await import('@/lib/db/migrate');
    await runMigrations(`postgres://fake-${crypto.randomUUID()}`);

    expect(await readFramingColumns(pg)).toHaveLength(2);
    await expectRangeConstraints(pg);
    expect(poolState.endCalls).toBe(1);

    poolState.client = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock')) {
          return { rows: [] };
        }
        if (sql.trimStart().startsWith('ALTER TABLE achievements')) {
          throw new Error('simulated locked migration failure');
        }
        return pg.query(sql, params);
      },
      release: () => {},
    };

    await expect(runMigrations('postgres://fake-failure')).rejects.toThrow(
      'simulated locked migration failure'
    );
    expect(poolState.endCalls).toBe(2);
  });
});
