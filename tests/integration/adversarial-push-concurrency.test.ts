import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { resetDatabase, getDb } from '@/lib/db';
import { pushSubscriptions, reminderAttempts } from '@/lib/db/schema';
import { setAllowedTestOrigin } from '@/lib/push/egress';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { hashSessionToken } from '@/lib/auth/crypto';
import { POST as sendReminderHandler } from '@/app/api/reminders/send/route';
import { sendManualReminder } from '@/lib/push/sender';

describe('Adversarial Verification: Concurrency, Cooldown Durability & Idempotency', () => {
  beforeEach(async () => {
    await resetDatabase();
    setAllowedTestOrigin('https://fcm.googleapis.com');
  });

  afterEach(() => {
    setAllowedTestOrigin(null);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SCENARIO 1: Rapid Concurrent Sends with Identical Idempotency Key
  // =========================================================================
  describe('1. Concurrency Slam: Identical Idempotency Key', () => {
    it('handles 10 simultaneous concurrent sends with the same key with AT MOST ONE push dispatch and ZERO crashes', async () => {
      const { headers, rawToken } = await createAuthenticatedHeaders();
      const tokenHash = hashSessionToken(rawToken);
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash,
        endpoint: 'https://fcm.googleapis.com/fcm/send/concurrency-device-1',
        p256dh: 'BNcRnp_mock_valid_p256dh_key_65_bytes_string_sample_value_1234567890abcdef',
        auth: 'mockAuthSecret16',
        status: 'active',
      });

      // Simulate network latency in webpush.sendNotification to widen race window
      let pushCount = 0;
      vi.spyOn(webpush, 'sendNotification').mockImplementation(async () => {
        pushCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { statusCode: 201, headers: {}, body: '' };
      });

      const fixedKey = 'concurrency-hammer-idempotency-key-001';

      // Launch 10 parallel requests hitting the route handler simultaneously
      const requests = Array.from({ length: 10 }, () =>
        new NextRequest('http://localhost:3000/api/reminders/send', {
          method: 'POST',
          headers: new Headers(headers),
          body: JSON.stringify({ idempotencyKey: fixedKey }),
        })
      );

      const responses = await Promise.all(requests.map((req) => sendReminderHandler(req)));

      // Invariant 1: All 10 requests must return HTTP 200 (no 500 crash or unhandled constraint violation)
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      // Invariant 2: webpush.sendNotification must be called AT MOST ONCE
      expect(pushCount).toBe(1);

      // Invariant 3: Exactly 1 record exists in reminder_attempts for this idempotency key
      const attempts = await db.select().from(reminderAttempts);
      expect(attempts.length).toBe(1);
      expect(attempts[0]?.idempotencyKey).toBe(fixedKey);

      // Invariant 4: Check response payloads
      const payloads = await Promise.all(responses.map((r) => r.json()));
      const initialRuns = payloads.filter((p: any) => p.replayed === false);
      const replayedRuns = payloads.filter((p: any) => p.replayed === true);

      expect(initialRuns.length).toBe(1);
      expect(replayedRuns.length).toBe(9);
      expect(initialRuns[0].outcome).toBe('accepted');
    });

    it('handles direct programmatic concurrency slam on sendManualReminder without duplicate dispatch', async () => {
      const { rawToken } = await createAuthenticatedHeaders();
      const tokenHash = hashSessionToken(rawToken);
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash,
        endpoint: 'https://fcm.googleapis.com/fcm/send/concurrency-device-direct',
        p256dh: 'BNcRnp_mock_valid_p256dh_key_65_bytes_string_sample_value_1234567890abcdef',
        auth: 'mockAuthSecret16',
        status: 'active',
      });

      let pushCount = 0;
      vi.spyOn(webpush, 'sendNotification').mockImplementation(async () => {
        pushCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { statusCode: 201, headers: {}, body: '' };
      });

      const fixedKey = 'direct-concurrency-hammer-idempotency-key-002';

      const promises = Array.from({ length: 8 }, () =>
        sendManualReminder({
          tokenHash,
          idempotencyKey: fixedKey,
        })
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(8);
      expect(pushCount).toBe(1);

      const notReplayed = results.filter((r) => !r.replayed);
      const replayed = results.filter((r) => r.replayed);

      expect(notReplayed.length).toBe(1);
      expect(replayed.length).toBe(7);
    });

    it('concurrent requests with distinct idempotency keys: assesses concurrency behavior under parallel burst', async () => {
      const { headers, rawToken } = await createAuthenticatedHeaders();
      const tokenHash = hashSessionToken(rawToken);
      const db = await getDb();
      const subId = crypto.randomUUID();

      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash,
        endpoint: 'https://fcm.googleapis.com/fcm/send/concurrency-distinct-device',
        p256dh: 'BNcRnp_mock_valid_p256dh_key_65_bytes_string_sample_value_1234567890abcdef',
        auth: 'mockAuthSecret16',
        status: 'active',
      });

      let pushCount = 0;
      vi.spyOn(webpush, 'sendNotification').mockImplementation(async () => {
        pushCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { statusCode: 201, headers: {}, body: '' };
      });

      // 5 concurrent requests, each with a unique idempotency key
      const requests = Array.from({ length: 5 }, (_, i) =>
        new NextRequest('http://localhost:3000/api/reminders/send', {
          method: 'POST',
          headers: new Headers(headers),
          body: JSON.stringify({ idempotencyKey: `distinct-burst-key-${i}-${Date.now()}` }),
        })
      );

      const responses = await Promise.all(requests.map((req) => sendReminderHandler(req)));

      const successResponses = responses.filter((r) => r.status === 200);
      const cooldownResponses = responses.filter((r) => r.status === 429);

      // Atomic concurrency guarantee: exactly 1 request succeeds, all other concurrent requests are rejected with 429
      expect(successResponses.length).toBe(1);
      expect(cooldownResponses.length).toBe(4);
      for (const res of cooldownResponses) {
        expect(res.headers.get('Retry-After')).toBeDefined();
        const body = (await res.json()) as any;
        expect(body.code).toBe('COOLDOWN_ACTIVE');
      }

      // Check how many push dispatches actually completed (strictly 1)
      expect(pushCount).toBe(1);
    });
  });

  // =========================================================================
  // SCENARIO 2: Rapid Consecutive Sends & Cooldown Durability Across Cold Restarts
  // =========================================================================
  describe('2. Cooldown Durability across Simulated Cold Restarts', () => {
    it('strictly returns HTTP 429 with Retry-After header across simulated cold restarts within 60s', async () => {
      const { headers: initialHeaders, rawToken } = await createAuthenticatedHeaders();
      const tokenHash = hashSessionToken(rawToken);
      const db = await getDb();

      await db.insert(pushSubscriptions).values({
        id: crypto.randomUUID(),
        tokenHash,
        endpoint: 'https://fcm.googleapis.com/fcm/send/cold-restart-device',
        p256dh: 'BNcRnp...',
        auth: 'mockAuth...',
        status: 'active',
      });

      vi.spyOn(webpush, 'sendNotification').mockResolvedValue({
        statusCode: 201,
        headers: {},
        body: '',
      });

      // 1. Initial successful dispatch
      const req1 = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers: initialHeaders,
        body: JSON.stringify({ idempotencyKey: 'idemp-cold-restart-first-001' }),
      });
      const res1 = await sendReminderHandler(req1);
      expect(res1.status).toBe(200);

      // 2. Simulate Cold Restart 1: brand new authenticated session & request object, fresh headers
      const { headers: coldRestartHeaders1 } = await createAuthenticatedHeaders();
      const req2 = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers: coldRestartHeaders1,
        body: JSON.stringify({ idempotencyKey: 'idemp-cold-restart-second-002' }),
      });
      const res2 = await sendReminderHandler(req2);

      expect(res2.status).toBe(429);
      const retryAfterHeader = res2.headers.get('Retry-After');
      expect(retryAfterHeader).toBeDefined();
      const retryAfterVal = Number(retryAfterHeader);
      expect(retryAfterVal).toBeGreaterThanOrEqual(58);
      expect(retryAfterVal).toBeLessThanOrEqual(60);

      const body2 = (await res2.json()) as any;
      expect(body2.code).toBe('COOLDOWN_ACTIVE');
      expect(body2.retryAfter).toBe(retryAfterVal);

      // 3. Simulate another cold restart with a 3rd distinct caller
      const { headers: coldRestartHeaders2 } = await createAuthenticatedHeaders();
      const req3 = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers: coldRestartHeaders2,
        body: JSON.stringify({ idempotencyKey: 'idemp-cold-restart-third-003' }),
      });
      const res3 = await sendReminderHandler(req3);
      expect(res3.status).toBe(429);
      expect(res3.headers.get('Retry-After')).toBeDefined();
    });

    it('re-allows sending immediately once 60-second cooldown has elapsed', async () => {
      const { headers, rawToken } = await createAuthenticatedHeaders();
      const tokenHash = hashSessionToken(rawToken);
      const db = await getDb();

      await db.insert(pushSubscriptions).values({
        id: crypto.randomUUID(),
        tokenHash,
        endpoint: 'https://fcm.googleapis.com/fcm/send/cooldown-elapsed-device',
        p256dh: 'BNcRnp...',
        auth: 'mockAuth...',
        status: 'active',
      });

      // Insert an attempt from 61 seconds ago
      const sixtyOneSecondsAgo = new Date(Date.now() - 61_000);
      await db.insert(reminderAttempts).values({
        id: crypto.randomUUID(),
        idempotencyKey: 'idemp-attempt-from-61s-ago-xyz',
        tokenHash,
        targetIds: [],
        outcome: 'accepted',
        details: {},
        attemptedAt: sixtyOneSecondsAgo,
        createdAt: sixtyOneSecondsAgo,
      });

      vi.spyOn(webpush, 'sendNotification').mockResolvedValue({
        statusCode: 201,
        headers: {},
        body: '',
      });

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: 'idemp-cooldown-expired-send-004' }),
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.replayed).toBe(false);
    });
  });

  // =========================================================================
  // SCENARIO 3: Provider HTTP 404 & 410 Handling (Multi-Target Fleet)
  // =========================================================================
  describe('3. Push Provider Status Lifecycle (404/410 vs Transient Errors)', () => {
    it('disables subscriptions on 404 and 410, preserves subscription on 500/503/timeout, and marks outcome partial', async () => {
      const { headers, rawToken } = await createAuthenticatedHeaders();
      const tokenHash = hashSessionToken(rawToken);
      const db = await getDb();

      const subGone = crypto.randomUUID();
      const subNotFound = crypto.randomUUID();
      const subTransient500 = crypto.randomUUID();
      const subSuccess = crypto.randomUUID();

      await db.insert(pushSubscriptions).values([
        {
          id: subGone,
          tokenHash,
          endpoint: 'https://fcm.googleapis.com/fcm/send/dev-gone-410',
          p256dh: 'BNc1...',
          auth: 'auth1...',
          status: 'active',
        },
        {
          id: subNotFound,
          tokenHash,
          endpoint: 'https://fcm.googleapis.com/fcm/send/dev-notfound-404',
          p256dh: 'BNc2...',
          auth: 'auth2...',
          status: 'active',
        },
        {
          id: subTransient500,
          tokenHash,
          endpoint: 'https://fcm.googleapis.com/fcm/send/dev-transient-500',
          p256dh: 'BNc3...',
          auth: 'auth3...',
          status: 'active',
        },
        {
          id: subSuccess,
          tokenHash,
          endpoint: 'https://fcm.googleapis.com/fcm/send/dev-success-201',
          p256dh: 'BNc4...',
          auth: 'auth4...',
          status: 'active',
        },
      ]);

      vi.spyOn(webpush, 'sendNotification').mockImplementation(async (subscription: any) => {
        if (subscription.endpoint.includes('dev-gone-410')) {
          const err = new Error('Subscription expired');
          (err as any).statusCode = 410;
          throw err;
        }
        if (subscription.endpoint.includes('dev-notfound-404')) {
          const err = new Error('Not found');
          (err as any).statusCode = 404;
          throw err;
        }
        if (subscription.endpoint.includes('dev-transient-500')) {
          const err = new Error('Internal FCM Error');
          (err as any).statusCode = 500;
          throw err;
        }
        if (subscription.endpoint.includes('dev-success-201')) {
          return { statusCode: 201, headers: {}, body: '' };
        }
        throw new Error('Unknown subscription');
      });

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: 'idemp-multi-status-fleet-005' }),
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.outcome).toBe('partial');
      expect(data.results.length).toBe(4);

      // Verify Database Status for all subscriptions
      const allSubs = await db.select().from(pushSubscriptions);
      const subMap = new Map(allSubs.map((s) => [s.id, s.status]));

      // 410 Gone MUST be marked 'disabled'
      expect(subMap.get(subGone)).toBe('disabled');

      // 404 Not Found MUST be marked 'disabled'
      expect(subMap.get(subNotFound)).toBe('disabled');

      // 500 Transient server error MUST REMAIN 'active'
      expect(subMap.get(subTransient500)).toBe('active');

      // 201 Success MUST REMAIN 'active'
      expect(subMap.get(subSuccess)).toBe('active');
    });

    it('preserves subscription status when provider call fails with network connection timeout', async () => {
      const { headers, rawToken } = await createAuthenticatedHeaders();
      const tokenHash = hashSessionToken(rawToken);
      const db = await getDb();

      const subId = crypto.randomUUID();
      await db.insert(pushSubscriptions).values({
        id: subId,
        tokenHash,
        endpoint: 'https://fcm.googleapis.com/fcm/send/dev-timeout',
        p256dh: 'BNcTimeout...',
        auth: 'authTimeout...',
        status: 'active',
      });

      const timeoutErr = new Error('connect ETIMEDOUT 142.250.180.10:443');
      vi.spyOn(webpush, 'sendNotification').mockRejectedValueOnce(timeoutErr);

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: 'idemp-timeout-test-006' }),
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.outcome).toBe('rejected');

      // Invariant: Network timeout must NOT disable subscription
      const [sub] = await db.select().from(pushSubscriptions);
      expect(sub?.status).toBe('active');
    });
  });

  // =========================================================================
  // SCENARIO 4: Service Worker Boundary & Hygiene Audit
  // =========================================================================
  describe('4. Service Worker Boundary & Storage Inspection (AC6, AC9)', () => {
    const swPath = path.resolve(process.cwd(), 'public/sw.js');
    let swContent: string;

    beforeEach(() => {
      swContent = fs.readFileSync(swPath, 'utf8');
    });

    it('guarantees ZERO Cache API usage in public/sw.js', () => {
      expect(swContent).not.toMatch(/\bcaches\b/);
      expect(swContent).not.toMatch(/caches\.open/);
      expect(swContent).not.toMatch(/caches\.match/);
      expect(swContent).not.toMatch(/caches\.put/);
      expect(swContent).not.toMatch(/caches\.delete/);
      expect(swContent).not.toMatch(/CacheStorage/);
    });

    it('guarantees ZERO fetch event listeners in public/sw.js (no request hijacking or offline caching)', () => {
      expect(swContent).not.toMatch(/addEventListener\s*\(\s*['"]fetch['"]/);
      expect(swContent).not.toMatch(/self\.onfetch/);
      expect(swContent).not.toMatch(/onfetch\s*=/);
    });

    it('handles only authorized service worker lifecycle and push events', () => {
      // Find all event listeners attached to self
      const matches = Array.from(swContent.matchAll(/self\.addEventListener\s*\(\s*['"]([a-z]+)['"]/g)).map(
        (m) => m[1]
      );
      expect(matches.sort()).toEqual(['activate', 'install', 'notificationclick', 'push'].sort());
    });

    it('restricts notificationclick navigation to same-origin root route', () => {
      expect(swContent).toContain("clients.openWindow(urlToOpen)");
      expect(swContent).toContain("client.url.includes(self.location.origin)");
      expect(swContent).toContain("client.focus()");
    });

    it('contains zero secret tokens, URLs with credentials, or server-side keys', () => {
      expect(swContent).not.toMatch(/bearer/i);
      expect(swContent).not.toMatch(/secret/i);
      expect(swContent).not.toMatch(/vapid_private/i);
      expect(swContent).not.toMatch(/owner_access_code/i);
      expect(swContent).not.toMatch(/https?:\/\/[^:]+:[^@]+@/);
    });
  });

  // =========================================================================
  // SCENARIO 5: Idempotency Key Validation & Boundary Inputs
  // =========================================================================
  describe('5. Idempotency Key Boundary Inputs & Abuse Prevention', () => {
    it('rejects missing or empty idempotencyKey with HTTP 400 INVALID_IDEMPOTENCY_KEY', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('rejects idempotencyKey shorter than 16 characters with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: 'short-key-123' }),
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('rejects idempotencyKey longer than 128 characters with HTTP 400', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ idempotencyKey: 'a'.repeat(129) }),
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('rejects invalid JSON request body with HTTP 400 INVALID_JSON', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const req = new NextRequest('http://localhost:3000/api/reminders/send', {
        method: 'POST',
        headers,
        body: 'invalid-non-json-string{',
      });

      const res = await sendReminderHandler(req);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_JSON');
    });
  });
});
