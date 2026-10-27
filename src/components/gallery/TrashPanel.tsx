'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TrashItem } from '@/lib/operations/trash';

interface TrashPanelProps {
  revision: number;
  onChanged: () => void;
  onSessionExpired: () => void;
}

export function TrashPanel({ revision, onChanged, onSessionExpired }: TrashPanelProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(
    async (cursor: string | null = null) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (cursor) params.set('cursor', cursor);
        const response = await fetch(`/api/trash?${params}`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        if (!response.ok) throw new Error('Could not load Trash. Please retry.');

        const data = (await response.json()) as { items: TrashItem[]; nextCursor: string | null };
        setItems((previous) => (cursor ? [...previous, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load Trash. Please retry.');
      } finally {
        setLoading(false);
      }
    },
    [onSessionExpired]
  );

  useEffect(() => {
    void load(null);
  }, [load, revision]);

  const restore = async (item: TrashItem) => {
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/achievements/${item.id}/restore`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      const data = (await response.json()) as { error?: string; restored?: boolean };
      if (!response.ok || !data.restored) {
        throw new Error(data.error || 'Could not restore this artwork.');
      }
      setNotice(`"${item.title}" is back in the gallery. Its stored files were never removed.`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore this artwork.');
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (item: TrashItem) => {
    const confirmed = window.confirm(
      `Permanently delete "${item.title}"?\nThis removes its stored images and metadata irreversibly. This cannot be undone.`
    );
    if (!confirmed) return;

    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/achievements/${item.id}/purge`, {
        method: 'DELETE',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      const data = (await response.json()) as { error?: string; deleted?: boolean; message?: string };
      if (response.status === 202) {
        setNotice(data.message ?? 'Deletion is pending; the stored files could not all be removed yet.');
      } else if (!response.ok) {
        throw new Error(data.error || 'Could not delete this artwork permanently.');
      } else {
        setNotice(`"${item.title}" was permanently deleted.`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this artwork permanently.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      aria-labelledby="trash-heading"
      style={{
        marginBottom: 20,
        padding: '16px 18px',
        backgroundColor: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ flex: '1 1 280px' }}>
          <h2 id="trash-heading" style={{ margin: '0 0 4px 0', fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
            Trash
          </h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#64748b' }}>
            Deleted artwork waits here and still counts toward storage. Restore it, or delete it
            permanently to free the space.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="trash-list"
          style={{
            minHeight: 44,
            minWidth: 44,
            padding: '9px 16px',
            backgroundColor: '#fff',
            color: '#334155',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          {open ? 'Hide Trash' : `Show Trash${items.length > 0 ? ` (${items.length})` : ''}`}
        </button>
      </div>

      {open && (
        <div id="trash-list" style={{ marginTop: 14 }}>
          {loading && items.length === 0 && (
            <p role="status" style={{ margin: 0, fontSize: 13, color: '#475569' }}>
              Loading Trash…
            </p>
          )}

          {!loading && items.length === 0 && !error && (
            <p role="status" style={{ margin: 0, fontSize: 13, color: '#475569' }}>
              Trash is empty.
            </p>
          )}

          {error && (
            <p role="alert" style={{ margin: '0 0 10px 0', fontSize: 13, color: '#991b1b' }}>
              {error}
            </p>
          )}

          {notice && (
            <p role="status" aria-live="polite" style={{ margin: '0 0 10px 0', fontSize: 13, color: '#1e3a8a' }}>
              {notice}
            </p>
          )}

          {items.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {items.map((item) => (
                <li
                  key={item.id}
                  data-trash-item
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: 12,
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    backgroundColor: '#f8fafc',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', overflowWrap: 'anywhere' }}>
                      {item.title}
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      Completed {item.completionDate} · moved to Trash{' '}
                      {new Date(item.trashedAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => void restore(item)}
                      disabled={busyId === item.id}
                      style={{
                        minHeight: 44,
                        minWidth: 44,
                        padding: '8px 14px',
                        backgroundColor: '#fff',
                        color: '#1d4ed8',
                        border: '1px solid #bfdbfe',
                        borderRadius: 6,
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: busyId === item.id ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => void purge(item)}
                      disabled={busyId === item.id}
                      style={{
                        minHeight: 44,
                        minWidth: 44,
                        padding: '8px 14px',
                        backgroundColor: '#fff',
                        color: '#b91c1c',
                        border: '1px solid #fecaca',
                        borderRadius: 6,
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: busyId === item.id ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Delete permanently
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {nextCursor && (
            <button
              type="button"
              onClick={() => void load(nextCursor)}
              disabled={loading}
              style={{
                marginTop: 12,
                minHeight: 44,
                padding: '8px 14px',
                backgroundColor: '#fff',
                color: '#475569',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 13,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              Load more Trash
            </button>
          )}
        </div>
      )}
    </section>
  );
}
