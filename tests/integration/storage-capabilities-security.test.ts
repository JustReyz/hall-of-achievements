import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { uploadIntents, achievements, assets } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { signStorageCapability } from '@/lib/storage/capabilities';
import {
  reserveUploadQuota,
  getStorageQuotaStats,
  QuotaError,
  MAX_CONCURRENT_INTENTS,
} from '@/lib/storage/quota';
import { GET as downloadHandler } from '@/app/api/mock-storage/download/route';
import { PUT as uploadHandler } from '@/app/api/mock-storage/upload/route';
import { POST as intentHandler } from '@/app/api/uploads/intents/route';
import { DELETE as cancelIntentHandler } from '@/app/api/uploads/intents/[id]/route';
import { POST as finalizeHandler } from '@/app/api/uploads/[id]/finalize/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { createTestJpeg } from '../helpers/image-fixtures';

describe('Integration: Storage Capabilities, Access Control & Quota Hardening', () => {
  beforeEach(async () => {
    await resetDatabase();
    const storage = getStorage();
    if (storage instanceof MemoryStorageAdapter) {
      storage.clear();
    }
  });

  describe('Storage Endpoint Authentication & Capability Enforcement', () => {
    it('rejects unauthenticated requests to download and upload endpoints with HTTP 401', async () => {
      // 1. Unauthenticated download attempt
      const unauthDownloadReq = new NextRequest(
        'http://localhost:3000/api/mock-storage/download?key=quarantine/test.jpg',
        { method: 'GET' }
      );
      const downloadRes = await downloadHandler(unauthDownloadReq);
      expect(downloadRes.status).toBe(401);
      const downloadJson = (await downloadRes.json()) as { code: string; error: string };
      expect(downloadJson.code).toBe('UNAUTHENTICATED');

      // 2. Unauthenticated upload attempt
      const unauthUploadReq = new NextRequest(
        'http://localhost:3000/api/mock-storage/upload?key=quarantine/test.jpg',
        {
          method: 'PUT',
          body: Buffer.from('test-data'),
        }
      );
      const uploadRes = await uploadHandler(unauthUploadReq);
      expect(uploadRes.status).toBe(401);
      const uploadJson = (await uploadRes.json()) as { code: string; error: string };
      expect(uploadJson.code).toBe('UNAUTHENTICATED');
    });

    it('rejects missing, invalid, or expired capability signatures on download with HTTP 403', async () => {
      const { headers } = await createAuthenticatedHeaders();

      // 1. Missing signature
      const missingSigReq = new NextRequest(
        'http://localhost:3000/api/mock-storage/download?key=quarantine/test.jpg',
        { method: 'GET', headers }
      );
      const missingSigRes = await downloadHandler(missingSigReq);
      expect(missingSigRes.status).toBe(403);
      const missingJson = (await missingSigRes.json()) as { code: string };
      expect(missingJson.code).toBe('FORBIDDEN_CAPABILITY');

      // 2. Invalid signature
      const invalidSigReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/download?key=quarantine/test.jpg&expires=${Date.now() + 60000}&sig=badf00d`,
        { method: 'GET', headers }
      );
      const invalidSigRes = await downloadHandler(invalidSigReq);
      expect(invalidSigRes.status).toBe(403);
      const invalidJson = (await invalidSigRes.json()) as { code: string };
      expect(invalidJson.code).toBe('FORBIDDEN_CAPABILITY');

      // 3. Expired signature
      const expiredTimestamp = Date.now() - 5000;
      const expiredSig = signStorageCapability({
        action: 'read',
        key: 'quarantine/test.jpg',
        expiresAt: expiredTimestamp,
      });
      const expiredSigReq = new NextRequest(
        `http://localhost:3000/api/mock-storage/download?key=quarantine/test.jpg&expires=${expiredTimestamp}&sig=${expiredSig}`,
        { method: 'GET', headers }
      );
      const expiredSigRes = await downloadHandler(expiredSigReq);
      expect(expiredSigRes.status).toBe(403);
      const expiredJson = (await expiredSigRes.json()) as { code: string; error: string };
      expect(expiredJson.code).toBe('FORBIDDEN_CAPABILITY');
      expect(expiredJson.error).toContain('Capability expired');
    });

    it('rejects non-quarantine upload paths with HTTP 403 even if signature is valid', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const expires = Date.now() + 60000;
      const sig = signStorageCapability({
        action: 'write',
        key: 'originals/malicious.jpg',
        expiresAt: expires,
      });

      const req = new NextRequest(
        `http://localhost:3000/api/mock-storage/upload?key=originals/malicious.jpg&expires=${expires}&sig=${sig}`,
        {
          method: 'PUT',
          headers,
          body: Buffer.from('payload'),
        }
      );

      const res = await uploadHandler(req);
      expect(res.status).toBe(403);
      const json = (await res.json()) as { code: string };
      expect(json.code).toBe('FORBIDDEN_KEY');
    });

    it('successfully uploads and downloads object with valid session and signed capability', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const storage = getStorage();
      const testBuffer = Buffer.from('genuine-storage-content-12345');

      // 1. Generate signed upload URL via adapter
      const uploadResult = await storage.createSignedUploadUrl('quarantine/artifact.dat', 60);
      expect(uploadResult.uploadUrl).toContain('&sig=');

      // 2. Perform upload
      const uploadReq = new NextRequest(`http://localhost:3000${uploadResult.uploadUrl}`, {
        method: 'PUT',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
        },
        body: testBuffer,
      });
      const uploadRes = await uploadHandler(uploadReq);
      expect(uploadRes.status).toBe(200);

      // Verify object exists in storage
      const stored = await storage.getObject('quarantine/artifact.dat');
      expect(stored.data.equals(testBuffer)).toBe(true);

      // 3. Generate signed download URL via adapter with custom filename
      const downloadResult = await storage.createSignedDownloadUrl('quarantine/artifact.dat', 60, {
        downloadFilename: 'custom-export.dat',
      });
      expect(downloadResult.downloadUrl).toContain('&sig=');
      expect(downloadResult.downloadUrl).toContain('download=custom-export.dat');

      // 4. Perform download
      const downloadReq = new NextRequest(`http://localhost:3000${downloadResult.downloadUrl}`, {
        method: 'GET',
        headers,
      });
      const downloadRes = await downloadHandler(downloadReq);
      expect(downloadRes.status).toBe(200);

      const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
      expect(downloadedBytes.equals(testBuffer)).toBe(true);
      expect(downloadRes.headers.get('Content-Disposition')).toBe(
        'attachment; filename="custom-export.dat"'
      );
      expect(downloadRes.headers.get('Cache-Control')).toContain('private');
      expect(downloadRes.headers.get('Cache-Control')).toContain('no-store');
    });
  });

  describe('Atomic Quota Reservation Under Concurrency', () => {
    it('enforces maximum 3 concurrent intents atomically under parallel Promise.all', async () => {
      const db = await getDb();
      const tokenHash = 'test_concurrency_token_hash';

      // Fire 4 concurrent reservations simultaneously
      const results = await Promise.allSettled([
        reserveUploadQuota(db, {
          tokenHash,
          fileName: 'parallel_1.jpg',
          mimeType: 'image/jpeg',
          declaredSize: 1024 * 1024,
        }),
        reserveUploadQuota(db, {
          tokenHash,
          fileName: 'parallel_2.jpg',
          mimeType: 'image/jpeg',
          declaredSize: 1024 * 1024,
        }),
        reserveUploadQuota(db, {
          tokenHash,
          fileName: 'parallel_3.jpg',
          mimeType: 'image/jpeg',
          declaredSize: 1024 * 1024,
        }),
        reserveUploadQuota(db, {
          tokenHash,
          fileName: 'parallel_4.jpg',
          mimeType: 'image/jpeg',
          declaredSize: 1024 * 1024,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(MAX_CONCURRENT_INTENTS); // Exactly 3 succeed
      expect(rejected.length).toBe(1); // Exactly 1 rejected

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedError).toBeInstanceOf(QuotaError);
      expect(rejectedError.statusCode).toBe(429);
      expect(rejectedError.code).toBe('TOO_MANY_CONCURRENT_INTENTS');

      const stats = await getStorageQuotaStats(db);
      expect(stats.activeIntentCount).toBe(3);
    });
  });

  describe('Finalize Replay Idempotency & Quota Invariance', () => {
    it('replaying a consumed finalize is idempotent and does not duplicate rows or quota', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const storage = getStorage();
      const jpegBuffer = await createTestJpeg(400, 300);

      // 1. Create upload intent
      const intentReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'replay_test.jpg',
          mimeType: 'image/jpeg',
          fileSize: jpegBuffer.length,
        }),
      });
      const intentRes = await intentHandler(intentReq);
      expect(intentRes.status).toBe(201);
      const intentData = (await intentRes.json()) as { intentId: string; quarantineKey: string };

      // 2. Put bytes in quarantine
      await storage.putObject(intentData.quarantineKey, jpegBuffer, {
        contentType: 'image/jpeg',
      });

      // 3. Finalize upload
      const finalizeBody = {
        title: 'Replay Test Artwork',
        completionDate: '2026-11-01',
        tags: ['replay', 'idempotent'],
      };
      const finalizeReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentData.intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(finalizeBody),
        }
      );
      const firstFinalizeRes = await finalizeHandler(finalizeReq, {
        params: Promise.resolve({ id: intentData.intentId }),
      });
      expect(firstFinalizeRes.status).toBe(200);
      const firstPayload = (await firstFinalizeRes.json()) as {
        finalized: boolean;
        achievement: { id: string; title: string };
        asset: { id: string };
      };
      expect(firstPayload.finalized).toBe(true);

      // Verify DB row counts and quota stats after first finalize
      const achievementsAfterFirst = await db.select().from(achievements);
      const assetsAfterFirst = await db.select().from(assets);
      expect(achievementsAfterFirst.length).toBe(1);
      expect(assetsAfterFirst.length).toBe(1);

      const statsAfterFirst = await getStorageQuotaStats(db);
      expect(statsAfterFirst.activeIntentCount).toBe(0); // Intent is consumed, active count is 0

      // 4. Replay finalize for the exact same intent ID
      const replayReq = new NextRequest(
        `http://localhost:3000/api/uploads/${intentData.intentId}/finalize`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(finalizeBody),
        }
      );
      const replayRes = await finalizeHandler(replayReq, {
        params: Promise.resolve({ id: intentData.intentId }),
      });
      expect(replayRes.status).toBe(200);
      const replayPayload = (await replayRes.json()) as {
        finalized: boolean;
        achievement: { id: string };
        asset: { id: string };
      };

      // Assert identical payload and IDs
      expect(replayPayload.finalized).toBe(true);
      expect(replayPayload.achievement.id).toBe(firstPayload.achievement.id);
      expect(replayPayload.asset.id).toBe(firstPayload.asset.id);

      // Assert zero duplicate database rows
      const achievementsAfterReplay = await db.select().from(achievements);
      const assetsAfterReplay = await db.select().from(assets);
      expect(achievementsAfterReplay.length).toBe(1);
      expect(assetsAfterReplay.length).toBe(1);

      // Assert quota stats are strictly invariant
      const statsAfterReplay = await getStorageQuotaStats(db);
      expect(statsAfterReplay.committedBytes).toBe(statsAfterFirst.committedBytes);
      expect(statsAfterReplay.totalAccountedBytes).toBe(statsAfterFirst.totalAccountedBytes);
      expect(statsAfterReplay.activeIntentCount).toBe(0);
    });
  });

  describe('Upload Intent Cancellation & Quota Release', () => {
    it('cancels pending intent via DELETE, frees storage quarantine and quota immediately', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();
      const storage = getStorage();

      // 1. Create 3 intents to reach concurrency limit
      const intent1Req = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'cancel_1.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024 * 1024,
        }),
      });
      const intent1Res = await intentHandler(intent1Req);
      expect(intent1Res.status).toBe(201);
      const intent1Data = (await intent1Res.json()) as { intentId: string; quarantineKey: string };

      await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'cancel_2.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024 * 1024,
          }),
        })
      );
      await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'cancel_3.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024 * 1024,
          }),
        })
      );

      // Verify active count is 3
      const statsBefore = await getStorageQuotaStats(db);
      expect(statsBefore.activeIntentCount).toBe(3);

      // Attempting 4th intent must be rejected
      const intent4Req = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'cancel_4.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024 * 1024,
        }),
      });
      const intent4Res = await intentHandler(intent4Req);
      expect(intent4Res.status).toBe(429);

      // Put dummy file into quarantine for intent 1
      await storage.putObject(intent1Data.quarantineKey, Buffer.from('quarantine-data'), {
        contentType: 'image/jpeg',
      });
      const initialStored = await storage.getObject(intent1Data.quarantineKey);
      expect(initialStored).toBeDefined();

      // 2. Cancel intent 1 via DELETE /api/uploads/intents/:id
      const deleteReq = new NextRequest(
        `http://localhost:3000/api/uploads/intents/${intent1Data.intentId}`,
        {
          method: 'DELETE',
          headers,
        }
      );
      const deleteRes = await cancelIntentHandler(deleteReq, {
        params: Promise.resolve({ id: intent1Data.intentId }),
      });
      expect(deleteRes.status).toBe(200);

      // Verify intent 1 is marked 'cleaned'
      const [intent1Row] = await db
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intent1Data.intentId));
      expect(intent1Row?.status).toBe('cleaned');
      expect(intent1Row?.quarantineCleanedAt).toBeTruthy();

      // Verify quarantine object was deleted from storage
      await expect(storage.getObject(intent1Data.quarantineKey)).rejects.toThrow();

      // Verify active intent count dropped to 2
      const statsAfterCancel = await getStorageQuotaStats(db);
      expect(statsAfterCancel.activeIntentCount).toBe(2);

      // 3. Now creating 4th intent succeeds immediately
      const retryReq = new NextRequest('http://localhost:3000/api/uploads/intents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileName: 'cancel_4_retry.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024 * 1024,
        }),
      });
      const retryRes = await intentHandler(retryReq);
      expect(retryRes.status).toBe(201);
    });

    it('returns HTTP 409 when attempting to cancel an already consumed intent', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const storage = getStorage();
      const jpegBuffer = await createTestJpeg(200, 200);

      const intentRes = await intentHandler(
        new NextRequest('http://localhost:3000/api/uploads/intents', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fileName: 'consumed_check.jpg',
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

      await finalizeHandler(
        new NextRequest(`http://localhost:3000/api/uploads/${intentId}/finalize`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            title: 'Consumed Intent Art',
            completionDate: '2026-11-05',
          }),
        }),
        { params: Promise.resolve({ id: intentId }) }
      );

      // Attempt DELETE on consumed intent -> 409
      const deleteRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${intentId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: intentId }) }
      );
      expect(deleteRes.status).toBe(409);
      const deleteJson = (await deleteRes.json()) as { code: string };
      expect(deleteJson.code).toBe('INTENT_ALREADY_CONSUMED');
    });

    it('returns HTTP 404 when attempting to cancel a non-existent intent', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const nonExistentId = crypto.randomUUID();

      const deleteRes = await cancelIntentHandler(
        new NextRequest(`http://localhost:3000/api/uploads/intents/${nonExistentId}`, {
          method: 'DELETE',
          headers,
        }),
        { params: Promise.resolve({ id: nonExistentId }) }
      );
      expect(deleteRes.status).toBe(404);
      const deleteJson = (await deleteRes.json()) as { code: string };
      expect(deleteJson.code).toBe('NOT_FOUND');
    });
  });
});
