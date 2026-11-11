import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { financeGroupMembers, financeNoteReminders, financePushAttempts, financePushSubscriptions, financeUsers } from '@/lib/db/schema';
import { validatePushEndpoint } from '@/lib/push/egress';
import { lockFinanceSession, type FinanceSessionContext } from './auth';
import { FinanceLedgerError, requireUuid } from './ledger';
import webpush from 'web-push';
import { assertPushEndpointSafe, createSafePushAgent } from '@/lib/push/egress';
import { getVapidKeys } from '@/lib/push/sender';

function validateKey(value: unknown, length: number, prefix?: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100) throw new FinanceLedgerError('INVALID_SUBSCRIPTION', 'Invalid subscription key.', 400);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== length || decoded.toString('base64url') !== value || (prefix !== undefined && decoded[0] !== prefix)) throw new FinanceLedgerError('INVALID_SUBSCRIPTION', 'Invalid subscription key.', 400);
  return value;
}

export async function listFinanceDevices(db: AppDatabase, userId: string) {
  return db.select({ id: financePushSubscriptions.id, userAgent: financePushSubscriptions.userAgent, createdAt: financePushSubscriptions.createdAt })
    .from(financePushSubscriptions).where(and(eq(financePushSubscriptions.userId, userId), eq(financePushSubscriptions.status, 'active')))
    .orderBy(desc(financePushSubscriptions.createdAt));
}

export async function registerFinanceDevice(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const endpoint = input.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || endpoint.length === 0) throw new FinanceLedgerError('INVALID_SUBSCRIPTION', 'Invalid subscription endpoint.', 400);
  const keys = input.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new FinanceLedgerError('INVALID_SUBSCRIPTION', 'Invalid subscription keys.', 400);
  const p256dh = validateKey((keys as Record<string, unknown>).p256dh, 65, 4);
  const auth = validateKey((keys as Record<string, unknown>).auth, 16);
  const userAgent = typeof input.userAgent === 'string' ? input.userAgent.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 200) : null;
  const validation = await validatePushEndpoint(endpoint);
  if (!validation.valid) throw new FinanceLedgerError('INVALID_SUBSCRIPTION', 'Unsupported or unsafe push endpoint.', 400);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [user] = await tx.select({ id: financeUsers.id }).from(financeUsers).where(eq(financeUsers.id, context.userId)).for('update');
    if (!user) throw new FinanceLedgerError('NOT_FOUND', 'User not found.', 404);
    const [existing] = await tx.select().from(financePushSubscriptions).where(eq(financePushSubscriptions.endpoint, endpoint)).for('update');
    if (existing && existing.userId !== context.userId && existing.status === 'active') throw new FinanceLedgerError('DEVICE_IN_USE', 'This device is linked to another finance account.', 409);
    const active = await tx.select({ id: financePushSubscriptions.id }).from(financePushSubscriptions)
      .where(and(eq(financePushSubscriptions.userId, context.userId), eq(financePushSubscriptions.status, 'active')));
    if ((!existing || existing.status !== 'active') && active.length >= 5) throw new FinanceLedgerError('DEVICE_LIMIT', 'A maximum of five devices can be active.', 409);
    if (existing) {
      await tx.update(financePushSubscriptions).set({ userId: context.userId, p256dh, auth, userAgent, status: 'active', updatedAt: new Date() }).where(eq(financePushSubscriptions.id, existing.id));
      await lockFinanceSession(tx, context);
      return { id: existing.id };
    }
    const [created] = await tx.insert(financePushSubscriptions).values({ userId: context.userId, endpoint, p256dh, auth, userAgent }).returning({ id: financePushSubscriptions.id });
    await lockFinanceSession(tx, context);
    if (!created) throw new Error('Could not register device.');
    return created;
  });
}

export async function removeFinanceDevice(db: AppDatabase, context: FinanceSessionContext, rawId: unknown) {
  const id = requireUuid(rawId, 'deviceId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [removed] = await tx.update(financePushSubscriptions).set({ status: 'disabled', updatedAt: new Date() })
      .where(and(eq(financePushSubscriptions.id, id), eq(financePushSubscriptions.userId, context.userId), eq(financePushSubscriptions.status, 'active')))
      .returning({ id: financePushSubscriptions.id });
    if (!removed) throw new FinanceLedgerError('NOT_FOUND', 'Device not found.', 404);
    await lockFinanceSession(tx, context);
    return removed;
  });
}

export async function sendFinanceReminder(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const reminderId = requireUuid(input.reminderId, 'reminderId');
  const idempotencyKey = requireUuid(input.idempotencyKey, 'idempotencyKey');
  if (!Array.isArray(input.deviceIds) || input.deviceIds.length < 1 || input.deviceIds.length > 5) throw new FinanceLedgerError('INVALID_TARGETS', 'Select one to five devices.', 400);
  const targetIds = input.deviceIds.map((id) => requireUuid(id, 'deviceId')).sort();
  if (new Set(targetIds).size !== targetIds.length) throw new FinanceLedgerError('INVALID_TARGETS', 'Duplicate devices are not allowed.', 400);
  const vapid = getVapidKeys();
  const reservation = await db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [user] = await tx.select({ id: financeUsers.id }).from(financeUsers).where(eq(financeUsers.id, context.userId)).for('update');
    if (!user) throw new FinanceLedgerError('NOT_FOUND', 'User not found.', 404);
    const [reminder] = await tx.select({ id: financeNoteReminders.id, status: financeNoteReminders.status })
      .from(financeNoteReminders).innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeNoteReminders.groupId), eq(financeGroupMembers.userId, context.userId)))
      .where(eq(financeNoteReminders.id, reminderId)).for('update');
    if (!reminder || reminder.status !== 'pending') throw new FinanceLedgerError('NOT_FOUND', 'Pending reminder not found.', 404);
    const [existing] = await tx.select().from(financePushAttempts).where(and(eq(financePushAttempts.userId, context.userId), eq(financePushAttempts.idempotencyKey, idempotencyKey)));
    if (existing) {
      if (existing.reminderId !== reminderId || JSON.stringify(existing.targetIds) !== JSON.stringify(targetIds)) throw new FinanceLedgerError('IDEMPOTENCY_CONFLICT', 'This request key was already used for a different reminder or device selection.', 409);
      return { replayed: true as const, attempt: existing };
    }
    const [recent] = await tx.select({ id: financePushAttempts.id }).from(financePushAttempts)
      .where(and(eq(financePushAttempts.userId, context.userId), gt(financePushAttempts.attemptedAt, new Date(Date.now() - 60_000)))).limit(1);
    if (recent) throw new FinanceLedgerError('COOLDOWN_ACTIVE', 'Wait one minute before sending another reminder.', 429);
    const targets = await tx.select().from(financePushSubscriptions).where(and(eq(financePushSubscriptions.userId, context.userId), eq(financePushSubscriptions.status, 'active'), inArray(financePushSubscriptions.id, targetIds))).for('update');
    if (targets.length !== targetIds.length) throw new FinanceLedgerError('INVALID_TARGETS', 'One or more selected devices are unavailable.', 404);
    const [attempt] = await tx.insert(financePushAttempts).values({ userId: context.userId, reminderId, idempotencyKey, targetIds }).returning();
    if (!attempt) throw new Error('Could not reserve reminder.');
    await lockFinanceSession(tx, context);
    return { replayed: false as const, attempt, targets };
  });
  if (reservation.replayed) {
    const stale = reservation.attempt.outcome === 'in_progress' && reservation.attempt.attemptedAt.getTime() < Date.now() - 120_000;
    return { attemptId: reservation.attempt.id, outcome: stale ? 'unknown' as const : reservation.attempt.outcome, results: reservation.attempt.results, replayed: true };
  }
  const results: { subscriptionId: string; status: 'accepted' | 'rejected' | 'unknown' }[] = [];
  for (const sub of reservation.targets) {
    let dispatchStarted = false;
    try {
      const { url, resolvedIps } = await assertPushEndpointSafe(sub.endpoint);
      const agent = createSafePushAgent(resolvedIps[0]!, url.hostname, url.protocol === 'http:');
      await db.transaction(async (tx) => {
        await lockFinanceSession(tx, context);
        const [reminder] = await tx.select({ id: financeNoteReminders.id }).from(financeNoteReminders)
          .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeNoteReminders.groupId), eq(financeGroupMembers.userId, context.userId)))
          .where(and(eq(financeNoteReminders.id, reminderId), eq(financeNoteReminders.status, 'pending'))).for('update');
        const [device] = await tx.select().from(financePushSubscriptions)
          .where(and(eq(financePushSubscriptions.id, sub.id), eq(financePushSubscriptions.userId, context.userId), eq(financePushSubscriptions.status, 'active'))).for('update');
        if (!reminder || !device) throw new Error('Reminder or device is no longer available.');
        try {
          dispatchStarted = true;
          await webpush.sendNotification({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, JSON.stringify({ title: 'Pengingat keuangan', body: 'Buka Keuangan untuk melihat pengingat Anda.', url: '/finance' }), {
            TTL: 60, urgency: 'normal', timeout: 10_000, vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, agent: agent as unknown as undefined,
          });
        } catch (error: unknown) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await tx.update(financePushSubscriptions).set({ status: 'disabled', updatedAt: new Date() }).where(eq(financePushSubscriptions.id, device.id));
          return typeof status === 'number' && status >= 400 && status < 500 ? 'rejected' as const : 'unknown' as const;
        }
        return 'accepted' as const;
      }).then((status) => results.push({ subscriptionId: sub.id, status }));
    } catch {
      results.push({ subscriptionId: sub.id, status: dispatchStarted ? 'unknown' : 'rejected' });
    }
  }
  await db.update(financePushAttempts).set({ outcome: 'complete', results }).where(and(eq(financePushAttempts.id, reservation.attempt.id), eq(financePushAttempts.userId, context.userId)));
  return { attemptId: reservation.attempt.id, outcome: 'complete' as const, results, replayed: false };
}
