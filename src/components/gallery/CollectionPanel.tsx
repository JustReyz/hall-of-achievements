'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CollectionDetail, CollectionSummary } from './types';

interface CollectionPanelProps {
  selectedCollectionId: string | null;
  revision: number;
  onSelect: (collection: CollectionSummary | null) => void;
  onChanged: () => void;
  onSessionExpired: () => void;
}

const buttonStyle = {
  minHeight: 44,
  minWidth: 44,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
};

export function CollectionPanel({
  selectedCollectionId,
  revision,
  onSelect,
  onChanged,
  onSessionExpired,
}: CollectionPanelProps) {
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const loadCollections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/collections', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) throw new Error('Could not load collections. Please retry.');
      const data = (await response.json()) as { collections: CollectionSummary[] };
      setCollections(data.collections);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load collections. Please retry.');
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/collections/${id}`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        if (!response.ok) throw new Error('Could not load this collection.');
        setDetail((await response.json()) as CollectionDetail);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load this collection.');
      }
    },
    [onSessionExpired]
  );

  useEffect(() => {
    void loadCollections();
  }, [loadCollections, revision]);

  useEffect(() => {
    if (!selectedCollectionId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedCollectionId);
  }, [selectedCollectionId, loadDetail, revision]);

  const create = async () => {
    if (!name.trim()) {
      setError('Name the collection first.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ name }),
      });
      const data = (await response.json()) as { collection?: CollectionSummary; error?: string };
      if (!response.ok || !data.collection) {
        throw new Error(data.error || 'Could not create the collection.');
      }
      setName('');
      setNotice(`Created "${data.collection.name}".`);
      await loadCollections();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the collection.');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (collection: CollectionSummary) => {
    const next = window.prompt('Rename collection', collection.name);
    if (next === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/collections/${collection.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ name: next }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not rename the collection.');
      await loadCollections();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the collection.');
    } finally {
      setBusy(false);
    }
  };

  const removeCollection = async (collection: CollectionSummary) => {
    const confirmed = window.confirm(
      `Delete the collection "${collection.name}"?\nIts artwork stays in the archive; only the grouping is removed.`
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/collections/${collection.id}`, {
        method: 'DELETE',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || 'Could not delete the collection.');
      }
      if (selectedCollectionId === collection.id) onSelect(null);
      setNotice(`Deleted "${collection.name}". The artwork is still in the archive.`);
      await loadCollections();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the collection.');
    } finally {
      setBusy(false);
    }
  };

  const writeOrder = async (nextIds: string[], successMessage: string) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/collections/${detail.id}/items`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ revision: detail.revision, achievementIds: nextIds }),
      });
      const data = (await response.json()) as { revision?: number; error?: string; code?: string };
      if (response.status === 409) {
        await loadDetail(detail.id);
        setError('This collection changed in another tab. The latest order is shown; try again.');
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Could not update the collection order.');
      }
      setDetail((previous) =>
        previous ? { ...previous, revision: data.revision ?? previous.revision + 1 } : previous
      );
      await loadDetail(detail.id);
      await loadCollections();
      setNotice(successMessage);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the collection order.');
    } finally {
      setBusy(false);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    if (!detail) return;
    const ids = detail.items.map((item) => item.achievementId);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const swapped = [...ids];
    const current = swapped[index];
    const other = swapped[target];
    if (!current || !other) return;
    swapped[index] = other;
    swapped[target] = current;
    await writeOrder(swapped, 'Order updated.');
  };

  const removeMember = async (achievementId: string) => {
    if (!detail) return;
    const ids = detail.items
      .map((item) => item.achievementId)
      .filter((id) => id !== achievementId);
    await writeOrder(ids, 'Artwork removed from this collection. It stays in the archive.');
  };

  return (
    <section
      aria-labelledby="collections-heading"
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
          <h2 id="collections-heading" style={{ margin: '0 0 4px 0', fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
            Collections
          </h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#64748b' }}>
            Group related artwork into an ordered series. Removing a collection or a member never
            removes artwork. A collection holds up to 200 works.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="collections-panel"
          style={{ ...buttonStyle, backgroundColor: '#fff', color: '#334155', border: '1px solid #cbd5e1' }}
        >
          {open ? 'Hide collections' : `Show collections${collections.length ? ` (${collections.length})` : ''}`}
        </button>
      </div>

      {open && (
        <div id="collections-panel" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <label htmlFor="collection-name-input" style={{ position: 'absolute', left: -9999 }}>
              New collection name
            </label>
            <input
              id="collection-name-input"
              type="text"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="New collection name"
              style={{
                flex: '1 1 220px',
                minHeight: 44,
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: 14,
              }}
            />
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              style={{ ...buttonStyle, backgroundColor: '#2563eb', color: '#fff', border: 'none' }}
            >
              Create collection
            </button>
          </div>

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

          {loading && collections.length === 0 && (
            <p role="status" style={{ margin: 0, fontSize: 13, color: '#475569' }}>
              Loading collections…
            </p>
          )}

          {!loading && collections.length === 0 && (
            <p role="status" style={{ margin: 0, fontSize: 13, color: '#475569' }}>
              No collections yet.
            </p>
          )}

          {collections.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {collections.map((collection) => {
                const active = selectedCollectionId === collection.id;
                return (
                  <li
                    key={collection.id}
                    data-collection-row
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: 10,
                      borderRadius: 8,
                      border: active ? '2px solid #2563eb' : '1px solid #e2e8f0',
                      backgroundColor: active ? '#eff6ff' : '#f8fafc',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', overflowWrap: 'anywhere' }}>
                        {collection.name}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>
                        {collection.memberCount} {collection.memberCount === 1 ? 'artwork' : 'artworks'} · revision{' '}
                        {collection.revision}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => onSelect(active ? null : collection)}
                        style={{ ...buttonStyle, backgroundColor: '#fff', color: active ? '#b91c1c' : '#1d4ed8', border: active ? '1px solid #fecaca' : '1px solid #bfdbfe' }}
                      >
                        {active ? 'Clear gallery scope' : 'Browse collection'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void rename(collection)}
                        disabled={busy}
                        style={{ ...buttonStyle, backgroundColor: '#fff', color: '#475569', border: '1px solid #cbd5e1' }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeCollection(collection)}
                        disabled={busy}
                        style={{ ...buttonStyle, backgroundColor: '#fff', color: '#b91c1c', border: '1px solid #fecaca' }}
                      >
                        Delete collection
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {detail && (
            <div style={{ marginTop: 14 }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                {detail.name} — order and members
              </h3>
              {detail.items.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>
                  This collection is empty. Open an artwork and use Add to collection.
                </p>
              ) : (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                  {detail.items.map((item, index) => (
                    <li
                      key={item.achievementId}
                      data-collection-member
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: '1px solid #e2e8f0',
                        backgroundColor: '#fff',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', overflowWrap: 'anywhere' }}>
                          {index + 1}. {item.title}
                          {item.trashedAt ? ' (in Trash)' : ''}
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>{item.completionDate}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => void move(index, -1)}
                          disabled={busy || index === 0}
                          aria-label={`Move ${item.title} up`}
                          style={{ ...buttonStyle, backgroundColor: '#fff', color: '#475569', border: '1px solid #cbd5e1', opacity: index === 0 ? 0.5 : 1 }}
                        >
                          Move up
                        </button>
                        <button
                          type="button"
                          onClick={() => void move(index, 1)}
                          disabled={busy || index === detail.items.length - 1}
                          aria-label={`Move ${item.title} down`}
                          style={{ ...buttonStyle, backgroundColor: '#fff', color: '#475569', border: '1px solid #cbd5e1', opacity: index === detail.items.length - 1 ? 0.5 : 1 }}
                        >
                          Move down
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeMember(item.achievementId)}
                          disabled={busy}
                          aria-label={`Remove ${item.title} from collection`}
                          style={{ ...buttonStyle, backgroundColor: '#fff', color: '#b91c1c', border: '1px solid #fecaca' }}
                        >
                          Remove from collection
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
