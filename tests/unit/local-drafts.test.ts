import { describe, expect, it } from 'vitest';
import { editValues, editsEqual, loadDraft, parseDraftRecord, type EditDraftValues } from '@/lib/drafts/local-drafts';
import type { AchievementItem } from '@/components/gallery/types';

const values: EditDraftValues = {
  title: 'Study', completionDate: '2026-10-01', notes: 'Notes', tags: ['oil'],
  thumbnailPositionX: 0.5, thumbnailPositionY: 0.4,
};
const header = { schemaVersion: 1, savedAt: '2026-10-30T00:00:00.000Z', revision: '73b6722f-ae1b-47d4-9ce1-99ccffcb9b8c' };

function uploadRecord() {
  return {
    ...header, key: 'upload', kind: 'upload',
    items: [{
      id: 'item-1', title: '', completionDate: '', notes: 'Unfinished', tags: [],
      file: { bytes: new Blob([new Uint8Array([0, 1, 254, 255])], { type: 'image/png' }), name: 'drawing.png', type: 'image/png', lastModified: 1234 },
      stage: 'uploading', intentId: 'intent-1', achievementId: null,
      uploadUrl: 'https://example.com/secret-signed-url', error: 'transient',
    }],
  };
}

describe('local draft boundaries', () => {
  it('recovers identical file bytes and metadata without a signed URL or automatic network work', async () => {
    const draft = parseDraftRecord(uploadRecord(), 'upload');
    expect(draft.kind).toBe('upload');
    if (draft.kind !== 'upload') throw new Error('Expected upload draft');
    const item = draft.items[0]!;
    expect(Array.from(new Uint8Array(await item.file.arrayBuffer()))).toEqual([0, 1, 254, 255]);
    expect([item.file.name, item.file.type, item.file.lastModified]).toEqual(['drawing.png', 'image/png', 1234]);
    expect(item.title).toBe('');
    expect(item.completionDate).toBe('');
    expect(item.stage).toBe('unknown');
    expect(item.intentId).toBe('intent-1');
    expect(item.uploadUrl).toBeNull();
    expect(item.error).toBeNull();
  });

  it('preserves completed items even if cleanup failed', () => {
    const record = uploadRecord();
    const item = record.items[0]!;
    const recovered = parseDraftRecord({ ...record, items: [{ ...item, stage: 'succeeded', achievementId: 'artwork-1' }] }, 'upload');
    expect(recovered.kind === 'upload' && recovered.items[0]?.stage).toBe('succeeded');
    expect(() => parseDraftRecord({ ...record, items: [{ ...item, stage: 'succeeded' }] }, 'upload')).toThrow('invalid');
  });

  it('rejects corrupted records and mismatched identity', () => {
    const record = uploadRecord();
    expect(() => parseDraftRecord({ ...record, schemaVersion: 2 }, 'upload')).toThrow('invalid');
    expect(() => parseDraftRecord(record, 'edit:other')).toThrow('invalid');
    expect(() => parseDraftRecord({ ...record, items: [...record.items, ...record.items] }, 'upload')).toThrow('invalid');
    expect(() => parseDraftRecord({ ...header, key: 'edit:other', kind: 'edit', artworkId: 'artwork-1', baselineUpdatedAt: null, values }, 'edit:other')).toThrow('invalid');
  });

  it('reuses file and metadata limits while allowing blank editable fields', () => {
    const record = uploadRecord();
    const item = record.items[0]!;
    for (const patch of [
      { title: 'x'.repeat(121) },
      { notes: 'x'.repeat(2001) },
      { tags: ['x'.repeat(25)] },
      { completionDate: '2026-02-30' },
      { file: { ...item.file, type: 'image/svg+xml' } },
      { file: { ...item.file, bytes: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]) } },
    ]) {
      expect(() => parseDraftRecord({ ...record, items: [{ ...item, ...patch }] }, 'upload')).toThrow('invalid');
    }
    expect(() => parseDraftRecord({ ...record, items: Array.from({ length: 21 }, (_, index) => ({ ...item, id: `item-${index}` })) }, 'upload')).toThrow('invalid');
    expect(() => parseDraftRecord({ ...header, key: 'edit:artwork-1', kind: 'edit', artworkId: 'artwork-1', baselineUpdatedAt: null, values: { ...values, title: '', completionDate: '' } }, 'edit:artwork-1')).not.toThrow();
  });

  it('reports unavailable storage without silently succeeding', async () => {
    expect(typeof indexedDB).toBe('undefined');
    await expect(loadDraft('upload')).rejects.toThrow('unavailable');
  });
});

describe('edit dirty comparison', () => {
  it('uses save normalization without changing raw recovered input', () => {
    expect(editsEqual(values, { ...values, title: ' Study ', notes: ' Notes ', tags: [' OIL ', '', 'oil'] })).toBe(true);
    expect(editsEqual(values, { ...values, title: '' })).toBe(false);
    expect(editsEqual(values, { ...values, tags: ['oil', 'new'] })).toBe(false);
    expect(editsEqual(values, { ...values, completionDate: '' })).toBe(false);
    expect(editsEqual(values, { ...values, thumbnailPositionX: 0.51 })).toBe(false);
    expect(editsEqual(values, { ...values, thumbnailPositionY: 0.41 })).toBe(false);
    expect(editsEqual(values, values)).toBe(true);
  });

  it('takes the same missing-field baseline as the edit form', () => {
    const artwork: AchievementItem = { id: 'artwork-1', ...values, notes: null, thumbnailPositionX: Number.NaN, thumbnailPositionY: Number.NaN, createdAt: header.savedAt, state: 'ready' };
    expect(editValues(artwork)).toEqual({ ...values, notes: '', thumbnailPositionX: 0.5, thumbnailPositionY: 0.5 });
  });
});
