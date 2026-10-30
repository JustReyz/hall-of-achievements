'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AchievementHealth } from '@/lib/storage/health';
import type {
  GalleryFilters,
  GalleryResponse,
  ObjectHealthState,
  RestoreRequest,
} from './types';

const HEALTH_BATCH_SIZE = 8;

interface ArchiveHealthPanelProps {
  filters: GalleryFilters;
  revision: number;
  onOpenRestore: (request: RestoreRequest) => Promise<void>;
  onSessionExpired: () => void;
}

type ScanPhase = 'idle' | 'collecting' | 'checking' | 'complete' | 'cancelled' | 'error';

function countState(results: AchievementHealth[], state: ObjectHealthState): number {
  return results.filter(
    (result) =>
      result.original === state || result.display === state || result.thumbnail === state
  ).length;
}

function needsAttention(result: AchievementHealth): boolean {
  return (
    result.linkage === 'missing' ||
    result.original !== 'present' ||
    result.display !== 'present' ||
    result.thumbnail !== 'present'
  );
}

function missingFields(result: AchievementHealth): string[] {
  const fields: string[] = [];
  if (result.original === 'missing') fields.push('original');
  if (result.display === 'missing') fields.push('display');
  if (result.thumbnail === 'missing') fields.push('thumbnail');
  return fields;
}

function unknownFields(result: AchievementHealth): string[] {
  const fields: string[] = [];
  if (result.original === 'unknown') fields.push('original');
  if (result.display === 'unknown') fields.push('display');
  if (result.thumbnail === 'unknown') fields.push('thumbnail');
  return fields;
}

function statusTone(value: ObjectHealthState): { background: string; color: string; border: string } {
  if (value === 'present') {
    return { background: '#ecfdf5', color: '#047857', border: '#a7f3d0' };
  }
  if (value === 'missing') {
    return { background: '#fef2f2', color: '#b91c1c', border: '#fecaca' };
  }
  return { background: '#fffbeb', color: '#92400e', border: '#fde68a' };
}

function StatusBadge({ label, value }: { label: string; value: ObjectHealthState }) {
  const tone = statusTone(value);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        borderRadius: 12,
        border: `1px solid ${tone.border}`,
        backgroundColor: tone.background,
        color: tone.color,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {label}: {value}
    </span>
  );
}

export function ArchiveHealthPanel({
  filters,
  revision,
  onOpenRestore,
  onSessionExpired,
}: ArchiveHealthPanelProps) {
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [collected, setCollected] = useState(0);
  const [total, setTotal] = useState(0);
  const [checked, setChecked] = useState(0);
  const [results, setResults] = useState<AchievementHealth[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const scopeKey = `${filters.q}\u0000${filters.from}\u0000${filters.to}\u0000${filters.tag}`;

  // A filter change or archive mutation invalidates every number on screen. The
  // generation bump also makes late responses from the prior scope inert.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    runRef.current++;
    setPhase('idle');
    setCollected(0);
    setTotal(0);
    setChecked(0);
    setResults([]);
    setMessage(null);
    setOpenError(null);
    setOpeningId(null);
  }, [scopeKey, revision]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      runRef.current++;
    },
    []
  );

  const cancelScan = useCallback(() => {
    const wasCollecting = phase === 'collecting';
    abortRef.current?.abort();
    abortRef.current = null;
    runRef.current++;
    setPhase('cancelled');
    setMessage(
      wasCollecting
        ? 'Scan cancelled before any artwork was checked.'
        : `Scan cancelled after ${checked} of ${total} artworks were checked.`
    );
    setOpenError(null);
  }, [checked, phase, total]);

  const startScan = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const run = ++runRef.current;
    const isCurrent = () => run === runRef.current;

    setPhase('collecting');
    setCollected(0);
    setTotal(0);
    setChecked(0);
    setResults([]);
    setMessage(null);
    setOpenError(null);

    try {
      // Collect every ID in the current archive scope. This is not the gallery's
      // loaded page: the scan covers the active search, date, and tag filters.
      const ids: string[] = [];
      let cursor: string | null = null;

      do {
        const params = new URLSearchParams({ limit: '24' });
        if (filters.q) params.set('q', filters.q);
        if (filters.from) params.set('from', filters.from);
        if (filters.to) params.set('to', filters.to);
        if (filters.tag) params.set('tag', filters.tag);
        if (cursor) params.set('cursor', cursor);

        const response = await fetch(`/api/achievements?${params}`, {
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        if (!response.ok) {
          throw new Error('Failed to scan artwork. Please retry.');
        }

        const data = (await response.json()) as GalleryResponse;
        if (!isCurrent()) return;
        ids.push(...data.items.map((item) => item.id));
        setCollected(ids.length);
        cursor = data.nextCursor;
      } while (cursor);

      setTotal(ids.length);
      if (ids.length === 0) {
        setPhase('complete');
        return;
      }

      setPhase('checking');
      const accumulated: AchievementHealth[] = [];

      for (let offset = 0; offset < ids.length; offset += HEALTH_BATCH_SIZE) {
        if (!isCurrent()) return;
        const batch = ids.slice(offset, offset + HEALTH_BATCH_SIZE);

        const response = await fetch('/api/archive/health', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ ids: batch }),
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        if (!response.ok) {
          throw new Error('The archive health check could not be completed. Please retry.');
        }

        const data = (await response.json()) as { results?: AchievementHealth[] };
        if (!isCurrent()) return;
        accumulated.push(...(data.results ?? []));
        setResults([...accumulated]);
        setChecked(Math.min(offset + batch.length, ids.length));
      }

      setPhase('complete');
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setPhase('error');
      setMessage(
        error instanceof Error ? error.message : 'The archive health check failed. Please retry.'
      );
    } finally {
      if (isCurrent()) abortRef.current = null;
    }
  }, [filters, onSessionExpired]);

  const openRestore = useCallback(
    async (result: AchievementHealth) => {
      const run = runRef.current;
      setOpeningId(result.id);
      setOpenError(null);
      try {
        await onOpenRestore({
          achievementId: result.id,
          linkage: result.linkage,
          original: result.original,
          display: result.display,
          thumbnail: result.thumbnail,
        });
      } catch (error) {
        if (run !== runRef.current) return;
        setOpenError(
          error instanceof Error ? error.message : 'Could not open this artwork. Please retry.'
        );
      } finally {
        if (run === runRef.current) setOpeningId(null);
      }
    },
    [onOpenRestore]
  );

  const running = phase === 'collecting' || phase === 'checking';
  const showResults = (phase === 'complete' || phase === 'cancelled') && results.length > 0;
  const needsAttentionResults = results.filter(needsAttention);
  const healthyCount = results.length - needsAttentionResults.length;
  const missingLinkageCount = results.filter((result) => result.linkage === 'missing').length;
  const unverifiedCount = countState(
    results.filter((result) => result.linkage === 'present'),
    'unknown'
  );
  const partial = phase === 'cancelled';

  return (
    <section
      aria-labelledby="archive-health-heading"
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
          <h2
            id="archive-health-heading"
            style={{ margin: '0 0 4px 0', fontSize: 16, fontWeight: 700, color: '#0f172a' }}
          >
            Archive health
          </h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#64748b' }}>
            Check whether stored image files are still reachable. This reads object metadata
            only; it never downloads, repairs, replaces, or deletes artwork. You can close this
            window while the check runs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void startScan()}
          disabled={running}
          style={{
            minHeight: 44,
            minWidth: 44,
            padding: '9px 16px',
            backgroundColor: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 14,
            cursor: running ? 'not-allowed' : 'pointer',
            opacity: running ? 0.65 : 1,
          }}
        >
          {running ? 'Checking…' : 'Check archive'}
        </button>
      </div>

      {running && (
        <div role="status" aria-live="polite" style={{ marginTop: 14 }}>
          <p style={{ margin: '0 0 8px 0', fontSize: 13, color: '#334155' }}>
            {phase === 'collecting'
              ? `Collecting artwork in this view… ${collected} found`
              : `Checking ${checked} of ${total} artworks…`}
          </p>
          {phase === 'checking' && total > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <progress
                aria-label="Archive health check progress"
                max={total}
                value={checked}
                style={{ flex: '1 1 180px', maxWidth: 320, height: 10 }}
              />
              <button
                type="button"
                onClick={cancelScan}
                style={{
                  minHeight: 44,
                  minWidth: 44,
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
                Cancel
              </button>
            </div>
          )}
          {phase === 'collecting' && (
            <button
              type="button"
              onClick={cancelScan}
              style={{
                minHeight: 44,
                minWidth: 44,
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
              Cancel
            </button>
          )}
        </div>
      )}

      {phase === 'complete' && total === 0 && (
        <p role="status" style={{ margin: '14px 0 0 0', fontSize: 13, color: '#475569' }}>
          No artwork in this view to check.
        </p>
      )}

      {(phase === 'cancelled' || phase === 'error') && message && (
        <p
          role={phase === 'error' ? 'alert' : 'status'}
          className={phase === 'cancelled' ? 'gallery-status-transition' : undefined}
          style={{
            margin: '14px 0 0 0',
            padding: '10px 12px',
            borderRadius: 6,
            backgroundColor: phase === 'error' ? '#fef2f2' : '#f8fafc',
            border: `1px solid ${phase === 'error' ? '#fecaca' : '#e2e8f0'}`,
            color: phase === 'error' ? '#991b1b' : '#475569',
            fontSize: 13,
          }}
        >
          {message}
        </p>
      )}

      {phase === 'error' && (
        <button
          type="button"
          onClick={() => void startScan()}
          style={{
            marginTop: 10,
            minHeight: 44,
            padding: '9px 16px',
            backgroundColor: '#fff',
            color: '#991b1b',
            border: '1px solid #fca5a5',
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Retry health check
        </button>
      )}

      {showResults && (
        <div style={{ marginTop: 14 }}>
          <p role="status" aria-live="polite" style={{ margin: '0 0 10px 0', fontSize: 13, color: '#334155' }}>
            {partial ? 'Partial results: ' : ''}
            {results.length} checked · {needsAttentionResults.length} need attention ·{' '}
            {healthyCount} healthy
            {missingLinkageCount > 0 ? ` · ${missingLinkageCount} without a linked asset` : ''}
            {unverifiedCount > 0 ? ` · ${unverifiedCount} unverified` : ''}
          </p>

          {needsAttentionResults.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: '#047857', fontWeight: 600 }}>
              Every checked artwork has a reachable original, display, and thumbnail file.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {needsAttentionResults.map((result) => {
                const missing = missingFields(result);
                const unknown = unknownFields(result);
                const canRestore = result.linkage === 'missing' || missing.length > 0;

                return (
                  <li
                    key={result.id}
                    style={{
                      padding: 12,
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      backgroundColor: '#f8fafc',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                          {result.title}
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>
                          Completed {result.completionDate}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {result.linkage === 'missing' && (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              padding: '3px 8px',
                              borderRadius: 12,
                              border: '1px solid #fecaca',
                              backgroundColor: '#fef2f2',
                              color: '#b91c1c',
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            No linked asset record
                          </span>
                        )}
                        <StatusBadge label="Original" value={result.original} />
                        <StatusBadge label="Display" value={result.display} />
                        <StatusBadge label="Thumbnail" value={result.thumbnail} />
                      </div>
                    </div>

                    <p style={{ margin: '8px 0 0 0', fontSize: 13, lineHeight: 1.5, color: '#475569' }}>
                      {result.linkage === 'missing'
                        ? 'The artwork record has no linked image asset. Metadata is intact, but there is no stored file to show.'
                        : null}
                      {result.linkage === 'present' && missing.length > 0
                        ? `Missing stored ${missing.join(', ')} ${missing.length === 1 ? 'file' : 'files'}. Metadata is intact.`
                        : null}
                      {result.linkage === 'present' && missing.length > 0 && unknown.length > 0 ? ' ' : null}
                      {result.linkage === 'present' && unknown.length > 0
                        ? `Could not verify the ${unknown.join(', ')} ${unknown.length === 1 ? 'file' : 'files'}. The provider may be unavailable; try again later.`
                        : null}
                    </p>

                    {canRestore && (
                      <button
                        type="button"
                        onClick={() => void openRestore(result)}
                        disabled={openingId === result.id}
                        style={{
                          marginTop: 10,
                          minHeight: 44,
                          minWidth: 44,
                          padding: '8px 14px',
                          backgroundColor: '#fff',
                          color: '#1d4ed8',
                          border: '1px solid #bfdbfe',
                          borderRadius: 6,
                          fontWeight: 600,
                          fontSize: 13,
                          cursor: openingId === result.id ? 'not-allowed' : 'pointer',
                          opacity: openingId === result.id ? 0.7 : 1,
                        }}
                      >
                        {openingId === result.id ? 'Opening details…' : 'Open details to restore'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {openError && (
            <p role="alert" style={{ margin: '10px 0 0 0', color: '#991b1b', fontSize: 13 }}>
              {openError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
