import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDatabase } from '@/lib/db';
import { financeGroups, financeGroupMembers, financeImportRecords, financeUsers, financeWallets, financeTransactions, financeNotes, financeNoteReminders, financeScheduledTasks } from '@/lib/db/schema';
import { preflightSaversExport } from './savers-preflight';
import { saversImportId as mappedId } from './savers-id';

const id = z.string().uuid();
const time = z.string().datetime({ offset: true });
const money = z.string().regex(/^\d{1,14}(?:\.\d{1,2})?$/);
const balance = z.string().regex(/^-?\d{1,14}(?:\.\d{1,2})?$/);
const text = (max: number) => z.string().max(max).nullable();
const sourceSchema = z.object({
  users: z.array(z.object({ id }).passthrough()),
  wallet_members: z.array(z.object({ wallet_id: id, user_id: id }).passthrough()),
  wallets: z.array(z.object({ id, name: z.string().trim().min(1).max(120), type: z.enum(['regular', 'goal']), target_amount: money.nullable(), default_category: text(100), current_balance: balance, created_at: time }).passthrough()),
  transactions: z.array(z.object({ id, wallet_id: id, user_id: id, type: z.enum(['income', 'expense']), category: text(100), amount: money, notes: text(10000), created_at: time }).passthrough()),
  notes: z.array(z.object({ id, user_id: id, title: z.string().trim().min(1).max(200), content: text(10000), target_at: time.nullable(), is_pinned: z.boolean(), is_completed: z.boolean(), created_at: time, updated_at: time }).passthrough()),
  note_reminders: z.array(z.object({ id, note_id: id, user_id: id, reminder_type: z.enum(['relative', 'recurring']), lead_minutes: z.number().int().nonnegative().nullable(), remind_at: time, recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']), until_date: z.string().date().nullable(), message: text(1000), status: z.enum(['pending', 'sent', 'cancelled']), delivered_count: z.number().int().nonnegative(), last_notified_at: time.nullable(), created_at: time, updated_at: time }).passthrough()),
  scheduled_tasks: z.array(z.object({ id, user_id: id, title: z.string().trim().min(1).max(200), details: text(10000), schedule_at: time, recurrence: z.enum(['once', 'daily', 'weekly', 'monthly']), is_active: z.boolean(), last_notified_at: time.nullable(), completed_at: time.nullable(), created_at: time, updated_at: time }).passthrough()),
}).passthrough();
const mappingsSchema = z.object({ users: z.record(z.string(), id), walletGroups: z.record(z.string(), id), plannerGroups: z.record(z.string(), id) }).strict();

const asDate = (value: string | null) => value === null ? null : new Date(value);
const sameDate = (left: Date | null, right: string | null) => left === null ? right === null : right !== null && left.getTime() === new Date(right).getTime();
const minor = (value: string) => {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -amount : amount;
};
class ImportPreview extends Error {
  constructor(readonly counts: ImportCounts) { super('Import preview rolled back.'); }
}
type ImportCounts = { wallets: number; transactions: number; notes: number; reminders: number; scheduledTasks: number; skipped: number };
function requireMapping(mapping: Record<string, string>, source: string, kind: string): string {
  const value = mapping[source];
  if (!value) throw new Error(`Missing ${kind} mapping for ${source}.`);
  return value;
}

/** Operator-only import into existing finance groups. No source credentials are copied. */
export async function importSavers(db: AppDatabase, rawSource: unknown, rawMappings: unknown, options: { apply?: boolean } = {}): Promise<ImportCounts> {
  const source = sourceSchema.parse(rawSource);
  const mappings = mappingsSchema.parse(rawMappings);
  const preflight = preflightSaversExport(source);
  if (!preflight.valid) throw new Error(`Savers preflight failed: ${preflight.problems.join(' ')}`);
  if (new Set(Object.values(mappings.users)).size !== Object.values(mappings.users).length) throw new Error('Each legacy user must map to a different finance user.');
  const sourceUsers = new Set(source.users.map((row) => row.id));
  for (const [label, ids] of [['note', source.notes.map((row) => row.id)], ['reminder', source.note_reminders.map((row) => row.id)], ['task', source.scheduled_tasks.map((row) => row.id)]] as const) {
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} identifiers.`);
  }
  for (const user of source.users) requireMapping(mappings.users, user.id, 'user');
  const noteUsers = new Map(source.notes.map((note) => [note.id, note.user_id]));
  for (const reminder of source.note_reminders) {
    if (noteUsers.get(reminder.note_id) !== reminder.user_id) throw new Error(`Reminder ${reminder.id} has an invalid note owner.`);
  }
  for (const row of [...source.notes, ...source.scheduled_tasks]) if (!sourceUsers.has(row.user_id)) throw new Error('Planner record references an unknown user.');
  const counts = { wallets: 0, transactions: 0, notes: 0, reminders: 0, scheduledTasks: 0, skipped: 0 };

  try { return await db.transaction(async (tx) => {
    const checkImportRecord = async (kind: 'wallet' | 'transaction' | 'note' | 'reminder' | 'task', legacyId: string, targetId: string, groupId: string, exists: boolean) => {
      const [record] = await tx.select().from(financeImportRecords).where(and(eq(financeImportRecords.kind, kind), eq(financeImportRecords.legacyId, legacyId))).for('update');
      if (record && (record.targetId !== targetId || record.groupId !== groupId)) throw new Error(`${kind} ${legacyId} was previously mapped to another group.`);
      if (record && !exists) throw new Error(`${kind} ${legacyId} was previously imported and later deleted.`);
      if (!record && exists) throw new Error(`${kind} ${legacyId} conflicts with an existing record.`);
      return !!record;
    };
    const markImported = async (kind: 'wallet' | 'transaction' | 'note' | 'reminder' | 'task', legacyId: string, targetId: string, groupId: string) => {
      await tx.insert(financeImportRecords).values({ kind, legacyId, targetId, groupId });
    };
    const targetMembers = new Map<string, Set<string>>();
    const groups = new Set([...source.wallets.map((w) => requireMapping(mappings.walletGroups, w.id, 'wallet group')), ...source.notes.map((n) => requireMapping(mappings.plannerGroups, n.user_id, 'planner group')), ...source.scheduled_tasks.map((t) => requireMapping(mappings.plannerGroups, t.user_id, 'planner group'))]);
    for (const userId of Object.values(mappings.users)) {
      const [user] = await tx.select({ id: financeUsers.id }).from(financeUsers).where(eq(financeUsers.id, userId)).for('update');
      if (!user) throw new Error(`Mapped finance user ${userId} does not exist.`);
    }
    for (const groupId of [...groups].sort()) {
      const [group] = await tx.select({ id: financeGroups.id }).from(financeGroups).where(eq(financeGroups.id, groupId)).for('update');
      if (!group) throw new Error(`Mapped finance group ${groupId} does not exist.`);
      const members = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers).where(eq(financeGroupMembers.groupId, groupId)).for('update');
      targetMembers.set(groupId, new Set(members.map((m) => m.userId)));
    }
    for (const wallet of source.wallets) {
      if ((wallet.type === 'regular') !== (wallet.target_amount === null)) throw new Error(`Wallet ${wallet.id} has an invalid target.`);
      const groupId = requireMapping(mappings.walletGroups, wallet.id, 'wallet group');
      const legacyMembers = source.wallet_members.filter((m) => m.wallet_id === wallet.id).map((m) => requireMapping(mappings.users, m.user_id, 'user'));
      const members = targetMembers.get(groupId)!;
      if (members.size !== legacyMembers.length || legacyMembers.some((member) => !members.has(member))) throw new Error(`Wallet ${wallet.id} membership differs from its target group.`);
    }
    for (const row of [...source.notes, ...source.scheduled_tasks]) {
      const groupId = requireMapping(mappings.plannerGroups, row.user_id, 'planner group');
      const userId = requireMapping(mappings.users, row.user_id, 'user');
      const members = targetMembers.get(groupId)!;
      if (members.size !== 1 || !members.has(userId)) throw new Error(`Planner group for ${row.user_id} must contain only the mapped user.`);
    }
    for (const row of source.wallets) {
      const walletId = mappedId('wallet', row.id), groupId = mappings.walletGroups[row.id]!;
      const [existing] = await tx.select().from(financeWallets).where(eq(financeWallets.id, walletId)).for('update');
      await checkImportRecord('wallet', row.id, walletId, groupId, !!existing);
      if (existing) {
        if (existing.groupId !== groupId) throw new Error(`Wallet ${row.id} was previously mapped to another group.`);
        if (existing.name !== row.name || existing.type !== row.type || existing.defaultCategory !== row.default_category || (existing.targetAmount === null ? row.target_amount !== null : row.target_amount === null || minor(existing.targetAmount) !== minor(row.target_amount))) throw new Error(`Wallet ${row.id} has changed; reconcile it before replay.`);
        counts.skipped++; continue;
      }
      await tx.insert(financeWallets).values({ id: walletId, groupId, name: row.name, type: row.type, targetAmount: row.target_amount, defaultCategory: row.default_category, createdAt: new Date(row.created_at), updatedAt: new Date(row.created_at) }); await markImported('wallet', row.id, walletId, groupId); counts.wallets++;
    }
    for (const row of source.transactions) {
      const txId = mappedId('transaction', row.id), walletId = mappedId('wallet', row.wallet_id), groupId = requireMapping(mappings.walletGroups, row.wallet_id, 'wallet group'), createdBy = requireMapping(mappings.users, row.user_id, 'user');
      const [existing] = await tx.select().from(financeTransactions).where(eq(financeTransactions.id, txId)).for('update');
      await checkImportRecord('transaction', row.id, txId, groupId, !!existing);
      if (existing) {
        if (existing.groupId !== groupId || existing.walletId !== walletId || existing.createdBy !== createdBy) throw new Error(`Transaction ${row.id} has a conflicting mapping.`);
        if (existing.deletedAt !== null || existing.type !== row.type || minor(existing.amount) !== minor(row.amount) || existing.category !== row.category || existing.note !== row.notes || existing.transactionDate !== new Date(row.created_at).toISOString().slice(0, 10)) throw new Error(`Transaction ${row.id} has changed; reconcile it before replay.`);
        counts.skipped++; continue;
      }
      await tx.insert(financeTransactions).values({ id: txId, groupId, walletId, type: row.type, amount: row.amount, category: row.category, note: row.notes, transactionDate: new Date(row.created_at).toISOString().slice(0, 10), createdBy, createdAt: new Date(row.created_at), updatedAt: new Date(row.created_at) }); await markImported('transaction', row.id, txId, groupId); counts.transactions++;
    }
    for (const row of source.notes) {
      const noteId = mappedId('note', row.id), groupId = mappings.plannerGroups[row.user_id]!, createdBy = mappings.users[row.user_id]!;
      const [existing] = await tx.select().from(financeNotes).where(eq(financeNotes.id, noteId)).for('update');
      await checkImportRecord('note', row.id, noteId, groupId, !!existing);
      if (existing) {
        if (existing.groupId !== groupId || existing.createdBy !== createdBy) throw new Error(`Note ${row.id} has a conflicting mapping.`);
        if (existing.title !== row.title || existing.content !== row.content || !sameDate(existing.targetAt, row.target_at) || existing.isPinned !== row.is_pinned || existing.isCompleted !== row.is_completed) throw new Error(`Note ${row.id} has changed; reconcile it before replay.`);
        counts.skipped++; continue;
      }
      await tx.insert(financeNotes).values({ id: noteId, groupId, createdBy, title: row.title, content: row.content, targetAt: asDate(row.target_at), isPinned: row.is_pinned, isCompleted: row.is_completed, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }); await markImported('note', row.id, noteId, groupId); counts.notes++;
    }
    for (const row of source.note_reminders) {
      const reminderId = mappedId('reminder', row.id), groupId = mappings.plannerGroups[row.user_id]!, createdBy = mappings.users[row.user_id]!, noteId = mappedId('note', row.note_id);
      const [existing] = await tx.select().from(financeNoteReminders).where(eq(financeNoteReminders.id, reminderId)).for('update');
      await checkImportRecord('reminder', row.id, reminderId, groupId, !!existing);
      if (existing) {
        if (existing.groupId !== groupId || existing.createdBy !== createdBy || existing.noteId !== noteId) throw new Error(`Reminder ${row.id} has a conflicting mapping.`);
        if (existing.reminderType !== row.reminder_type || existing.leadMinutes !== row.lead_minutes || !sameDate(existing.remindAt, row.remind_at) || existing.recurrence !== row.recurrence || existing.untilDate !== row.until_date || existing.message !== row.message || existing.status !== row.status || existing.deliveredCount !== row.delivered_count || !sameDate(existing.lastNotifiedAt, row.last_notified_at)) throw new Error(`Reminder ${row.id} has changed; reconcile it before replay.`);
        counts.skipped++; continue;
      }
      await tx.insert(financeNoteReminders).values({ id: reminderId, groupId, createdBy, noteId, reminderType: row.reminder_type, leadMinutes: row.lead_minutes, remindAt: new Date(row.remind_at), recurrence: row.recurrence, untilDate: row.until_date, message: row.message, status: row.status, deliveredCount: row.delivered_count, lastNotifiedAt: asDate(row.last_notified_at), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }); await markImported('reminder', row.id, reminderId, groupId); counts.reminders++;
    }
    for (const row of source.scheduled_tasks) {
      const taskId = mappedId('task', row.id), groupId = mappings.plannerGroups[row.user_id]!, createdBy = mappings.users[row.user_id]!;
      const [existing] = await tx.select().from(financeScheduledTasks).where(eq(financeScheduledTasks.id, taskId)).for('update');
      await checkImportRecord('task', row.id, taskId, groupId, !!existing);
      if (existing) {
        if (existing.groupId !== groupId || existing.createdBy !== createdBy) throw new Error(`Task ${row.id} has a conflicting mapping.`);
        if (existing.title !== row.title || existing.details !== row.details || !sameDate(existing.scheduleAt, row.schedule_at) || existing.recurrence !== row.recurrence || existing.isActive !== row.is_active || !sameDate(existing.lastNotifiedAt, row.last_notified_at) || !sameDate(existing.completedAt, row.completed_at)) throw new Error(`Task ${row.id} has changed; reconcile it before replay.`);
        counts.skipped++; continue;
      }
      await tx.insert(financeScheduledTasks).values({ id: taskId, groupId, createdBy, title: row.title, details: row.details, scheduleAt: new Date(row.schedule_at), recurrence: row.recurrence, isActive: row.is_active, lastNotifiedAt: asDate(row.last_notified_at), completedAt: asDate(row.completed_at), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }); await markImported('task', row.id, taskId, groupId); counts.scheduledTasks++;
    }
    for (const wallet of source.wallets) {
      const [result] = await tx.select({ balance: sql<string>`COALESCE(SUM(CASE WHEN ${financeTransactions.type} = 'income' THEN ${financeTransactions.amount} ELSE -${financeTransactions.amount} END), 0)::text` })
        .from(financeTransactions).where(and(eq(financeTransactions.walletId, mappedId('wallet', wallet.id)), isNull(financeTransactions.deletedAt)));
      if (!result || minor(result.balance) !== minor(wallet.current_balance)) throw new Error(`Wallet ${wallet.id} target balance differs from the source; reconcile it before import.`);
    }
    if (!options.apply) throw new ImportPreview(counts);
    return counts;
  }); } catch (error) {
    if (error instanceof ImportPreview) return error.counts;
    throw error;
  }
}
