import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import webpush from 'web-push';
import { resetDatabase, getDb } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';
import { setAllowedTestOrigin } from '@/lib/push/egress';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { GET as getVapidPublicKeyHandler } from '@/app/api/push/vapid-public-key/route';
import {
  GET as getSubscriptionsHandler,
  POST as postSubscriptionHandler,
  DELETE as deleteSubscriptionHandler,
} from '@/app/api/push/subscriptions/route';
import { POST as sendReminderHandler } from '@/app/api/reminders/send/route';
import { DELETE as logoutSessionHandler } from '@/app/api/session/route';
import { POST as revokeAllSessionsHandler } from '@/app/api/sessions/revoke-all/route';
import { rotateAuthState } from '@/lib/auth/auth-state';

describe('Integration: Manual Web Push & Strict Notification Boundaries (AC6-AC9)', () => {
  beforeEach(async () => {
    await resetDatabase();
    setAllowedTestOrigin('https://fcm.googleapis.com');
  });

  afterEach(() => {
    setAllowedTestOrigin(null);
    vi.restoreAllMocks();
  });

  describe('1. VAPID Public Key Retrieval', () => {
    it('GET /api/push/vapid-public-key returns 200 with public key for authenticated owner', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const req = new NextRequest('http://localhost:3000/api/push/vapid-public-key', {
        method: 'GET',
        headers,
      });

      const res = await getVapidPublicKeyHandler(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { publicKey: string };
      expect(data.publicKey).toBeDefined();
      expect(typeof data.publicKey).toBe('string');
      expect(data.publicKey.length).toBeGreaterThan(60);
    });

    it('GET /api/push/vapid-public-key rejects unauthenticated requests with HTTP 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/push/vapid-public-key', {
        method: 'GET',
      });

      const res = await getVapidPublicKeyHandler(req);
      expect(res.status).toBe(401);
    });
  });

  describe('2. Subscription Lifecycle & Zero-Push Opt-In Guarantee (AC6)', () => {
    it('POST /api/push/subscriptions saves subscription and sends ZERO push notifications', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const pushSpy = vi.spyOn(webpush, 'sendNotification');

      const body = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-integration-1',
        keys: {
          p256dh: 'BNcRnp_mock_valid_p256dh_key_65_bytes_string_sample_value_1234567890abcdef',
          auth: 'mockAuthSecret16',
        },
        userAgent: 'Mozilla/5.0 Test Chrome',
      };

      const req = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const res = await postSubscriptionHandler(req);
      expect(res.status).toBe(201);

      const data = (await res.json()) as { success: boolean; subscription: { id: string; status: string } };
      expect(data.success).toBe(true);
      expect(data.subscription.status).toBe('active');

      // CRITICAL INVARIANT: Zero pushes dispatched upon subscription registration
      expect(pushSpy).not.toHaveBeenCalled();

      // Verify in database
      const db = await getDb();
      const [saved] = await db.select().from(pushSubscriptions);
      expect(saved).toBeDefined();
      expect(saved?.endpoint).toBe(body.endpoint);
      expect(saved?.status).toBe('active');
    });

    it('updating an existing endpoint re-activates it without creating duplicate records', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const body = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/re-register-endpoint',
        keys: {
          p256dh: 'BNcRnp_initial_key...',
          auth: 'auth1...',
        },
      };

      // First registration
      const req1 = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const res1 = await postSubscriptionHandler(req1);
      expect(res1.status).toBe(201);

      // Second registration with updated keys
      const updatedBody = {
        endpoint: body.endpoint,
        keys: {
          p256dh: 'BNcRnp_updated_key...',
          auth: 'auth2...',
        },
      };

      const req2 = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify(updatedBody),
      });
      const res2 = await postSubscriptionHandler(req2);
      expect(res2.status).toBe(200);

      // Verify single record in database
      const db = await getDb();
      const subs = await db.select().from(pushSubscriptions);
      expect(subs.length).toBe(1);
      expect(subs[0]?.p256dh).toBe('BNcRnp_updated_key...');
    });

    it('enforces maximum 5 active devices fleet limit (rejects 6th with HTTP 409)', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Seed 5 active devices
      for (let i = 1; i <= 5; i++) {
        await db.insert(pushSubscriptions).values({
          id: crypto.randomUUID(),
          tokenHash: `token-hash-${i}`,
          endpoint: `https://fcm.googleapis.com/fcm/send/device-${i}`,
          p256dh: `p256dh-${i}`,
          auth: `auth-${i}`,
          status: 'active',
        });
      }

      // Attempt to register 6th device
      const req6 = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/device-6',
          keys: {
            p256dh: 'p256dh-6',
            auth: 'auth-6',
          },
        }),
      });

      const res6 = await postSubscriptionHandler(req6);
      expect(res6.status).toBe(409);

      const data6 = (await res6.json()) as { code: string };
      expect(data6.code).toBe('MAX_SUBSCRIPTIONS_EXCEEDED');

      // Verify count in database remains exactly 5
      const allSubs = await db.select().from(pushSubscriptions);
      expect(allSubs.length).toBe(5);
    });

    it('rejects endpoints targeting private IPs or unauthorized providers with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Test SSRF attempt targeting cloud metadata
      const ssrfReq = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: 'https://169.254.169.254/latest/meta-data',
          keys: { p256dh: 'p...', auth: 'a...' },
        }),
      });
      const ssrfRes = await postSubscriptionHandler(ssrfReq);
      expect(ssrfRes.status).toBe(400);

      // Test unauthorized origin
      const evilReq = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: 'https://attacker.com/fake-push',
          keys: { p256dh: 'p...', auth: 'a...' },
        }),
      });
      const evilRes = await postSubscriptionHandler(evilReq);
      expect(evilRes.status).toBe(400);
    });

    it('GET /api/push/subscriptions returns sanitized list without leaking cryptographic secrets', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      await db.insert(pushSubscriptions).values({
        id: crypto.randomUUID(),
        tokenHash: 'different-device-hash',
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-other',
        p256dh: 'SECRET_P256DH_MATERIAL',
        auth: 'SECRET_AUTH_MATERIAL',
        userAgent: 'Safari on iPhone',
        status: 'active',
      });

      const req = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'GET',
        headers,
      });

      const res = await getSubscriptionsHandler(req);
      expect(res.status).toBe(200);

      const jsonString = await res.text();
      // Ensure zero secrets or raw endpoints leaked
      expect(jsonString).not.toContain('SECRET_P256DH_MATERIAL');
      expect(jsonString).not.toContain('SECRET_AUTH_MATERIAL');
      expect(jsonString).not.toContain('https://fcm.googleapis.com');

      const parsed = JSON.parse(jsonString) as { subscriptions: Array<{ userAgent: string; status: string }> };
      expect(parsed.subscriptions.length).toBe(1);
      expect(parsed.subscriptions[0]?.userAgent).toBe('Safari on iPhone');
    });

    it('DELETE /api/push/subscriptions deactivates subscription (marks disabled)', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'test-hash',
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-to-delete',
        p256dh: 'p256dh...',
        auth: 'auth...',
        status: 'active',
      });

      const deleteReq = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ id: subId }),
      });

      const deleteRes = await deleteSubscriptionHandler(deleteReq);
      expect(deleteRes.status).toBe(200);

      const [updated] = await db.select().from(pushSubscriptions);
      expect(updated?.status).toBe('disabled');
    });
  });

  describe('3. Manual Send Boundary, Durable Cooldown & Idempotency (AC6, AC8)', () => {
    it('POST /api/reminders/send executes push with generic payload and 60-second TTL', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'current-device-hash',
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-send-1',
        p256dh: 'p256dh...',
        auth: 'auth...',
        status: 'active',
      });

      const sendSpy = vi.spyOn(webpush, 'sendNotification').mockResolvedValueOnce({
        statusCode: 201,
        headers: {},
        body: '',
      });

      const sendReq = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          idempotencyKey: 'idemp-manual-send-integration-1',
        }),
      });

      const sendRes = await sendReminderHandler(sendReq);
      expect(sendRes.status).toBe(200);

      const data = (await sendRes.json()) as { success: boolean; outcome: string; results: Array<{ status: string }> };
      expect(data.success).toBe(true);
      expect(data.outcome).toBe('accepted');
      expect(data.results[0]?.status).toBe('accepted');

      expect(sendSpy).toHaveBeenCalledOnce();
      const payloadArg = sendSpy.mock.calls[0]?.[1];
      const parsedPayload = JSON.parse(String(payloadArg));
      expect(parsedPayload.title).toBe('Hall of Achievements');
      expect(parsedPayload.body).toBe('New reminder from Hall of Achievements');
      expect(parsedPayload.url).toBe('/');
    });

    it('enforces durable 1-minute cooldown that persists across cold starts', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'hash-cooldown',
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-cooldown',
        p256dh: 'p256dh...',
        auth: 'auth...',
        status: 'active',
      });

      vi.spyOn(webpush, 'sendNotification').mockResolvedValue({
        statusCode: 201,
        headers: {},
        body: '',
      });

      // 1. Initial manual send succeeds
      const req1 = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          idempotencyKey: 'idemp-cooldown-first-send',
        }),
      });
      const res1 = await sendReminderHandler(req1);
      expect(res1.status).toBe(200);

      // 2. Simulated serverless cold start: new request with fresh headers & different idempotency key
      const { headers: freshColdStartHeaders } = await createAuthenticatedHeaders();

      const req2 = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers: freshColdStartHeaders,
        body: JSON.stringify({
          idempotencyKey: 'idemp-cooldown-second-send-immediate',
        }),
      });

      // 3. Second send is rejected with HTTP 429 Cooldown Active & Retry-After header
      const res2 = await sendReminderHandler(req2);
      expect(res2.status).toBe(429);
      expect(res2.headers.get('Retry-After')).toBeDefined();

      const data2 = (await res2.json()) as { code: string; retryAfter: number };
      expect(data2.code).toBe('COOLDOWN_ACTIVE');
      expect(data2.retryAfter).toBeGreaterThan(0);
      expect(data2.retryAfter).toBeLessThanOrEqual(60);
    });

    it('replayed idempotencyKey returns stored attempt record without re-dispatching push', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'hash-idemp',
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-idemp',
        p256dh: 'p256dh...',
        auth: 'auth...',
        status: 'active',
      });

      const sendSpy = vi.spyOn(webpush, 'sendNotification').mockResolvedValueOnce({
        statusCode: 201,
        headers: {},
        body: '',
      });

      const fixedKey = 'fixed-idempotency-key-repeat-test-12345';

      // First dispatch
      const req1 = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: fixedKey }),
      });
      const res1 = await sendReminderHandler(req1);
      expect(res1.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // Replay with identical key
      const req2 = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: fixedKey }),
      });
      const res2 = await sendReminderHandler(req2);
      expect(res2.status).toBe(200);

      const data2 = (await res2.json()) as { replayed: boolean; success: boolean };
      expect(data2.success).toBe(true);
      expect(data2.replayed).toBe(true);

      // Zero additional outbound pushes dispatched on idempotency replay
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it('push provider 410 Gone response immediately disables subscription in database', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash: 'hash-410',
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-gone',
        p256dh: 'p256dh...',
        auth: 'auth...',
        status: 'active',
      });

      const goneError = new Error('Subscription has expired');
      (goneError as unknown as { statusCode: number }).statusCode = 410;
      vi.spyOn(webpush, 'sendNotification').mockRejectedValueOnce(goneError);

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: 'idemp-410-integration-key-xyz' }),
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { outcome: string; results: Array<{ status: string; statusCode: number }> };
      expect(data.outcome).toBe('rejected');
      expect(data.results[0]?.status).toBe('rejected');
      expect(data.results[0]?.statusCode).toBe(410);

      // Subscription in DB must now be marked 'disabled'
      const [sub] = await db.select().from(pushSubscriptions);
      expect(sub?.status).toBe('disabled');
    });
  });

  describe('4. Session Revocation & Subscription Invalidation Integration (AC9)', () => {
    it('logout revokes session AND disables the device subscription', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Register device subscription
      const subReq = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/device-logout-test',
          keys: { p256dh: 'p...', auth: 'a...' },
        }),
      });
      await postSubscriptionHandler(subReq);

      const [subBefore] = await db.select().from(pushSubscriptions);
      expect(subBefore?.status).toBe('active');

      // Logout: DELETE /api/session
      const logoutReq = new NextRequest('http://localhost:3000/api/session', {
        method: 'DELETE',
        headers,
      });
      const logoutRes = await logoutSessionHandler(logoutReq);
      expect(logoutRes.status).toBe(200);

      // Subscription is now disabled
      const [subAfter] = await db.select().from(pushSubscriptions);
      expect(subAfter?.status).toBe('disabled');
    });

    it('fleet revoke-all disables all active push subscriptions across all devices', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Seed 3 active subscriptions across different sessions
      for (let i = 1; i <= 3; i++) {
        await db.insert(pushSubscriptions).values({
          id: crypto.randomUUID(),
          tokenHash: `token-hash-${i}`,
          endpoint: `https://fcm.googleapis.com/fcm/send/fleet-device-${i}`,
          p256dh: `p256dh-${i}`,
          auth: `auth-${i}`,
          status: 'active',
        });
      }

      // Revoke all: POST /api/sessions/revoke-all
      const revokeReq = new NextRequest('http://localhost:3000/api/sessions/revoke-all', {
        method: 'POST',
        headers,
      });
      const revokeRes = await revokeAllSessionsHandler(revokeReq);
      expect(revokeRes.status).toBe(200);

      // All subscriptions across the entire fleet are now disabled
      const allSubs = await db.select().from(pushSubscriptions);
      expect(allSubs.length).toBe(3);
      for (const sub of allSubs) {
        expect(sub.status).toBe('disabled');
      }
    });

    it('rotating AuthState active version immediately denies push registration and reminder dispatches issued under prior version', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // Rotate AuthState version
      await rotateAuthState({
        newVersion: 'new_rotated_hmac_version_v2_abcdef0123456789abcdef0123456789abcdef',
      });

      // 1. Push registration attempt with earlier session cookie is denied with 401
      const subReq = new NextRequest('http://localhost:3000/api/push/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/device-post-rotation',
          keys: { p256dh: 'p...', auth: 'a...' },
        }),
      });
      const subRes = await postSubscriptionHandler(subReq);
      expect(subRes.status).toBe(401);

      // 2. Reminder dispatch attempt with earlier session cookie is denied with 401
      const sendReq = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: 'idemp-post-rotation-key-1' }),
      });
      const sendRes = await sendReminderHandler(sendReq);
      expect(sendRes.status).toBe(401);
    });
  });
});
