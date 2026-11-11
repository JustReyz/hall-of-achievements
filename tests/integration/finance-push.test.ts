import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import webpush from 'web-push';
import { createInMemoryDb, resetDatabase, type AppDatabase } from '@/lib/db';
import { financeGroupMembers, financeGroups, financeNoteReminders, financeNotes, financePushAttempts, financePushSubscriptions, financeSessions, financeUsers } from '@/lib/db/schema';
import type { FinanceSessionContext } from '@/lib/finance/auth';
import * as egress from '@/lib/push/egress';
import { listFinanceDevices, registerFinanceDevice, removeFinanceDevice, sendFinanceReminder } from '@/lib/finance/push';
import { financeCookieName } from '@/lib/finance/auth';
import { POST as registerAccount } from '@/app/api/finance/session/route';
import { GET as listDevicesRoute, POST as registerDeviceRoute } from '@/app/api/finance/push/devices/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';

describe('finance push isolation and delivery', () => {
  let db: AppDatabase;
  let pglite: PGlite;
  let owner: FinanceSessionContext;
  let outsider: FinanceSessionContext;
  let reminderId: string;
  let groupId: string;
  const endpoint = 'https://fcm.googleapis.com/fcm/send/finance-test';
  let keys: { p256dh: string; auth: string };
  let send: MockInstance<typeof webpush.sendNotification>;

  beforeEach(async () => {
    ({ db, pglite } = await createInMemoryDb());
    const [first, second] = await db.insert(financeUsers).values([
      { username: 'push-owner', displayName: 'Owner', passwordHash: 'unused' },
      { username: 'push-outsider', displayName: 'Other', passwordHash: 'unused' },
    ]).returning();
    const expiresAt = new Date(Date.now() + 60_000);
    owner = { userId: first!.id, financeTokenHash: 'a'.repeat(64), hallTokenHash: null };
    outsider = { userId: second!.id, financeTokenHash: 'b'.repeat(64), hallTokenHash: null };
    await db.insert(financeSessions).values([owner, outsider].map((context) => ({ tokenHash: context.financeTokenHash, userId: context.userId, expiresAt, idleExpiresAt: expiresAt })));
    const [group] = await db.insert(financeGroups).values({ name: 'Private', createdBy: owner.userId }).returning();
    groupId = group!.id;
    await db.insert(financeGroupMembers).values({ groupId: group!.id, userId: owner.userId, role: 'owner' });
    const [note] = await db.insert(financeNotes).values({ groupId: group!.id, createdBy: owner.userId, title: 'Private title' }).returning();
    const [reminder] = await db.insert(financeNoteReminders).values({ groupId: group!.id, noteId: note!.id, createdBy: owner.userId, remindAt: new Date() }).returning();
    reminderId = reminder!.id;
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
    vi.spyOn(egress, 'validatePushEndpoint').mockResolvedValue({ valid: true, url: new URL(endpoint), resolvedIps: ['1.1.1.1'] });
    vi.spyOn(egress, 'assertPushEndpointSafe').mockResolvedValue({ url: new URL(endpoint), resolvedIps: ['1.1.1.1'] });
    send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 } as never);
  });
  afterEach(async () => { vi.restoreAllMocks(); await pglite.close(); });

  it('requires explicit registration and isolates devices and reminders by account', async () => {
    const device = await registerFinanceDevice(db, owner, { endpoint, keys, userAgent: 'Browser' });
    expect(send).not.toHaveBeenCalled();
    expect(await listFinanceDevices(db, outsider.userId)).toEqual([]);
    await expect(registerFinanceDevice(db, outsider, { endpoint, keys })).rejects.toMatchObject({ code: 'DEVICE_IN_USE' });
    await expect(removeFinanceDevice(db, outsider, device.id)).rejects.toMatchObject({ status: 404 });
    await expect(sendFinanceReminder(db, outsider, { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 404 });
    const key = randomUUID();
    const result = await sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: key });
    expect(result.results).toEqual([{ subscriptionId: device.id, status: 'accepted' }]);
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(send.mock.calls[0])).not.toContain('Private title');
    expect((await sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: key })).replayed).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await expect(sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 429 });
  });

  it('rejects invalid keys and disables an expired device', async () => {
    await expect(registerFinanceDevice(db, owner, { endpoint, keys: { ...keys, auth: 'bad' } })).rejects.toMatchObject({ status: 400 });
    const device = await registerFinanceDevice(db, owner, { endpoint, keys });
    send.mockRejectedValueOnce({ statusCode: 410 });
    const result = await sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() });
    expect(result.results[0]?.status).toBe('rejected');
    expect((await db.select().from(financePushSubscriptions))[0]?.status).toBe('disabled');
  });

  it('reports an ambiguous provider failure as unknown', async () => {
    const device = await registerFinanceDevice(db, owner, { endpoint, keys });
    send.mockRejectedValueOnce(new Error('Socket timeout'));
    const result = await sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() });
    expect(result.results[0]?.status).toBe('unknown');
    expect((await listFinanceDevices(db, owner.userId))).toHaveLength(1);
  });

  it('prevents a group member from targeting another account device', async () => {
    const device = await registerFinanceDevice(db, owner, { endpoint, keys });
    await db.insert(financeGroupMembers).values({ groupId, userId: outsider.userId, role: 'member' });
    await expect(sendFinanceReminder(db, outsider, { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_TARGETS' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reuses an idempotency key only for the same reminder and device selection', async () => {
    const first = await registerFinanceDevice(db, owner, { endpoint, keys });
    const second = await registerFinanceDevice(db, owner, { endpoint: `${endpoint}-2`, keys });
    const key = randomUUID();
    await sendFinanceReminder(db, owner, { reminderId, deviceIds: [first.id], idempotencyKey: key });
    await expect(sendFinanceReminder(db, owner, { reminderId, deviceIds: [second.id], idempotencyKey: key })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows a device removed by one account to be explicitly registered by another', async () => {
    const first = await registerFinanceDevice(db, owner, { endpoint, keys });
    await removeFinanceDevice(db, owner, first.id);
    const second = await registerFinanceDevice(db, outsider, { endpoint, keys });
    expect(second.id).toBe(first.id);
    expect(await listFinanceDevices(db, owner.userId)).toEqual([]);
    expect(await listFinanceDevices(db, outsider.userId)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send to a device removed while its endpoint is being checked', async () => {
    const device = await registerFinanceDevice(db, owner, { endpoint, keys });
    let resume!: () => void;
    let checking!: () => void;
    const entered = new Promise<void>((resolve) => { checking = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    vi.mocked(egress.assertPushEndpointSafe).mockImplementationOnce(async () => {
      checking();
      await paused;
      return { url: new URL(endpoint), resolvedIps: ['1.1.1.1'] };
    });
    const pending = sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() });
    await entered;
    await removeFinanceDevice(db, owner, device.id);
    await registerFinanceDevice(db, outsider, { endpoint, keys });
    resume();
    const result = await pending;
    expect(result.results[0]?.status).toBe('rejected');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects sending with a revoked finance session', async () => {
    const device = await registerFinanceDevice(db, owner, { endpoint, keys });
    await db.update(financeSessions).set({ revokedAt: new Date() }).where(eq(financeSessions.tokenHash, owner.financeTokenHash));
    await expect(sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() })).rejects.toThrow('session is no longer valid');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not dispatch twice for concurrent requests with the same key', async () => {
    const device = await registerFinanceDevice(db, owner, { endpoint, keys });
    const input = { reminderId, deviceIds: [device.id], idempotencyKey: randomUUID() };
    const results = await Promise.all([sendFinanceReminder(db, owner, input), sendFinanceReminder(db, owner, input)]);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it('reports an old unfinished attempt as unknown without sending again', async () => {
    const device = await registerFinanceDevice(db, owner, { endpoint, keys });
    const key = randomUUID();
    await db.insert(financePushAttempts).values({ userId: owner.userId, reminderId, idempotencyKey: key, targetIds: [device.id], attemptedAt: new Date(Date.now() - 180_000) });
    const result = await sendFinanceReminder(db, owner, { reminderId, deviceIds: [device.id], idempotencyKey: key });
    expect(result).toMatchObject({ outcome: 'unknown', replayed: true });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('finance push API', () => {
  beforeEach(async () => { vi.stubEnv('FINANCE_EXPERIMENTAL', 'true'); await resetDatabase(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('enforces sessions, same-origin writes and body limits without exposing subscriptions', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/private-token';
    const makeRequest = (headers: HeadersInit, body: string) => new NextRequest('http://localhost:3000/api/finance/push/devices', { method: 'POST', headers, body });
    expect((await registerDeviceRoute(makeRequest({ origin: 'http://localhost:3000' }, '{}'))).status).toBe(401);
    const { headers } = await createAuthenticatedHeaders();
    const registration = await registerAccount(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers, body: JSON.stringify({ action: 'register', username: 'device-owner', password: 'secure-password-for-test' }),
    }));
    const token = registration.cookies.get(financeCookieName())?.value;
    const authHeaders = { ...headers, cookie: `${headers.cookie}; ${financeCookieName()}=${token}` };
    expect((await registerDeviceRoute(makeRequest({ ...authHeaders, origin: 'https://evil.example' }, '{}'))).status).toBe(403);
    expect((await registerDeviceRoute(makeRequest(authHeaders, 'x'.repeat(8193)))).status).toBe(413);
    vi.spyOn(egress, 'validatePushEndpoint').mockResolvedValue({ valid: true, url: new URL(endpoint), resolvedIps: ['1.1.1.1'] });
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const auth = randomBytes(16).toString('base64url');
    const response = await registerDeviceRoute(makeRequest(authHeaders, JSON.stringify({ endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth }, userAgent: 'Test browser' })));
    expect(response.status).toBe(201);
    const list = await listDevicesRoute(new NextRequest('http://localhost:3000/api/finance/push/devices', { headers: authHeaders }));
    const content = await list.text();
    expect(content).toContain('Test browser');
    expect(content).not.toContain('private-token');
    expect(content).not.toContain(auth);
    expect(list.headers.get('cache-control')).toContain('no-store');
  });
});
