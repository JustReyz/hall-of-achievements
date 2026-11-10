import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createInMemoryDb, type AppDatabase } from '@/lib/db';
import { financeGroupMembers, financeGroups, financeNoteReminders, financeNotes, financeScheduledTasks, financeTransactions, financeUsers, financeWallets } from '@/lib/db/schema';
import { importSavers } from '@/lib/finance/savers-import';

const legacyUser = '00000000-0000-4000-8000-000000000001';
const wallet = '00000000-0000-4000-8000-000000000002';
const transaction = '00000000-0000-4000-8000-000000000003';
const note = '00000000-0000-4000-8000-000000000004';
const reminder = '00000000-0000-4000-8000-000000000005';
const task = '00000000-0000-4000-8000-000000000006';
const at = '2026-11-01T10:00:00.000Z';
const source = {
  users: [{ id: legacyUser, password_hash: 'not-imported' }],
  wallets: [{ id: wallet, name: 'Savings', type: 'regular', target_amount: null, default_category: null, current_balance: '100.50', created_at: at }],
  wallet_members: [{ wallet_id: wallet, user_id: legacyUser }],
  transactions: [{ id: transaction, wallet_id: wallet, user_id: legacyUser, type: 'income', category: null, amount: '100.50', notes: null, created_at: at }],
  notes: [{ id: note, user_id: legacyUser, title: 'Plan', content: 'Details', target_at: null, is_pinned: false, is_completed: false, created_at: at, updated_at: at }],
  note_reminders: [{ id: reminder, note_id: note, user_id: legacyUser, reminder_type: 'relative', lead_minutes: null, remind_at: at, recurrence: 'none', until_date: null, message: null, status: 'pending', delivered_count: 0, last_notified_at: null, created_at: at, updated_at: at }],
  scheduled_tasks: [{ id: task, user_id: legacyUser, title: 'Task', details: null, schedule_at: at, recurrence: 'once', is_active: true, last_notified_at: null, completed_at: null, created_at: at, updated_at: at }],
};

describe('Savers import', () => {
  let db: AppDatabase;
  let pglite: PGlite;
  let userId: string;
  let groupId: string;
  beforeEach(async () => {
    ({ db, pglite } = await createInMemoryDb());
    const [user] = await db.insert(financeUsers).values({ username: 'import-owner', displayName: 'Owner', passwordHash: 'existing-hash' }).returning();
    userId = user!.id;
    const [group] = await db.insert(financeGroups).values({ name: 'Private', createdBy: userId }).returning();
    groupId = group!.id;
    await db.insert(financeGroupMembers).values({ groupId, userId, role: 'owner' });
  });
  afterEach(async () => { await pglite.close(); });

  it('previews without writes, imports complete records and safely replays', async () => {
    const mapping = { users: { [legacyUser]: userId }, walletGroups: { [wallet]: groupId }, plannerGroups: { [legacyUser]: groupId } };
    const expected = { wallets: 1, transactions: 1, notes: 1, reminders: 1, scheduledTasks: 1, skipped: 0 };
    expect(await importSavers(db, source, mapping)).toEqual(expected);
    expect(await db.select().from(financeWallets)).toHaveLength(0);
    expect(await importSavers(db, source, mapping, { apply: true })).toEqual(expected);
    expect((await db.select().from(financeTransactions))[0]?.amount).toBe('100.50');
    expect(await db.select().from(financeNotes)).toHaveLength(1);
    expect(await db.select().from(financeNoteReminders)).toHaveLength(1);
    expect(await db.select().from(financeScheduledTasks)).toHaveLength(1);
    expect((await db.select().from(financeUsers))[0]?.passwordHash).toBe('existing-hash');
    expect(await importSavers(db, source, mapping, { apply: true })).toEqual({ wallets: 0, transactions: 0, notes: 0, reminders: 0, scheduledTasks: 0, skipped: 5 });
  });

  it('rejects a target group with additional members without writing records', async () => {
    const [other] = await db.insert(financeUsers).values({ username: 'other', displayName: 'Other', passwordHash: 'existing' }).returning();
    await db.insert(financeGroupMembers).values({ groupId, userId: other!.id, role: 'member' });
    const mapping = { users: { [legacyUser]: userId }, walletGroups: { [wallet]: groupId }, plannerGroups: { [legacyUser]: groupId } };
    await expect(importSavers(db, source, mapping, { apply: true })).rejects.toThrow('membership differs');
    expect(await db.select().from(financeWallets)).toHaveLength(0);
  });

  it('rejects an unbalanced export before writing records', async () => {
    const mapping = { users: { [legacyUser]: userId }, walletGroups: { [wallet]: groupId }, plannerGroups: { [legacyUser]: groupId } };
    const unbalanced = { ...source, wallets: [{ ...source.wallets[0]!, current_balance: '0.00' }] };
    await expect(importSavers(db, unbalanced, mapping, { apply: true })).rejects.toThrow('balance does not match');
    expect(await db.select().from(financeWallets)).toHaveLength(0);
  });

  it('rolls back earlier inserts when a replay changes a wallet mapping', async () => {
    const mapping = { users: { [legacyUser]: userId }, walletGroups: { [wallet]: groupId }, plannerGroups: { [legacyUser]: groupId } };
    await importSavers(db, source, mapping, { apply: true });
    const [otherGroup] = await db.insert(financeGroups).values({ name: 'Other private group', createdBy: userId }).returning();
    await db.insert(financeGroupMembers).values({ groupId: otherGroup!.id, userId, role: 'owner' });
    const newWallet = '00000000-0000-4000-8000-000000000007';
    const changedSource = {
      ...source,
      wallets: [{ ...source.wallets[0]!, id: newWallet, current_balance: '0.00' }, ...source.wallets],
      wallet_members: [{ wallet_id: newWallet, user_id: legacyUser }, ...source.wallet_members],
    };
    const changedMapping = { ...mapping, walletGroups: { [newWallet]: otherGroup!.id, [wallet]: otherGroup!.id } };
    await expect(importSavers(db, changedSource, changedMapping, { apply: true })).rejects.toThrow('previously mapped to another group');
    expect(await db.select().from(financeWallets)).toHaveLength(1);
  });

  it('rejects changed source records on replay instead of overwriting or skipping them', async () => {
    const mapping = { users: { [legacyUser]: userId }, walletGroups: { [wallet]: groupId }, plannerGroups: { [legacyUser]: groupId } };
    await importSavers(db, source, mapping, { apply: true });
    const changedSource = { ...source, notes: [{ ...source.notes[0]!, title: 'Changed in Savers' }] };
    await expect(importSavers(db, changedSource, mapping, { apply: true })).rejects.toThrow('has changed');
    expect((await db.select().from(financeNotes))[0]?.title).toBe('Plan');
  });

  it('does not recreate an imported note that was later deleted', async () => {
    const mapping = { users: { [legacyUser]: userId }, walletGroups: { [wallet]: groupId }, plannerGroups: { [legacyUser]: groupId } };
    await importSavers(db, source, mapping, { apply: true });
    await db.delete(financeNotes);
    await expect(importSavers(db, source, mapping, { apply: true })).rejects.toThrow('previously imported and later deleted');
    expect(await db.select().from(financeNotes)).toHaveLength(0);
  });

  it('detects a target balance that changed after import without modifying it', async () => {
    const mapping = { users: { [legacyUser]: userId }, walletGroups: { [wallet]: groupId }, plannerGroups: { [legacyUser]: groupId } };
    await importSavers(db, source, mapping, { apply: true });
    const [importedWallet] = await db.select().from(financeWallets);
    await db.insert(financeTransactions).values({ groupId, walletId: importedWallet!.id, type: 'income', amount: '1.00', transactionDate: '2026-11-02', createdBy: userId });
    await expect(importSavers(db, source, mapping, { apply: true })).rejects.toThrow('target balance differs');
    expect(await db.select().from(financeTransactions)).toHaveLength(2);
  });
});
