import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements, assets, sessions, pushSubscriptions, financeUsers, financeGroups, financeGroupMembers, financeImportRecords, financeSources, financeBudgets, financeWallets, financeTransactions, financeSessions, financeInvitations, financeNotes, financeNoteReminders, financeScheduledTasks, financePushSubscriptions } from '@/lib/db/schema';
import { getStorage } from '@/lib/storage';
import { MemoryStorageAdapter } from '@/lib/storage/memory';
import { exportArchive } from '@/lib/operations/export';
import { restoreArchive, IntegrityError } from '@/lib/operations/restore';
import { ARCHIVE_VERSION } from '@/lib/operations/export';
import { saversImportId } from '@/lib/finance/savers-id';
import { hashFinancePassword } from '@/lib/finance/password';

describe('Integration: Operator Export & Restore Protocol (AC11)', () => {
  let tmpDirs: string[] = [];

  function createTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoa-test-${prefix}-`));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    vi.stubEnv('FINANCE_EXPERIMENTAL', 'true');
    await resetDatabase();
    const storage = getStorage();
    if (storage instanceof MemoryStorageAdapter) {
      storage.clear();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpDirs) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // cleanup best-effort
      }
    }
    tmpDirs = [];
  });

  it('round-trips finance records while revoking target sessions and invitations', async () => {
    const db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const userId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const walletId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const sessionTokenHash = crypto.randomBytes(32).toString('hex');
    const invitationTokenHash = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    await db.insert(financeUsers).values({ id: userId, username: 'archive-owner', passwordHash: await hashFinancePassword('a-strong-finance-password'), displayName: 'Archive Owner', profilePicture: 'data:image/webp;base64,YQ==' });
    await db.insert(financeGroups).values({ id: groupId, name: 'Archive household', createdBy: userId });
    await db.insert(financeGroupMembers).values({ groupId, userId, role: 'owner' });
    await db.insert(financeSources).values({ id: sourceId, groupId, name: 'Bank', type: 'bank', createdBy: userId });
    await db.insert(financeBudgets).values({ groupId, monthlyLimit: '2500000.00', enabled: true });
    await db.insert(financeWallets).values({ id: walletId, groupId, name: 'Emergency', type: 'goal', targetAmount: '5000000.00' });
    await db.insert(financeTransactions).values({ id: transactionId, groupId, walletId, sourceId, type: 'income', amount: '1200.50', category: 'Salary', note: 'Monthly', transactionDate: '2026-11-10', createdBy: userId, idempotencyKey: crypto.randomUUID() });
    await db.insert(financeNotes).values({ id: noteId, groupId, createdBy: userId, title: 'Review savings', content: 'Compare rate', targetAt: new Date('2026-11-21T09:00:00Z'), isPinned: true });
    const reminderId = crypto.randomUUID();
    await db.insert(financeNoteReminders).values({ id: reminderId, groupId, noteId, createdBy: userId, reminderType: 'recurring', remindAt: new Date('2026-11-20T09:00:00Z'), recurrence: 'weekly', untilDate: '2026-12-31', message: 'Review it' });
    await db.insert(financeScheduledTasks).values({ id: taskId, groupId, createdBy: userId, title: 'Pay rent', scheduleAt: new Date('2026-11-25T02:00:00Z'), recurrence: 'monthly' });
    const legacyWalletId = crypto.randomUUID();
    await db.insert(financeImportRecords).values({ kind: 'wallet', legacyId: legacyWalletId, targetId: saversImportId('wallet', legacyWalletId), groupId });
    await db.insert(financeSessions).values({ tokenHash: sessionTokenHash, userId, idleExpiresAt: new Date(now.getTime() + 60_000), expiresAt: new Date(now.getTime() + 60_000) });
    await db.insert(financeInvitations).values({ tokenHash: invitationTokenHash, groupId, invitedBy: userId, expiresAt: new Date(now.getTime() + 60_000) });
    await db.insert(financePushSubscriptions).values({ userId, endpoint: 'https://fcm.googleapis.com/fcm/send/private-capability', p256dh: 'secret-public-key', auth: 'secret-auth-key' });

    const outputDir = createTmpDir('finance-roundtrip');
    const archive = await exportArchive({ outputDir, db, storage });
    expect(archive.manifest.version).toBe(ARCHIVE_VERSION);
    expect(archive.manifest.files.some((entry) => entry.path === 'metadata/finance.json')).toBe(true);
    const financeFile = fs.readFileSync(path.join(outputDir, 'metadata', 'finance.json'), 'utf8');
    expect(financeFile).not.toContain(sessionTokenHash);
    expect(financeFile).not.toContain(invitationTokenHash);
    expect(financeFile).not.toContain('private-capability');
    expect(financeFile).not.toContain('secret-auth-key');

    await db.insert(financeSessions).values({ tokenHash: crypto.randomBytes(32).toString('hex'), userId, idleExpiresAt: new Date(now.getTime() + 60_000), expiresAt: new Date(now.getTime() + 60_000) });
    await db.delete(financeImportRecords);
    await restoreArchive({ inputDir: outputDir, db, storage });
    expect((await db.select().from(financeUsers)).map(({ id, username }) => ({ id, username }))).toEqual([{ id: userId, username: 'archive-owner' }]);
    expect((await db.select().from(financeUsers))[0]?.profilePicture).toBe('data:image/webp;base64,YQ==');
    expect((await db.select().from(financeImportRecords))[0]).toMatchObject({ kind: 'wallet', targetId: saversImportId('wallet', legacyWalletId), groupId });
    expect((await db.select().from(financeGroups)).map(({ id, name }) => ({ id, name }))).toEqual([{ id: groupId, name: 'Archive household' }]);
    expect((await db.select().from(financeWallets)).map(({ id, targetAmount }) => ({ id, targetAmount }))).toEqual([{ id: walletId, targetAmount: '5000000.00' }]);
    expect((await db.select().from(financeTransactions)).map(({ id, amount }) => ({ id, amount }))).toEqual([{ id: transactionId, amount: '1200.50' }]);
    expect((await db.select().from(financeNotes)).map(({ id, isPinned }) => ({ id, isPinned }))).toEqual([{ id: noteId, isPinned: true }]);
    expect((await db.select().from(financeNoteReminders)).map(({ id, recurrence }) => ({ id, recurrence }))).toEqual([{ id: reminderId, recurrence: 'weekly' }]);
    expect((await db.select().from(financeScheduledTasks)).map(({ id, recurrence }) => ({ id, recurrence }))).toEqual([{ id: taskId, recurrence: 'monthly' }]);
    expect((await db.select().from(financeBudgets)).map(({ monthlyLimit }) => monthlyLimit)).toEqual(['2500000.00']);
    expect((await db.select().from(financeSessions)).every((session) => session.revokedAt instanceof Date)).toBe(true);
    expect((await db.select().from(financeInvitations)).every((invitation) => invitation.revokedAt instanceof Date)).toBe(true);
    expect((await db.select().from(financePushSubscriptions)).every((subscription) => subscription.status === 'disabled')).toBe(true);
  });

  it('restores version 6 archives without import records and rejects incomplete version 7 archives', async () => {
    const db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const outputDir = createTmpDir('finance-v6-compatibility');
    await exportArchive({ outputDir, db, storage });
    const financePath = path.join(outputDir, 'metadata', 'finance.json');
    const payload = JSON.parse(fs.readFileSync(financePath, 'utf8')) as Record<string, unknown>;
    delete payload.importRecords;
    const buffer = Buffer.from(JSON.stringify(payload));
    fs.writeFileSync(financePath, buffer);
    const manifestPath = path.join(outputDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: number; files: Array<{ path: string; size: number; sha256: string }> };
    const entry = manifest.files.find((item) => item.path === 'metadata/finance.json')!;
    entry.size = buffer.length;
    entry.sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    manifest.version = 6;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(restoreArchive({ inputDir: outputDir, db, storage })).resolves.toBeDefined();
    manifest.version = 7;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(restoreArchive({ inputDir: outputDir, db, storage })).rejects.toThrow('Missing importRecords');
  });

  it('restores planner history authored by a former group member', async () => {
    const db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const passwordHash = await hashFinancePassword('a-strong-finance-password');
    const [owner, former] = await db.insert(financeUsers).values([
      { username: 'history-owner', displayName: 'Owner', passwordHash },
      { username: 'history-former', displayName: 'Former', passwordHash },
    ]).returning();
    const [group] = await db.insert(financeGroups).values({ name: 'History', createdBy: owner!.id }).returning();
    await db.insert(financeGroupMembers).values({ groupId: group!.id, userId: owner!.id, role: 'owner' });
    const [note] = await db.insert(financeNotes).values({ groupId: group!.id, createdBy: former!.id, title: 'History' }).returning();
    await db.insert(financeNoteReminders).values({ groupId: group!.id, noteId: note!.id, createdBy: former!.id, remindAt: new Date() });
    await db.insert(financeScheduledTasks).values({ groupId: group!.id, createdBy: former!.id, title: 'Task', scheduleAt: new Date() });
    const outputDir = createTmpDir('finance-former-member');
    await exportArchive({ outputDir, db, storage });
    await db.delete(financeNoteReminders);
    await db.delete(financeScheduledTasks);
    await restoreArchive({ inputDir: outputDir, db, storage });
    expect((await db.select().from(financeNoteReminders))[0]?.createdBy).toBe(former!.id);
    expect((await db.select().from(financeScheduledTasks))[0]?.createdBy).toBe(former!.id);
  });

  it('validates finance archive relationships before any database changes', async () => {
    const db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;
    const outputDir = createTmpDir('finance-invalid');
    await exportArchive({ outputDir, db, storage });
    const financePath = path.join(outputDir, 'metadata', 'finance.json');
    const financePayload = JSON.parse(fs.readFileSync(financePath, 'utf8')) as { wallets: unknown[] };
    financePayload.wallets.push({ id: crypto.randomUUID(), groupId: crypto.randomUUID(), name: 'Orphan', type: 'regular', targetAmount: null, currency: 'IDR', defaultCategory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const financeBuffer = Buffer.from(JSON.stringify(financePayload));
    fs.writeFileSync(financePath, financeBuffer);
    const manifestPath = path.join(outputDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; size: number; sha256: string }> };
    const financeEntry = manifest.files.find((entry) => entry.path === 'metadata/finance.json')!;
    financeEntry.size = financeBuffer.length;
    financeEntry.sha256 = crypto.createHash('sha256').update(financeBuffer).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(restoreArchive({ inputDir: outputDir, db, storage })).rejects.toThrow(IntegrityError);
    expect(await db.select().from(financeWallets)).toEqual([]);
    expect(await db.select().from(achievements)).toEqual([]);
  });

  it('completes full export and restore round-trip with checksum verification', async () => {
    let db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;

    // 1. Seed ready achievements and linked assets
    const achId1 = crypto.randomUUID();
    const achId2 = crypto.randomUUID();
    const assetId1 = crypto.randomUUID();
    const assetId2 = crypto.randomUUID();

    await db.insert(achievements).values([
      {
        id: achId1,
        title: 'Masterpiece 1: Starlit Lake',
        completionDate: '2026-05-10',
        notes: 'Oil painting on canvas with textured skies',
        imageDescription: 'A small sailboat beneath a starry blue sky.',
        tags: ['oil', 'landscape'],
        state: 'ready',
      },
      {
        id: achId2,
        title: 'Masterpiece 2: Mountain Peak',
        completionDate: '2026-08-20',
        notes: 'Acrylic on wood panel',
        tags: ['acrylic', 'mountains'],
        state: 'ready',
      },
    ]);

    // Store binary objects for both achievements
    const origBuf1 = Buffer.from('FAKE_ORIGINAL_BINARY_BYTES_1_JPEG', 'utf-8');
    const dispBuf1 = Buffer.from('FAKE_DISPLAY_BINARY_BYTES_1_WEBP', 'utf-8');
    const thumbBuf1 = Buffer.from('FAKE_THUMB_BINARY_BYTES_1_WEBP', 'utf-8');

    const origBuf2 = Buffer.from('FAKE_ORIGINAL_BINARY_BYTES_2_PNG', 'utf-8');
    const dispBuf2 = Buffer.from('FAKE_DISPLAY_BINARY_BYTES_2_WEBP', 'utf-8');
    const thumbBuf2 = Buffer.from('FAKE_THUMB_BINARY_BYTES_2_WEBP', 'utf-8');

    const origKey1 = `originals/${achId1}/original.jpg`;
    const dispKey1 = `derivatives/${achId1}/display.webp`;
    const thumbKey1 = `derivatives/${achId1}/thumb.webp`;

    const origKey2 = `originals/${achId2}/original.png`;
    const dispKey2 = `derivatives/${achId2}/display.webp`;
    const thumbKey2 = `derivatives/${achId2}/thumb.webp`;

    await storage.putObject(origKey1, origBuf1, { contentType: 'image/jpeg' });
    await storage.putObject(dispKey1, dispBuf1, { contentType: 'image/webp' });
    await storage.putObject(thumbKey1, thumbBuf1, { contentType: 'image/webp' });

    await storage.putObject(origKey2, origBuf2, { contentType: 'image/png' });
    await storage.putObject(dispKey2, dispBuf2, { contentType: 'image/webp' });
    await storage.putObject(thumbKey2, thumbBuf2, { contentType: 'image/webp' });

    await db.insert(assets).values([
      {
        id: assetId1,
        achievementId: achId1,
        originalKey: origKey1,
        displayKey: dispKey1,
        thumbnailKey: thumbKey1,
        originalBytes: origBuf1.length,
        mimeType: 'image/jpeg',
        width: 1920,
        height: 1080,
        checksum: crypto.createHash('sha256').update(origBuf1).digest('hex'),
      },
      {
        id: assetId2,
        achievementId: achId2,
        originalKey: origKey2,
        displayKey: dispKey2,
        thumbnailKey: thumbKey2,
        originalBytes: origBuf2.length,
        mimeType: 'image/png',
        width: 1200,
        height: 900,
        checksum: crypto.createHash('sha256').update(origBuf2).digest('hex'),
      },
    ]);

    // Seed dummy session and push subscription in source DB (must NOT be exported)
    const tokenHash = crypto.createHash('sha256').update('secret_session_token').digest('hex');
    await db.insert(sessions).values({
      tokenHash,
      authStateVersion: 'v1_initial',
      idleExpiresAt: new Date(Date.now() + 86400000),
      expiresAt: new Date(Date.now() + 86400000 * 7),
      revoked: false,
    });

    await db.insert(pushSubscriptions).values({
      id: crypto.randomUUID(),
      tokenHash,
      endpoint: 'https://fcm.googleapis.com/fcm/send/fake-device-endpoint-1',
      p256dh: 'BNcRdreALRF8FsII1yk_',
      auth: 'tBHItJqlVqN_bWdc5BaDAg',
      status: 'active',
    });

    // 2. Perform Export
    const exportDir = createTmpDir('export');
    const exportRes = await exportArchive({ outputDir: exportDir, db, storage });

    expect(exportRes.achievementsCount).toBe(2);
    expect(exportRes.assetsCount).toBe(2);
    expect(exportRes.filesCount).toBe(10); // 4 metadata + 6 binary assets
    expect(exportRes.manifest.version).toBe(ARCHIVE_VERSION);

    // Verify disk structure
    const manifestPath = path.join(exportDir, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(path.join(exportDir, 'metadata', 'achievements.json'))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, 'metadata', 'assets.json'))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, 'metadata', 'collections.json'))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, 'assets', ...origKey1.split('/')))).toBe(true);
    expect(fs.existsSync(path.join(exportDir, 'assets', ...origKey2.split('/')))).toBe(true);

    // Verify session and push exclusion
    const exportEntries = fs.readdirSync(exportDir);
    expect(exportEntries).not.toContain('sessions.json');
    expect(exportEntries).not.toContain('push_subscriptions.json');

    // 3. Reset database and storage to a clean, empty state
    db = await resetDatabase();
    storage.clear();

    const emptyAchievements = await db.select().from(achievements);
    expect(emptyAchievements.length).toBe(0);

    // 4. Restore from export directory
    const restoreRes = await restoreArchive({ inputDir: exportDir, db, storage });

    expect(restoreRes.achievementsRestored).toBe(2);
    const descriptionRows = await db
      .select({ id: achievements.id, imageDescription: achievements.imageDescription })
      .from(achievements);
    expect(descriptionRows.find((row) => row.id === achId1)?.imageDescription).toBe(
      'A small sailboat beneath a starry blue sky.'
    );
    expect(restoreRes.assetsRestored).toBe(2);
    expect(restoreRes.filesRestored).toBe(10);

    // 5. Verify restored DB records
    const restoredAchievements = await db.select().from(achievements);
    expect(restoredAchievements.length).toBe(2);
    const restored1 = restoredAchievements.find((a) => a.id === achId1);
    expect(restored1).toBeDefined();
    expect(restored1?.title).toBe('Masterpiece 1: Starlit Lake');
    expect(restored1?.completionDate).toBe('2026-05-10');
    expect(restored1?.tags).toEqual(['oil', 'landscape']);

    const restoredAssets = await db.select().from(assets);
    expect(restoredAssets.length).toBe(2);
    const asset1 = restoredAssets.find((a) => a.id === assetId1);
    expect(asset1).toBeDefined();
    expect(asset1?.width).toBe(1920);
    expect(asset1?.originalBytes).toBe(origBuf1.length);

    // 6. Verify restored binary objects in storage
    const restoredObj1 = await storage.getObject(origKey1);
    expect(restoredObj1.data.toString('utf-8')).toBe(origBuf1.toString('utf-8'));

    const restoredObj2 = await storage.getObject(dispKey2);
    expect(restoredObj2.data.toString('utf-8')).toBe(dispBuf2.toString('utf-8'));

    // 7. Verify post-restore security: sessions empty/revoked, push subscriptions empty/disabled
    const restoredSessions = await db.select().from(sessions);
    expect(restoredSessions.length).toBe(0); // None were restored
  });

  it('fails closed and aborts with IntegrityError before modifying DB when file is corrupted', async () => {
    let db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;

    // Seed 1 achievement and export
    const achId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    await db.insert(achievements).values({
      id: achId,
      title: 'Untampered Work',
      completionDate: '2026-01-01',
      state: 'ready',
    });

    const origBuf = Buffer.from('AUTHENTIC_ORIGINAL_BYTES', 'utf-8');
    const dispBuf = Buffer.from('AUTHENTIC_DISPLAY_BYTES', 'utf-8');
    const thumbBuf = Buffer.from('AUTHENTIC_THUMB_BYTES', 'utf-8');

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
      width: 800,
      height: 600,
      checksum: crypto.createHash('sha256').update(origBuf).digest('hex'),
    });

    const exportDir = createTmpDir('tamper-test');
    await exportArchive({ outputDir: exportDir, db, storage });

    // TAMPER WITH A FILE: Overwrite display.webp with corrupted bytes
    const displayFilePath = path.join(exportDir, 'assets', ...dispKey.split('/'));
    fs.writeFileSync(displayFilePath, Buffer.from('CORRUPTED_TAMPERED_BYTES', 'utf-8'));

    // Reset target DB
    db = await resetDatabase();
    storage.clear();

    // Attempt restore — must fail with IntegrityError
    await expect(restoreArchive({ inputDir: exportDir, db, storage })).rejects.toThrow(
      IntegrityError
    );

    // Verify fail-closed atomicity: zero records in DB, zero objects in storage
    const targetAchievements = await db.select().from(achievements);
    expect(targetAchievements.length).toBe(0);

    const targetAssets = await db.select().from(assets);
    expect(targetAssets.length).toBe(0);

    await expect(storage.getObject(origKey)).rejects.toThrow();
  });

  it('fails closed when manifest is missing or contains unsupported version', async () => {
    const db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;

    const invalidDir = createTmpDir('invalid-version');
    fs.writeFileSync(
      path.join(invalidDir, 'manifest.json'),
      JSON.stringify({ version: 99, files: [] })
    );

    await expect(restoreArchive({ inputDir: invalidDir, db, storage })).rejects.toThrow(
      IntegrityError
    );
  });

  it('fails closed when any listed file is missing from archive', async () => {
    let db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;

    // Seed 1 achievement and export
    const achId = crypto.randomUUID();
    await db.insert(achievements).values({
      id: achId,
      title: 'Work With Missing File',
      completionDate: '2026-03-01',
      state: 'ready',
    });

    const exportDir = createTmpDir('missing-file-test');
    await exportArchive({ outputDir: exportDir, db, storage });

    // DELETE metadata/assets.json
    fs.unlinkSync(path.join(exportDir, 'metadata', 'assets.json'));

    db = await resetDatabase();
    storage.clear();

    await expect(restoreArchive({ inputDir: exportDir, db, storage })).rejects.toThrow(
      /missing on disk/i
    );

    // Verify zero DB mutations
    const records = await db.select().from(achievements);
    expect(records.length).toBe(0);
  });

  it('enforces post-restore session revocation and push disablement on target DB', async () => {
    let db = await getDb();
    const storage = getStorage() as MemoryStorageAdapter;

    // 1. Export valid archive
    const achId = crypto.randomUUID();
    await db.insert(achievements).values({
      id: achId,
      title: 'Security Target Artwork',
      completionDate: '2026-04-01',
      state: 'ready',
    });
    const exportDir = createTmpDir('post-restore-sec');
    await exportArchive({ outputDir: exportDir, db, storage });

    // 2. Clear achievements, but leave an active session and active subscription on target DB
    db = await resetDatabase();

    const targetTokenHash = crypto.createHash('sha256').update('target_session').digest('hex');
    await db.insert(sessions).values({
      tokenHash: targetTokenHash,
      authStateVersion: 'v1_initial',
      idleExpiresAt: new Date(Date.now() + 86400000),
      expiresAt: new Date(Date.now() + 86400000 * 7),
      revoked: false,
    });

    const subId = crypto.randomUUID();
    await db.insert(pushSubscriptions).values({
      id: subId,
      tokenHash: targetTokenHash,
      endpoint: 'https://push.example.com/sub/123',
      p256dh: 'fake-p256dh',
      auth: 'fake-auth',
      status: 'active',
    });

    // 3. Restore archive
    await restoreArchive({ inputDir: exportDir, db, storage });

    // 4. Verify post-restore security: target session was revoked, push subscription was disabled
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, targetTokenHash));
    expect(sessionRows.length).toBe(1);
    expect(sessionRows[0]?.revoked).toBe(true);
    expect(sessionRows[0]?.revokedAt).not.toBeNull();

    const subRows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, subId));
    expect(subRows.length).toBe(1);
    expect(subRows[0]?.status).toBe('disabled');
  });

  describe('Path Traversal & Archive Containment Protections (AC11)', () => {
    function setupValidMetadata(archiveDir: string) {
      fs.mkdirSync(path.join(archiveDir, 'metadata'), { recursive: true });
      const achBuf = Buffer.from(JSON.stringify([], null, 2), 'utf-8');
      const astBuf = Buffer.from(JSON.stringify([], null, 2), 'utf-8');
      fs.writeFileSync(path.join(archiveDir, 'metadata', 'achievements.json'), achBuf);
      fs.writeFileSync(path.join(archiveDir, 'metadata', 'assets.json'), astBuf);
      return [
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
      ];
    }

    it('rejects manifest referencing external parent directory file (../secret.txt) and leaves DB/storage unmutated', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;
      storage.clear();

      const parentDir = createTmpDir('pt-parent');
      const archiveDir = path.join(parentDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });

      const secretPath = path.join(parentDir, 'secret.txt');
      const secretBuf = Buffer.from('TOP_SECRET_HOST_DATA', 'utf-8');
      fs.writeFileSync(secretPath, secretBuf);

      const baseFiles = setupValidMetadata(archiveDir);
      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: {
          achievementsCount: 0,
          assetsCount: 0,
          filesCount: 3,
          totalSizeBytes: secretBuf.length,
        },
        files: [
          ...baseFiles,
          {
            path: '../secret.txt',
            size: secretBuf.length,
            sha256: crypto.createHash('sha256').update(secretBuf).digest('hex'),
          },
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        /traversal|invalid path|outside|escapes/i
      );

      const achRows = await db.select().from(achievements);
      expect(achRows.length).toBe(0);
      const astRows = await db.select().from(assets);
      expect(astRows.length).toBe(0);
    });

    it('rejects absolute paths and deep traversal paths across platforms', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;

      const maliciousPaths = [
        '/etc/passwd',
        '\\Windows\\System32\\config',
        'C:/secret.txt',
        'C:\\secret.txt',
        '../../etc/passwd',
        '..\\..\\Windows\\win.ini',
      ];

      for (const badPath of maliciousPaths) {
        const archiveDir = createTmpDir('pt-abs');
        const baseFiles = setupValidMetadata(archiveDir);
        const manifest = {
          version: 1,
          exportedAt: new Date().toISOString(),
          metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: 10 },
          files: [
            ...baseFiles,
            {
              path: badPath,
              size: 10,
              sha256: '0000000000000000000000000000000000000000000000000000000000000000',
            },
          ],
        };
        fs.writeFileSync(
          path.join(archiveDir, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
          'utf-8'
        );

        await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
          /traversal|invalid path|absolute|illegal|outside|escapes/i
        );
      }
    });

    it('rejects asset path traversal (assets/../../evil.txt) targeting storage overwrite', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;

      const archiveDir = createTmpDir('pt-storage-trav');
      const baseFiles = setupValidMetadata(archiveDir);
      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: 10 },
        files: [
          ...baseFiles,
          {
            path: 'assets/../../evil.txt',
            size: 10,
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        /traversal|invalid path|outside|escapes/i
      );
    });

    it('rejects metadata with traversal or disallowed keys in metadata/assets.json', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;

      const archiveDir = createTmpDir('pt-meta-keys');
      fs.mkdirSync(path.join(archiveDir, 'metadata'), { recursive: true });

      const achBuf = Buffer.from(JSON.stringify([], null, 2), 'utf-8');
      fs.writeFileSync(path.join(archiveDir, 'metadata', 'achievements.json'), achBuf);

      const maliciousAsset = [
        {
          id: crypto.randomUUID(),
          achievementId: crypto.randomUUID(),
          originalKey: '../../evil.jpg',
          displayKey: 'derivatives/display.webp',
          thumbnailKey: 'derivatives/thumb.webp',
          originalBytes: 100,
          mimeType: 'image/jpeg',
          width: 100,
          height: 100,
          checksum: 'abc',
          createdAt: new Date().toISOString(),
        },
      ];
      const astBuf = Buffer.from(JSON.stringify(maliciousAsset, null, 2), 'utf-8');
      fs.writeFileSync(path.join(archiveDir, 'metadata', 'assets.json'), astBuf);

      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: {
          achievementsCount: 0,
          assetsCount: 1,
          filesCount: 2,
          totalSizeBytes: achBuf.length + astBuf.length,
        },
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
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        /traversal|disallowed storage key/i
      );

      const astRows = await db.select().from(assets);
      expect(astRows.length).toBe(0);
    });

    it('rejects manifest entries containing null bytes or control characters', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;

      const archiveDir = createTmpDir('pt-null');
      const baseFiles = setupValidMetadata(archiveDir);
      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: 10 },
        files: [
          ...baseFiles,
          {
            path: 'assets/originals/pic.png\0.txt',
            size: 10,
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        /null byte|control character|traversal/i
      );
    });

    it('rejects unexpected files outside whitelisted metadata/ and assets/ namespaces', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;

      const archiveDir = createTmpDir('pt-whitelist');
      const baseFiles = setupValidMetadata(archiveDir);

      const backdoorBuf = Buffer.from('echo backdoor', 'utf-8');
      fs.writeFileSync(path.join(archiveDir, 'backdoor.sh'), backdoorBuf);

      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: {
          achievementsCount: 0,
          assetsCount: 0,
          filesCount: 3,
          totalSizeBytes: backdoorBuf.length,
        },
        files: [
          ...baseFiles,
          {
            path: 'backdoor.sh',
            size: backdoorBuf.length,
            sha256: crypto.createHash('sha256').update(backdoorBuf).digest('hex'),
          },
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        /unexpected file location/i
      );
    });

    it('rejects asset entries targeting reserved quarantine storage prefix', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;

      const archiveDir = createTmpDir('pt-quarantine');
      const baseFiles = setupValidMetadata(archiveDir);

      fs.mkdirSync(path.join(archiveDir, 'assets', 'quarantine'), { recursive: true });
      const exploitBuf = Buffer.from('FAKE_EXPLOIT', 'utf-8');
      fs.writeFileSync(path.join(archiveDir, 'assets', 'quarantine', 'exploit.jpg'), exploitBuf);

      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: {
          achievementsCount: 0,
          assetsCount: 0,
          filesCount: 3,
          totalSizeBytes: exploitBuf.length,
        },
        files: [
          ...baseFiles,
          {
            path: 'assets/quarantine/exploit.jpg',
            size: exploitBuf.length,
            sha256: crypto.createHash('sha256').update(exploitBuf).digest('hex'),
          },
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        /disallowed storage key|originals or derivatives/i
      );
    });

    it('prevents host file existence probing by rejecting traversal before touching disk', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;

      const archiveDir = createTmpDir('pt-oracle');
      const baseFiles = setupValidMetadata(archiveDir);

      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: { achievementsCount: 0, assetsCount: 0, filesCount: 3, totalSizeBytes: 100 },
        files: [
          ...baseFiles,
          {
            path: '../../nonexistent_file_xyz_12345.txt',
            size: 100,
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      try {
        await restoreArchive({ inputDir: archiveDir, db, storage });
        expect.unreachable('Should have thrown IntegrityError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(IntegrityError);
        const msg = err instanceof Error ? err.message : String(err);
        // Must be a traversal/containment error, NOT "Archive file missing on disk"
        expect(msg).toMatch(/traversal|invalid path|outside|escapes/i);
        expect(msg).not.toMatch(/missing on disk/i);
      }
    });
  });

  describe('Restore Atomicity & In-Memory Pre-Validation (AC11)', () => {
    it('enforces atomicity: when metadata/assets.json has a disallowed storage key, restore aborts with IntegrityError and leaves 0 achievements in target DB', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;
      storage.clear();

      const archiveDir = createTmpDir('atomicity-bad-key');
      fs.mkdirSync(path.join(archiveDir, 'metadata'), { recursive: true });

      const achId = crypto.randomUUID();
      const achBuf = Buffer.from(
        JSON.stringify(
          [
            {
              id: achId,
              title: 'Atomicity Disallowed Key Artwork',
              completionDate: '2026-06-01',
              notes: 'Testing atomicity rollback',
              tags: ['atomicity'],
              state: 'ready',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          null,
          2
        ),
        'utf-8'
      );

      const maliciousAssets = [
        {
          id: crypto.randomUUID(),
          achievementId: achId,
          originalKey: 'quarantine/malicious_exploit.jpg',
          displayKey: 'derivatives/display.webp',
          thumbnailKey: 'derivatives/thumb.webp',
          originalBytes: 256,
          mimeType: 'image/jpeg',
          width: 200,
          height: 200,
          checksum: 'sha-fake',
          createdAt: new Date().toISOString(),
        },
      ];
      const astBuf = Buffer.from(JSON.stringify(maliciousAssets, null, 2), 'utf-8');

      fs.writeFileSync(path.join(archiveDir, 'metadata', 'achievements.json'), achBuf);
      fs.writeFileSync(path.join(archiveDir, 'metadata', 'assets.json'), astBuf);

      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: {
          achievementsCount: 1,
          assetsCount: 1,
          filesCount: 2,
          totalSizeBytes: achBuf.length + astBuf.length,
        },
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
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        IntegrityError
      );

      // Verify atomicity guarantee: 0 achievements and 0 assets persist in target DB
      const remainingAchievements = await db.select().from(achievements);
      expect(remainingAchievements).toHaveLength(0);

      const remainingAssets = await db.select().from(assets);
      expect(remainingAssets).toHaveLength(0);
    });

    it('enforces atomicity: when metadata/assets.json has malformed JSON, restore aborts with IntegrityError and leaves 0 achievements in target DB', async () => {
      const db = await resetDatabase();
      const storage = getStorage() as MemoryStorageAdapter;
      storage.clear();

      const archiveDir = createTmpDir('atomicity-malformed-json');
      fs.mkdirSync(path.join(archiveDir, 'metadata'), { recursive: true });

      const achId = crypto.randomUUID();
      const achBuf = Buffer.from(
        JSON.stringify(
          [
            {
              id: achId,
              title: 'Atomicity Malformed JSON Artwork',
              completionDate: '2026-07-01',
              notes: 'Testing JSON parsing error atomicity',
              tags: ['atomicity'],
              state: 'ready',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          null,
          2
        ),
        'utf-8'
      );

      const malformedAstBuf = Buffer.from('{ "corrupt": [not_valid_json_syntax', 'utf-8');

      fs.writeFileSync(path.join(archiveDir, 'metadata', 'achievements.json'), achBuf);
      fs.writeFileSync(path.join(archiveDir, 'metadata', 'assets.json'), malformedAstBuf);

      const manifest = {
        version: 1,
        exportedAt: new Date().toISOString(),
        metadata: {
          achievementsCount: 1,
          assetsCount: 0,
          filesCount: 2,
          totalSizeBytes: achBuf.length + malformedAstBuf.length,
        },
        files: [
          {
            path: 'metadata/achievements.json',
            size: achBuf.length,
            sha256: crypto.createHash('sha256').update(achBuf).digest('hex'),
          },
          {
            path: 'metadata/assets.json',
            size: malformedAstBuf.length,
            sha256: crypto.createHash('sha256').update(malformedAstBuf).digest('hex'),
          },
        ],
      };
      fs.writeFileSync(
        path.join(archiveDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      await expect(restoreArchive({ inputDir: archiveDir, db, storage })).rejects.toThrow(
        IntegrityError
      );

      // Verify atomicity guarantee: 0 achievements and 0 assets persist in target DB
      const remainingAchievements = await db.select().from(achievements);
      expect(remainingAchievements).toHaveLength(0);

      const remainingAssets = await db.select().from(assets);
      expect(remainingAssets).toHaveLength(0);
    });
  });
});
