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
} from '../src/lib/db/schema';
import { getStorage } from '../src/lib/storage';
import { MemoryStorageAdapter } from '../src/lib/storage/memory';
import { restoreArchive, IntegrityError, assertSafeRelativePath, assertSafeStorageKey } from '../src/lib/operations/restore';

interface ProbeResult {
  id: string;
  name: string;
  passed: boolean;
  notes: string;
}

const probeResults: ProbeResult[] = [];
const tmpDirs: string[] = [];

function createTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoa-probe-${prefix}-`));
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

async function runProbes() {
  console.log('=== STARTING EMPIRICAL PROBES FOR EXPORT/RESTORE ===\n');

  // -------------------------------------------------------------
  // PROBE 1: assertSafeRelativePath Bypass Probing
  // -------------------------------------------------------------
  const bypassPayloads = [
    // Windows drive letters
    { payload: 'C:secret.txt', desc: 'Windows drive letter relative (C:secret.txt)' },
    { payload: 'C:/secret.txt', desc: 'Windows drive letter absolute forward slash (C:/secret.txt)' },
    { payload: 'C:\\secret.txt', desc: 'Windows drive letter absolute backslash (C:\\secret.txt)' },
    { payload: 'd:something/file.txt', desc: 'Lowercase drive letter (d:something/file.txt)' },
    // UNC paths
    { payload: '\\\\server\\share\\file.txt', desc: 'UNC path standard (\\\\server\\share\\file.txt)' },
    { payload: '//server/share/file.txt', desc: 'UNC path forward slash (//server/share/file.txt)' },
    { payload: '\\\\?\\C:\\secret.txt', desc: 'Windows verbatim path prefix' },
    // URL Encoding
    { payload: '%2e%2e/secret.txt', desc: 'URL encoded dot-dot (%2e%2e)' },
    { payload: '..%2fsecret.txt', desc: 'URL encoded slash (%2f)' },
    { payload: '%2e%2e%2fsecret.txt', desc: 'URL encoded both (%2e%2e%2f)' },
    { payload: 'assets/%2e%2e/%2e%2e/secret.txt', desc: 'URL encoded deep traversal' },
    { payload: '%00secret.txt', desc: 'URL encoded null byte (%00)' },
    { payload: '%252e%252e/secret.txt', desc: 'Double URL encoded traversal (%252e%252e)' },
    // Null bytes & control characters
    { payload: 'assets/file.txt\0.jpg', desc: 'Null byte injection (\\0)' },
    { payload: 'assets/file.txt\x01', desc: 'SOH control char (\\x01)' },
    { payload: 'assets/file.txt\x1f', desc: 'Unit separator control char (\\x1f)' },
    { payload: 'assets/file.txt\x7f', desc: 'DEL control char (\\x7f)' },
    { payload: 'assets/file.txt\r\n', desc: 'CRLF injection (\\r\\n)' },
    // Deep nesting & trick segments
    { payload: 'assets/a/../../..', desc: 'Deep nesting escaping root (assets/a/../../..)' },
    { payload: 'assets/a/b/c/../../../../secret.txt', desc: 'Deep nesting multi-level escape' },
    { payload: 'assets/./file.txt', desc: 'Current directory segment (assets/./file.txt)' },
    { payload: 'assets//file.txt', desc: 'Empty directory segment (assets//file.txt)' },
    { payload: '/etc/passwd', desc: 'POSIX root path (/etc/passwd)' },
    { payload: '\\Windows\\System32', desc: 'Windows backslash root path' },
  ];

  let p1Failures = 0;
  for (const item of bypassPayloads) {
    try {
      assertSafeRelativePath(os.tmpdir(), item.payload);
      console.error(`[FAIL] assertSafeRelativePath accepted dangerous payload: ${item.desc} ('${item.payload}')`);
      p1Failures++;
    } catch (err: unknown) {
      if (!(err instanceof IntegrityError)) {
        console.error(`[WARN] Threw non-IntegrityError for ${item.desc}:`, err);
      }
    }
  }

  probeResults.push({
    id: 'PROBE-1',
    name: 'assertSafeRelativePath comprehensive bypass resistance',
    passed: p1Failures === 0,
    notes: `Tested ${bypassPayloads.length} payloads. Failures: ${p1Failures}`,
  });

  // -------------------------------------------------------------
  // PROBE 2: assertSafeStorageKey Bypass Probing
  // -------------------------------------------------------------
  const storageKeyPayloads = [
    { payload: 'originals/../../secret.txt', desc: 'Traversal via .. in originals' },
    { payload: 'derivatives/../../secret.txt', desc: 'Traversal via .. in derivatives' },
    { payload: 'quarantine/secret.jpg', desc: 'Restricted quarantine namespace' },
    { payload: 'uploads/temp.jpg', desc: 'Restricted uploads namespace' },
    { payload: 'originals/foo\\bar.jpg', desc: 'Backslash in storage key' },
    { payload: 'originals/foo:bar.jpg', desc: 'Colon in storage key' },
    { payload: 'originals/foo\0bar.jpg', desc: 'Null byte in storage key' },
    { payload: 'originals/foo%2ebar.jpg', desc: 'URL encoded character in storage key' },
    { payload: '/originals/foo.jpg', desc: 'Leading slash in storage key' },
    { payload: 'originals//foo.jpg', desc: 'Empty segment in storage key' },
    { payload: 'originals/./foo.jpg', desc: 'Dot segment in storage key' },
    { payload: 'originals', desc: 'Missing trailing slash/filename' },
    { payload: 'derivatives', desc: 'Missing trailing slash/filename' },
  ];

  let p2Failures = 0;
  for (const item of storageKeyPayloads) {
    try {
      assertSafeStorageKey(item.payload);
      console.error(`[FAIL] assertSafeStorageKey accepted dangerous key: ${item.desc} ('${item.payload}')`);
      p2Failures++;
    } catch {
      // Expected
    }
  }

  probeResults.push({
    id: 'PROBE-2',
    name: 'assertSafeStorageKey comprehensive bypass resistance',
    passed: p2Failures === 0,
    notes: `Tested ${storageKeyPayloads.length} payloads. Failures: ${p2Failures}`,
  });

  // -------------------------------------------------------------
  // PROBE 3: Traversal Key Smuggling inside metadata/assets.json
  // -------------------------------------------------------------
  const probe3Dir = createTmpDir('probe3-smuggle');
  fs.mkdirSync(path.join(probe3Dir, 'metadata'), { recursive: true });

  const achBuf3 = Buffer.from(JSON.stringify([{
    id: crypto.randomUUID(),
    title: 'Smuggle Test Artwork',
    completionDate: '2026-01-01',
    state: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }], null, 2));

  // Try smuggling in displayKey and thumbnailKey as well
  const maliciousAssetsList = [
    {
      id: crypto.randomUUID(),
      achievementId: crypto.randomUUID(),
      originalKey: 'originals/valid.jpg',
      displayKey: 'derivatives/../../evil_display.webp',
      thumbnailKey: 'derivatives/valid_thumb.webp',
      originalBytes: 100,
      mimeType: 'image/jpeg',
      width: 100,
      height: 100,
      checksum: 'sha',
      createdAt: new Date().toISOString(),
    },
  ];
  const astBuf3 = Buffer.from(JSON.stringify(maliciousAssetsList, null, 2));

  fs.writeFileSync(path.join(probe3Dir, 'metadata', 'achievements.json'), achBuf3);
  fs.writeFileSync(path.join(probe3Dir, 'metadata', 'assets.json'), astBuf3);

  const manifest3 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 1, assetsCount: 1, filesCount: 2, totalSizeBytes: achBuf3.length + astBuf3.length },
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
    ],
  };
  fs.writeFileSync(path.join(probe3Dir, 'manifest.json'), JSON.stringify(manifest3, null, 2));

  const db3 = await resetDatabase();
  const storage3 = getStorage() as MemoryStorageAdapter;
  storage3.clear();

  let p3Rejected = false;
  try {
    await restoreArchive({ inputDir: probe3Dir, db: db3, storage: storage3 });
  } catch (err: unknown) {
    if (err instanceof IntegrityError && /traversal|disallowed/i.test(err.message)) {
      p3Rejected = true;
    }
  }

  probeResults.push({
    id: 'PROBE-3',
    name: 'Traversal key smuggling in metadata/assets.json (displayKey / thumbnailKey / originalKey)',
    passed: p3Rejected,
    notes: p3Rejected ? 'Successfully caught and rejected with IntegrityError' : 'VULNERABILITY: Smuggled key was accepted',
  });

  // -------------------------------------------------------------
  // PROBE 4: Host File Existence Probing (Existence Oracle)
  // -------------------------------------------------------------
  // Verify that restoreArchive rejects an invalid traversal path BEFORE checking if it exists on disk
  const probe4Dir = createTmpDir('probe4-oracle');
  fs.mkdirSync(path.join(probe4Dir, 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(probe4Dir, 'metadata', 'achievements.json'), achBuf3);
  fs.writeFileSync(path.join(probe4Dir, 'metadata', 'assets.json'), Buffer.from('[]'));

  const manifest4 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: 100 },
    files: [
      {
        path: 'metadata/achievements.json',
        size: achBuf3.length,
        sha256: crypto.createHash('sha256').update(achBuf3).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: 2,
        sha256: crypto.createHash('sha256').update(Buffer.from('[]')).digest('hex'),
      },
      {
        path: '../../completely_nonexistent_oracle_target_99999.txt',
        size: 100,
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      },
    ],
  };
  fs.writeFileSync(path.join(probe4Dir, 'manifest.json'), JSON.stringify(manifest4, null, 2));

  let p4NoOracle = false;
  try {
    await restoreArchive({ inputDir: probe4Dir, db: db3, storage: storage3 });
  } catch (err: unknown) {
    if (err instanceof IntegrityError) {
      const msg = err.message;
      if (/traversal|outside|escapes/i.test(msg) && !/missing on disk/i.test(msg)) {
        p4NoOracle = true;
      }
    }
  }

  probeResults.push({
    id: 'PROBE-4',
    name: 'Existence Oracle check: traversal rejected before disk existence query',
    passed: p4NoOracle,
    notes: p4NoOracle ? 'Confirmed: traversal rejection precedes disk stat' : 'Failed: leaked file existence',
  });

  // -------------------------------------------------------------
  // PROBE 5: Atomicity & Orphaned Record Check During Restore Failure
  // -------------------------------------------------------------
  // What happens if pre-flight checksums pass, but metadata insertion fails midway?
  // Specifically: metadata/achievements.json is valid, but metadata/assets.json has an invalid key (e.g. quarantine/exploit.jpg)
  // Check if achievements table has orphaned records after restore throws!
  const probe5Dir = createTmpDir('probe5-atomic');
  fs.mkdirSync(path.join(probe5Dir, 'metadata'), { recursive: true });

  const testAchId = crypto.randomUUID();
  const achBuf5 = Buffer.from(JSON.stringify([{
    id: testAchId,
    title: 'Atomicity Test Artwork',
    completionDate: '2026-01-01',
    state: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }], null, 2));

  const badAssetBuf5 = Buffer.from(JSON.stringify([{
    id: crypto.randomUUID(),
    achievementId: testAchId,
    originalKey: 'quarantine/exploit.jpg', // Invalid storage key!
    displayKey: 'derivatives/display.webp',
    thumbnailKey: 'derivatives/thumb.webp',
    originalBytes: 100,
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    checksum: 'sha',
    createdAt: new Date().toISOString(),
  }], null, 2));

  fs.writeFileSync(path.join(probe5Dir, 'metadata', 'achievements.json'), achBuf5);
  fs.writeFileSync(path.join(probe5Dir, 'metadata', 'assets.json'), badAssetBuf5);

  const manifest5 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 1, assetsCount: 1, filesCount: 2, totalSizeBytes: achBuf5.length + badAssetBuf5.length },
    files: [
      {
        path: 'metadata/achievements.json',
        size: achBuf5.length,
        sha256: crypto.createHash('sha256').update(achBuf5).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: badAssetBuf5.length,
        sha256: crypto.createHash('sha256').update(badAssetBuf5).digest('hex'),
      },
    ],
  };
  fs.writeFileSync(path.join(probe5Dir, 'manifest.json'), JSON.stringify(manifest5, null, 2));

  const db5 = await resetDatabase();
  const storage5 = getStorage() as MemoryStorageAdapter;
  storage5.clear();

  let p5Threw = false;
  try {
    await restoreArchive({ inputDir: probe5Dir, db: db5, storage: storage5 });
  } catch (err: unknown) {
    p5Threw = true;
  }

  // Check whether achievements table contains testAchId
  const remainingAchs = await db5.select().from(achievements);
  const remainingAssets = await db5.select().from(assets);

  console.log(`\nProbe 5 results: Threw error: ${p5Threw}`);
  console.log(`Achievements in DB after failure: ${remainingAchs.length}`);
  console.log(`Assets in DB after failure: ${remainingAssets.length}`);

  const p5Passed = remainingAchs.length === 0 && remainingAssets.length === 0;

  probeResults.push({
    id: 'PROBE-5A',
    name: 'Atomicity check: No orphaned records in DB when metadata/assets.json has disallowed key',
    passed: p5Passed,
    notes: p5Passed
      ? 'Clean: DB contains 0 records after midway failure'
      : `ORPHANED RECORDS DETECTED: DB contains ${remainingAchs.length} achievements after failure!`,
  });

  // -------------------------------------------------------------
  // PROBE 5B: Malformed JSON in metadata/assets.json Atomicity
  // -------------------------------------------------------------
  const probe5bDir = createTmpDir('probe5b-malformed');
  fs.mkdirSync(path.join(probe5bDir, 'metadata'), { recursive: true });

  const testAchIdB = crypto.randomUUID();
  const achBuf5B = Buffer.from(JSON.stringify([{
    id: testAchIdB,
    title: 'Atomicity Malformed JSON Test',
    completionDate: '2026-01-01',
    state: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }], null, 2));

  const malformedAssetsBuf = Buffer.from('{ "corrupt": invalid_json_syntax ');

  fs.writeFileSync(path.join(probe5bDir, 'metadata', 'achievements.json'), achBuf5B);
  fs.writeFileSync(path.join(probe5bDir, 'metadata', 'assets.json'), malformedAssetsBuf);

  const manifest5B = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 1, assetsCount: 0, filesCount: 2, totalSizeBytes: achBuf5B.length + malformedAssetsBuf.length },
    files: [
      {
        path: 'metadata/achievements.json',
        size: achBuf5B.length,
        sha256: crypto.createHash('sha256').update(achBuf5B).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: malformedAssetsBuf.length,
        sha256: crypto.createHash('sha256').update(malformedAssetsBuf).digest('hex'),
      },
    ],
  };
  fs.writeFileSync(path.join(probe5bDir, 'manifest.json'), JSON.stringify(manifest5B, null, 2));

  const db5B = await resetDatabase();
  storage5.clear();

  let p5BThrew = false;
  try {
    await restoreArchive({ inputDir: probe5bDir, db: db5B, storage: storage5 });
  } catch {
    p5BThrew = true;
  }

  const remainingAchs5B = await db5B.select().from(achievements);
  const p5BPassed = p5BThrew && remainingAchs5B.length === 0;

  probeResults.push({
    id: 'PROBE-5B',
    name: 'Atomicity check: No orphaned records in DB when metadata/assets.json is malformed JSON',
    passed: p5BPassed,
    notes: p5BPassed
      ? 'Clean: DB contains 0 records after malformed assets JSON'
      : `ORPHANED RECORDS DETECTED: DB contains ${remainingAchs5B.length} achievements after malformed assets JSON!`,
  });

  // -------------------------------------------------------------
  // PROBE 6: Pre-flight Checksum Failure Atomicity
  // -------------------------------------------------------------
  // If a binary file fails checksum during pre-flight, are zero records created?
  const probe6Dir = createTmpDir('probe6-preflight');
  fs.mkdirSync(path.join(probe6Dir, 'metadata'), { recursive: true });
  fs.mkdirSync(path.join(probe6Dir, 'assets', 'originals', testAchId), { recursive: true });

  fs.writeFileSync(path.join(probe6Dir, 'metadata', 'achievements.json'), achBuf5);
  fs.writeFileSync(path.join(probe6Dir, 'metadata', 'assets.json'), Buffer.from('[]'));

  const dummyBin = Buffer.from('CORRUPTED_BINARY');
  const binPath = path.join(probe6Dir, 'assets', 'originals', testAchId, 'orig.jpg');
  fs.writeFileSync(binPath, dummyBin);

  const manifest6 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 1, assetsCount: 0, filesCount: 3, totalSizeBytes: 100 },
    files: [
      {
        path: 'metadata/achievements.json',
        size: achBuf5.length,
        sha256: crypto.createHash('sha256').update(achBuf5).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: 2,
        sha256: crypto.createHash('sha256').update(Buffer.from('[]')).digest('hex'),
      },
      {
        path: `assets/originals/${testAchId}/orig.jpg`,
        size: dummyBin.length,
        sha256: 'wrong_hash_intentionally',
      },
    ],
  };
  fs.writeFileSync(path.join(probe6Dir, 'manifest.json'), JSON.stringify(manifest6, null, 2));

  const db6 = await resetDatabase();
  storage5.clear();

  let p6Threw = false;
  try {
    await restoreArchive({ inputDir: probe6Dir, db: db6, storage: storage5 });
  } catch {
    p6Threw = true;
  }

  const p6Achs = await db6.select().from(achievements);
  const p6Passed = p6Threw && p6Achs.length === 0;

  probeResults.push({
    id: 'PROBE-6',
    name: 'Atomicity check: Pre-flight checksum failure writes 0 records',
    passed: p6Passed,
    notes: p6Passed ? 'Verified: Zero mutations occur when pre-flight fails' : 'Failed: DB was mutated',
  });

  // -------------------------------------------------------------
  // PROBE 7: Post-restore target security state
  // -------------------------------------------------------------
  // Confirm sessions are marked revoked: true AND push subscriptions status: 'disabled'
  const probe7Dir = createTmpDir('probe7-sec');
  fs.mkdirSync(path.join(probe7Dir, 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(probe7Dir, 'metadata', 'achievements.json'), Buffer.from('[]'));
  fs.writeFileSync(path.join(probe7Dir, 'metadata', 'assets.json'), Buffer.from('[]'));

  const manifest7 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 2, totalSizeBytes: 4 },
    files: [
      {
        path: 'metadata/achievements.json',
        size: 2,
        sha256: crypto.createHash('sha256').update(Buffer.from('[]')).digest('hex'),
      },
      {
        path: 'metadata/assets.json',
        size: 2,
        sha256: crypto.createHash('sha256').update(Buffer.from('[]')).digest('hex'),
      },
    ],
  };
  fs.writeFileSync(path.join(probe7Dir, 'manifest.json'), JSON.stringify(manifest7, null, 2));

  const db7 = await resetDatabase();
  await db7.insert(sessions).values({
    tokenHash: 'dummy_hash_for_test',
    authStateVersion: 'v1',
    idleExpiresAt: new Date(Date.now() + 100000),
    expiresAt: new Date(Date.now() + 1000000),
    revoked: false,
  });
  await db7.insert(pushSubscriptions).values({
    id: crypto.randomUUID(),
    tokenHash: 'dummy_hash_for_test',
    endpoint: 'https://example.com',
    p256dh: 'p',
    auth: 'a',
    status: 'active',
  });

  await restoreArchive({ inputDir: probe7Dir, db: db7, storage: storage5 });

  const sessAfter = await db7.select().from(sessions);
  const subsAfter = await db7.select().from(pushSubscriptions);

  const p7Passed = sessAfter[0]?.revoked === true && subsAfter[0]?.status === 'disabled';

  probeResults.push({
    id: 'PROBE-7',
    name: 'Post-restore security guarantees: sessions revoked, subscriptions disabled',
    passed: p7Passed,
    notes: p7Passed ? 'Verified' : 'Failed to revoke/disable',
  });

  // -------------------------------------------------------------
  // PROBE 8: Whitelist namespace enforcement
  // -------------------------------------------------------------
  // Probing if unexpected top-level files (e.g. `scripts/hack.sh`, `malicious.json`, `config/db.json`)
  // are rejected even if valid relative paths inside the archive directory
  const probe8Dir = createTmpDir('probe8-whitelist');
  fs.mkdirSync(path.join(probe8Dir, 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(probe8Dir, 'metadata', 'achievements.json'), Buffer.from('[]'));
  fs.writeFileSync(path.join(probe8Dir, 'metadata', 'assets.json'), Buffer.from('[]'));

  const disallowedEntries = [
    'malicious.json',
    'scripts/hack.sh',
    'config/db.json',
    'metadata/secret.json',
    'assets_extra/payload.bin',
  ];

  let p8Failures = 0;
  for (const badFile of disallowedEntries) {
    const filePath = path.join(probe8Dir, ...badFile.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = Buffer.from('DISALLOWED_CONTENT');
    fs.writeFileSync(filePath, content);

    const m = {
      version: 1,
      exportedAt: new Date().toISOString(),
      metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: 4 + content.length },
      files: [
        {
          path: 'metadata/achievements.json',
          size: 2,
          sha256: crypto.createHash('sha256').update(Buffer.from('[]')).digest('hex'),
        },
        {
          path: 'metadata/assets.json',
          size: 2,
          sha256: crypto.createHash('sha256').update(Buffer.from('[]')).digest('hex'),
        },
        {
          path: badFile,
          size: content.length,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        },
      ],
    };
    fs.writeFileSync(path.join(probe8Dir, 'manifest.json'), JSON.stringify(m, null, 2));

    try {
      await restoreArchive({ inputDir: probe8Dir, db: db7, storage: storage5 });
      console.error(`[FAIL] restoreArchive accepted disallowed namespace entry: '${badFile}'`);
      p8Failures++;
    } catch (err: unknown) {
      if (!(err instanceof IntegrityError) || !/unexpected file location/i.test(err.message)) {
        console.error(`[WARN] Unexpected error message for disallowed file '${badFile}':`, err);
      }
    }
  }

  probeResults.push({
    id: 'PROBE-8',
    name: 'Namespace whitelist strict enforcement',
    passed: p8Failures === 0,
    notes: `Tested ${disallowedEntries.length} disallowed entries. Failures: ${p8Failures}`,
  });

  // -------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------
  console.log('\n=============================================================');
  console.log('                 EMPIRICAL PROBE SUMMARY                     ');
  console.log('=============================================================');
  let allPassed = true;
  for (const r of probeResults) {
    const status = r.passed ? 'PASS [OK]' : 'FAIL [INVESTIGATE]';
    console.log(`${r.id.padEnd(9)} | ${status.padEnd(20)} | ${r.name}`);
    console.log(`          └── Notes: ${r.notes}`);
    if (!r.passed) allPassed = false;
  }
  console.log('=============================================================');
  console.log(`TOTAL: ${probeResults.length} | OVERALL: ${allPassed ? 'ALL PROBES PASSED' : 'SOME PROBES FAILED'}\n`);

  cleanup();
  return { allPassed, probeResults };
}

runProbes().then(({ allPassed }) => {
  if (!allPassed) {
    process.exit(1);
  }
  process.exit(0);
}).catch((err) => {
  cleanup();
  console.error('Fatal probe execution error:', err);
  process.exit(1);
});
