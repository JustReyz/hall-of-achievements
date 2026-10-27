import type { AchievementItem } from '@/components/gallery/types';

export type UploadStage =
  | 'editing'
  | 'queued'
  | 'uploading'
  | 'finalizing'
  | 'unknown'
  | 'failed'
  | 'succeeded';

export interface UploadQueueItem {
  id: string;
  file: File;
  title: string;
  completionDate: string;
  notes: string;
  tags: string[];
  stage: UploadStage;
  intentId: string | null;
  uploadUrl: string | null;
  achievementId: string | null;
  error: string | null;
}

export interface UploadDeps {
  /** Must already be bound to its receiver; a bare window.fetch throws. */
  fetch: typeof fetch;
  timezone: string;
}

export interface UploadRunResult {
  item: UploadQueueItem;
  achievement: AchievementItem | null;
  paused: boolean;
  sessionExpired: boolean;
}

export interface UploadQueueRunResult {
  items: UploadQueueItem[];
  achievements: AchievementItem[];
  paused: boolean;
  sessionExpired: boolean;
}

export const MAX_BATCH_FILES = 20;
export const MAX_QUEUE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TITLE_LENGTH = 120;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Codes that mean the queue must stop until the owner frees space or slots. */
const PAUSE_CODES = new Set(['TOO_MANY_CONCURRENT_INTENTS', 'STORAGE_QUOTA_EXCEEDED']);

class UploadQueueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextStage: Extract<UploadStage, 'queued' | 'unknown' | 'failed'>,
    readonly options: { paused?: boolean; resetIntent?: boolean; sessionExpired?: boolean } = {}
  ) {
    super(message);
    this.name = 'UploadQueueError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Upload failed';
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A non-JSON error body still carries a status we can act on.
  }
  return {};
}

function suggestedTitle(file: File): string {
  return (file.name.replace(/\.[^/.]+$/, '') || 'Untitled Artwork').slice(0, MAX_TITLE_LENGTH);
}

export function createQueueItem(
  file: File,
  options: { completionDate: string; id?: string }
): UploadQueueItem {
  return {
    id: options.id ?? crypto.randomUUID(),
    file,
    title: suggestedTitle(file),
    completionDate: options.completionDate,
    notes: '',
    tags: [],
    stage: 'queued',
    intentId: null,
    uploadUrl: null,
    achievementId: null,
    error: null,
  };
}

/**
 * Screens a selection before it joins the queue: type, size, and the batch cap.
 * Rejected names are returned so the modal can explain each one.
 */
export function screenSelectedFiles(
  files: File[],
  alreadyQueued: number
): { accepted: File[]; rejected: Array<{ name: string; reason: string }> } {
  const accepted: File[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const file of files) {
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      rejected.push({ name: file.name, reason: 'only JPEG, PNG, and WebP are accepted' });
      continue;
    }
    if (file.size > MAX_QUEUE_FILE_BYTES) {
      rejected.push({ name: file.name, reason: 'the file exceeds 10 MiB' });
      continue;
    }
    if (alreadyQueued + accepted.length >= MAX_BATCH_FILES) {
      rejected.push({ name: file.name, reason: `a batch holds at most ${MAX_BATCH_FILES} files` });
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejected };
}

export function parseTagsInput(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

async function requestIntent(item: UploadQueueItem, deps: UploadDeps) {
  const response = await deps.fetch('/api/uploads/intents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      fileName: item.file.name,
      mimeType: item.file.type,
      fileSize: item.file.size,
    }),
  });

  const data = await readJson(response);

  if (response.status === 401) {
    throw new UploadQueueError('UNAUTHENTICATED', 'Your session expired. Unlock the archive and retry.', 'queued', {
      sessionExpired: true,
    });
  }

  if (!response.ok || typeof data.intentId !== 'string' || typeof data.uploadUrl !== 'string') {
    const code = typeof data.code === 'string' ? data.code : 'INTENT_FAILED';
    throw new UploadQueueError(
      code,
      typeof data.error === 'string' ? data.error : 'Could not start this upload.',
      'queued',
      { paused: PAUSE_CODES.has(code) }
    );
  }

  return { intentId: data.intentId, uploadUrl: data.uploadUrl };
}

async function uploadBytes(item: UploadQueueItem, deps: UploadDeps): Promise<void> {
  if (!item.uploadUrl) {
    throw new UploadQueueError('UPLOAD_FAILED', 'This upload has no storage target. Retry the item.', 'queued');
  }

  let response: Response;
  try {
    response = await deps.fetch(item.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': item.file.type },
      body: item.file,
    });
  } catch {
    throw new UploadQueueError(
      'UPLOAD_NETWORK_FAILED',
      'The image could not be uploaded. Check the connection and retry.',
      'queued'
    );
  }

  if (!response.ok) {
    throw new UploadQueueError(
      'UPLOAD_FAILED',
      'The image could not be uploaded to storage. Retry this item.',
      'queued'
    );
  }
}

async function finalizeItem(item: UploadQueueItem, deps: UploadDeps): Promise<AchievementItem> {
  let response: Response;
  try {
    response = await deps.fetch(`/api/uploads/${item.intentId}/finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        title: item.title.trim(),
        completionDate: item.completionDate,
        notes: item.notes.trim(),
        tags: item.tags,
        timezone: deps.timezone,
      }),
    });
  } catch {
    throw new UploadQueueError(
      'FINALIZE_UNKNOWN',
      'The server did not confirm this upload. Retrying the same upload will not create a duplicate.',
      'unknown'
    );
  }

  const data = await readJson(response);

  if (response.status === 401) {
    throw new UploadQueueError('UNAUTHENTICATED', 'Your session expired. Unlock the archive and retry.', 'queued', {
      sessionExpired: true,
    });
  }

  if (response.ok && typeof data.achievement === 'object' && data.achievement !== null) {
    return data.achievement as AchievementItem;
  }

  const code = typeof data.code === 'string' ? data.code : 'FINALIZE_FAILED';
  const message = typeof data.error === 'string' ? data.error : 'Finalization failed.';

  if (code === 'UPLOAD_NOT_FOUND') {
    throw new UploadQueueError(code, message, 'queued');
  }

  if (code === 'INTENT_EXPIRED' || code === 'INTENT_CLEANED' || code === 'NOT_FOUND') {
    throw new UploadQueueError(
      code,
      'This upload expired before it was finalized. Retrying sends it again with a new upload intent.',
      'queued',
      { resetIntent: true }
    );
  }

  if (code === 'INTENT_NOT_PENDING') {
    throw new UploadQueueError(code, message, 'unknown');
  }

  if (code === 'STORAGE_WRITE_FAILED' || code === 'FINALIZE_FAILED' || response.status >= 500) {
    throw new UploadQueueError(
      code,
      'The server could not confirm this upload. Retrying the same upload will not create a duplicate.',
      'unknown'
    );
  }

  throw new UploadQueueError(code, message, 'failed');
}

/**
 * Runs one queue item through intent, direct upload, and finalization. A failure
 * keeps the intent and the last confirmed stage so a retry never re-uploads a
 * finished artwork or mints a second record for the same intent.
 */
export async function runUploadItem(
  item: UploadQueueItem,
  deps: UploadDeps
): Promise<UploadRunResult> {
  if (item.stage === 'succeeded') {
    return { item, achievement: null, paused: false, sessionExpired: false };
  }

  let current: UploadQueueItem = { ...item, error: null };

  try {
    if (!current.intentId || !current.uploadUrl) {
      current = { ...current, stage: 'uploading' };
      const intent = await requestIntent(current, deps);
      current = { ...current, intentId: intent.intentId, uploadUrl: intent.uploadUrl, stage: 'queued' };
    }

    // A finalize retry reuses the bytes already sitting in quarantine.
    if (current.stage !== 'unknown' && current.stage !== 'finalizing') {
      current = { ...current, stage: 'uploading' };
      await uploadBytes(current, deps);
      current = { ...current, stage: 'queued' };
    }

    current = { ...current, stage: 'finalizing' };
    const achievement = await finalizeItem(current, deps);

    return {
      item: {
        ...current,
        stage: 'succeeded',
        achievementId: achievement.id,
        error: null,
      },
      achievement,
      paused: false,
      sessionExpired: false,
    };
  } catch (error) {
    const failure =
      error instanceof UploadQueueError
        ? error
        : new UploadQueueError('UPLOAD_FAILED', messageOf(error), 'unknown');

    return {
      item: {
        ...current,
        stage: failure.nextStage,
        intentId: failure.options.resetIntent ? null : current.intentId,
        uploadUrl: failure.options.resetIntent ? null : current.uploadUrl,
        error: failure.message,
      },
      achievement: null,
      paused: Boolean(failure.options.paused),
      sessionExpired: Boolean(failure.options.sessionExpired),
    };
  }
}

/**
 * Processes queued items one at a time. Stops on a quota pause, an unresolved
 * finalize outcome, or an expired session so the owner decides what happens next.
 */
export async function runUploadQueue(
  items: UploadQueueItem[],
  deps: UploadDeps,
  onUpdate: (item: UploadQueueItem) => void,
  isCancelled: () => boolean = () => false
): Promise<UploadQueueRunResult> {
  const results = [...items];
  const achievements: AchievementItem[] = [];
  let paused = false;
  let sessionExpired = false;

  for (let index = 0; index < results.length; index++) {
    if (isCancelled() || paused || sessionExpired) break;

    const item = results[index];
    if (!item || item.stage !== 'queued') continue;

    const result = await runUploadItem(item, deps);
    results[index] = result.item;
    onUpdate(result.item);
    if (result.achievement) achievements.push(result.achievement);

    paused = result.paused || result.item.stage === 'unknown';
    sessionExpired = result.sessionExpired;
  }

  return { items: results, achievements, paused, sessionExpired };
}
