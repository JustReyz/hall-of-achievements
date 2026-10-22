/**
 * Adversarial Challenge Test Harness for Milestone 4 (AC11)
 *
 * Stresses export/restore system against attack vectors and edge cases:
 * 1. Tampered manifest checksum (flip 1 bit in manifest sha256)
 * 2. Bit-flipped binary asset file
 * 3. Missing binary asset file from assets/ directory
 * 4. Missing manifest.json or corrupted JSON syntax
 * 5. Unsupported manifest version (e.g. version: 2 or version: 99)
 * 6. Path traversal attempt in manifest file path (e.g. ../../etc/passwd or ../secret.txt)
 * 7. Verification that sessions and subscriptions remain revoked/disabled in target environment
 * 8. Round-trip data fidelity test (unicode, multiline, special chars, empty/multiple tags)
 * 9. Idempotency test (restore twice to same database)
 * 10. Non-ready achievements exclusion (pending/deleting must not be exported)
 * 11. Empty archive handling (0 achievements)
 */

import '../src/tests/setup';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resetDatabase } from '../src/lib/db';
import {
  achievements,
  assets,
  sessions,
  pushSubscriptions,
  type Achievement,
} from '../src/lib/db/schema';
import { getStorage } from '../src/lib/storage';
import { MemoryStorageAdapter } from '../src/lib/storage/memory';
import { exportArchive } from '../src/lib/operations/export';
import { restoreArchive, IntegrityError } from '../src/lib/operations/restore';

interface TestResult {
  vector: string;
  name: string;
  passed: boolean;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];
let tmpDirs: string[] = [];

function createTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoa-adv-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function cleanupTmpDirs(): void {
  for (const dir of tmpDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  }
  tmpDirs = [];
}

async function seedStandardArchive(outputDir: string): Promise<{
  achId: string;
  assetId: string;
  origKey: string;
  dispKey: string;
  thumbKey: string;
  origBuf: Buffer;
  dispBuf: Buffer;
  thumbBuf: Buffer;
}> {
  const db = await resetDatabase();
  const storage = getStorage() as MemoryStorageAdapter;
  storage.clear();

  const achId = crypto.randomUUID();
  const assetId = crypto.randomUUID();

  await db.insert(achievements).values({
    id: achId,
    title: 'Standard Artwork For Testing',
    completionDate: '2026-06-15',
    notes: 'Sample notes for testing',
    tags: ['oil', 'classic'],
    state: 'ready',
  });

  const origBuf = Buffer.from('STANDARD_ORIGINAL_BINARY_BYTES', 'utf-8');
  const dispBuf = Buffer.from('STANDARD_DISPLAY_BINARY_BYTES', 'utf-8');
  const thumbBuf = Buffer.from('STANDARD_THUMB_BINARY_BYTES', 'utf-8');

  const origKey = `originals/${achId}/original.jpg`;
  const dispKey = `derivatives/${achId}/display.webp`;
  const thumbKey = `derivatives/${achId}/thumb.webp`;

  await storage.putObject(origKey, origBuf, { contentType: 'image/jpeg' });
  await storage.putObject(dispKey, dispBuf, { contentType: 'image/webp' });
  await storage.putObject(thumbKey, thumbBuf, { contentType: 'image/webp' });

  await db.insert(assets).values({
    id: assetId,
    achievementId: achId,
    originalKey: origKey,
    displayKey: dispKey,
    thumbnailKey: thumbKey,
    originalBytes: origBuf.length,
    mimeType: 'image/jpeg',
    width: 1024,
    height: 768,
    checksum: crypto.createHash('sha256').update(origBuf).digest('hex'),
  });

  await exportArchive({ outputDir, db, storage });

  return { achId, assetId, origKey, dispKey, thumbKey, origBuf, dispBuf, thumbBuf };
}

async function runVector1(): Promise<void> {
  const vector = 'Vector 1';
  const name = 'Tampered manifest checksum (flip 1 bit in manifest sha256)';
  try {
    const exportDir = createTmpDir('v1-export');
    await seedStandardArchive(exportDir);

    // Read manifest.json and flip 1 bit in the sha256 of metadata/achievements.json
    const manifestPath = path.join(exportDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const entry = manifest.files.find((f: { path: string }) => f.path === 'metadata/achievements.json');
    if (!entry) throw new Error('metadata/achievements.json not found in manifest');

    // Flip last character of sha256
    const origHash = entry.sha256 as string;
    const flippedChar = origHash.endsWith('0') ? '1' : '0';
    entry.sha256 = origHash.slice(0, -1) + flippedChar;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Target DB clean setup
    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    let threwExpected = false;
    try {
      await restoreArchive({ inputDir: exportDir, db, storage });
    } catch (err: unknown) {
      if (err instanceof IntegrityError && /checksum mismatch/i.test(err.message)) {
        threwExpected = true;
      } else {
        throw new Error(`Expected IntegrityError with checksum mismatch, got: ${String(err)}`);
      }
    }

    if (!threwExpected) {
      throw new Error('restoreArchive succeeded despite tampered manifest checksum!');
    }

    // Verify zero DB or storage changes
    const achs = await db.select().from(achievements);
    const asts = await db.select().from(assets);
    if (achs.length !== 0 || asts.length !== 0) {
      throw new Error(`Fail-closed violation: DB contains ${achs.length} achievements, ${asts.length} assets`);
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector2(): Promise<void> {
  const vector = 'Vector 2';
  const name = 'Bit-flipped binary asset file';
  try {
    const exportDir = createTmpDir('v2-export');
    const { dispKey } = await seedStandardArchive(exportDir);

    // Corrupt display asset on disk
    const assetFilePath = path.join(exportDir, 'assets', ...dispKey.split('/'));
    const originalBytes = fs.readFileSync(assetFilePath);
    // Flip 1 byte
    originalBytes[0] = originalBytes[0]! ^ 0x01;
    fs.writeFileSync(assetFilePath, originalBytes);

    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    let threwExpected = false;
    try {
      await restoreArchive({ inputDir: exportDir, db, storage });
    } catch (err: unknown) {
      if (err instanceof IntegrityError && /checksum mismatch/i.test(err.message)) {
        threwExpected = true;
      } else {
        throw new Error(`Expected IntegrityError with checksum mismatch, got: ${String(err)}`);
      }
    }

    if (!threwExpected) {
      throw new Error('restoreArchive succeeded despite bit-flipped binary asset file!');
    }

    // Verify zero DB or storage changes
    const achs = await db.select().from(achievements);
    const asts = await db.select().from(assets);
    if (achs.length !== 0 || asts.length !== 0) {
      throw new Error(`Fail-closed violation: DB has records after bit-flip failure`);
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector3(): Promise<void> {
  const vector = 'Vector 3';
  const name = 'Missing binary asset file from assets/ directory';
  try {
    const exportDir = createTmpDir('v3-export');
    const { origKey } = await seedStandardArchive(exportDir);

    // Delete original asset on disk
    const origFilePath = path.join(exportDir, 'assets', ...origKey.split('/'));
    fs.unlinkSync(origFilePath);

    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    let threwExpected = false;
    try {
      await restoreArchive({ inputDir: exportDir, db, storage });
    } catch (err: unknown) {
      if (err instanceof IntegrityError && /missing on disk/i.test(err.message)) {
        threwExpected = true;
      } else {
        throw new Error(`Expected IntegrityError with missing file message, got: ${String(err)}`);
      }
    }

    if (!threwExpected) {
      throw new Error('restoreArchive succeeded despite missing binary asset file!');
    }

    // Verify zero DB or storage changes
    const achs = await db.select().from(achievements);
    if (achs.length !== 0) {
      throw new Error(`Fail-closed violation: DB contains achievements after missing file failure`);
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector4(): Promise<void> {
  const vector = 'Vector 4';
  const name = 'Missing manifest.json or corrupted JSON syntax';
  try {
    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    // 4a: Missing manifest.json
    const emptyDir = createTmpDir('v4a-empty');
    let missingManifestThrew = false;
    try {
      await restoreArchive({ inputDir: emptyDir, db, storage });
    } catch (err: unknown) {
      if (err instanceof IntegrityError && /manifest\.json is missing/i.test(err.message)) {
        missingManifestThrew = true;
      }
    }
    if (!missingManifestThrew) {
      throw new Error('4a failed: restoreArchive did not throw expected missing manifest error');
    }

    // 4b: Corrupted JSON syntax
    const corruptDir = createTmpDir('v4b-corrupt');
    fs.writeFileSync(path.join(corruptDir, 'manifest.json'), '{ "version": 1, corrupted_json... ');
    let corruptJsonThrew = false;
    try {
      await restoreArchive({ inputDir: corruptDir, db, storage });
    } catch (err: unknown) {
      if (err instanceof IntegrityError && /failed to parse manifest\.json/i.test(err.message)) {
        corruptJsonThrew = true;
      }
    }
    if (!corruptJsonThrew) {
      throw new Error('4b failed: restoreArchive did not throw expected JSON parse error');
    }

    // Verify zero DB changes
    const achs = await db.select().from(achievements);
    if (achs.length !== 0) {
      throw new Error('Fail-closed violation: DB has records after corrupt manifest');
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector5(): Promise<void> {
  const vector = 'Vector 5';
  const name = 'Unsupported manifest version (e.g. version: 2 or version: 99)';
  try {
    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    for (const v of [2, 99, 0, -1]) {
      const vDir = createTmpDir(`v5-ver-${v}`);
      fs.writeFileSync(
        path.join(vDir, 'manifest.json'),
        JSON.stringify({ version: v, exportedAt: new Date().toISOString(), files: [] })
      );

      let threw = false;
      try {
        await restoreArchive({ inputDir: vDir, db, storage });
      } catch (err: unknown) {
        if (err instanceof IntegrityError && /unsupported manifest schema version/i.test(err.message)) {
          threw = true;
        }
      }
      if (!threw) {
        throw new Error(`Failed to reject unsupported manifest version ${v}`);
      }
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector6(): Promise<void> {
  const vector = 'Vector 6';
  const name = 'Path traversal attempt in manifest file path (e.g. ../../etc/passwd or ../secret.txt)';
  try {
    const parentDir = createTmpDir('v6-parent');
    const archiveDir = path.join(parentDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });

    // Create an external secret file outside the archive directory
    const secretFilePath = path.join(parentDir, 'secret.txt');
    const secretContent = 'TOP_SECRET_CREDENTIALS_NEVER_LEAK';
    fs.writeFileSync(secretFilePath, secretContent, 'utf-8');
    const secretHash = crypto.createHash('sha256').update(Buffer.from(secretContent)).digest('hex');

    // Case 6.1: Manifest entry pointing to ../secret.txt with exact matching hash and size
    const manifest61 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 1, totalSizeBytes: secretContent.length },
      files: [
        {
          path: '../secret.txt',
          size: secretContent.length,
          sha256: secretHash,
        },
      ],
    };
    fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest61, null, 2), 'utf-8');

    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    let rejectedTraversal61 = false;
    let errorMsg61 = '';
    try {
      await restoreArchive({ inputDir: archiveDir, db, storage });
    } catch (err: unknown) {
      errorMsg61 = err instanceof Error ? err.message : String(err);
      // Path traversal should be explicitly detected and rejected, or safely failed with IntegrityError
      if (err instanceof IntegrityError) {
        // Did it reject because of path traversal, or because of missing metadata?
        // If it read ../secret.txt, it passed step 2 and only failed in step 4 because metadata/achievements.json was missing!
        // To verify whether it actually read ../secret.txt, let's see if step 2 accepted it!
        rejectedTraversal61 = /traversal|invalid path|outside|escapes/i.test(errorMsg61);
      }
    }

    if (!rejectedTraversal61) {
      throw new Error(`Case 6.1 path traversal was not rejected: ${errorMsg61}`);
    }

    // Let's test if step 2 accepted ../secret.txt by providing metadata/achievements.json and metadata/assets.json AS WELL
    fs.mkdirSync(path.join(archiveDir, 'metadata'), { recursive: true });
    const achJson = JSON.stringify([], null, 2);
    const astJson = JSON.stringify([], null, 2);
    const achBuf = Buffer.from(achJson);
    const astBuf = Buffer.from(astJson);
    fs.writeFileSync(path.join(archiveDir, 'metadata', 'achievements.json'), achBuf);
    fs.writeFileSync(path.join(archiveDir, 'metadata', 'assets.json'), astBuf);

    // Case 6.2: Manifest includes valid metadata + malicious path traversal entry
    const manifest62 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: secretContent.length },
      files: [
        {
          path: 'metadata/achievements.json',
          size: achBuf.length,
          sha256: crypto.createHash('sha256').update(achBuf).digest('hex'),
        },
        {
          path: 'metadata/assets.json',
          size: astBuf.length,
          sha256: crypto.createHash('sha256').update(astBuf).digest('hex'),
        },
        {
          path: '../secret.txt',
          size: secretContent.length,
          sha256: secretHash,
        },
      ],
    };
    fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest62, null, 2), 'utf-8');

    let succeededWithTraversal = false;
    let rejectedTraversal62 = false;
    let errorMsg62 = '';
    try {
      await restoreArchive({ inputDir: archiveDir, db, storage });
      // If restoreArchive SUCCEEDED, it read ../secret.txt from outside the archive!
      succeededWithTraversal = true;
    } catch (err: unknown) {
      errorMsg62 = err instanceof Error ? err.message : String(err);
      if (/traversal|invalid path|outside|escapes/i.test(errorMsg62)) {
        rejectedTraversal62 = true;
      }
    }

    // Case 6.3: Path traversal with assets/../../outside.txt targeting storage write
    const manifest63 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: secretContent.length },
      files: [
        {
          path: 'metadata/achievements.json',
          size: achBuf.length,
          sha256: crypto.createHash('sha256').update(achBuf).digest('hex'),
        },
        {
          path: 'metadata/assets.json',
          size: astBuf.length,
          sha256: crypto.createHash('sha256').update(astBuf).digest('hex'),
        },
        {
          path: 'assets/../../secret.txt',
          size: secretContent.length,
          sha256: secretHash,
        },
      ],
    };
    fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest63, null, 2), 'utf-8');

    let succeededStorageTraversal = false;
    try {
      await restoreArchive({ inputDir: archiveDir, db, storage });
      succeededStorageTraversal = true;
    } catch {
      // Expected to fail on traversal
    }

    if (succeededWithTraversal || succeededStorageTraversal) {
      throw new Error(
        `CRITICAL SECURITY VULNERABILITY (Path Traversal): restoreArchive did not reject path traversal! ` +
        `Archive with '../secret.txt' successfully read external file outside archive directory into memory ` +
        `(succeededWithTraversal: ${succeededWithTraversal}, succeededStorageTraversal: ${succeededStorageTraversal}).`
      );
    }

    if (!rejectedTraversal62) {
      throw new Error(
        `Path traversal was not explicitly rejected with path validation error. Result: ${errorMsg62}`
      );
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector7(): Promise<void> {
  const vector = 'Vector 7';
  const name = 'Sessions and subscriptions remain revoked/disabled in target environment after restore';
  try {
    const exportDir = createTmpDir('v7-export');
    await seedStandardArchive(exportDir);

    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    // Seed 2 active sessions and 2 active push subscriptions on target DB before restore
    const tokenHash1 = crypto.createHash('sha256').update('active_token_1').digest('hex');
    const tokenHash2 = crypto.createHash('sha256').update('active_token_2').digest('hex');

    await db.insert(sessions).values([
      {
        tokenHash: tokenHash1,
        authStateVersion: 'v1_initial',
        idleExpiresAt: new Date(Date.now() + 86400000),
        expiresAt: new Date(Date.now() + 86400000 * 7),
        revoked: false,
      },
      {
        tokenHash: tokenHash2,
        authStateVersion: 'v1_initial',
        idleExpiresAt: new Date(Date.now() + 86400000),
        expiresAt: new Date(Date.now() + 86400000 * 7),
        revoked: false,
      },
    ]);

    const subId1 = crypto.randomUUID();
    const subId2 = crypto.randomUUID();
    await db.insert(pushSubscriptions).values([
      {
        id: subId1,
        tokenHash: tokenHash1,
        endpoint: 'https://fcm.googleapis.com/fcm/send/target-device-1',
        p256dh: 'target_p256dh_1',
        auth: 'target_auth_1',
        status: 'active',
      },
      {
        id: subId2,
        tokenHash: tokenHash2,
        endpoint: 'https://fcm.googleapis.com/fcm/send/target-device-2',
        p256dh: 'target_p256dh_2',
        auth: 'target_auth_2',
        status: 'active',
      },
    ]);

    // Perform restore
    await restoreArchive({ inputDir: exportDir, db, storage });

    // Verify all sessions in target DB are revoked
    const targetSessions = await db.select().from(sessions);
    if (targetSessions.length !== 2) {
      throw new Error(`Expected 2 sessions, found ${targetSessions.length}`);
    }
    for (const s of targetSessions) {
      if (!s.revoked || !s.revokedAt) {
        throw new Error(`Session ${s.tokenHash} was NOT revoked after restore!`);
      }
    }

    // Verify all push subscriptions in target DB are disabled
    const targetSubs = await db.select().from(pushSubscriptions);
    if (targetSubs.length !== 2) {
      throw new Error(`Expected 2 subscriptions, found ${targetSubs.length}`);
    }
    for (const sub of targetSubs) {
      if (sub.status !== 'disabled') {
        throw new Error(`Push subscription ${sub.id} status is '${sub.status}', expected 'disabled'!`);
      }
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector8(): Promise<void> {
  const vector = 'Vector 8';
  const name = 'Round-trip data fidelity test (unicode, multiline, special chars, empty/multiple tags)';
  try {
    const exportDir = createTmpDir('v8-export');
    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    const ach1Id = crypto.randomUUID();
    const ach2Id = crypto.randomUUID();
    const ach3Id = crypto.randomUUID();

    const asset1Id = crypto.randomUUID();
    const asset2Id = crypto.randomUUID();
    const asset3Id = crypto.randomUUID();

    // Test cases:
    // 1. Unicode, emojis, Japanese, Spanish accents, special HTML characters
    const ach1: typeof achievements.$inferInsert = {
      id: ach1Id,
      title: '🌟 特殊文字 <script>alert("xss")</script> &\'"/=\\`~!@#$%^&*()_+ 🎨',
      completionDate: '2026-01-01',
      notes: 'Line 1\r\nLine 2 with \t tabs\nLine 3 with unicode: こんにちは世界 🚀\n\nDouble newline.',
      tags: ['🎨 art', 'special:tag', 'emoji-✨', 'quotes"&\'', '<xml>'],
      state: 'ready',
    };

    // 2. Empty tags, null notes, date boundary
    const ach2: typeof achievements.$inferInsert = {
      id: ach2Id,
      title: 'Minimal Achievement Empty Tags Null Notes',
      completionDate: '1970-01-01',
      notes: null,
      tags: [],
      state: 'ready',
    };

    // 3. Huge notes (5000 chars), many tags, future date boundary
    const hugeNotes = 'A'.repeat(5000);
    const ach3: typeof achievements.$inferInsert = {
      id: ach3Id,
      title: 'Maximum Boundary Notes and Tags Achievement',
      completionDate: '2099-12-31',
      notes: hugeNotes,
      tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`),
      state: 'ready',
    };

    await db.insert(achievements).values([ach1, ach2, ach3]);

    // Create binary objects with exact byte buffers (including zeroes and arbitrary binary patterns)
    const buf1 = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    const buf2 = Buffer.from('SIMPLE_TEXT_BINARY_BUFFER_WEBP', 'utf-8');
    const buf3 = Buffer.alloc(4096, 0xef);

    const origKey1 = `originals/${ach1Id}/original.jpg`;
    const dispKey1 = `derivatives/${ach1Id}/display.webp`;
    const thumbKey1 = `derivatives/${ach1Id}/thumb.webp`;

    const origKey2 = `originals/${ach2Id}/original.png`;
    const dispKey2 = `derivatives/${ach2Id}/display.webp`;
    const thumbKey2 = `derivatives/${ach2Id}/thumb.webp`;

    const origKey3 = `originals/${ach3Id}/original.webp`;
    const dispKey3 = `derivatives/${ach3Id}/display.webp`;
    const thumbKey3 = `derivatives/${ach3Id}/thumb.webp`;

    for (const [k, b] of [
      [origKey1, buf1], [dispKey1, buf2], [thumbKey1, buf3],
      [origKey2, buf2], [dispKey2, buf1], [thumbKey2, buf3],
      [origKey3, buf3], [dispKey3, buf2], [thumbKey3, buf1],
    ] as [string, Buffer][]) {
      await storage.putObject(k, b, { contentType: 'application/octet-stream' });
    }

    await db.insert(assets).values([
      {
        id: asset1Id,
        achievementId: ach1Id,
        originalKey: origKey1,
        displayKey: dispKey1,
        thumbnailKey: thumbKey1,
        originalBytes: buf1.length,
        mimeType: 'image/jpeg',
        width: 3840,
        height: 2160,
        checksum: crypto.createHash('sha256').update(buf1).digest('hex'),
      },
      {
        id: asset2Id,
        achievementId: ach2Id,
        originalKey: origKey2,
        displayKey: dispKey2,
        thumbnailKey: thumbKey2,
        originalBytes: buf2.length,
        mimeType: 'image/png',
        width: 800,
        height: 600,
        checksum: crypto.createHash('sha256').update(buf2).digest('hex'),
      },
      {
        id: asset3Id,
        achievementId: ach3Id,
        originalKey: origKey3,
        displayKey: dispKey3,
        thumbnailKey: thumbKey3,
        originalBytes: buf3.length,
        mimeType: 'image/webp',
        width: 1200,
        height: 1200,
        checksum: crypto.createHash('sha256').update(buf3).digest('hex'),
      },
    ]);

    // Export
    const exportRes = await exportArchive({ outputDir: exportDir, db, storage });
    if (exportRes.achievementsCount !== 3 || exportRes.assetsCount !== 3) {
      throw new Error(`Export counts mismatch: expected 3/3, got ${exportRes.achievementsCount}/${exportRes.assetsCount}`);
    }

    // Reset target DB and clear storage
    const targetDb = await resetDatabase();
    storage.clear();

    // Restore
    const restoreRes = await restoreArchive({ inputDir: exportDir, db: targetDb, storage });
    if (restoreRes.achievementsRestored !== 3 || restoreRes.assetsRestored !== 3) {
      throw new Error(`Restore counts mismatch: expected 3/3, got ${restoreRes.achievementsRestored}/${restoreRes.assetsRestored}`);
    }

    // Verify achievement field fidelity
    const restoredAchs = await targetDb.select().from(achievements);
    const r1 = restoredAchs.find((a) => a.id === ach1Id);
    if (!r1) throw new Error('Restored ach1 missing');
    if (r1.title !== ach1.title) throw new Error(`Title fidelity failed: expected '${ach1.title}', got '${r1.title}'`);
    if (r1.notes !== ach1.notes) throw new Error(`Notes fidelity failed: expected '${ach1.notes}', got '${r1.notes}'`);
    if (JSON.stringify(r1.tags) !== JSON.stringify(ach1.tags)) {
      throw new Error(`Tags fidelity failed: expected ${JSON.stringify(ach1.tags)}, got ${JSON.stringify(r1.tags)}`);
    }
    if (r1.completionDate !== ach1.completionDate) {
      throw new Error(`Date fidelity failed: expected '${ach1.completionDate}', got '${r1.completionDate}'`);
    }

    const r2 = restoredAchs.find((a) => a.id === ach2Id);
    if (!r2) throw new Error('Restored ach2 missing');
    if (r2.notes !== null) throw new Error(`Expected null notes, got '${r2.notes}'`);
    if (r2.tags.length !== 0) throw new Error(`Expected empty tags, got ${JSON.stringify(r2.tags)}`);

    const r3 = restoredAchs.find((a) => a.id === ach3Id);
    if (!r3) throw new Error('Restored ach3 missing');
    if (r3.notes !== hugeNotes) throw new Error('Huge notes fidelity failed');
    if (r3.tags.length !== 50) throw new Error(`Expected 50 tags, got ${r3.tags.length}`);

    // Verify binary storage byte-for-byte fidelity
    const restoredObj1 = await storage.getObject(origKey1);
    if (!restoredObj1.data.equals(buf1)) {
      throw new Error('Binary buffer buf1 byte-for-byte fidelity failed!');
    }

    const restoredObj3 = await storage.getObject(thumbKey1);
    if (!restoredObj3.data.equals(buf3)) {
      throw new Error('Binary buffer buf3 byte-for-byte fidelity failed!');
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector9(): Promise<void> {
  const vector = 'Vector 9';
  const name = 'Idempotency test (restore twice to same database)';
  try {
    const exportDir = createTmpDir('v9-export');
    await seedStandardArchive(exportDir);

    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    // First restore
    const res1 = await restoreArchive({ inputDir: exportDir, db, storage });
    if (res1.achievementsRestored !== 1) {
      throw new Error(`First restore expected 1 achievement, got ${res1.achievementsRestored}`);
    }

    const achs1 = await db.select().from(achievements);
    const asts1 = await db.select().from(assets);
    if (achs1.length !== 1 || asts1.length !== 1) {
      throw new Error(`DB records after first restore unexpected: ${achs1.length} achs, ${asts1.length} asts`);
    }

    // Second restore to identical database without reset
    const res2 = await restoreArchive({ inputDir: exportDir, db, storage });
    if (res2.achievementsRestored !== 1) {
      throw new Error(`Second restore expected 1 achievement, got ${res2.achievementsRestored}`);
    }

    const achs2 = await db.select().from(achievements);
    const asts2 = await db.select().from(assets);
    if (achs2.length !== 1 || asts2.length !== 1) {
      throw new Error(`Idempotency violated: DB has ${achs2.length} achievements, ${asts2.length} assets`);
    }

    if (achs2[0]?.title !== achs1[0]?.title) {
      throw new Error('Idempotency corrupted achievement title');
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector10(): Promise<void> {
  const vector = 'Vector 10';
  const name = 'Exclusion of non-ready achievements (pending/deleting must not be exported)';
  try {
    const exportDir = createTmpDir('v10-export');
    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    const readyId = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    const deletingId = crypto.randomUUID();

    await db.insert(achievements).values([
      { id: readyId, title: 'Ready Artwork', completionDate: '2026-01-01', state: 'ready' },
      { id: pendingId, title: 'Pending Artwork', completionDate: '2026-01-02', state: 'pending' },
      { id: deletingId, title: 'Deleting Artwork', completionDate: '2026-01-03', state: 'deleting' },
    ]);

    const buf = Buffer.from('READY_BYTES');
    const origKey = `originals/${readyId}/original.jpg`;
    const dispKey = `derivatives/${readyId}/display.webp`;
    const thumbKey = `derivatives/${readyId}/thumb.webp`;
    await storage.putObject(origKey, buf, { contentType: 'image/jpeg' });
    await storage.putObject(dispKey, buf, { contentType: 'image/webp' });
    await storage.putObject(thumbKey, buf, { contentType: 'image/webp' });

    await db.insert(assets).values({
      id: crypto.randomUUID(),
      achievementId: readyId,
      originalKey: origKey,
      displayKey: dispKey,
      thumbnailKey: thumbKey,
      originalBytes: buf.length,
      mimeType: 'image/jpeg',
      width: 100,
      height: 100,
      checksum: crypto.createHash('sha256').update(buf).digest('hex'),
    });

    const exportRes = await exportArchive({ outputDir: exportDir, db, storage });
    if (exportRes.achievementsCount !== 1) {
      throw new Error(`Export included non-ready achievements: count is ${exportRes.achievementsCount}, expected 1`);
    }

    const rawAchs = JSON.parse(
      fs.readFileSync(path.join(exportDir, 'metadata', 'achievements.json'), 'utf-8')
    ) as Achievement[];
    const ids = rawAchs.map((a) => a.id);
    if (ids.includes(pendingId) || ids.includes(deletingId)) {
      throw new Error('Exported metadata contains pending or deleting achievements!');
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runVector11(): Promise<void> {
  const vector = 'Vector 11';
  const name = 'Empty archive handling (0 achievements)';
  try {
    const exportDir = createTmpDir('v11-export');
    const db = await resetDatabase();
    const storage = getStorage() as MemoryStorageAdapter;
    storage.clear();

    const exportRes = await exportArchive({ outputDir: exportDir, db, storage });
    if (exportRes.achievementsCount !== 0 || exportRes.assetsCount !== 0) {
      throw new Error(`Expected 0 achievements/assets, got ${exportRes.achievementsCount}/${exportRes.assetsCount}`);
    }

    // Verify manifest was created
    const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf-8'));
    if (manifest.metadata.achievementsCount !== 0) {
      throw new Error('Manifest achievementsCount != 0');
    }

    // Restore empty archive
    const restoreRes = await restoreArchive({ inputDir: exportDir, db, storage });
    if (restoreRes.achievementsRestored !== 0) {
      throw new Error('Restored count != 0');
    }

    results.push({ vector, name, passed: true });
  } catch (err: unknown) {
    results.push({ vector, name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('   OPERATOR EXPORT & RESTORE ADVERSARIAL CHALLENGE HARNESS      ');
  console.log('================================================================\n');

  try {
    await runVector1();
    await runVector2();
    await runVector3();
    await runVector4();
    await runVector5();
    await runVector6();
    await runVector7();
    await runVector8();
    await runVector9();
    await runVector10();
    await runVector11();
  } finally {
    cleanupTmpDirs();
  }

  console.log('----------------------------------------------------------------');
  console.log('                   CHALLENGE RESULTS SUMMARY                    ');
  console.log('----------------------------------------------------------------');

  let passedCount = 0;
  let failedCount = 0;

  for (const r of results) {
    const status = r.passed ? 'PASS [OK]' : 'FAIL [VULNERABILITY/BUG]';
    console.log(`${r.vector.padEnd(11)} | ${status.padEnd(25)} | ${r.name}`);
    if (!r.passed && r.error) {
      console.log(`            └── ERROR: ${r.error}`);
    }
    if (r.passed) passedCount++;
    else failedCount++;
  }

  console.log('----------------------------------------------------------------');
  console.log(`TOTAL: ${results.length} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
  console.log('----------------------------------------------------------------');

  if (failedCount > 0) {
    console.error(`\nOVERALL VERDICT: REJECT (Found ${failedCount} failing vectors)`);
    process.exit(1);
  } else {
    console.log('\nOVERALL VERDICT: APPROVE (All adversarial vectors defended)');
    process.exit(0);
  }
}

void main();
