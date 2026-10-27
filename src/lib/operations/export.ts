import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq, inArray, asc } from 'drizzle-orm';
import { getDb, type AppDatabase } from '../db';
import { getStorage } from '../storage';
import { StorageAdapter } from '../storage/adapter';
import { achievements, assets, type Asset } from '../db/schema';

export interface ManifestFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export const ARCHIVE_VERSION = 3;

export interface ExportManifest {
  version: number;
  exportedAt: string;
  metadata: {
    achievementsCount: number;
    assetsCount: number;
    filesCount: number;
    totalSizeBytes: number;
  };
  files: ManifestFileEntry[];
}

export interface ExportOptions {
  outputDir?: string | undefined;
  db?: AppDatabase | undefined;
  storage?: StorageAdapter | undefined;
  force?: boolean | undefined;
  pretty?: boolean | undefined;
}

export interface ExportResult {
  outputDir: string;
  manifest: ExportManifest;
  achievementsCount: number;
  assetsCount: number;
  filesCount: number;
  totalSizeBytes: number;
}

/**
 * Exports ready artwork achievements, derivative assets, and binary objects into an offline directory.
 * Strictly excludes sessions, push subscriptions, rate limits, and server environment credentials.
 */
export async function exportArchive(options: ExportOptions = {}): Promise<ExportResult> {
  const db = options.db ?? (await getDb());
  const storage = options.storage ?? getStorage();

  // 1. Resolve output directory
  const targetDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.resolve(process.cwd(), `export-${new Date().toISOString().replace(/[:.]/g, '-')}`);

  // 2. Validate directory presence and handle conflicts
  if (fs.existsSync(targetDir)) {
    const existingEntries = fs.readdirSync(targetDir);
    if (existingEntries.length > 0 && !options.force) {
      throw new Error(`Output directory '${targetDir}' already exists and is not empty. Pass force: true to overwrite.`);
    }
  }

  fs.mkdirSync(path.join(targetDir, 'metadata'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'assets'), { recursive: true });

  // 3. Query all ready achievements, including those in Trash: their bytes and
  // metadata belong to the archive until a purge completes.
  const deletingRows = await db
    .select({ id: achievements.id })
    .from(achievements)
    .where(eq(achievements.state, 'deleting'));
  if (deletingRows.length > 0) {
    console.warn(
      `[EXPORT WARNING] ${deletingRows.length} artwork(s) are mid-deletion and hold cleanup references. They are not archived; their stored objects may remain until cleanup finishes.`
    );
  }

  const readyAchievements = await db
    .select()
    .from(achievements)
    .where(eq(achievements.state, 'ready'))
    .orderBy(asc(achievements.createdAt));

  // 4. Query all associated assets
  let readyAssets: Asset[] = [];
  if (readyAchievements.length > 0) {
    const achievementIds = readyAchievements.map((a) => a.id);
    readyAssets = await db
      .select()
      .from(assets)
      .where(inArray(assets.achievementId, achievementIds))
      .orderBy(asc(assets.createdAt));
  }

  const files: ManifestFileEntry[] = [];
  let totalSizeBytes = 0;

  // 5. Download binary assets from storage adapter and calculate checksums
  const processedKeys = new Set<string>();

  for (const asset of readyAssets) {
    const keys = [asset.originalKey, asset.displayKey, asset.thumbnailKey];

    for (const key of keys) {
      if (processedKeys.has(key)) continue;
      processedKeys.add(key);

      const obj = await storage.getObject(key);
      const relativePath = `assets/${key.replace(/\\/g, '/')}`;
      const destPath = path.join(targetDir, ...relativePath.split('/'));

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, obj.data);

      const sha256 = crypto.createHash('sha256').update(obj.data).digest('hex');
      files.push({
        path: relativePath,
        size: obj.data.length,
        sha256,
      });

      totalSizeBytes += obj.data.length;
    }
  }

  // 6. Write schema-versioned metadata files
  const indent = options.pretty !== false ? 2 : undefined;

  // metadata/achievements.json
  const achievementsJson = JSON.stringify(readyAchievements, null, indent);
  const achievementsBuf = Buffer.from(achievementsJson, 'utf-8');
  const achievementsHash = crypto.createHash('sha256').update(achievementsBuf).digest('hex');
  fs.writeFileSync(path.join(targetDir, 'metadata', 'achievements.json'), achievementsBuf);
  files.unshift({
    path: 'metadata/achievements.json',
    size: achievementsBuf.length,
    sha256: achievementsHash,
  });
  totalSizeBytes += achievementsBuf.length;

  // Superseded versions awaiting cleanup are not archive content: their bytes
  // are not exported and the reference is a server-side retry note only.
  const pendingCleanup = readyAssets.filter((asset) => asset.retiredObjects.length > 0);
  if (pendingCleanup.length > 0) {
    console.warn(
      `[EXPORT WARNING] ${pendingCleanup.length} artwork asset(s) still hold superseded objects awaiting cleanup. Their active files are exported; the obsolete versions are not.`
    );
  }
  const archiveAssets = readyAssets.map(({ retiredObjects: _retiredObjects, ...asset }) => asset);

  // metadata/assets.json
  const assetsJson = JSON.stringify(archiveAssets, null, indent);
  const assetsBuf = Buffer.from(assetsJson, 'utf-8');
  const assetsHash = crypto.createHash('sha256').update(assetsBuf).digest('hex');
  fs.writeFileSync(path.join(targetDir, 'metadata', 'assets.json'), assetsBuf);
  files.splice(1, 0, {
    path: 'metadata/assets.json',
    size: assetsBuf.length,
    sha256: assetsHash,
  });
  totalSizeBytes += assetsBuf.length;

  // 7. Generate manifest.json
  const manifest: ExportManifest = {
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    metadata: {
      achievementsCount: readyAchievements.length,
      assetsCount: readyAssets.length,
      filesCount: files.length,
      totalSizeBytes,
    },
    files,
  };

  const manifestJson = JSON.stringify(manifest, null, indent);
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), manifestJson, 'utf-8');

  return {
    outputDir: targetDir,
    manifest,
    achievementsCount: readyAchievements.length,
    assetsCount: readyAssets.length,
    filesCount: files.length,
    totalSizeBytes,
  };
}
