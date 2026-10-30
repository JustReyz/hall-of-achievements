import { z } from 'zod';
import type { AchievementItem } from '@/components/gallery/types';
import { MAX_BATCH_FILES, screenSelectedFiles, type UploadQueueItem } from '@/lib/uploads/upload-item';
import {
  validateCalendarDate,
  validateNotes,
  validateTags,
  validateTitle,
} from '@/lib/validation/achievement';

export interface EditDraftValues {
  title: string;
  completionDate: string;
  notes: string;
  tags: string[];
  thumbnailPositionX: number;
  thumbnailPositionY: number;
}

interface DraftHeader {
  schemaVersion: 1;
  savedAt: string;
  revision: string;
}

export interface UploadDraft extends DraftHeader {
  key: 'upload';
  kind: 'upload';
  items: UploadQueueItem[];
}

export interface EditDraft extends DraftHeader {
  key: string;
  kind: 'edit';
  artworkId: string;
  baselineUpdatedAt: string | null;
  values: EditDraftValues;
}

export type LocalDraft = UploadDraft | EditDraft;

export class DraftConflictError extends Error {
  constructor() {
    super('This draft changed in another tab. Your current form is intact. Reopen the draft to review the newer copy before replacing or deleting it.');
    this.name = 'DraftConflictError';
  }
}

const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/);
const metadata = z.object({
  title: z.string(),
  completionDate: z.string(),
  notes: z.string(),
  tags: z.array(z.string()),
});
const editSchema = metadata.extend({
  thumbnailPositionX: z.number().finite().min(0).max(1),
  thumbnailPositionY: z.number().finite().min(0).max(1),
});
const header = {
  schemaVersion: z.literal(1),
  savedAt: z.string().datetime(),
  revision: z.string().uuid(),
};
const storedItem = metadata.extend({
  id: identifier,
  file: z.object({
    bytes: z.instanceof(Blob),
    name: z.string().min(1).max(1024),
    type: z.string(),
    lastModified: z.number().int().nonnegative(),
  }),
  stage: z.enum(['editing', 'queued', 'uploading', 'finalizing', 'unknown', 'failed', 'succeeded']),
  intentId: identifier.nullable(),
  achievementId: identifier.nullable(),
});
const recordSchema = z.discriminatedUnion('kind', [
  z.object({ ...header, key: z.literal('upload'), kind: z.literal('upload'), items: z.array(storedItem).max(MAX_BATCH_FILES) }),
  z.object({ ...header, key: z.string(), kind: z.literal('edit'), artworkId: identifier, baselineUpdatedAt: z.string().nullable(), values: editSchema }),
]);

function validateMetadata(value: z.infer<typeof metadata>): void {
  if (value.title.trim()) validateTitle(value.title);
  if (value.completionDate) validateCalendarDate(value.completionDate);
  validateNotes(value.notes);
  validateTags(value.tags);
}

export function editValues(achievement: AchievementItem): EditDraftValues {
  return {
    title: achievement.title,
    completionDate: achievement.completionDate,
    notes: achievement.notes ?? '',
    tags: [...achievement.tags],
    thumbnailPositionX: Number.isFinite(achievement.thumbnailPositionX) ? achievement.thumbnailPositionX : 0.5,
    thumbnailPositionY: Number.isFinite(achievement.thumbnailPositionY) ? achievement.thumbnailPositionY : 0.5,
  };
}

export function editsEqual(a: EditDraftValues, b: EditDraftValues): boolean {
  const normalizedTags = (tags: string[]) => JSON.stringify([...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]);
  return a.title.trim() === b.title.trim()
    && a.completionDate === b.completionDate
    && a.notes.trim() === b.notes.trim()
    && normalizedTags(a.tags) === normalizedTags(b.tags)
    && a.thumbnailPositionX === b.thumbnailPositionX
    && a.thumbnailPositionY === b.thumbnailPositionY;
}

export function parseDraftRecord(value: unknown, key: string): LocalDraft {
  try {
    const record = recordSchema.parse(value);
    if (record.key !== key) throw new Error('Draft key does not match.');
    if (record.kind === 'edit') {
      if (record.key !== `edit:${record.artworkId}`) throw new Error('Artwork key does not match.');
      validateMetadata(record.values);
      return record;
    }
    const ids = new Set<string>();
    const items = record.items.map((item): UploadQueueItem => {
      if (ids.has(item.id)) throw new Error('Duplicate item ID.');
      ids.add(item.id);
      validateMetadata(item);
      if (item.stage === 'succeeded' && !item.achievementId) throw new Error('Completed item has no artwork ID.');
      if (item.achievementId && item.stage !== 'succeeded') throw new Error('Confirmed artwork must remain completed.');
      const file = new File([item.file.bytes], item.file.name, { type: item.file.type, lastModified: item.file.lastModified });
      if (screenSelectedFiles([file], 0).rejected.length) throw new Error('Invalid saved file.');
      return {
        id: item.id,
        file,
        title: item.title,
        completionDate: item.completionDate,
        notes: item.notes,
        tags: item.tags,
        stage: item.stage === 'uploading' || item.stage === 'finalizing' ? (item.intentId ? 'unknown' : 'queued') : item.stage,
        intentId: item.intentId,
        achievementId: item.achievementId,
        uploadUrl: null,
        error: null,
      };
    });
    return { ...record, items };
  } catch {
    throw new Error('This local draft is invalid or from an unsupported version. It has not been changed.');
  }
}

function storageError(error: unknown): Error {
  if (error instanceof DraftConflictError) return error;
  if (error instanceof Error && error.name === 'QuotaExceededError') {
    return new Error('There is not enough browser storage to save this draft. Free space and retry.');
  }
  return error instanceof Error ? error : new Error('Local draft storage is unavailable. Keep this form open and retry.');
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Local draft storage is unavailable in this browser.'));
      return;
    }
    let settled = false;
    const request = indexedDB.open('hall-of-achievements-drafts', 1);
    const fail = (error: unknown) => { settled = true; reject(storageError(error)); };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath: 'key' });
    };
    request.onblocked = () => fail(new Error('Local draft storage is blocked by another tab. Close that tab and retry.'));
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transact<T>(key: string, mode: IDBTransactionMode, work: (value: unknown, store: IDBObjectStore) => T): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = db.transaction('drafts', mode); }
    catch (error) { db.close(); reject(storageError(error)); return; }
    let result: T;
    let failure: unknown;
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onabort = () => { db.close(); reject(storageError(failure ?? transaction.error)); };
    transaction.onerror = () => { failure ??= transaction.error; };
    const store = transaction.objectStore('drafts');
    const request = store.get(key);
    request.onerror = () => { failure = request.error; };
    request.onsuccess = () => {
      try { result = work(request.result, store); }
      catch (error) { failure = error; transaction.abort(); }
    };
  });
}

function checkRevision(value: unknown, expectedRevision: string | null): void {
  const current = value === undefined ? null : z.object({ revision: z.string().uuid() }).parse(value).revision;
  if (current !== expectedRevision) throw new DraftConflictError();
}

export function loadDraft(key: string): Promise<LocalDraft | null> {
  return transact(key, 'readonly', (value) => value === undefined ? null : parseDraftRecord(value, key));
}

export async function saveUploadDraft(items: UploadQueueItem[], expectedRevision: string | null): Promise<UploadDraft> {
  const record = {
    key: 'upload', kind: 'upload', schemaVersion: 1,
    savedAt: new Date().toISOString(), revision: crypto.randomUUID(),
    items: items.map((item) => ({
      id: item.id,
      file: { bytes: item.file.slice(), name: item.file.name, type: item.file.type, lastModified: item.file.lastModified },
      title: item.title, completionDate: item.completionDate, notes: item.notes, tags: [...item.tags],
      stage: item.stage, intentId: item.intentId, achievementId: item.achievementId,
    })),
  };
  const parsed = parseDraftRecord(record, 'upload') as UploadDraft;
  return transact('upload', 'readwrite', (current, store) => {
    checkRevision(current, expectedRevision);
    store.put(record);
    return parsed;
  });
}

export async function saveEditDraft(artworkId: string, baselineUpdatedAt: string | null, values: EditDraftValues, expectedRevision: string | null): Promise<EditDraft> {
  const record = { key: `edit:${artworkId}`, kind: 'edit', schemaVersion: 1, savedAt: new Date().toISOString(), revision: crypto.randomUUID(), artworkId, baselineUpdatedAt, values };
  const parsed = parseDraftRecord(record, record.key) as EditDraft;
  return transact(record.key, 'readwrite', (current, store) => {
    checkRevision(current, expectedRevision);
    store.put(parsed);
    return parsed;
  });
}

export function deleteDraft(key: string, expectedRevision: string | null): Promise<void> {
  return transact(key, 'readwrite', (current, store) => {
    checkRevision(current, expectedRevision);
    store.delete(key);
  });
}
