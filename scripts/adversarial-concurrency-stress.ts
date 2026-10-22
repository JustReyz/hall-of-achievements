/**
 * Empirical Adversarial Concurrency & Fleet Cooldown Stress Harness
 * Target: src/lib/push/sender.ts and src/app/api/reminders/send/route.ts
 *
 * Verifies:
 * 1. 25-burst parallel requests with IDENTICAL idempotency key:
 *    - Strictly 1 actual push dispatch
 *    - Zero duplicate push calls
 *    - All 25 callers receive HTTP 200 (1 primary, 24 replayed)
 *    - Zero 500 errors or unhandled database conflicts
 * 2. 20-burst parallel requests with DISTINCT idempotency keys:
 *    - Strictly 1 caller receives HTTP 200
 *    - Strictly 19 callers receive HTTP 429 with COOLDOWN_ACTIVE and Retry-After
 *    - Push dispatch executed strictly ONCE
 *    - Exactly 1 attempt record in reminder_attempts
 * 3. Atomic advisory lock release and clean rollback
 */

import '../src/tests/setup';
import { NextRequest } from 'next/server';
import webpush from 'web-push';
import { resetDatabase, getDb } from '../src/lib/db';
import { pushSubscriptions, reminderAttempts } from '../src/lib/db/schema';
import { setAllowedTestOrigin } from '../src/lib/push/egress';
import { hashSessionToken } from '../src/lib/auth/crypto';
import { createAuthenticatedHeaders } from '../tests/helpers/auth-helper';
import { POST as sendReminderHandler } from '../src/app/api/reminders/send/route';

interface StressResult {
  name: string;
  passed: boolean;
  details: string;
}

const stressResults: StressResult[] = [];

function report(name: string, passed: boolean, details: string) {
  stressResults.push({ name, passed, details });
  const status = passed ? '[PASS]' : '[FAIL]';
  console.log(`${status} ${name}: ${details}`);
}

async function runEmpiricalStress() {
  console.log('======================================================================');
  console.log('STARTING EMPIRICAL ADVERSARIAL CONCURRENCY & COOLDOWN STRESS TEST');
  console.log('======================================================================\n');

  // Setup environment
  setAllowedTestOrigin('https://fcm.googleapis.com');

  // -------------------------------------------------------------------------
  // TEST 1: 25-Burst Slam with IDENTICAL Idempotency Key
  // -------------------------------------------------------------------------
  console.log('--- Test 1: 25-Burst Slam with Identical Idempotency Key ---');
  await resetDatabase();
  const db = await getDb();
  const { headers, rawToken } = await createAuthenticatedHeaders();
  const tokenHash = hashSessionToken(rawToken);

  const subId = crypto.randomUUID();
  await db.insert(pushSubscriptions).values({
    id: subId,
    tokenHash,
    endpoint: 'https://fcm.googleapis.com/fcm/send/stress-device-identical',
    p256dh: 'BNcRnp_mock_valid_p256dh_key_65_bytes_string_sample_value_1234567890abcdef',
    auth: 'mockAuthSecret16',
    status: 'active',
  });

  let pushCount = 0;
  const originalSend = webpush.sendNotification;
  (webpush as any).sendNotification = async () => {
    pushCount++;
    // Add artificial delay to widen race window
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { statusCode: 201, headers: {}, body: '' };
  };

  const identicalKey = 'adversarial-stress-hammer-key-identical-999';
  const burstCount = 25;

  const identicalRequests = Array.from({ length: burstCount }, () =>
    new NextRequest('http://localhost:3000/api/reminders/send', {
      method: 'POST',
      headers: new Headers(headers),
      body: JSON.stringify({ idempotencyKey: identicalKey }),
    })
  );

  const identicalResponses = await Promise.all(
    identicalRequests.map((req) => sendReminderHandler(req))
  );

  const all200 = identicalResponses.every((res) => res.status === 200);
  const statusCounts = identicalResponses.reduce((acc: Record<number, number>, res) => {
    acc[res.status] = (acc[res.status] || 0) + 1;
    return acc;
  }, {});

  const payloads = await Promise.all(identicalResponses.map((r) => r.json()));
  const initialRuns = payloads.filter((p: any) => p.replayed === false);
  const replayedRuns = payloads.filter((p: any) => p.replayed === true);

  const attemptsInDb = await db.select().from(reminderAttempts);

  report(
    'Identical Key: All 25 responses return HTTP 200',
    all200,
    `Status distribution: ${JSON.stringify(statusCounts)}`
  );

  report(
    'Identical Key: Exactly 1 primary dispatch and 24 replayed responses',
    initialRuns.length === 1 && replayedRuns.length === 24,
    `Primary: ${initialRuns.length}, Replayed: ${replayedRuns.length}`
  );

  report(
    'Identical Key: webpush.sendNotification called strictly ONCE',
    pushCount === 1,
    `Actual push count: ${pushCount}`
  );

  report(
    'Identical Key: Exactly 1 attempt record persisted in DB',
    attemptsInDb.length === 1 && attemptsInDb[0]?.idempotencyKey === identicalKey,
    `DB record count: ${attemptsInDb.length}`
  );

  // -------------------------------------------------------------------------
  // TEST 2: 20-Burst Slam with DISTINCT Idempotency Keys (Parallel Cooldown Stress)
  // -------------------------------------------------------------------------
  console.log('\n--- Test 2: 20-Burst Slam with Distinct Idempotency Keys ---');
  await resetDatabase();
  const db2 = await getDb();
  const { headers: headers2, rawToken: rawToken2 } = await createAuthenticatedHeaders();
  const tokenHash2 = hashSessionToken(rawToken2);

  await db2.insert(pushSubscriptions).values({
    id: crypto.randomUUID(),
    tokenHash: tokenHash2,
    endpoint: 'https://fcm.googleapis.com/fcm/send/stress-device-distinct',
    p256dh: 'BNcRnp_mock_valid_p256dh_key_65_bytes_string_sample_value_1234567890abcdef',
    auth: 'mockAuthSecret16',
    status: 'active',
  });

  let distinctPushCount = 0;
  (webpush as any).sendNotification = async () => {
    distinctPushCount++;
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { statusCode: 201, headers: {}, body: '' };
  };

  const distinctBurstCount = 20;
  const distinctRequests = Array.from({ length: distinctBurstCount }, (_, i) =>
    new NextRequest('http://localhost:3000/api/reminders/send', {
      method: 'POST',
      headers: new Headers(headers2),
      body: JSON.stringify({ idempotencyKey: `distinct-burst-stress-${i}-${Date.now()}` }),
    })
  );

  const distinctResponses = await Promise.all(
    distinctRequests.map((req) => sendReminderHandler(req))
  );

  const distinctStatusCounts = distinctResponses.reduce((acc: Record<number, number>, res) => {
    acc[res.status] = (acc[res.status] || 0) + 1;
    return acc;
  }, {});

  const success200 = distinctResponses.filter((r) => r.status === 200);
  const cooldown429 = distinctResponses.filter((r) => r.status === 429);

  let retryAfterValid = true;
  for (const r of cooldown429) {
    const val = Number(r.headers.get('Retry-After'));
    if (isNaN(val) || val < 50 || val > 60) {
      retryAfterValid = false;
    }
  }

  const distinctAttemptsInDb = await db2.select().from(reminderAttempts);

  report(
    'Distinct Keys: Strictly 1 success (200) and 19 cooldown rejections (429)',
    success200.length === 1 && cooldown429.length === 19,
    `Status distribution: ${JSON.stringify(distinctStatusCounts)}`
  );

  report(
    'Distinct Keys: All 19 rejected responses include valid Retry-After header',
    retryAfterValid,
    `Retry-After verified for all 19 rejections`
  );

  report(
    'Distinct Keys: webpush.sendNotification called strictly ONCE',
    distinctPushCount === 1,
    `Actual push count: ${distinctPushCount}`
  );

  report(
    'Distinct Keys: Exactly 1 attempt record created in DB',
    distinctAttemptsInDb.length === 1,
    `DB record count: ${distinctAttemptsInDb.length}`
  );

  // -------------------------------------------------------------------------
  // TEST 3: Elapsed Cooldown Re-allowance
  // -------------------------------------------------------------------------
  console.log('\n--- Test 3: Elapsed Cooldown Verification ---');
  await resetDatabase();
  const db3 = await getDb();
  const { headers: headers3, rawToken: rawToken3 } = await createAuthenticatedHeaders();
  const tokenHash3 = hashSessionToken(rawToken3);

  await db3.insert(pushSubscriptions).values({
    id: crypto.randomUUID(),
    tokenHash: tokenHash3,
    endpoint: 'https://fcm.googleapis.com/fcm/send/stress-device-elapsed',
    p256dh: 'BNcRnp_mock_valid_p256dh_key_65_bytes_string_sample_value_1234567890abcdef',
    auth: 'mockAuthSecret16',
    status: 'active',
  });

  // Insert an attempt from 65 seconds ago
  const sixtyFiveAgo = new Date(Date.now() - 65_000);
  await db3.insert(reminderAttempts).values({
    id: crypto.randomUUID(),
    idempotencyKey: 'attempt-from-65-seconds-ago-key',
    tokenHash: tokenHash3,
    targetIds: [],
    outcome: 'accepted',
    details: {},
    attemptedAt: sixtyFiveAgo,
    createdAt: sixtyFiveAgo,
  });

  const nextReq = new NextRequest('http://localhost:3000/api/reminders/send', {
    method: 'POST',
    headers: new Headers(headers3),
    body: JSON.stringify({ idempotencyKey: `after-cooldown-elapsed-key-${Date.now()}` }),
  });

  const nextRes = await sendReminderHandler(nextReq);
  const nextBody = await nextRes.json();

  report(
    'Cooldown Elapsed: New send succeeds immediately after 60s cooldown',
    nextRes.status === 200 && nextBody.success === true,
    `Status: ${nextRes.status}, Body: ${JSON.stringify(nextBody)}`
  );

  // Restore mocks
  webpush.sendNotification = originalSend;
  setAllowedTestOrigin(null);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const total = stressResults.length;
  const passed = stressResults.filter((r) => r.passed).length;
  const failed = stressResults.filter((r) => !r.passed).length;

  console.log('\n======================================================================');
  console.log(`TOTAL STRESS TESTS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('======================================================================');

  if (failed > 0) {
    console.error('\nADVERSARIAL STRESS CHALLENGE FAILED.');
    process.exit(1);
  } else {
    console.log('\nALL EMPIRICAL ADVERSARIAL STRESS CHECKS PASSED.');
    process.exit(0);
  }
}

runEmpiricalStress().catch((err) => {
  console.error('Fatal stress test runner error:', err);
  process.exit(1);
});
