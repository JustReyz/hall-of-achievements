import { z } from 'zod';
import { validateCalendarDate } from '../validation/achievement';

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const money = z.string().regex(/^\d{1,16}(?:\.\d{1,2})?$/);
const nullableMoney = money.nullable();
const nullableText = z.string().nullable();
const userSchema = z.object({
  id,
  username: z.string().regex(/^[a-z0-9_.-]{3,50}$/),
  passwordHash: z.string().regex(/^scrypt\$131072\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/),
  displayName: z.string().min(1).max(120),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
const groupSchema = z.object({ id, name: z.string().min(1).max(120), createdBy: id, createdAt: timestamp, updatedAt: timestamp }).strict();
const memberSchema = z.object({ groupId: id, userId: id, role: z.enum(['owner', 'admin', 'member']), createdAt: timestamp }).strict();
const sourceSchema = z.object({ id, groupId: id, name: z.string().min(1).max(100), type: z.enum(['cash', 'e-wallet', 'bank', 'other']), createdBy: id, deletedAt: timestamp.nullable(), createdAt: timestamp, updatedAt: timestamp }).strict();
const budgetSchema = z.object({ id, groupId: id, monthlyLimit: nullableMoney, currency: z.string().regex(/^[A-Z]{3}$/), enabled: z.boolean(), createdAt: timestamp, updatedAt: timestamp }).strict();
const walletSchema = z.object({ id, groupId: id, name: z.string().min(1).max(120), type: z.enum(['regular', 'goal']), targetAmount: nullableMoney, currency: z.string().regex(/^[A-Z]{3}$/), defaultCategory: nullableText, createdAt: timestamp, updatedAt: timestamp }).strict().refine((wallet) => wallet.type === 'regular' ? wallet.targetAmount === null : wallet.targetAmount !== null, 'wallet type and target do not match');
const transactionSchema = z.object({
  id, groupId: id, walletId: id, sourceId: id.nullable(), type: z.enum(['income', 'expense']), amount: money,
  category: nullableText, note: nullableText,
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validateCalendarDate),
  createdBy: id, updatedBy: id.nullable(), idempotencyKey: id.nullable(), deletedAt: timestamp.nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
const noteSchema = z.object({ id, groupId: id, createdBy: id, title: z.string().min(1).max(200), content: z.string().nullable(), targetAt: timestamp.nullable(), isPinned: z.boolean(), isCompleted: z.boolean(), createdAt: timestamp, updatedAt: timestamp }).strict();
const reminderSchema = z.object({
  id, groupId: id, noteId: id, createdBy: id,
  reminderType: z.enum(['relative', 'recurring']), leadMinutes: z.number().int().nonnegative().nullable(),
  remindAt: timestamp, recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']),
  untilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validateCalendarDate).nullable(),
  message: z.string().nullable(), status: z.enum(['pending', 'sent', 'cancelled']), deliveredCount: z.number().int().nonnegative(),
  lastNotifiedAt: timestamp.nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
const scheduledTaskSchema = z.object({
  id, groupId: id, createdBy: id, title: z.string().min(1).max(200), details: z.string().nullable(), scheduleAt: timestamp,
  recurrence: z.enum(['once', 'daily', 'weekly', 'monthly']), isActive: z.boolean(),
  lastNotifiedAt: timestamp.nullable(), completedAt: timestamp.nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict();

export const financeArchiveSchema = z.object({
  users: z.array(userSchema),
  groups: z.array(groupSchema),
  members: z.array(memberSchema),
  sources: z.array(sourceSchema),
  budgets: z.array(budgetSchema),
  wallets: z.array(walletSchema),
  transactions: z.array(transactionSchema),
  notes: z.array(noteSchema),
  reminders: z.array(reminderSchema),
  scheduledTasks: z.array(scheduledTaskSchema),
}).strict().superRefine((archive, context) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path: [path], message: 'duplicate identifiers' });
  };
  unique(archive.users.map((row) => row.id), 'users');
  unique(archive.groups.map((row) => row.id), 'groups');
  unique(archive.sources.map((row) => row.id), 'sources');
  unique(archive.budgets.map((row) => row.groupId), 'budgets');
  unique(archive.wallets.map((row) => row.id), 'wallets');
  unique(archive.transactions.map((row) => row.id), 'transactions');
  unique(archive.notes.map((row) => row.id), 'notes');
  unique(archive.reminders.map((row) => row.id), 'reminders');
  unique(archive.scheduledTasks.map((row) => row.id), 'scheduledTasks');
  const users = new Set(archive.users.map((row) => row.id));
  const groups = new Set(archive.groups.map((row) => row.id));
  const members = new Set(archive.members.map((row) => `${row.groupId}:${row.userId}`));
  const sources = new Map(archive.sources.map((row) => [row.id, row.groupId]));
  const wallets = new Map(archive.wallets.map((row) => [row.id, row.groupId]));
  const notes = new Map(archive.notes.map((row) => [row.id, row.groupId]));
  for (const row of archive.groups) if (!users.has(row.createdBy)) context.addIssue({ code: 'custom', path: ['groups'], message: `unknown creator ${row.createdBy}` });
  for (const row of archive.members) if (!groups.has(row.groupId) || !users.has(row.userId)) context.addIssue({ code: 'custom', path: ['members'], message: 'membership references an unknown group or user' });
  for (const row of archive.sources) if (!groups.has(row.groupId) || !users.has(row.createdBy)) context.addIssue({ code: 'custom', path: ['sources'], message: 'source references an unknown group or creator' });
  for (const row of archive.budgets) if (!groups.has(row.groupId)) context.addIssue({ code: 'custom', path: ['budgets'], message: 'budget references an unknown group' });
  for (const row of archive.wallets) if (!groups.has(row.groupId)) context.addIssue({ code: 'custom', path: ['wallets'], message: 'wallet references an unknown group' });
  for (const row of archive.transactions) {
    if (!users.has(row.createdBy) || wallets.get(row.walletId) !== row.groupId ||
        (row.sourceId !== null && sources.get(row.sourceId) !== row.groupId) ||
        (row.updatedBy !== null && !users.has(row.updatedBy))) {
      context.addIssue({ code: 'custom', path: ['transactions'], message: `transaction ${row.id} references invalid finance records` });
    }
  }
  for (const row of archive.notes) if (!groups.has(row.groupId) || !users.has(row.createdBy)) context.addIssue({ code: 'custom', path: ['notes'], message: 'note references an unknown group or user' });
  for (const row of archive.reminders) if (notes.get(row.noteId) !== row.groupId || !members.has(`${row.groupId}:${row.createdBy}`)) context.addIssue({ code: 'custom', path: ['reminders'], message: 'reminder references an unknown note or group member' });
  for (const row of archive.scheduledTasks) if (!groups.has(row.groupId) || !members.has(`${row.groupId}:${row.createdBy}`)) context.addIssue({ code: 'custom', path: ['scheduledTasks'], message: 'scheduled task references an unknown group member' });
});

export type FinanceArchive = z.infer<typeof financeArchiveSchema>;
