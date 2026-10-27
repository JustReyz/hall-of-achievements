import { describe, it, expect, vi } from 'vitest';
import {
  MAX_BATCH_FILES,
  createQueueItem,
  parseTagsInput,
  runUploadItem,
  runUploadQueue,
  screenSelectedFiles,
  type UploadDeps,
  type UploadQueueItem,
} from '@/lib/uploads/upload-item';

const ACHIEVEMENT = {
  id: 'achievement-1',
  title: 'Night Study',
  completionDate: '2026-10-27',
  notes: '',
  tags: [],
  state: 'ready',
};

function makeFile(name = 'night-study.png', type = 'image/png', bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function makeItem(name = 'night-study.png'): UploadQueueItem {
  return createQueueItem(makeFile(name), { completionDate: '2026-10-27', id: `item-${name}` });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchPlan {
  intent?: () => Response | Promise<Response>;
  put?: () => Response | Promise<Response>;
  finalize?: () => Response | Promise<Response>;
}

function plannedFetch(plan: FetchPlan) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/uploads/intents') {
      calls.push('intent');
      return plan.intent
        ? await plan.intent()
        : jsonResponse({ intentId: 'intent-1', uploadUrl: '/mock-upload', expiresAt: '' }, 201);
    }
    if (url.includes('/finalize')) {
      calls.push('finalize');
      return plan.finalize
        ? await plan.finalize()
        : jsonResponse({ finalized: true, achievement: ACHIEVEMENT });
    }
    calls.push('put');
    return plan.put ? await plan.put() : new Response(null, { status: 200 });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, fetchMock: fetchImpl };
}

function deps(fetchImpl: typeof fetch): UploadDeps {
  return { fetch: fetchImpl, timezone: 'Asia/Makassar' };
}

describe('Unit: batch upload item state machine', () => {
  it('screens file type, size, and the batch cap before queueing', () => {
    const oversized = makeFile('huge.jpg', 'image/jpeg', 10 * 1024 * 1024 + 1);
    const wrongType = makeFile('vector.svg', 'image/svg+xml');
    const accepted = makeFile('fine.webp', 'image/webp');

    const screening = screenSelectedFiles([oversized, wrongType, accepted], 0);

    expect(screening.accepted.map((file) => file.name)).toEqual(['fine.webp']);
    expect(screening.rejected).toHaveLength(2);
    expect(screening.rejected[0]?.reason).toContain('10 MiB');
    expect(screening.rejected[1]?.reason).toContain('JPEG');

    const overCap = screenSelectedFiles(
      Array.from({ length: 3 }, (_, index) => makeFile(`extra-${index}.png`)),
      MAX_BATCH_FILES - 1
    );
    expect(overCap.accepted).toHaveLength(1);
    expect(overCap.rejected).toHaveLength(2);
    expect(overCap.rejected[0]?.reason).toContain(String(MAX_BATCH_FILES));
  });

  it('normalizes tag input and derives a title from the file name', () => {
    expect(parseTagsInput(' Oil, Pastel ,, Landscape ')).toEqual(['oil', 'pastel', 'landscape']);
    expect(makeItem('autumn-river.jpg').title).toBe('autumn-river');
  });

  it('runs intent, direct upload, and finalize in order', async () => {
    const { fetchImpl, calls } = plannedFetch({});
    const item = makeItem();

    const result = await runUploadItem(item, deps(fetchImpl));

    expect(calls).toEqual(['intent', 'put', 'finalize']);
    expect(result.item.stage).toBe('succeeded');
    expect(result.item.achievementId).toBe(ACHIEVEMENT.id);
    expect(result.item.intentId).toBe('intent-1');
    expect(result.item.error).toBeNull();
    expect(result.achievement?.id).toBe(ACHIEVEMENT.id);
  });

  it('retries a lost finalize response without re-uploading or minting a second intent', async () => {
    let finalizeAttempts = 0;
    const { fetchImpl, calls } = plannedFetch({
      finalize: () => {
        finalizeAttempts++;
        if (finalizeAttempts === 1) throw new TypeError('network connection lost');
        return jsonResponse({ finalized: true, achievement: ACHIEVEMENT });
      },
    });
    const item = makeItem();

    const first = await runUploadItem(item, deps(fetchImpl));
    expect(first.item.stage).toBe('unknown');
    expect(first.item.intentId).toBe('intent-1');
    expect(first.item.error).toContain('will not create a duplicate');

    const retry = await runUploadItem(first.item, deps(fetchImpl));
    expect(retry.item.stage).toBe('succeeded');
    expect(retry.item.achievementId).toBe(ACHIEVEMENT.id);
    expect(calls).toEqual(['intent', 'put', 'finalize', 'finalize']);
  });

  it('keeps a failed validation terminal instead of retrying it', async () => {
    const { fetchImpl } = plannedFetch({
      finalize: () =>
        jsonResponse({ code: 'INVALID_FILE_FORMAT', error: 'Invalid file format.' }, 400),
    });

    const result = await runUploadItem(makeItem(), deps(fetchImpl));

    expect(result.item.stage).toBe('failed');
    expect(result.item.error).toBe('Invalid file format.');
  });

  it('drops an expired intent so the retry starts a fresh upload', async () => {
    let finalizeAttempts = 0;
    const { fetchImpl, calls } = plannedFetch({
      finalize: () => {
        finalizeAttempts++;
        if (finalizeAttempts === 1) {
          return jsonResponse({ code: 'INTENT_EXPIRED', error: 'expired' }, 410);
        }
        return jsonResponse({ finalized: true, achievement: ACHIEVEMENT });
      },
    });

    const first = await runUploadItem(makeItem(), deps(fetchImpl));
    expect(first.item.stage).toBe('queued');
    expect(first.item.intentId).toBeNull();
    expect(first.item.uploadUrl).toBeNull();

    const retry = await runUploadItem(first.item, deps(fetchImpl));
    expect(retry.item.stage).toBe('succeeded');
    expect(calls).toEqual(['intent', 'put', 'finalize', 'intent', 'put', 'finalize']);
  });

  it('re-uploads bytes when the quarantine copy is gone but the intent is still usable', async () => {
    let finalizeAttempts = 0;
    const { fetchImpl, calls } = plannedFetch({
      finalize: () => {
        finalizeAttempts++;
        if (finalizeAttempts === 1) {
          return jsonResponse({ code: 'UPLOAD_NOT_FOUND', error: 'missing' }, 400);
        }
        return jsonResponse({ finalized: true, achievement: ACHIEVEMENT });
      },
    });

    const first = await runUploadItem(makeItem(), deps(fetchImpl));
    expect(first.item.stage).toBe('queued');
    expect(first.item.intentId).toBe('intent-1');

    const retry = await runUploadItem(first.item, deps(fetchImpl));
    expect(retry.item.stage).toBe('succeeded');
    expect(calls).toEqual(['intent', 'put', 'finalize', 'put', 'finalize']);
  });

  it('continues the queue after one item fails', async () => {
    const { fetchImpl } = plannedFetch({});
    const failingFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/uploads/intents') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { fileName?: string };
        if (body.fileName === 'broken.png') {
          return jsonResponse({ code: 'INVALID_FILE_FORMAT', error: 'nope' }, 400);
        }
        return jsonResponse({ intentId: 'intent-1', uploadUrl: '/mock-upload' }, 201);
      }
      if (url.includes('/finalize')) {
        return jsonResponse({ finalized: true, achievement: ACHIEVEMENT });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const items = [makeItem('broken.png'), makeItem('fine.png')];
    const updates: UploadQueueItem[] = [];

    const run = await runUploadQueue(items, deps(failingFetch), (item) => updates.push(item));

    expect(run.paused).toBe(false);
    expect(run.items[0]?.stage).toBe('queued');
    expect(run.items[0]?.error).toBe('nope');
    expect(run.items[1]?.stage).toBe('succeeded');
    expect(updates).toHaveLength(2);
    // The untouched fetch plan is not used; keep the reference meaningful.
    expect(typeof fetchImpl).toBe('function');
  });

  it('pauses the queue when the server reports no free upload slot', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { code: 'TOO_MANY_CONCURRENT_INTENTS', error: 'Too many active uploads.' },
        429
      )
    ) as unknown as typeof fetch;

    const items = [makeItem('one.png'), makeItem('two.png')];
    const run = await runUploadQueue(items, deps(fetchImpl), () => undefined);

    expect(run.paused).toBe(true);
    expect(run.items[0]?.stage).toBe('queued');
    expect(run.items[1]?.stage).toBe('queued');
  });
});
