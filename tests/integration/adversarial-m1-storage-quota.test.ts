import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { signStorageCapability } from '@/lib/storage/capabilities';
import {
  reserveUploadQuota,
  getStorageQuotaStats,
  MAX_CONCURRENT_INTENTS,
  RESERVED_BYTES_PER_INTENT,
} from '@/lib/storage/quota';
import { PUT as uploadHandler } from '@/app/api/mock-storage/upload/route';
import { POST as intentHandler } from '@/app/api/uploads/intents/route';
import { DELETE as cancelIntentHandler } from '@/app/api/uploads/intents/[id]/route';
import { POST as finalizeHandler } from '@/app/api/uploads/[id]/finalize/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';

describe('Adversarial Challenge: Milestone 1 Quota Ceiling, Intent Cancellation & Upload Hardening', () => {
  beforeEach(async () => {
    await resetDatabase();
    const storage = getStorage();
    if (storage instanceof MemoryStorageAdapter) {
      storage.clear();
    }
  });

  afterEach(() => {
    delete process.env.STORAGE_PROVIDER_ALLOWANCE_BYTES;
  });

  describe('1. Intent Cancellation Hardening (DELETE /api/uploads/intents/:id)', () => {
    it('cancels pending intent, immediately frees concurrency slot, removes quarantine object, and zero-out quota', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const storage = getStorage();

      // 1. Create upload intent
      const createReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'test_cancel.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024 * 1024,
        }),
      });
      const createRes = await intentHandler(createReq);
      expect(createRes.status).toBe(201);
      const { intentId, quarantineKey } = (await createRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      // 2. Put object in quarantine storage
      await storage.putObject(quarantineKey, Buffer.from('mock-quarantine-bytes'), {
        contentType: 'image/jpeg',
      });
      const storedBefore = await storage.getObject(quarantineKey);
      expect(storedBefore).toBeDefined();

      // Check stats before cancel
      const statsBefore = await getStorageQuotaStats(db);
      expect(statsBefore.activeIntentCount).toBe(1);
      expect(statsBefore.reservedBytes).toBe(RESERVED_BYTES_PER_INTENT);
      expect(statsBefore.orphanedQuarantineBytes).toBe(0);

      // 3. Cancel intent via DELETE /api/uploads/intents/:id
      const deleteReq = new NextRequest(`http://localhost:3000/api/uploads/intents/${intentId}`, {
        method: 'DELETE',
        headers,
      });
      const deleteRes = await cancelIntentHandler(deleteReq, {
        params: Promise.resolve({ id: intentId }),
      });
      expect(deleteRes.status).toBe(200);
      const deleteJson = (await deleteRes.json()) as { success: boolean; message: string };
      expect(deleteJson.success).toBe(true);

      // 4. Verify quarantine object is physically purged from storage
      await expect(storage.getObject(quarantineKey)).rejects.toThrow();

      // 5. Verify database record updated to cleaned
      const [intentRow] = await db
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intentId));
      expect(intentRow?.status).toBe('cleaned');
      expect(intentRow?.quarantineCleanedAt).toBeTruthy();

      // 6. Verify quota stats: active count dropped to 0, reserved bytes dropped to 0
      const statsAfter = await getStorageQuotaStats(db);
      expect(statsAfter.activeIntentCount).toBe(0);
      expect(statsAfter.reservedBytes).toBe(0);
      expect(statsAfter.orphanedQuarantineBytes).toBe(0);
      expect(statsAfter.totalAccountedBytes).toBe(0);
    });

    it('unblocks concurrency limit immediately upon intent cancellation', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Saturate all 3 concurrency slots
      const intentIds: string[] = [];
      for (let i = 1; i <= MAX_CONCURRENT_INTENTS; i++) {
        const res = await intentHandler(
          new NextRequest('http://localhost:3000/api/uploads/intents', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              fileName: `saturation_${i}.png`,
              mimeType: 'image/png',
              fileSize: 500 * 1024,
            }),
          })
        );
        expect(res.status).toBe(201);
        const data = (await res.json()) as { intentId: string };
        intentIds.push(data.intentId);
      }

      // Verify activeIntentCount is 3
      const statsFull = await getStorageQuotaStats(db);
      expect(statsFull.activeIntentCount).toBe(3);

      // 4th intent MUST be rejected with HTTP 429
      const rejectedRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'saturation_4.png',
            mimeType: 'image/png',
            fileSize: 500 * 1024,
          }),
        })
      );
      expect(rejectedRes.status).toBe(429);
      const rejJson = (await rejectedRes.json()) as { code: string };
      expect(rejJson.code).toBe('TOO_MANY_CONCURRENT_INTENTS');

      // Cancel intent #2 via DELETE
      const cancelRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${intentIds[1]}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: intentIds[1]! }) }
      );
      expect(cancelRes.status).toBe(200);

      // Verify active count is now 2
      const statsFreed = await getStorageQuotaStats(db);
      expect(statsFreed.activeIntentCount).toBe(2);

      // Now 4th intent MUST succeed immediately
      const retryRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'saturation_4_retry.png',
            mimeType: 'image/png',
            fileSize: 500 * 1024,
          }),
        })
      );
      expect(retryRes.status).toBe(201);
    });

    it('returns 404 NOT_FOUND when attempting to cancel non-existent intent', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const fakeId = crypto.randomUUID();

      const res = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${fakeId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: fakeId }) }
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { code: string };
      expect(json.code).toBe('NOT_FOUND');
    });

    it('returns 409 INTENT_ALREADY_CONSUMED when attempting to cancel consumed intent', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const storage = getStorage();
      const jpegBuffer = await createTestJpeg(250, 250);

      const intentRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'artwork_finalized.jpg',
            mimeType: 'image/jpeg',
            fileSize: jpegBuffer.length,
          }),
        })
      );
      expect(intentRes.status).toBe(201);
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      await storage.putObject(quarantineKey, jpegBuffer, { contentType: 'image/jpeg' });

      const finalizeRes = await finalizeHandler(
        new NextRequest(`http://localhost:3000/api/uploads/${intentId}/finalize`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Consumed Intent Artwork',
            completionDate: '2026-11-01',
          }),
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(finalizeRes.status).toBe(200);

      // Attempt to cancel the finalized intent -> MUST be rejected with HTTP 409
      const cancelRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${intentId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(cancelRes.status).toBe(409);
      const cancelJson = (await cancelRes.json()) as { code: string };
      expect(cancelJson.code).toBe('INTENT_ALREADY_CONSUMED');
    });

    it('idempotently handles repeated cancellation of already cleaned intent', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const intentRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'repeat_cancel.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024,
          }),
        })
      );
      const { intentId } = (await intentRes.json()) as { intentId: string };

      // 1st Cancel
      const res1 = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${intentId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(res1.status).toBe(200);

      // 2nd Cancel on the exact same intent ID -> safe and idempotent
      const res2 = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${intentId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(res2.status).toBe(200);
      const json2 = (await res2.json()) as { success: boolean };
      expect(json2.success).toBe(true);
    });

    it('cleans linked pending achievement if no assets were committed when cancelled', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Create an intent
      const intentRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'pending_ach_test.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024,
          }),
        })
      );
      const { intentId } = (await intentRes.json()) as { intentId: string };

      // Create a pending achievement bound to this intent (simulating an in-flight upload session)
      const achievementId = crypto.randomUUID();
      await db.insert(achievements).values({
        id: achievementId,
        title: 'Pending Artwork To Discard',
        completionDate: '2026-11-01',
        state: 'pending',
      });
      await db
        .update(uploadIntents)
        .set({ achievementId })
        .where(eq(uploadIntents.id, intentId));

      // Verify pending achievement exists
      const [achBefore] = await db
        .select()
        .from(achievements)
        .where(eq(achievements.id, achievementId));
      expect(achBefore).toBeDefined();

      // Cancel intent via DELETE
      const cancelRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${intentId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(cancelRes.status).toBe(200);

      // Verify the pending achievement was deleted to prevent orphan metadata
      const [achAfter] = await db
        .select()
        .from(achievements)
        .where(eq(achievements.id, achievementId));
      expect(achAfter).toBeUndefined();
    });

    it('rejects unauthenticated cancellation requests with HTTP 403 (no CSRF) or HTTP 401 (no session)', async () => {
      const fakeId = crypto.randomUUID();

      // 1. Without CSRF origin -> rejected by API guard CSRF filter with HTTP 403
      const noCsrfRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${fakeId}`, {
          method: 'DELETE',
        }),
        { params: Promise.resolve({ id: fakeId }) }
      );
      expect(noCsrfRes.status).toBe(403);
      expect(((await noCsrfRes.json()) as { code: string }).code).toBe('CSRF_FAILED');

      // 2. With valid CSRF origin but missing session token -> rejected with HTTP 401 UNAUTHENTICATED
      const unauthRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${fakeId}`, {
          method: 'DELETE',
          headers: {
            origin: 'http://localhost:3000',
            'sec-fetch-site': 'same-origin',
          },
        }),
        { params: Promise.resolve({ id: fakeId }) }
      );
      expect(unauthRes.status).toBe(401);
      expect(((await unauthRes.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('2. Expired Intent & Orphan Quota Accounting', () => {
    it('continues tracking expired pending intent reservation in orphanedQuarantineBytes until quarantineCleanedAt is recorded', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const storage = getStorage();

      // 1. Create intent
      const createRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'orphan_test.jpg',
            mimeType: 'image/jpeg',
            fileSize: 2 * 1024 * 1024,
          }),
        })
      );
      expect(createRes.status).toBe(201);
      const { intentId, quarantineKey } = (await createRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      // Put data in quarantine
      await storage.putObject(quarantineKey, Buffer.from('uncleaned-quarantine-bytes'), {
        contentType: 'image/jpeg',
      });

      // 2. Simulate expiration without cleanup: set expiresAt to 10 seconds in the past
      const pastDate = new Date(Date.now() - 10000);
      await db
        .update(uploadIntents)
        .set({ expiresAt: pastDate })
        .where(eq(uploadIntents.id, intentId));

      // 3. Query quota stats
      const statsExpired = await getStorageQuotaStats(db);
      // Active intent count is 0 (concurrency slot is freed so user is not permanently locked out)
      expect(statsExpired.activeIntentCount).toBe(0);
      // BUT orphanedQuarantineBytes MUST still account for the 12 MiB reservation!
      expect(statsExpired.orphanedQuarantineBytes).toBe(RESERVED_BYTES_PER_INTENT);
      expect(statsExpired.reservedBytes).toBe(RESERVED_BYTES_PER_INTENT);
      expect(statsExpired.totalAccountedBytes).toBe(RESERVED_BYTES_PER_INTENT);

      // 4. Clean the quarantine via DELETE endpoint
      const deleteRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${intentId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(deleteRes.status).toBe(200);

      // 5. Query quota stats after cleanup: orphanedQuarantineBytes MUST drop to 0
      const statsCleaned = await getStorageQuotaStats(db);
      expect(statsCleaned.orphanedQuarantineBytes).toBe(0);
      expect(statsCleaned.reservedBytes).toBe(0);
      expect(statsCleaned.totalAccountedBytes).toBe(0);
    });

    it('enforces 70% storage quota ceiling when orphan quarantine bytes push usage over ceiling', async () => {
      const db = await getDb();
      const tokenHash = 'test_ceiling_token_hash';

      // Set allowance to 20,000,000 bytes (~19.07 MiB).
      // 70% storage ceiling = 14,000,000 bytes (~13.35 MiB).
      // RESERVED_BYTES_PER_INTENT = 12,582,912 bytes (~12.0 MiB).
      process.env.STORAGE_PROVIDER_ALLOWANCE_BYTES = '20000000';

      // Intent 1: reserves 12 MiB (12,582,912 <= 14,000,000 ceiling). This MUST succeed.
      const intent1 = await reserveUploadQuota(db, {
        tokenHash,
        fileName: 'intent_1.jpg',
        mimeType: 'image/jpeg',
        declaredSize: 1024 * 1024,
      });
      expect(intent1.id).toBeDefined();

      // Simulate expiration of Intent 1 without quarantine cleanup
      await db
        .update(uploadIntents)
        .set({
          status: 'expired',
          expiresAt: new Date(Date.now() - 30000),
          quarantineCleanedAt: null,
        })
        .where(eq(uploadIntents.id, intent1.id));

      const statsWithOrphan = await getStorageQuotaStats(db);
      expect(statsWithOrphan.activeIntentCount).toBe(0);
      expect(statsWithOrphan.orphanedQuarantineBytes).toBe(RESERVED_BYTES_PER_INTENT);

      // Attempt Intent 2:
      // Current accounted bytes = 12,582,912.
      // Required reservation = 12,582,912.
      // Total needed = 25,165,824 > 14,000,000 ceiling.
      // Quota ceiling MUST reject with HTTP 507 STORAGE_QUOTA_EXCEEDED!
      await expect(
        reserveUploadQuota(db, {
          tokenHash,
          fileName: 'intent_2.jpg',
          mimeType: 'image/jpeg',
          declaredSize: 1024 * 1024,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'STORAGE_QUOTA_EXCEEDED',
          statusCode: 507,
        })
      );

      // Now physically clean Intent 1's quarantine
      await db
        .update(uploadIntents)
        .set({ quarantineCleanedAt: new Date() })
        .where(eq(uploadIntents.id, intent1.id));

      // With orphan cleaned, total accounted bytes is 0.
      // Intent 2 MUST now succeed!
      const intent2 = await reserveUploadQuota(db, {
        tokenHash,
        fileName: 'intent_2.jpg',
        mimeType: 'image/jpeg',
        declaredSize: 1024 * 1024,
      });
      expect(intent2.id).toBeDefined();
    });

    it('auto-expires stale pending intents inside reserveUploadQuota while keeping orphan quarantine accounted', async () => {
      const db = await getDb();
      const tokenHash = 'test_autoexpire_token_hash';

      // 1. Manually insert a stale pending intent that expired 1 hour ago
      const staleIntentId = crypto.randomUUID();
      await db.insert(uploadIntents).values({
        id: staleIntentId,
        tokenHash,
        fileName: 'stale_intent.jpg',
        mimeType: 'image/jpeg',
        declaredSize: 1024 * 1024,
        reservedBytes: RESERVED_BYTES_PER_INTENT,
        quarantineKey: `quarantine/${staleIntentId}.jpg`,
        status: 'pending',
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
        quarantineCleanedAt: null,
      });

      // 2. Calling reserveUploadQuota triggers coordinator row lock and step 2 auto-expiration
      const newIntent = await reserveUploadQuota(db, {
        tokenHash,
        fileName: 'fresh_intent.jpg',
        mimeType: 'image/jpeg',
        declaredSize: 1024 * 1024,
      });
      expect(newIntent.id).toBeDefined();

      // 3. Verify the stale intent's status was updated to 'expired'
      const [staleRow] = await db
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, staleIntentId));
      expect(staleRow?.status).toBe('expired');

      // 4. Verify its bytes are still tracked in orphanedQuarantineBytes
      const stats = await getStorageQuotaStats(db);
      expect(stats.activeIntentCount).toBe(1); // Only the fresh intent
      expect(stats.orphanedQuarantineBytes).toBe(RESERVED_BYTES_PER_INTENT);
      expect(stats.reservedBytes).toBe(RESERVED_BYTES_PER_INTENT * 2);
    });
  });

  describe('3. Path Traversal Resistance & Prefix Protection on Upload (PUT /api/mock-storage/upload)', () => {
    it('rejects directory traversal vectors targeting upload endpoint with HTTP 403 FORBIDDEN_KEY', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const expires = Date.now() + 60000;

      // Traversal vectors passed in URL query parameter
      const traversalQueryStrings = [
        'key=quarantine/../originals/file.jpg',
        'key=quarantine/..\\originals\\file.jpg',
        'key=quarantine/nested/../../etc/passwd',
        'key=quarantine/....//escaped.jpg',
        'key=quarantine/%2e%2e/originals/file.jpg',
        'key=quarantine/..%2foriginals/file.jpg',
        'key=../quarantine/file.jpg',
        'key=/quarantine/file.jpg',
        'key=quarantine',
      ];

      for (const queryPart of traversalQueryStrings) {
        // Parse the key the same way the Next.js route URL parser does
        const parsedKey = new URL(`http://localhost:3000/api/mock-storage/upload?${queryPart}`).searchParams.get('key') || '';
        const sig = signStorageCapability({
          action: 'write',
          key: parsedKey,
          expiresAt: expires,
        });

        const req = new NextRequest(
          `http://localhost:3000/api/mock-storage/upload?${queryPart}&expires=${expires}&sig=${sig}`,
          {
            method: 'PUT',
            headers,
            body: Buffer.from('payload'),
          }
        );

        const res = await uploadHandler(req);
        expect(res.status, `Expected 403 for query part: ${queryPart}`).toBe(403);
        const json = (await res.json()) as { code: string };
        expect(json.code).toBe('FORBIDDEN_KEY');
      }
    });

    it('rejects non-quarantine upload target paths with HTTP 403 FORBIDDEN_KEY', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const expires = Date.now() + 60000;

      const disallowedKeys = [
        'originals/stolen.jpg',
        'assets/display.webp',
        'thumbnails/thumb.webp',
        'metadata/manifest.json',
        'system/config',
        'public/logo.png',
      ];

      for (const key of disallowedKeys) {
        const sig = signStorageCapability({
          action: 'write',
          key,
          expiresAt: expires,
        });

        const req = new NextRequest(
          `http://localhost:3000/api/mock-storage/upload?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`,
          {
            method: 'PUT',
            headers,
            body: Buffer.from('exploit-bytes'),
          }
        );

        const res = await uploadHandler(req);
        expect(res.status, `Expected 403 for non-quarantine key: ${key}`).toBe(403);
        const json = (await res.json()) as { code: string };
        expect(json.code).toBe('FORBIDDEN_KEY');
      }
    });

    it('rejects upload with missing, expired, or forged capability signature with HTTP 403 FORBIDDEN_CAPABILITY', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const validKey = 'quarantine/legit_target.jpg';
      const validExpiry = Date.now() + 60000;
      const validSig = signStorageCapability({
        action: 'write',
        key: validKey,
        expiresAt: validExpiry,
      });

      // 1. Missing signature
      const missingSigReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=${validKey}&expires=${validExpiry}`,
        { method: 'PUT', headers, body: Buffer.from('data') }
      );
      const missingRes = await uploadHandler(missingSigReq);
      expect(missingRes.status).toBe(403);
      expect(((await missingRes.json()) as { code: string }).code).toBe('FORBIDDEN_CAPABILITY');

      // 2. Forged / tampered signature
      const forgedSigReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=${validKey}&expires=${validExpiry}&sig=deadbeefc001cafe`,
        { method: 'PUT', headers, body: Buffer.from('data') }
      );
      const forgedRes = await uploadHandler(forgedSigReq);
      expect(forgedRes.status).toBe(403);
      expect(((await forgedRes.json()) as { code: string }).code).toBe('FORBIDDEN_CAPABILITY');

      // 3. Expired signature
      const pastExpiry = Date.now() - 5000;
      const expiredSig = signStorageCapability({
        action: 'write',
        key: validKey,
        expiresAt: pastExpiry,
      });
      const expiredReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=${validKey}&expires=${pastExpiry}&sig=${expiredSig}`,
        { method: 'PUT', headers, body: Buffer.from('data') }
      );
      const expiredRes = await uploadHandler(expiredReq);
      expect(expiredRes.status).toBe(403);
      expect(((await expiredRes.json()) as { code: string }).code).toBe('FORBIDDEN_CAPABILITY');

      // 4. Expiry tampering (signed for validExpiry, but query param sent as validExpiry + 1000)
      const tamperedExpiryReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=${validKey}&expires=${validExpiry + 1000}&sig=${validSig}`,
        { method: 'PUT', headers, body: Buffer.from('data') }
      );
      const tamperedExpiryRes = await uploadHandler(tamperedExpiryReq);
      expect(tamperedExpiryRes.status).toBe(403);
      expect(((await tamperedExpiryRes.json()) as { code: string }).code).toBe('FORBIDDEN_CAPABILITY');

      // 5. Key tampering (signed for validKey, but query param sent for different key)
      const tamperedKeyReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=quarantine/another_key.jpg&expires=${validExpiry}&sig=${validSig}`,
        { method: 'PUT', headers, body: Buffer.from('data') }
      );
      const tamperedKeyRes = await uploadHandler(tamperedKeyReq);
      expect(tamperedKeyRes.status).toBe(403);
      expect(((await tamperedKeyRes.json()) as { code: string }).code).toBe('FORBIDDEN_CAPABILITY');

      // 6. Action mismatch: capability signed for 'read' presented to upload handler ('write')
      const readSig = signStorageCapability({
        action: 'read',
        key: validKey,
        expiresAt: validExpiry,
      });
      const actionMismatchReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=${validKey}&expires=${validExpiry}&sig=${readSig}`,
        { method: 'PUT', headers, body: Buffer.from('data') }
      );
      const actionMismatchRes = await uploadHandler(actionMismatchReq);
      expect(actionMismatchRes.status).toBe(403);
      expect(((await actionMismatchRes.json()) as { code: string }).code).toBe('FORBIDDEN_CAPABILITY');
    });

    it('rejects unauthenticated upload requests with HTTP 401 UNAUTHENTICATED even with valid capability', async () => {
      const validKey = 'quarantine/unauth_target.jpg';
      const validExpiry = Date.now() + 60000;
      const validSig = signStorageCapability({
        action: 'write',
        key: validKey,
        expiresAt: validExpiry,
      });

      const unauthReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=${validKey}&expires=${validExpiry}&sig=${validSig}`,
        { method: 'PUT', body: Buffer.from('unauth-payload') }
      );
      const unauthRes = await uploadHandler(unauthReq);
      expect(unauthRes.status).toBe(401);
      const unauthJson = (await unauthRes.json()) as { code: string };
      expect(unauthJson.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('4. Concurrency & Replay Stress Testing', () => {
    it('concurrent cancel and create maintains quota and concurrency invariants', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Create 3 intents in parallel
      const createResults = await Promise.all([
        intentHandler(
          new NextRequest('http://localhost:3000/api/uploads/intents', {
            method: 'POST',
            headers,
            body: JSON.stringify({ fileName: 'burst_1.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
          })
        ),
        intentHandler(
          new NextRequest('http://localhost:3000/api/uploads/intents', {
            method: 'POST',
            headers,
            body: JSON.stringify({ fileName: 'burst_2.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
          })
        ),
        intentHandler(
          new NextRequest('http://localhost:3000/api/uploads/intents', {
            method: 'POST',
            headers,
            body: JSON.stringify({ fileName: 'burst_3.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
          })
        ),
      ]);

      const [res1, res2, res3] = createResults;
      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res3.status).toBe(201);

      const intent1Id = ((await res1.json()) as { intentId: string }).intentId;

      // Concurrently cancel intent 1 while requesting intent 4
      const [cancelRes, newIntentRes] = await Promise.all([
        cancelIntentHandler(
          new NextRequest(`http://localhost:3000/api/uploads/intents/${intent1Id}`, {
            method: 'DELETE',
            headers,
          }),
          { params: Promise.resolve({ id: intent1Id }) }
        ),
        intentHandler(
          new NextRequest('http://localhost:3000/api/uploads/intents', {
            method: 'POST',
            headers,
            body: JSON.stringify({ fileName: 'burst_4.jpg', mimeType: 'image/jpeg', fileSize: 1000 }),
          })
        ),
      ]);

      expect(cancelRes.status).toBe(200);
      // Intent 4 might succeed or be 429 depending on sub-millisecond arrival,
      // but if cancel finishes first, it succeeds.
      expect([201, 429]).toContain(newIntentRes.status);

      // Verify active count is within [2, 3] and DB is completely consistent
      const stats = await getStorageQuotaStats(db);
      expect(stats.activeIntentCount).toBeLessThanOrEqual(MAX_CONCURRENT_INTENTS);
    });

    it('mass concurrent replay of consumed finalize does not duplicate database rows or committed bytes', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const storage = getStorage();
      const jpegBuffer = await createTestJpeg(300, 300);

      // 1. Create intent
      const intentRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'mass_replay.jpg',
            mimeType: 'image/jpeg',
            fileSize: jpegBuffer.length,
          }),
        })
      );
      const { intentId, quarantineKey } = (await intentRes.json()) as {
        intentId: string;
        quarantineKey: string;
      };

      await storage.putObject(quarantineKey, jpegBuffer, { contentType: 'image/jpeg' });

      // 2. Finalize initial request
      const finalizeBody = {
        title: 'Mass Replay Masterpiece',
        completionDate: '2026-11-01',
        tags: ['stress', 'concurrency'],
      };
      const initialFinalize = await finalizeHandler(
        new NextRequest(`http://localhost:3000/api/uploads/${intentId}/finalize`, {
          method: 'POST',
          headers,
          body: JSON.stringify(finalizeBody),
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(initialFinalize.status).toBe(200);
      const initialPayload = (await initialFinalize.json()) as {
        finalized: boolean;
        achievement: { id: string };
        asset: { id: string };
      };

      const statsAfterInitial = await getStorageQuotaStats(db);

      // 3. Fire 6 concurrent replay requests simultaneously
      const replayRequests = Array.from({ length: 6 }).map(() =>
        finalizeHandler(
          new NextRequest(`http://localhost:3000/api/uploads/${intentId}/finalize`, {
            method: 'POST',
            headers,
            body: JSON.stringify(finalizeBody),
          }),
          { params: Promise.resolve({ id: intentId }) }
        )
      );

      const replayResults = await Promise.all(replayRequests);

      // All 6 must succeed with HTTP 200 and return identical achievement and asset IDs
      for (const res of replayResults) {
        expect(res.status).toBe(200);
        const payload = (await res.json()) as {
          finalized: boolean;
          achievement: { id: string };
          asset: { id: string };
        };
        expect(payload.finalized).toBe(true);
        expect(payload.achievement.id).toBe(initialPayload.achievement.id);
        expect(payload.asset.id).toBe(initialPayload.asset.id);
      }

      // Assert database invariants: exactly 1 achievement and 1 asset
      const allAchievements = await db.select().from(achievements);
      const allAssets = await db.select().from(assets);
      expect(allAchievements.length).toBe(1);
      expect(allAssets.length).toBe(1);

      // Assert storage quota invariants: committedBytes and totalAccountedBytes strictly match
      const statsAfterReplays = await getStorageQuotaStats(db);
      expect(statsAfterReplays.committedBytes).toBe(statsAfterInitial.committedBytes);
      expect(statsAfterReplays.totalAccountedBytes).toBe(statsAfterInitial.totalAccountedBytes);
      expect(statsAfterReplays.activeIntentCount).toBe(0);
      expect(statsAfterReplays.orphanedQuarantineBytes).toBe(0);
    });
  });
});
