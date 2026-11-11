import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@/lib/db/schema';
import { initTables, type AppDatabase } from '@/lib/db';
import { createGroup, createTransaction, createWallet, listWallets } from '@/lib/finance/ledger';
import type { FinanceSessionContext } from '@/lib/finance/auth';
import { importSavers } from '@/lib/finance/savers-import';
import { applyArchiveSchemaUpgrades } from '@/lib/db/schema-upgrades';
import { registerFinanceDevice, sendFinanceReminder } from '@/lib/finance/push';
import * as egress from '@/lib/push/egress';
import webpush from 'web-push';
import { createECDH } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exportArchive } from '@/lib/operations/export';
import { restoreArchive } from '@/lib/operations/restore';
import { MemoryStorageAdapter } from '@/lib/storage/memory';

const url = process.env.FINANCE_AUDIT_POSTGRES_URL;
const allowedUrl = 'postgresql://finance_audit@127.0.0.1:55439/postgres';
const passwordHash = `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;

describe.skipIf(!url)('finance on isolated PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let db: AppDatabase;
  let secondDb: AppDatabase;
  let schemaName: string;

  beforeAll(async () => {
    if (url !== allowedUrl) throw new Error('PostgreSQL audit is restricted to the isolated local finance_audit server.');
    schemaName = `finance_audit_${randomBytes(16).toString('hex')}`;
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schemaName}`, max: 6 });
    await initTables({ query: (statement, params) => pool.query(statement, params) });
    db = drizzle(pool, { schema }) as unknown as AppDatabase;
    secondDb = drizzle(pool, { schema }) as unknown as AppDatabase;
  }, 30000);

  afterAll(async () => {
    await pool?.end();
    if (admin && /^finance_audit_[0-9a-f]{32}$/.test(schemaName)) await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin?.end();
  });

  it('enforces wallet locks across independent database instances', async () => {
    const [owner, member] = await db.insert(schema.financeUsers).values([
      { username: 'pg-owner', displayName: 'Owner', passwordHash },
      { username: 'pg-member', displayName: 'Member', passwordHash },
    ]).returning();
    const expiresAt = new Date(Date.now() + 120_000);
    const first: FinanceSessionContext = { userId: owner!.id, financeTokenHash: 'a'.repeat(64), hallTokenHash: null };
    const second: FinanceSessionContext = { userId: member!.id, financeTokenHash: 'b'.repeat(64), hallTokenHash: null };
    await db.insert(schema.financeSessions).values([first, second].map((context) => ({ tokenHash: context.financeTokenHash, userId: context.userId, expiresAt, idleExpiresAt: expiresAt })));
    const group = await createGroup(db, first, { name: 'Postgres concurrency' });
    await db.insert(schema.financeGroupMembers).values({ groupId: group.id, userId: member!.id, role: 'member' });
    const wallet = await createWallet(db, first, { groupId: group.id, name: 'Wallet', type: 'regular' });
    await createTransaction(db, first, randomUUID(), { walletId: wallet.id, type: 'income', amount: '100.00' });
    const results = await Promise.allSettled([
      createTransaction(db, first, randomUUID(), { walletId: wallet.id, type: 'expense', amount: '80.00' }),
      createTransaction(secondDb, second, randomUUID(), { walletId: wallet.id, type: 'expense', amount: '80.00' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await listWallets(db, first.userId, group.id))[0]?.balance).toBe('20.00');
  }, 30000);

  it('previews, imports, and replays a mapped Savers wallet atomically', async () => {
    const [owner] = await db.insert(schema.financeUsers).values({ username: 'pg-import-owner', displayName: 'Owner', passwordHash }).returning();
    const [group] = await db.insert(schema.financeGroups).values({ name: 'Private import', createdBy: owner!.id }).returning();
    await db.insert(schema.financeGroupMembers).values({ groupId: group!.id, userId: owner!.id, role: 'owner' });
    const legacyUser = randomUUID(), legacyWallet = randomUUID(), legacyTransaction = randomUUID();
    const source = {
      users: [{ id: legacyUser }],
      wallets: [{ id: legacyWallet, name: 'Imported', type: 'regular', target_amount: null, default_category: null, current_balance: '10.50', created_at: '2026-01-01T00:00:00Z' }],
      wallet_members: [{ user_id: legacyUser, wallet_id: legacyWallet }],
      transactions: [{ id: legacyTransaction, wallet_id: legacyWallet, user_id: legacyUser, type: 'income', category: null, amount: '10.50', notes: null, created_at: '2026-01-01T00:00:00Z' }],
      notes: [], note_reminders: [], scheduled_tasks: [],
    };
    const mappings = { users: { [legacyUser]: owner!.id }, walletGroups: { [legacyWallet]: group!.id }, plannerGroups: {} };
    expect((await importSavers(db, source, mappings)).wallets).toBe(1);
    expect(await listWallets(db, owner!.id, group!.id)).toHaveLength(0);
    expect((await importSavers(db, source, mappings, { apply: true })).transactions).toBe(1);
    expect((await listWallets(db, owner!.id, group!.id))[0]?.balance).toBe('10.50');
    expect((await importSavers(db, source, mappings, { apply: true })).skipped).toBe(2);
  }, 30000);

  it('migrates legacy planner foreign keys and preserves history after member removal', async () => {
    const [owner, user] = await db.insert(schema.financeUsers).values([
      { username: 'pg-history-owner', displayName: 'Owner', passwordHash },
      { username: 'pg-former', displayName: 'Former', passwordHash },
    ]).returning();
    const [group] = await db.insert(schema.financeGroups).values({ name: 'Planner history', createdBy: owner!.id }).returning();
    await db.insert(schema.financeGroupMembers).values([{ groupId: group!.id, userId: owner!.id, role: 'owner' }, { groupId: group!.id, userId: user!.id, role: 'member' }]);
    const [note] = await db.insert(schema.financeNotes).values({ groupId: group!.id, createdBy: user!.id, title: 'History' }).returning();
    await db.insert(schema.financeNoteReminders).values({ groupId: group!.id, noteId: note!.id, createdBy: user!.id, remindAt: new Date() });
    await db.insert(schema.financeScheduledTasks).values({ groupId: group!.id, createdBy: user!.id, title: 'Task', scheduleAt: new Date() });
    await pool.query(`ALTER TABLE finance_note_reminders DROP CONSTRAINT finance_note_reminders_creator_fk;
      ALTER TABLE finance_note_reminders ADD CONSTRAINT finance_note_reminders_member_group_fk FOREIGN KEY (group_id, created_by) REFERENCES finance_group_members(group_id, user_id) ON DELETE CASCADE;
      ALTER TABLE finance_scheduled_tasks DROP CONSTRAINT finance_scheduled_tasks_creator_fk;
      ALTER TABLE finance_scheduled_tasks ADD CONSTRAINT finance_scheduled_tasks_member_group_fk FOREIGN KEY (group_id, created_by) REFERENCES finance_group_members(group_id, user_id) ON DELETE CASCADE`);
    await applyArchiveSchemaUpgrades({ query: (statement, params) => pool.query(statement, params) });
    await pool.query('DELETE FROM finance_group_members WHERE group_id = $1 AND user_id = $2', [group!.id, user!.id]);
    expect((await pool.query('SELECT id FROM finance_note_reminders WHERE group_id = $1', [group!.id])).rowCount).toBe(1);
    expect((await pool.query('SELECT id FROM finance_scheduled_tasks WHERE group_id = $1', [group!.id])).rowCount).toBe(1);
  }, 30000);

  it('reserves one push attempt for concurrent retries across database instances', async () => {
    const [user] = await db.insert(schema.financeUsers).values({ username: 'pg-push', displayName: 'Push', passwordHash }).returning();
    const expiresAt = new Date(Date.now() + 120_000);
    const context: FinanceSessionContext = { userId: user!.id, financeTokenHash: 'c'.repeat(64), hallTokenHash: null };
    await db.insert(schema.financeSessions).values({ tokenHash: context.financeTokenHash, userId: user!.id, expiresAt, idleExpiresAt: expiresAt });
    const group = await createGroup(db, context, { name: 'Push' });
    const [note] = await db.insert(schema.financeNotes).values({ groupId: group.id, createdBy: user!.id, title: 'Private' }).returning();
    const [reminder] = await db.insert(schema.financeNoteReminders).values({ groupId: group.id, noteId: note!.id, createdBy: user!.id, remindAt: new Date() }).returning();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/postgres-test';
    const key = createECDH('prime256v1'); key.generateKeys();
    vi.spyOn(egress, 'validatePushEndpoint').mockResolvedValue({ valid: true, url: new URL(endpoint), resolvedIps: ['1.1.1.1'] });
    vi.spyOn(egress, 'assertPushEndpointSafe').mockResolvedValue({ url: new URL(endpoint), resolvedIps: ['1.1.1.1'] });
    const dispatch = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 } as never);
    try {
      const device = await registerFinanceDevice(db, context, { endpoint, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
      const input = { reminderId: reminder!.id, deviceIds: [device.id], idempotencyKey: randomUUID() };
      const result = await Promise.all([sendFinanceReminder(db, context, input), sendFinanceReminder(secondDb, context, input)]);
      expect(result.filter((item) => !item.replayed)).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); }
  }, 30000);

  it('round-trips finance records and import markers through the archive', async () => {
    const scratchRoot = path.resolve('.superpowers/postgres-audit');
    const outputDir = fs.mkdtempSync(path.join(scratchRoot, 'archive-'));
    const storage = new MemoryStorageAdapter();
    try {
      const before = await db.select().from(schema.financeImportRecords);
      expect(before.length).toBeGreaterThan(0);
      await exportArchive({ outputDir, db, storage });
      await db.delete(schema.financeImportRecords);
      await restoreArchive({ inputDir: outputDir, db, storage });
      expect(await db.select().from(schema.financeImportRecords)).toHaveLength(before.length);
    } finally {
      if (path.dirname(outputDir) === scratchRoot && path.basename(outputDir).startsWith('archive-')) fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }, 30000);

  it('does not lock membership before waiting to revoke a finance session during restore', async () => {
    const [member] = await db.select().from(schema.financeGroupMembers).limit(1);
    if (!member) throw new Error('Expected a finance membership');
    const expiresAt = new Date(Date.now() + 120_000);
    const [session] = await db.insert(schema.financeSessions).values({ tokenHash: randomBytes(32).toString('hex'), userId: member.userId, expiresAt, idleExpiresAt: expiresAt }).returning();
    const scratchRoot = path.resolve('.superpowers/postgres-audit');
    const outputDir = fs.mkdtempSync(path.join(scratchRoot, 'archive-'));
    const storage = new MemoryStorageAdapter();
    const client = await pool.connect();
    let restoring: Promise<unknown> | undefined;
    try {
      await exportArchive({ outputDir, db, storage });
      await client.query('BEGIN');
      await client.query('SET LOCAL lock_timeout = 1000');
      await client.query('SELECT 1 FROM finance_sessions WHERE token_hash = $1 FOR UPDATE', [session!.tokenHash]);
      const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
      restoring = restoreArchive({ inputDir: outputDir, db, storage });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE '%update%finance_sessions%'", [pid]);
        waiting = !!result.rowCount;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await client.query('SELECT 1 FROM finance_group_members WHERE group_id = $1 AND user_id = $2 FOR UPDATE', [member.groupId, member.userId]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await restoring;
      if (path.dirname(outputDir) === scratchRoot && path.basename(outputDir).startsWith('archive-')) fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }, 30000);

  it('waits for an in-flight finance login before revoking its session during restore', async () => {
    const [member] = await db.select().from(schema.financeGroupMembers).limit(1);
    if (!member) throw new Error('Expected a finance membership');
    const scratchRoot = path.resolve('.superpowers/postgres-audit');
    const outputDir = fs.mkdtempSync(path.join(scratchRoot, 'archive-'));
    const storage = new MemoryStorageAdapter();
    const client = await pool.connect();
    let restoring: Promise<unknown> | undefined;
    try {
      await exportArchive({ outputDir, db, storage });
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(1213153614, 1179209281)');
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 120_000);
      await client.query('INSERT INTO finance_sessions (token_hash, user_id, expires_at, idle_expires_at) VALUES ($1, $2, $3, $3)', [token, member.userId, expiresAt]);
      const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
      restoring = restoreArchive({ inputDir: outputDir, db, storage });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE '%pg_advisory_xact_lock%'", [pid]);
        waiting = !!result.rowCount;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await client.query('COMMIT');
      await restoring;
      restoring = undefined;
      const result = await pool.query('SELECT revoked_at FROM finance_sessions WHERE token_hash = $1', [token]);
      expect(result.rows[0]?.revoked_at).not.toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await restoring;
      if (path.dirname(outputDir) === scratchRoot && path.basename(outputDir).startsWith('archive-')) fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }, 30000);
});
