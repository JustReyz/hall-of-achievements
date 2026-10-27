import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, type AppDatabase } from '../db';
import { getStorage } from '../storage';
import { StorageAdapter } from '../storage/adapter';
import {
  achievements,
  assets,
  sessions,
  pushSubscriptions,
  type Achievement,
  type Asset,
} from '../db/schema';
import type { ExportManifest } from './export';
import { isValidThumbnailPosition } from '../validation/achievement';

export interface RestoreOptions {
  inputDir: string;
  db?: AppDatabase | undefined;
  storage?: StorageAdapter | undefined;
}

export interface RestoreResult {
  inputDir: string;
  manifest: ExportManifest;
  achievementsRestored: number;
  assetsRestored: number;
  filesRestored: number;
  totalSizeBytes: number;
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

/**
 * Asserts that a relative path is strictly contained within baseDir,
 * contains no traversal characters ('..', backslashes, leading slashes, drive letters, null bytes, URL encoded percent),
 * and returns the normalized absolute path.
 */
export function assertSafeRelativePath(baseDir: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new IntegrityError('Invalid path: relative path must be a non-empty string.');
  }

  // Reject null bytes and control characters
  if (relativePath.includes('\0') || /[\x00-\x1f\x7f]/.test(relativePath)) {
    throw new IntegrityError(
      `Path traversal attempt detected: path contains null bytes or control characters: '${relativePath}'`
    );
  }

  // Reject URL encoded characters
  if (relativePath.includes('%')) {
    throw new IntegrityError(
      `Path traversal attempt detected: URL encoded character in path '${relativePath}'`
    );
  }

  // Reject absolute paths across platforms (POSIX and Windows)
  if (
    path.isAbsolute(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new IntegrityError(
      `Path traversal attempt detected: absolute path '${relativePath}' is not permitted.`
    );
  }

  // Reject directory traversal sequence '..' or backslash
  if (relativePath.includes('..') || relativePath.includes('\\')) {
    throw new IntegrityError(
      `Path traversal attempt detected: illegal sequence in path '${relativePath}'.`
    );
  }

  // Reject empty segments or '.' segments
  const segments = relativePath.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg === '') {
      throw new IntegrityError(
        `Path traversal attempt detected: invalid path segment '${seg}' in '${relativePath}'.`
      );
    }
  }

  // Resolve against baseDir and verify containment
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, relativePath);
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;

  if (!resolvedPath.startsWith(baseWithSep) && resolvedPath !== resolvedBase) {
    throw new IntegrityError(
      `Path traversal attempt detected: path '${relativePath}' escapes directory '${baseDir}'.`
    );
  }

  return resolvedPath;
}

/**
 * Asserts that a storage key is safe, starts with originals/ or derivatives/,
 * and contains no traversal sequences, leading slashes, or invalid characters.
 */
export function assertSafeStorageKey(key: string, context: string = 'Storage key'): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new IntegrityError(`${context} must be a non-empty string.`);
  }

  if (key.includes('\0') || /[\x00-\x1f\x7f]/.test(key)) {
    throw new IntegrityError(
      `Path traversal attempt detected: ${context.toLowerCase()} contains null bytes or control characters: '${key}'`
    );
  }

  if (key.includes('%')) {
    throw new IntegrityError(
      `Path traversal attempt detected: ${context.toLowerCase()} contains URL encoded characters: '${key}'`
    );
  }

  if (key.includes('..')) {
    throw new IntegrityError(
      `Path traversal attempt detected in ${context.toLowerCase()}: '${key}'`
    );
  }

  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new IntegrityError(
      `Path traversal attempt detected: ${context.toLowerCase()} cannot start with a slash: '${key}'`
    );
  }

  if (key.includes('\\') || key.includes(':')) {
    throw new IntegrityError(
      `Path traversal attempt detected: ${context.toLowerCase()} contains illegal characters: '${key}'`
    );
  }

  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg === '') {
      throw new IntegrityError(
        `Path traversal attempt detected: invalid path segment '${seg}' in ${context.toLowerCase()}: '${key}'`
      );
    }
  }

  if (!key.startsWith('originals/') && !key.startsWith('derivatives/')) {
    throw new IntegrityError(
      `Disallowed storage key in manifest entry or metadata: '${key}'. Must start with originals/ or derivatives/.`
    );
  }

  return key;
}


function inferContentType(filePath: string, assetRecords?: Asset[]): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';

  if (assetRecords) {
    const key = filePath.startsWith('assets/') ? filePath.slice('assets/'.length) : filePath;
    const match = assetRecords.find(
      (a) => a.originalKey === key || a.displayKey === key || a.thumbnailKey === key
    );
    if (match) return match.mimeType;
  }

  return 'application/octet-stream';
}

/**
 * Restores artwork achievements and binary assets from an offline archive into a target environment.
 * Executes an atomic pre-flight checksum validation before modifying any database or storage state.
 * Guarantees that target sessions are revoked and push subscriptions remain disabled post-restore.
 */
export async function restoreArchive(options: RestoreOptions): Promise<RestoreResult> {
  const inputDir = path.resolve(options.inputDir);

  if (!fs.existsSync(inputDir)) {
    throw new IntegrityError(`Input directory '${inputDir}' does not exist.`);
  }

  // 1. Pre-flight Manifest Presence & Parsing
  const manifestPath = path.join(inputDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new IntegrityError(`Archive manifest.json is missing in '${inputDir}'.`);
  }

  let manifest: ExportManifest;
  try {
    const rawManifest = fs.readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(rawManifest) as ExportManifest;
  } catch (err: unknown) {
    throw new IntegrityError(
      `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (manifest.version !== 1 && manifest.version !== 2) {
    throw new IntegrityError(
      `Unsupported manifest schema version: ${manifest.version}. Supported versions are 1 and 2.`
    );
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new IntegrityError('Manifest files array is empty or invalid.');
  }

  // 2. Atomic Pre-flight Checksum Verification across ALL files
  // NO DB OR STORAGE MUTATIONS MUST OCCUR BEFORE ALL CHECKSUMS ARE VERIFIED
  const fileBuffers = new Map<string, Buffer>();

  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string') {
      throw new IntegrityError('Invalid manifest file entry: missing or non-string path.');
    }

    // Strict path validation and containment assertion BEFORE any disk operations
    const fullPath = assertSafeRelativePath(inputDir, entry.path);

    // Whitelist allowed manifest file locations
    const isAchievementsMeta = entry.path === 'metadata/achievements.json';
    const isAssetsMeta = entry.path === 'metadata/assets.json';
    const isAsset = entry.path.startsWith('assets/');

    if (!isAchievementsMeta && !isAssetsMeta && !isAsset) {
      throw new IntegrityError(
        `Path traversal attempt detected: unexpected file location '${entry.path}'. Only metadata/ and assets/ entries are permitted.`
      );
    }

    // Validate storage key if asset entry
    if (entry.path.startsWith('assets/')) {
      const storageKey = entry.path.slice('assets/'.length);
      assertSafeStorageKey(storageKey, 'Manifest asset storage key');
    }

    if (!fs.existsSync(fullPath)) {
      throw new IntegrityError(`Archive file missing on disk: ${entry.path}`);
    }

    const buffer = fs.readFileSync(fullPath);
    if (buffer.length !== entry.size) {
      throw new IntegrityError(
        `File size mismatch for '${entry.path}': expected ${entry.size} bytes, found ${buffer.length} bytes.`
      );
    }

    const calculatedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (calculatedSha256 !== entry.sha256) {
      throw new IntegrityError(
        `Integrity checksum mismatch for '${entry.path}': expected ${entry.sha256}, computed ${calculatedSha256}.`
      );
    }

    fileBuffers.set(entry.path, buffer);
  }

  // 3. Connect to target DB and storage
  const db = options.db ?? (await getDb());
  const storage = options.storage ?? getStorage();

  // 4. In-memory pre-validation of metadata: parse and validate achievements and assets BEFORE any mutations
  const achievementsBuf = fileBuffers.get('metadata/achievements.json');
  if (!achievementsBuf) {
    throw new IntegrityError('Missing metadata/achievements.json in verified archive.');
  }

  let rawAchievements: Achievement[];
  try {
    rawAchievements = JSON.parse(achievementsBuf.toString('utf-8')) as Achievement[];
  } catch (err: unknown) {
    throw new IntegrityError(
      `Failed to parse metadata/achievements.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(rawAchievements)) {
    throw new IntegrityError('metadata/achievements.json must contain an array of achievements.');
  }

  if (manifest.version === 2) {
    for (const achievement of rawAchievements) {
      if (
        !isValidThumbnailPosition(achievement.thumbnailPositionX) ||
        !isValidThumbnailPosition(achievement.thumbnailPositionY)
      ) {
        throw new IntegrityError(
          `Achievement '${achievement.id}' has invalid thumbnail framing values. Expected finite numbers between 0 and 1.`
        );
      }
    }
  }

  const assetsBuf = fileBuffers.get('metadata/assets.json');
  if (!assetsBuf) {
    throw new IntegrityError('Missing metadata/assets.json in verified archive.');
  }

  let rawAssets: Asset[];
  try {
    rawAssets = JSON.parse(assetsBuf.toString('utf-8')) as Asset[];
  } catch (err: unknown) {
    throw new IntegrityError(
      `Failed to parse metadata/assets.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(rawAssets)) {
    throw new IntegrityError('metadata/assets.json must contain an array of assets.');
  }

  // Pre-validate all storage keys in memory BEFORE any database writes
  for (const asset of rawAssets) {
    assertSafeStorageKey(asset.originalKey, 'Asset originalKey');
    assertSafeStorageKey(asset.displayKey, 'Asset displayKey');
    assertSafeStorageKey(asset.thumbnailKey, 'Asset thumbnailKey');
  }

  // 5. Atomic database transaction: ingest achievements, assets, and apply security invalidations atomically
  await db.transaction(async (tx) => {
    for (const a of rawAchievements) {
      const thumbnailPositionX = manifest.version === 1 ? 0.5 : a.thumbnailPositionX;
      const thumbnailPositionY = manifest.version === 1 ? 0.5 : a.thumbnailPositionY;

      await tx
        .insert(achievements)
        .values({
          id: a.id,
          title: a.title,
          completionDate: a.completionDate,
          notes: a.notes,
          tags: a.tags,
          thumbnailPositionX,
          thumbnailPositionY,
          state: a.state,
          createdAt: new Date(a.createdAt),
          updatedAt: new Date(a.updatedAt),
        })
        .onConflictDoUpdate({
          target: achievements.id,
          set: {
            title: a.title,
            completionDate: a.completionDate,
            notes: a.notes,
            tags: a.tags,
            thumbnailPositionX,
            thumbnailPositionY,
            state: a.state,
            updatedAt: new Date(a.updatedAt),
          },
        });
    }

    for (const asset of rawAssets) {
      await tx
        .insert(assets)
        .values({
          id: asset.id,
          achievementId: asset.achievementId,
          originalKey: asset.originalKey,
          displayKey: asset.displayKey,
          thumbnailKey: asset.thumbnailKey,
          originalBytes: asset.originalBytes,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          checksum: asset.checksum,
          createdAt: new Date(asset.createdAt),
        })
        .onConflictDoUpdate({
          target: assets.id,
          set: {
            achievementId: asset.achievementId,
            originalKey: asset.originalKey,
            displayKey: asset.displayKey,
            thumbnailKey: asset.thumbnailKey,
            originalBytes: asset.originalBytes,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            checksum: asset.checksum,
          },
        });
    }

    // Post-restore security guarantees: invalidate all target sessions and disable push subscriptions
    await tx.update(sessions).set({
      revoked: true,
      revokedAt: new Date(),
    });

    await tx.update(pushSubscriptions).set({
      status: 'disabled',
      updatedAt: new Date(),
    });
  });

  // 6. Restore binary assets to storage adapter
  let binaryFilesRestored = 0;
  for (const entry of manifest.files) {
    if (entry.path.startsWith('assets/')) {
      const storageKey = entry.path.slice('assets/'.length);
      assertSafeStorageKey(storageKey, 'Restored asset storage key');

      const buffer = fileBuffers.get(entry.path);
      if (!buffer) continue;

      const contentType = inferContentType(entry.path, rawAssets);
      await storage.putObject(storageKey, buffer, {
        contentType,
        upsert: true,
        cacheControl: 'private, no-store',
      });
      binaryFilesRestored++;
    }
  }

  return {
    inputDir,
    manifest,
    achievementsRestored: rawAchievements.length,
    assetsRestored: rawAssets.length,
    filesRestored: binaryFilesRestored + 2,
    totalSizeBytes: manifest.metadata.totalSizeBytes,
  };
}
