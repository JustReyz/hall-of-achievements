'use client';

import type { UploadQueueItem, UploadStage } from '@/lib/uploads/upload-item';

interface BatchUploadListProps {
  items: UploadQueueItem[];
  running: boolean;
  onEdit: (
    id: string,
    patch: Partial<Pick<UploadQueueItem, 'title' | 'completionDate' | 'notes' | 'tags'>>
  ) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

const STAGE_LABELS: Record<UploadStage, string> = {
  editing: 'Waiting',
  queued: 'Ready',
  uploading: 'Uploading…',
  finalizing: 'Finalizing…',
  unknown: 'Unconfirmed',
  failed: 'Failed',
  succeeded: 'Saved',
};

function stageTone(stage: UploadStage): { background: string; color: string; border: string } {
  switch (stage) {
    case 'succeeded':
      return { background: '#ecfdf5', color: '#047857', border: '#a7f3d0' };
    case 'failed':
      return { background: '#fef2f2', color: '#b91c1c', border: '#fecaca' };
    case 'unknown':
      return { background: '#fffbeb', color: '#92400e', border: '#fde68a' };
    case 'uploading':
    case 'finalizing':
      return { background: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' };
    default:
      return { background: '#f8fafc', color: '#475569', border: '#e2e8f0' };
  }
}

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid #cbd5e1',
  fontSize: 14,
};

const labelStyle = {
  display: 'block',
  fontWeight: 600,
  fontSize: 12,
  color: '#475569',
  marginBottom: 4,
};

function fileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function BatchUploadList({ items, running, onEdit, onRetry, onRemove }: BatchUploadListProps) {
  if (items.length === 0) return null;

  return (
    <ul style={{ listStyle: 'none', margin: '0 0 18px 0', padding: 0, display: 'grid', gap: 12 }}>
      {items.map((item) => {
        const tone = stageTone(item.stage);
        const locked = running || item.stage === 'succeeded' || item.stage === 'uploading' || item.stage === 'finalizing';
        const metadataLocked = locked || item.intentId !== null;
        const canRemove = !locked;
        const canRetry = !running && (item.stage === 'queued' || item.stage === 'unknown' || item.stage === 'failed');

        return (
          <li
            key={item.id}
            data-upload-item
            data-stage={item.stage}
            className="gallery-upload-row"
            style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, backgroundColor: '#fff' }}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 8,
                marginBottom: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a', overflowWrap: 'anywhere' }}>
                  {item.title.trim() || item.file.name}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', overflowWrap: 'anywhere' }}>
                  {item.file.name} · {fileSize(item.file.size)}
                </div>
              </div>
              <span
                className="gallery-upload-badge"
                style={{
                  padding: '3px 8px',
                  borderRadius: 12,
                  border: `1px solid ${tone.border}`,
                  backgroundColor: tone.background,
                  color: tone.color,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {STAGE_LABELS[item.stage]}
              </span>
            </div>

            {item.error && (
              <p role="alert" style={{ margin: '0 0 10px 0', fontSize: 13, color: '#991b1b', lineHeight: 1.5 }}>
                {item.error}
              </p>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label htmlFor={`upload-title-${item.id}`} style={labelStyle}>
                  Title ({item.title.length}/120)
                </label>
                <input
                  id={`upload-title-${item.id}`}
                  type="text"
                  maxLength={120}
                  defaultValue={item.title}
                  disabled={metadataLocked}
                  onChange={(event) => onEdit(item.id, { title: event.target.value })}
                  style={inputStyle}
                />
              </div>
              <div>
                <label htmlFor={`upload-date-${item.id}`} style={labelStyle}>
                  Completed
                </label>
                <input
                  id={`upload-date-${item.id}`}
                  type="date"
                  defaultValue={item.completionDate}
                  disabled={metadataLocked}
                  onChange={(event) => onEdit(item.id, { completionDate: event.target.value })}
                  style={inputStyle}
                />
              </div>
              <div>
                <label htmlFor={`upload-tags-${item.id}`} style={labelStyle}>
                  Tags (comma-separated)
                </label>
                <input
                  id={`upload-tags-${item.id}`}
                  type="text"
                  defaultValue={item.tags.join(', ')}
                  disabled={metadataLocked}
                  placeholder="oil, landscape"
                  onChange={(event) =>
                    onEdit(item.id, {
                      tags: event.target.value
                        .split(',')
                        .map((tag) => tag.trim().toLowerCase())
                        .filter((tag) => tag.length > 0),
                    })
                  }
                  style={inputStyle}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label htmlFor={`upload-notes-${item.id}`} style={labelStyle}>
                  Notes ({item.notes.length}/2000)
                </label>
                <input
                  id={`upload-notes-${item.id}`}
                  type="text"
                  maxLength={2000}
                  defaultValue={item.notes}
                  disabled={metadataLocked}
                  onChange={(event) => onEdit(item.id, { notes: event.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {canRetry && item.error && (
                <button
                  type="button"
                  onClick={() => onRetry(item.id)}
                  style={{
                    minHeight: 44,
                    padding: '8px 14px',
                    backgroundColor: '#fff',
                    color: '#1d4ed8',
                    border: '1px solid #bfdbfe',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Retry this artwork
                </button>
              )}
              {canRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  style={{
                    minHeight: 44,
                    padding: '8px 14px',
                    backgroundColor: '#fff',
                    color: '#475569',
                    border: '1px solid #cbd5e1',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
