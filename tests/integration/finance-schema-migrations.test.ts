import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { initTables } from '@/lib/db';
import { applyArchiveSchemaUpgrades } from '@/lib/db/schema-upgrades';

describe('finance schema migrations', () => {
  beforeEach(() => vi.stubEnv('FINANCE_EXPERIMENTAL', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('creates only additive finance tables while routes remain feature-gated', async () => {
    vi.stubEnv('FINANCE_EXPERIMENTAL', 'false');
    const pg = new PGlite();
    try {
      await initTables(pg);
      const result = await pg.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'finance_%'`);
      expect(result.rows.map((row) => row.table_name).sort()).toEqual([
        'finance_budgets', 'finance_group_members', 'finance_groups', 'finance_import_records', 'finance_invitations', 'finance_note_reminders', 'finance_notes',
        'finance_push_attempts', 'finance_push_subscriptions', 'finance_scheduled_tasks', 'finance_sessions', 'finance_sources', 'finance_transactions', 'finance_users', 'finance_wallets',
      ]);
    } finally { await pg.close(); }
  });
  it('preserves archive data and applies additive upgrades repeatedly on both initialization paths', async () => {
    const pg = new PGlite();
    try {
      await initTables(pg);
      await pg.query(`INSERT INTO achievements (id, title, completion_date) VALUES ('11111111-1111-4111-8111-111111111111', 'Existing archive', '2026-01-01')`);
      // The query-only wrapper exercises the pooled database initialization path.
      await initTables({ query: (statement, params) => pg.query(statement, params) });
      const existing = await pg.query<{ title: string }>(`SELECT title FROM achievements WHERE id = '11111111-1111-4111-8111-111111111111'`);
      expect(existing.rows[0]?.title).toBe('Existing archive');
      const tables = await pg.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'finance_%'`);
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        'finance_budgets', 'finance_group_members', 'finance_groups', 'finance_import_records', 'finance_invitations', 'finance_note_reminders', 'finance_notes',
        'finance_push_attempts', 'finance_push_subscriptions', 'finance_scheduled_tasks', 'finance_sessions', 'finance_sources', 'finance_transactions', 'finance_users', 'finance_wallets',
      ]);
    } finally {
      await pg.close();
    }
  });

  it('migrates old membership cascades without deleting existing planner records', async () => {
    const pg = new PGlite();
    try {
      await initTables(pg);
      await pg.exec(`
        INSERT INTO finance_users (id, username, password_hash, display_name) VALUES ('11111111-1111-4111-8111-111111111111', 'old-member', 'hash', 'Member');
        INSERT INTO finance_groups (id, name, created_by) VALUES ('22222222-2222-4222-8222-222222222222', 'Group', '11111111-1111-4111-8111-111111111111');
        INSERT INTO finance_group_members (group_id, user_id, role) VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'owner');
        INSERT INTO finance_notes (id, group_id, created_by, title) VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Note');
        INSERT INTO finance_note_reminders (group_id, note_id, created_by, remind_at) VALUES ('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', NOW());
        INSERT INTO finance_scheduled_tasks (group_id, created_by, title, schedule_at) VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Task', NOW());
        ALTER TABLE finance_note_reminders DROP CONSTRAINT finance_note_reminders_creator_fk;
        ALTER TABLE finance_note_reminders ADD CONSTRAINT finance_note_reminders_member_group_fk FOREIGN KEY (group_id, created_by) REFERENCES finance_group_members(group_id, user_id) ON DELETE CASCADE;
        ALTER TABLE finance_scheduled_tasks DROP CONSTRAINT finance_scheduled_tasks_creator_fk;
        ALTER TABLE finance_scheduled_tasks ADD CONSTRAINT finance_scheduled_tasks_member_group_fk FOREIGN KEY (group_id, created_by) REFERENCES finance_group_members(group_id, user_id) ON DELETE CASCADE;
      `);
      await applyArchiveSchemaUpgrades(pg);
      await pg.query(`DELETE FROM finance_group_members WHERE user_id = '11111111-1111-4111-8111-111111111111'`);
      expect((await pg.query('SELECT id FROM finance_note_reminders')).rows).toHaveLength(1);
      expect((await pg.query('SELECT id FROM finance_scheduled_tasks')).rows).toHaveLength(1);
      await applyArchiveSchemaUpgrades(pg);
    } finally { await pg.close(); }
  });

  it('keeps monetary precision and rejects mismatched groups, invalid amounts and duplicate requests', async () => {
    const pg = new PGlite();
    try {
      await initTables(pg);
      await pg.query(`INSERT INTO finance_users (id, username, password_hash, display_name) VALUES ('11111111-1111-4111-8111-111111111111', 'owner', 'test-hash', 'Owner')`);
      await pg.query(`INSERT INTO finance_groups (id, name, created_by) VALUES ('22222222-2222-4222-8222-222222222222', 'One', '11111111-1111-4111-8111-111111111111'), ('33333333-3333-4333-8333-333333333333', 'Two', '11111111-1111-4111-8111-111111111111')`);
      await pg.query(`INSERT INTO finance_wallets (id, group_id, name, type) VALUES ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', 'Wallet', 'regular')`);
      await expect(pg.query(`INSERT INTO finance_wallets (group_id, name, type) VALUES ('22222222-2222-4222-8222-222222222222', 'Bad goal', 'goal')`)).rejects.toThrow();
      const insert = `INSERT INTO finance_transactions (group_id, wallet_id, type, amount, transaction_date, created_by, idempotency_key) VALUES ($1, '44444444-4444-4444-8444-444444444444', 'income', $2, '2026-01-01', '11111111-1111-4111-8111-111111111111', $3)`;
      const group = '22222222-2222-4222-8222-222222222222';
      const key = '55555555-5555-4555-8555-555555555555';
      await pg.query(insert, [group, '900719925474099.23', key]);
      const amount = await pg.query<{ amount: string }>(`SELECT amount::text AS amount FROM finance_transactions`);
      expect(amount.rows[0]?.amount).toBe('900719925474099.23');
      await expect(pg.query(insert, ['33333333-3333-4333-8333-333333333333', '1.00', null])).rejects.toThrow();
      await expect(pg.query(insert, [group, '0', null])).rejects.toThrow();
      await expect(pg.query(insert, [group, 'NaN', null])).rejects.toThrow();
      await expect(pg.query(insert, [group, '1.00', key])).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
});
