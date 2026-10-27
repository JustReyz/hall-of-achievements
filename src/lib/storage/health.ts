import { and, inArray } from 'drizzle-orm';
import { normalVisibilityConditions } from '@/lib/gallery/query';
import { getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { ValidationError } from '@/lib/validation/achievement';
import { StorageAdapter, StorageNotFoundError } from './adapter';
import { getStorage } from './index';

export type ObjectHealth = 'present' | 'missing' | 'unknown';
export type AssetLinkage = 'present' | 'missing';

export interface AchievementHealth {
  id: string;
  title: string;
  completionDate: string;
  linkage: AssetLinkage;
  original: ObjectHealth;
  display: ObjectHealth;
  thumbnail: ObjectHealth;
  checkedAt: string;
}

export interface HealthRecord {
  id: string;
  title: string;
  completionDate: string;
  keys: {
    original: string;
    display: string;
    thumbnail: string;
  } | null;
}

export interface HealthCheckOptions {
  storage?: StorageAdapter;
  timeoutMs?: number;
  deadlineMs?: number;
  concurrency?: number;
  now?: () => Date;
}

export type HealthInspectionOptions = Omit<HealthCheckOptions, 'storage'>;

export const HEALTH_BATCH_MAX = 8;
export const HEALTH_PROBE_CONCURRENCY = 3;
export const HEALTH_PROBE_TIMEOUT_MS = 3000;
export const HEALTH_BATCH_DEADLINE_MS = 8000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates one health-check batch: 1 through 8 unique UUIDs.
 */
export function validateHealthIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(
      'INVALID_IDS',
      `Send between 1 and ${HEALTH_BATCH_MAX} artwork IDs to check.`
    );
  }

  if (value.length > HEALTH_BATCH_MAX) {
    throw new ValidationError(
      'INVALID_IDS',
      `A health check accepts at most ${HEALTH_BATCH_MAX} artworks at a time.`
    );
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new ValidationError('INVALID_IDS', 'Every artwork ID must be a UUID string.');
    }

    const id = raw.trim().toLowerCase();
    if (!UUID_PATTERN.test(id)) {
      throw new ValidationError('INVALID_IDS', `"${raw}" is not a valid artwork ID.`);
    }
    if (seen.has(id)) {
      throw new ValidationError('INVALID_IDS', 'Artwork IDs must be unique within a batch.');
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

type ProbeField = 'original' | 'display' | 'thumbnail';

interface ProbeTask {
  result: AchievementHealth;
  field: ProbeField;
  key: string;
}

/**
 * Holds a slot until the provider call settles, not merely until the caller stops
 * waiting for it. A probe that outlives its timeout still counts against the
 * limit, so a slow provider is never given more than `limit` requests at once.
 */
class ProviderGate {
  private active = 0;
  private readonly waiting: Array<(acquired: boolean) => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(deadline: number): Promise<(() => void) | null> {
    while (this.active >= this.limit) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      if (!(await this.waitForRelease(remaining))) return null;
    }

    this.active += 1;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.(true);
    };
  }

  private waitForRelease(remaining: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const entry = (acquired: boolean) => {
        clearTimeout(timer);
        resolve(acquired);
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(false);
      }, remaining);
      this.waiting.push(entry);
    });
  }
}

async function probeObject(
  storage: StorageAdapter,
  gate: ProviderGate,
  key: string,
  timeoutMs: number,
  deadline: number
): Promise<ObjectHealth> {
  const release = await gate.acquire(deadline);
  if (!release) return 'unknown';

  const inspection = (async (): Promise<ObjectHealth> => {
    try {
      await storage.getObjectMetadata(key);
      return 'present';
    } catch (error) {
      // Only a typed not-found response proves the object is absent. Auth failures,
      // throttling, transport errors, and timeouts stay unknown.
      return error instanceof StorageNotFoundError ? 'missing' : 'unknown';
    } finally {
      release();
    }
  })();

  const budget = Math.min(timeoutMs, Math.max(1, deadline - Date.now()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ObjectHealth>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), budget);
  });

  try {
    return await Promise.race([inspection, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });

  await Promise.all(workers);
}

/**
 * Inspects already-loaded records. Storage keys must come from the database,
 * never from a caller-supplied URL or key.
 */
export async function inspectHealthRecords(
  records: HealthRecord[],
  storage: StorageAdapter,
  options: HealthInspectionOptions = {}
): Promise<AchievementHealth[]> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const timeoutMs = options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? HEALTH_BATCH_DEADLINE_MS;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? HEALTH_PROBE_CONCURRENCY, HEALTH_PROBE_CONCURRENCY)
  );
  const deadline = Date.now() + deadlineMs;

  const results: AchievementHealth[] = records.map((record) => {
    const linked = record.keys !== null;
    const unlinkedState: ObjectHealth = linked ? 'unknown' : 'missing';

    return {
      id: record.id,
      title: record.title,
      completionDate: record.completionDate,
      linkage: linked ? 'present' : 'missing',
      original: unlinkedState,
      display: unlinkedState,
      thumbnail: unlinkedState,
      checkedAt,
    };
  });

  const tasks: ProbeTask[] = [];
  records.forEach((record, index) => {
    const result = results[index];
    if (!result || !record.keys) return;

    tasks.push(
      { result, field: 'original', key: record.keys.original },
      { result, field: 'display', key: record.keys.display },
      { result, field: 'thumbnail', key: record.keys.thumbnail }
    );
  });

  const gate = new ProviderGate(concurrency);

  await runWithConcurrency(tasks, concurrency, async (task) => {
    task.result[task.field] = await probeObject(storage, gate, task.key, timeoutMs, deadline);
  });

  return results;
}

/**
 * Loads ready records and their database-owned keys, then probes object
 * metadata. The returned shape never includes keys or signed URLs.
 */
export async function checkArchiveHealth(
  ids: string[],
  options: HealthCheckOptions = {}
): Promise<AchievementHealth[]> {
  const db = await getDb();

  const rows = await db
    .select({
      id: achievements.id,
      title: achievements.title,
      completionDate: achievements.completionDate,
    })
    .from(achievements)
    .where(and(inArray(achievements.id, ids), ...normalVisibilityConditions()));

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const foundIds = ids.filter((id) => rowsById.has(id));

  const assetRows =
    foundIds.length > 0
      ? await db
          .select({
            achievementId: assets.achievementId,
            originalKey: assets.originalKey,
            displayKey: assets.displayKey,
            thumbnailKey: assets.thumbnailKey,
          })
          .from(assets)
          .where(inArray(assets.achievementId, foundIds))
      : [];

  const assetByAchievement = new Map<string, (typeof assetRows)[number]>();
  for (const asset of assetRows) {
    if (!assetByAchievement.has(asset.achievementId)) {
      assetByAchievement.set(asset.achievementId, asset);
    }
  }

  const records: HealthRecord[] = [];
  for (const id of ids) {
    const row = rowsById.get(id);
    if (!row) continue;

    const asset = assetByAchievement.get(id);
    records.push({
      id: row.id,
      title: row.title,
      completionDate: row.completionDate,
      keys: asset
        ? {
            original: asset.originalKey,
            display: asset.displayKey,
            thumbnail: asset.thumbnailKey,
          }
        : null,
    });
  }

  return inspectHealthRecords(records, options.storage ?? getStorage(), options);
}
