import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createInMemoryDb, type AppDatabase } from '@/lib/db';
import { authState, financeSessions, financeUsers } from '@/lib/db/schema';
import { deriveAuthVersion } from '@/lib/auth/crypto';
import { eq } from 'drizzle-orm';
import type { FinanceSessionContext } from '@/lib/finance/auth';
import { createGroup } from '@/lib/finance/ledger';
import { createNote, createReminder, createScheduledTask, deleteNote, deleteScheduledTask, listNotes, listReminders, listScheduledTasks, updateNote, updateReminder, updateScheduledTask } from '@/lib/finance/planner';

describe('finance planner', () => {
  let db: AppDatabase;
  let pglite: PGlite;
  let owner: string;
  let outsider: string;
  let context: FinanceSessionContext;

  beforeEach(async () => {
    vi.stubEnv('FINANCE_EXPERIMENTAL', 'true');
    ({ db, pglite } = await createInMemoryDb());
    const [ownerUser, outsiderUser] = await db.insert(financeUsers).values([
      { username: 'planner-owner', displayName: 'Planner Owner', passwordHash: 'unused' },
      { username: 'planner-outsider', displayName: 'Planner Outsider', passwordHash: 'unused' },
    ]).returning({ id: financeUsers.id });
    owner = ownerUser!.id;
    outsider = outsiderUser!.id;
    const version = deriveAuthVersion();
    await db.update(authState).set({ currentVersion: version }).where(eq(authState.id, 1));
    const expiresAt = new Date(Date.now() + 60_000);
    const financeTokenHash = 'e'.repeat(64);
    await db.insert(financeSessions).values({ tokenHash: financeTokenHash, userId: owner, expiresAt, idleExpiresAt: expiresAt });
    context = { userId: owner, financeTokenHash, hallTokenHash: null };
  });

  afterEach(async () => { await pglite.close(); vi.unstubAllEnvs(); });

  it('scopes notes, recurring reminders and scheduled tasks to group members', async () => {
    const group = await createGroup(db, context, { name: 'Planning' });
    const note = await createNote(db, context, { groupId: group.id, title: 'Call the bank', content: 'Ask about rates', isPinned: true, targetAt: '2026-11-20T09:00:00.000Z' });
    const reminder = await createReminder(db, context, { groupId: group.id, noteId: note.id, reminderType: 'recurring', remindAt: '2026-11-20T08:00:00.000Z', recurrence: 'weekly', untilDate: '2026-12-31', message: 'Bank call' });
    const task = await createScheduledTask(db, context, { groupId: group.id, title: 'Pay rent', scheduleAt: '2026-11-25T02:00:00.000Z', recurrence: 'monthly' });

    expect(await listNotes(db, owner, group.id)).toMatchObject([{ id: note.id, title: 'Call the bank', isPinned: true }]);
    expect(await listReminders(db, owner, group.id)).toMatchObject([{ id: reminder!.id, recurrence: 'weekly', status: 'pending' }]);
    expect(await listScheduledTasks(db, owner, group.id)).toMatchObject([{ id: task!.id, recurrence: 'monthly', isActive: true }]);
    await expect(listNotes(db, outsider, group.id)).rejects.toMatchObject({ status: 404 });
    await updateNote(db, context, note.id, { isCompleted: true });
    await updateReminder(db, context, reminder!.id, { status: 'cancelled' });
    await updateScheduledTask(db, context, task!.id, { isActive: false, completedAt: '2026-11-25T02:00:00.000Z' });
    expect((await listNotes(db, owner, group.id))[0]?.isCompleted).toBe(true);
    expect((await listReminders(db, owner, group.id))[0]?.status).toBe('cancelled');
    expect((await listScheduledTasks(db, owner, group.id))[0]).toMatchObject({ isActive: false, completedAt: expect.any(Date) });
    await deleteNote(db, context, note.id);
    expect(await listReminders(db, owner, group.id)).toEqual([]);
    await deleteScheduledTask(db, context, task!.id);
    expect(await listScheduledTasks(db, owner, group.id)).toEqual([]);
  });

  it('rejects invalid recurrence and group references without creating records', async () => {
    const group = await createGroup(db, context, { name: 'Planning' });
    await expect(createScheduledTask(db, context, { groupId: group.id, title: 'Bad', scheduleAt: '2026-11-25T02:00:00.000Z', recurrence: 'yearly' })).rejects.toMatchObject({ status: 400 });
    await expect(createNote(db, context, { groupId: crypto.randomUUID(), title: 'Out of scope' })).rejects.toMatchObject({ status: 404 });
  });
});
