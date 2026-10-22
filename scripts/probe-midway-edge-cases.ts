import '../src/tests/setup';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resetDatabase } from '../src/lib/db';
import {
  achievements,
  assets,
} from '../src/lib/db/schema';
import { getStorage } from '../src/lib/storage';
import { MemoryStorageAdapter } from '../src/lib/storage/memory';
import { restoreArchive, IntegrityError } from '../src/lib/operations/restore';
import type { StorageAdapter, PutObjectOptions, StorageObjectMetadata } from '../src/lib/storage/adapter';

interface ProbeResult {
  id: string;
  name: string;
  passed: boolean;
  notes: string;
}

const probeResults: ProbeResult[] = [];
const tmpDirs: string[] = [];

function createTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoa-edge-probe-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

async function runEdgeProbes() {
  console.log('=== STARTING EDGE-CASE MIDWAY ATOMICITY PROBES ===\n');

  // --------------------------------------------------------------------------
  // EDGE CASE 1: metadata/achievements.json has malformed JSON syntax
  // --------------------------------------------------------------------------
  console.log('--- Probing Edge Case 1: Malformed JSON in metadata/achievements.json ---');
  const dir1 = createTmpDir('ec1-malformed-ach');
  fs.mkdirSync(path.join(dir1, 'metadata'), { recursive: true });

  const malformedAchBuf = Buffer.from('{"id": "broken", invalid_json', 'utf-8');
  const validAstBuf1 = Buffer.from('[]', 'utf-8');

  fs.writeFileSync(path.join(dir1, 'metadata', 'achievements.json'), malformedAchBuf);
  fs.writeFileSync(path.join(dir1, 'metadata', 'assets.json'), validAstBuf1);

  const manifest1 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 1, assetsCount: 0, filesCount: 2, totalSizeBytes: malformedAchBuf.length + validAstBuf1.length },
    files: [
      {
        path: 'metadata/achievements.json',
        size: malformedAchBuf.length,
        sha256: crypto.createHash('sha256').update(malformedAchBuf).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: validAstBuf1.length,
        sha256: crypto.createHash('sha256').update(validAstBuf1).digest('hex'),
      },
    ],
  };
  fs.writeFileSync(path.join(dir1, 'manifest.json'), JSON.stringify(manifest1, null, 2), 'utf-8');

  const db1 = await resetDatabase();
  const storage1 = getStorage() as MemoryStorageAdapter;
  storage1.clear();

  let ec1Threw = false;
  let ec1Error: unknown = null;
  try {
    await restoreArchive({ inputDir: dir1, db: db1, storage: storage1 });
  } catch (err: unknown) {
    ec1Threw = true;
    ec1Error = err;
  }

  const achRows1 = await db1.select().from(achievements);
  const astRows1 = await db1.select().from(assets);
  const ec1Passed = ec1Threw && ec1Error instanceof IntegrityError && achRows1.length === 0 && astRows1.length === 0;

  console.log(`EC1 Threw IntegrityError: ${ec1Threw && ec1Error instanceof IntegrityError}`);
  console.log(`EC1 Achievements in DB: ${achRows1.length}, Assets in DB: ${astRows1.length}`);

  probeResults.push({
    id: 'EDGE-1',
    name: 'Malformed JSON in metadata/achievements.json',
    passed: ec1Passed,
    notes: ec1Passed
      ? 'Clean fail: Threw IntegrityError with 0 orphaned records in DB'
      : `Failed: DB contains ${achRows1.length} achievements / error: ${String(ec1Error)}`,
  });

  // --------------------------------------------------------------------------
  // EDGE CASE 2: Asset references invalid/non-existent achievementId (Foreign Key Violation)
  // --------------------------------------------------------------------------
  console.log('\n--- Probing Edge Case 2: Asset references invalid achievementId (FK violation) ---');
  const dir2 = createTmpDir('ec2-invalid-fkey');
  fs.mkdirSync(path.join(dir2, 'metadata'), { recursive: true });

  const validAchId = crypto.randomUUID();
  const invalidAchId = crypto.randomUUID(); // Not in achievements

  const achBuf2 = Buffer.from(JSON.stringify([{
    id: validAchId,
    title: 'Valid Artwork for FK Test',
    completionDate: '2026-01-01',
    state: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }], null, 2), 'utf-8');

  const astBuf2 = Buffer.from(JSON.stringify([{
    id: crypto.randomUUID(),
    achievementId: invalidAchId, // Non-existent achievement ID!
    originalKey: 'originals/test.jpg',
    displayKey: 'derivatives/display.webp',
    thumbnailKey: 'derivatives/thumb.webp',
    originalBytes: 100,
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    checksum: 'sha',
    createdAt: new Date().toISOString(),
  }], null, 2), 'utf-8');

  fs.writeFileSync(path.join(dir2, 'metadata', 'achievements.json'), achBuf2);
  fs.writeFileSync(path.join(dir2, 'metadata', 'assets.json'), astBuf2);

  const manifest2 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 1, assetsCount: 1, filesCount: 2, totalSizeBytes: achBuf2.length + astBuf2.length },
    files: [
      {
        path: 'metadata/achievements.json',
        size: achBuf2.length,
        sha256: crypto.createHash('sha256').update(achBuf2).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: astBuf2.length,
        sha256: crypto.createHash('sha256').update(astBuf2).digest('hex'),
      },
    ],
  };
  fs.writeFileSync(path.join(dir2, 'manifest.json'), JSON.stringify(manifest2, null, 2), 'utf-8');

  const db2 = await resetDatabase();
  const storage2 = getStorage() as MemoryStorageAdapter;
  storage2.clear();

  let ec2Threw = false;
  let ec2Error: unknown = null;
  try {
    await restoreArchive({ inputDir: dir2, db: db2, storage: storage2 });
  } catch (err: unknown) {
    ec2Threw = true;
    ec2Error = err;
  }

  const achRows2 = await db2.select().from(achievements);
  const astRows2 = await db2.select().from(assets);
  const ec2Passed = ec2Threw && achRows2.length === 0 && astRows2.length === 0;

  console.log(`EC2 Threw error: ${ec2Threw} (${ec2Error instanceof Error ? ec2Error.message : String(ec2Error)})`);
  console.log(`EC2 Achievements in DB after FK failure: ${achRows2.length}, Assets in DB: ${astRows2.length}`);

  probeResults.push({
    id: 'EDGE-2',
    name: 'Asset references invalid achievementId (FK violation transaction rollback)',
    passed: ec2Passed,
    notes: ec2Passed
      ? 'Clean rollback: DB transaction rolled back, leaving 0 achievements and 0 assets'
      : `Failed: Orphaned achievements remained: ${achRows2.length}`,
  });

  // --------------------------------------------------------------------------
  // EDGE CASE 3: storage.putObject fails midway
  // --------------------------------------------------------------------------
  console.log('\n--- Probing Edge Case 3: storage.putObject fails midway ---');
  const dir3 = createTmpDir('ec3-storage-fail');
  fs.mkdirSync(path.join(dir3, 'metadata'), { recursive: true });
  const achId3 = crypto.randomUUID();
  fs.mkdirSync(path.join(dir3, 'assets', 'originals', achId3), { recursive: true });
  fs.mkdirSync(path.join(dir3, 'assets', 'derivatives', achId3), { recursive: true });

  const achBuf3 = Buffer.from(JSON.stringify([{
    id: achId3,
    title: 'Artwork With Assets For Storage Failure Test',
    completionDate: '2026-01-01',
    state: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }], null, 2), 'utf-8');

  const origKey3 = `originals/${achId3}/original.jpg`;
  const dispKey3 = `derivatives/${achId3}/display.webp`;
  const thumbKey3 = `derivatives/${achId3}/thumb.webp`;

  const astBuf3 = Buffer.from(JSON.stringify([{
    id: crypto.randomUUID(),
    achievementId: achId3,
    originalKey: origKey3,
    displayKey: dispKey3,
    thumbnailKey: thumbKey3,
    originalBytes: 50,
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    checksum: 'sha',
    createdAt: new Date().toISOString(),
  }], null, 2), 'utf-8');

  const origFileBuf = Buffer.from('AUTHENTIC_ORIGINAL_BINARY_BYTES', 'utf-8');
  const dispFileBuf = Buffer.from('AUTHENTIC_DISPLAY_BINARY_BYTES', 'utf-8');

  fs.writeFileSync(path.join(dir3, 'metadata', 'achievements.json'), achBuf3);
  fs.writeFileSync(path.join(dir3, 'metadata', 'assets.json'), astBuf3);
  fs.writeFileSync(path.join(dir3, 'assets', 'originals', achId3, 'original.jpg'), origFileBuf);
  fs.writeFileSync(path.join(dir3, 'assets', 'derivatives', achId3, 'display.webp'), dispFileBuf);

  const manifest3 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 1, assetsCount: 1, filesCount: 4, totalSizeBytes: achBuf3.length + astBuf3.length + origFileBuf.length + dispFileBuf.length },
    files: [
      {
        path: 'metadata/achievements.json',
        size: achBuf3.length,
        sha256: crypto.createHash('sha256').update(achBuf3).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: astBuf3.length,
        sha256: crypto.createHash('sha256').update(astBuf3).digest('hex'),
      },
      {
        path: `assets/${origKey3}`,
        size: origFileBuf.length,
        sha256: crypto.createHash('sha256').update(origFileBuf).digest('hex'),
      },
      {
        path: `assets/${dispKey3}`,
        size: dispFileBuf.length,
        sha256: crypto.createHash('sha256').update(dispFileBuf).digest('hex'),
      },
    ],
  };
  fs.writeFileSync(path.join(dir3, 'manifest.json'), JSON.stringify(manifest3, null, 2), 'utf-8');

  const db3 = await resetDatabase();

  // Create a mocking storage adapter that fails on the second putObject call
  let putCount = 0;
  const baseStorage = new MemoryStorageAdapter();
  const failingStorage: StorageAdapter = {
    providerName: 'memory',
    putObject: async (key: string, data: Buffer | Uint8Array, options: PutObjectOptions): Promise<StorageObjectMetadata> => {
      putCount++;
      if (putCount >= 2) {
        throw new Error('Simulated storage IO / network failure during putObject');
      }
      return baseStorage.putObject(key, data, options);
    },
    getObject: (key: string) => baseStorage.getObject(key),
    deleteObject: (key: string) => baseStorage.deleteObject(key),
    deleteObjects: (keys: string[]) => baseStorage.deleteObjects(keys),
    createSignedUploadUrl: (key: string, exp: number) => baseStorage.createSignedUploadUrl(key, exp),
    createSignedDownloadUrl: (key: string, exp: number, opt?: any) => baseStorage.createSignedDownloadUrl(key, exp, opt),
  };

  let ec3Threw = false;
  let ec3Error: unknown = null;
  try {
    await restoreArchive({ inputDir: dir3, db: db3, storage: failingStorage });
  } catch (err: unknown) {
    ec3Threw = true;
    ec3Error = err;
  }

  const achRows3 = await db3.select().from(achievements);
  const astRows3 = await db3.select().from(assets);

  console.log(`EC3 Threw error: ${ec3Threw} (${ec3Error instanceof Error ? ec3Error.message : String(ec3Error)})`);
  console.log(`EC3 Put count before failure: ${putCount}`);
  console.log(`EC3 Achievements in DB after storage failure: ${achRows3.length}`);
  console.log(`EC3 Assets in DB after storage failure: ${astRows3.length}`);

  probeResults.push({
    id: 'EDGE-3',
    name: 'Storage putObject midway failure behavior',
    passed: ec3Threw,
    notes: `Threw error: ${ec3Threw}. Achievements in DB: ${achRows3.length}, Assets in DB: ${astRows3.length}`,
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n=============================================================');
  console.log('                 EDGE-CASE PROBE SUMMARY                     ');
  console.log('=============================================================');
  for (const r of probeResults) {
    const status = r.passed ? 'PASS [OK]' : 'FAIL [INVESTIGATE]';
    console.log(`${r.id.padEnd(9)} | ${status.padEnd(20)} | ${r.name}`);
    console.log(`          └── Notes: ${r.notes}`);
  }
  console.log('=============================================================');

  cleanup();
}

runEdgeProbes().then(() => {
  process.exit(0);
}).catch((err) => {
  cleanup();
  console.error('Fatal probe error:', err);
  process.exit(1);
});
