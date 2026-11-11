import { and, desc, eq, getTableColumns } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { financeGroupMembers, financeNoteReminders, financeNotes, financeScheduledTasks } from '@/lib/db/schema';
import { validateCalendarDate } from '@/lib/validation/achievement';
import { lockFinanceSession, type FinanceSessionContext } from './auth';
import { FinanceLedgerError, requireUuid } from './ledger';

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new FinanceLedgerError('INVALID_INPUT', `${field} must contain 1 to ${max} characters.`, 400);
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new FinanceLedgerError('INVALID_INPUT', `${field} is invalid.`, 400);
  return value;
}

function timestamp(value: unknown, field: string, nullable = false): Date | null {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new FinanceLedgerError('INVALID_INPUT', `${field} must be an ISO timestamp with a timezone.`, 400);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new FinanceLedgerError('INVALID_INPUT', `${field} is invalid.`, 400);
  return parsed;
}

async function requireMembership(db: AppDatabase, userId: string, groupId: string) {
  const [member] = await db.select({ groupId: financeGroupMembers.groupId }).from(financeGroupMembers)
    .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
  if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
}

export async function listNotes(db: AppDatabase, userId: string, groupIdValue: unknown) {
  const groupId = requireUuid(groupIdValue, 'groupId');
  await requireMembership(db, userId, groupId);
  return db.select(getTableColumns(financeNotes)).from(financeNotes)
    .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeNotes.groupId), eq(financeGroupMembers.userId, userId)))
    .where(eq(financeNotes.groupId, groupId))
    .orderBy(desc(financeNotes.isPinned), desc(financeNotes.updatedAt));
}

export async function createNote(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const groupId = requireUuid(input.groupId, 'groupId');
  const title = requiredText(input.title, 'Title', 200);
  const content = optionalText(input.content, 'Content', 10000);
  const targetAt = timestamp(input.targetAt, 'targetAt', true);
  if (input.isPinned !== undefined && typeof input.isPinned !== 'boolean') throw new FinanceLedgerError('INVALID_INPUT', 'isPinned must be a boolean.', 400);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
    const [note] = await tx.insert(financeNotes).values({ groupId, createdBy: context.userId, title, content, targetAt, isPinned: input.isPinned === true })
      .returning();
    if (!note) throw new Error('Could not create note.');
    await lockFinanceSession(tx, context);
    return note;
  });
}

export async function updateNote(db: AppDatabase, context: FinanceSessionContext, idValue: unknown, input: Record<string, unknown>) {
  const id = requireUuid(idValue, 'noteId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [note] = await tx.select().from(financeNotes).where(eq(financeNotes.id, id)).for('update');
    if (!note) throw new FinanceLedgerError('NOT_FOUND', 'Note not found.', 404);
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, note.groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Note not found.', 404);
    const title = input.title === undefined ? note.title : requiredText(input.title, 'Title', 200);
    const content = input.content === undefined ? note.content : optionalText(input.content, 'Content', 10000);
    const targetAt = input.targetAt === undefined ? note.targetAt : timestamp(input.targetAt, 'targetAt', true);
    const isPinned = input.isPinned === undefined ? note.isPinned : input.isPinned;
    const isCompleted = input.isCompleted === undefined ? note.isCompleted : input.isCompleted;
    if (typeof isPinned !== 'boolean' || typeof isCompleted !== 'boolean') throw new FinanceLedgerError('INVALID_INPUT', 'Note flags must be booleans.', 400);
    const [updated] = await tx.update(financeNotes).set({ title, content, targetAt, isPinned, isCompleted, updatedAt: new Date() })
      .where(eq(financeNotes.id, id)).returning();
    await lockFinanceSession(tx, context);
    return updated;
  });
}

export async function deleteNote(db: AppDatabase, context: FinanceSessionContext, idValue: unknown) {
  const id = requireUuid(idValue, 'noteId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [note] = await tx.select({ id: financeNotes.id, groupId: financeNotes.groupId }).from(financeNotes).where(eq(financeNotes.id, id)).for('update');
    if (!note) throw new FinanceLedgerError('NOT_FOUND', 'Note not found.', 404);
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, note.groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Note not found.', 404);
    await tx.delete(financeNotes).where(eq(financeNotes.id, id));
    await lockFinanceSession(tx, context);
    return { id, deleted: true };
  });
}

const recurrenceValues = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;
type ReminderRecurrence = typeof recurrenceValues[number];
function reminderShape(input: Record<string, unknown>, current?: { reminderType: string; recurrence: string }) {
  const reminderType = input.reminderType ?? current?.reminderType ?? 'relative';
  const recurrence = input.recurrence ?? current?.recurrence ?? (reminderType === 'relative' ? 'none' : undefined);
  if (reminderType !== 'relative' && reminderType !== 'recurring') throw new FinanceLedgerError('INVALID_INPUT', 'reminderType is invalid.', 400);
  if (!recurrenceValues.includes(recurrence as ReminderRecurrence) || (reminderType === 'relative' && recurrence !== 'none') || (reminderType === 'recurring' && recurrence === 'none')) {
    throw new FinanceLedgerError('INVALID_INPUT', 'Reminder type and recurrence do not match.', 400);
  }
  const leadMinutes = input.leadMinutes;
  if (leadMinutes !== undefined && leadMinutes !== null && (!Number.isInteger(leadMinutes) || (leadMinutes as number) < 0 || (leadMinutes as number) > 525600)) {
    throw new FinanceLedgerError('INVALID_INPUT', 'leadMinutes is invalid.', 400);
  }
  const untilDate = input.untilDate;
  if (untilDate !== undefined && untilDate !== null && (typeof untilDate !== 'string' || !validateCalendarDate(untilDate))) throw new FinanceLedgerError('INVALID_INPUT', 'untilDate is invalid.', 400);
  return {
    reminderType: reminderType as 'relative' | 'recurring',
    recurrence: recurrence as ReminderRecurrence,
    leadMinutes: leadMinutes == null ? null : leadMinutes as number,
    untilDate: untilDate as string | null | undefined,
  };
}

export async function listReminders(db: AppDatabase, userId: string, groupIdValue: unknown) {
  const groupId = requireUuid(groupIdValue, 'groupId');
  await requireMembership(db, userId, groupId);
  return db.select(getTableColumns(financeNoteReminders)).from(financeNoteReminders)
    .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeNoteReminders.groupId), eq(financeGroupMembers.userId, userId)))
    .where(eq(financeNoteReminders.groupId, groupId)).orderBy(desc(financeNoteReminders.remindAt));
}

export async function createReminder(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const groupId = requireUuid(input.groupId, 'groupId');
  const noteId = requireUuid(input.noteId, 'noteId');
  const remindAt = timestamp(input.remindAt, 'remindAt')!;
  const message = optionalText(input.message, 'Message', 1000);
  const shape = reminderShape(input);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [note] = await tx.select({ id: financeNotes.id }).from(financeNotes)
      .where(and(eq(financeNotes.id, noteId), eq(financeNotes.groupId, groupId))).for('update');
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!note || !member) throw new FinanceLedgerError('NOT_FOUND', 'Note or group not found.', 404);
    const [reminder] = await tx.insert(financeNoteReminders).values({
      groupId, noteId, createdBy: context.userId, reminderType: shape.reminderType as 'relative' | 'recurring',
      leadMinutes: shape.leadMinutes, remindAt, recurrence: shape.recurrence as ReminderRecurrence,
      untilDate: shape.untilDate ?? null, message,
    }).returning();
    await lockFinanceSession(tx, context);
    return reminder;
  });
}

export async function updateReminder(db: AppDatabase, context: FinanceSessionContext, idValue: unknown, input: Record<string, unknown>) {
  const id = requireUuid(idValue, 'reminderId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [current] = await tx.select().from(financeNoteReminders).where(eq(financeNoteReminders.id, id)).for('update');
    if (!current) throw new FinanceLedgerError('NOT_FOUND', 'Reminder not found.', 404);
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, current.groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Reminder not found.', 404);
    const shape = reminderShape({
      ...input,
      leadMinutes: Object.hasOwn(input, 'leadMinutes') ? input.leadMinutes : current.leadMinutes,
      untilDate: Object.hasOwn(input, 'untilDate') ? input.untilDate : current.untilDate,
    }, current);
    const remindAt = input.remindAt === undefined ? current.remindAt : timestamp(input.remindAt, 'remindAt')!;
    const message = input.message === undefined ? current.message : optionalText(input.message, 'Message', 1000);
    const status = input.status === undefined ? current.status : input.status;
    if (status !== 'pending' && status !== 'cancelled' && status !== 'sent') throw new FinanceLedgerError('INVALID_INPUT', 'Reminder status is invalid.', 400);
    const [updated] = await tx.update(financeNoteReminders).set({ ...shape, remindAt, message, status, updatedAt: new Date() })
      .where(eq(financeNoteReminders.id, id)).returning();
    await lockFinanceSession(tx, context);
    return updated;
  });
}

export async function createScheduledTask(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const groupId = requireUuid(input.groupId, 'groupId');
  const title = requiredText(input.title, 'Title', 200);
  const details = optionalText(input.details, 'Details', 10000);
  const scheduleAt = timestamp(input.scheduleAt, 'scheduleAt')!;
  const recurrence = input.recurrence ?? 'once';
  if (recurrence !== 'once' && recurrence !== 'daily' && recurrence !== 'weekly' && recurrence !== 'monthly') throw new FinanceLedgerError('INVALID_INPUT', 'Task recurrence is invalid.', 400);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
    const [task] = await tx.insert(financeScheduledTasks).values({ groupId, createdBy: context.userId, title, details, scheduleAt, recurrence }).returning();
    await lockFinanceSession(tx, context);
    return task;
  });
}

export async function listScheduledTasks(db: AppDatabase, userId: string, groupIdValue: unknown) {
  const groupId = requireUuid(groupIdValue, 'groupId');
  await requireMembership(db, userId, groupId);
  return db.select(getTableColumns(financeScheduledTasks)).from(financeScheduledTasks)
    .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeScheduledTasks.groupId), eq(financeGroupMembers.userId, userId)))
    .where(eq(financeScheduledTasks.groupId, groupId)).orderBy(desc(financeScheduledTasks.scheduleAt));
}

export async function updateScheduledTask(db: AppDatabase, context: FinanceSessionContext, idValue: unknown, input: Record<string, unknown>) {
  const id = requireUuid(idValue, 'taskId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [current] = await tx.select().from(financeScheduledTasks).where(eq(financeScheduledTasks.id, id)).for('update');
    if (!current) throw new FinanceLedgerError('NOT_FOUND', 'Task not found.', 404);
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, current.groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Task not found.', 404);
    const title = input.title === undefined ? current.title : requiredText(input.title, 'Title', 200);
    const details = input.details === undefined ? current.details : optionalText(input.details, 'Details', 10000);
    const scheduleAt = input.scheduleAt === undefined ? current.scheduleAt : timestamp(input.scheduleAt, 'scheduleAt')!;
    const recurrence = input.recurrence === undefined ? current.recurrence : input.recurrence;
    const isActive = input.isActive === undefined ? current.isActive : input.isActive;
    const completedAt = input.completedAt === undefined ? current.completedAt : timestamp(input.completedAt, 'completedAt', true);
    if (recurrence !== 'once' && recurrence !== 'daily' && recurrence !== 'weekly' && recurrence !== 'monthly') throw new FinanceLedgerError('INVALID_INPUT', 'Task recurrence is invalid.', 400);
    if (typeof isActive !== 'boolean') throw new FinanceLedgerError('INVALID_INPUT', 'isActive must be a boolean.', 400);
    const [updated] = await tx.update(financeScheduledTasks).set({ title, details, scheduleAt, recurrence, isActive, completedAt, updatedAt: new Date() })
      .where(eq(financeScheduledTasks.id, id)).returning();
    await lockFinanceSession(tx, context);
    return updated;
  });
}

export async function deleteScheduledTask(db: AppDatabase, context: FinanceSessionContext, idValue: unknown) {
  const id = requireUuid(idValue, 'taskId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [task] = await tx.select().from(financeScheduledTasks).where(eq(financeScheduledTasks.id, id)).for('update');
    if (!task) throw new FinanceLedgerError('NOT_FOUND', 'Task not found.', 404);
    const [member] = await tx.select({ userId: financeGroupMembers.userId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, task.groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Task not found.', 404);
    await tx.delete(financeScheduledTasks).where(eq(financeScheduledTasks.id, id));
    await lockFinanceSession(tx, context);
    return { id, deleted: true };
  });
}
