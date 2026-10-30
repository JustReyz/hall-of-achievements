'use client';

import { useState, useRef, useEffect, useCallback, type ChangeEvent } from 'react';
import { AchievementItem } from './types';
import { BatchUploadList } from './BatchUploadList';
import {
  MAX_BATCH_FILES,
  createQueueItem,
  runUploadQueue,
  screenSelectedFiles,
  type UploadQueueItem,
} from '@/lib/uploads/upload-item';

interface AddAchievementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newAchievements: AchievementItem[]) => void;
  onSessionExpired?: () => void;
}

function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function AddAchievementModal({
  isOpen,
  onClose,
  onSuccess,
  onSessionExpired,
}: AddAchievementModalProps) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(false);

  const queuedCount = items.filter((item) => item.stage === 'queued').length;
  const savedCount = items.filter((item) => item.stage === 'succeeded').length;
  const needsAttention = items.filter(
    (item) => item.stage === 'unknown' || item.stage === 'failed'
  ).length;

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (selected.length === 0) return;

    const { accepted, rejected } = screenSelectedFiles(selected, items.length);
    setError(
      rejected.length > 0
        ? `Not added: ${rejected.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}.`
        : null
    );
    setNotice(null);

    const completionDate = todayLocalDate();
    setItems((previous) => [
      ...previous,
      ...accepted.map((file) => createQueueItem(file, { completionDate })),
    ]);
  };

  const updateItem = useCallback((id: string, patch: Partial<UploadQueueItem>) => {
    setItems((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const retryItem = useCallback((id: string) => {
    setItems((previous) =>
      previous.map((item) =>
        item.id === id && item.stage !== 'succeeded'
          ? { ...item, stage: 'queued', error: null }
          : item
      )
    );
    setError(null);
  }, []);

  const resetQueue = useCallback(() => {
    setItems([]);
    setError(null);
    setNotice(null);
    setStopping(false);
    cancelRef.current = false;
  }, []);

  const handleUpload = async () => {
    if (running) return;

    const pending = items.filter((item) => item.stage === 'queued');
    if (pending.length === 0) {
      setError('Add at least one image to upload.');
      return;
    }

    const missingTitle = pending.find((item) => !item.title.trim());
    if (missingTitle) {
      setError(`Add a title for "${missingTitle.file.name}" before uploading.`);
      return;
    }
    const missingDate = pending.find((item) => !item.completionDate);
    if (missingDate) {
      setError(`Choose a completion date for "${missingDate.file.name}".`);
      return;
    }

    setRunning(true);
    setStopping(false);
    setError(null);
    setNotice(null);
    cancelRef.current = false;

    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const run = await runUploadQueue(
        items,
        // The browser's fetch needs its window receiver; pass a bound call rather
        // than the bare global so calling it through the dependency object works.
        { fetch: (input, init) => fetch(input, init), timezone },
        (updated) => updateItem(updated.id, updated),
        () => cancelRef.current
      );

      setItems(run.items);

      if (run.achievements.length > 0) {
        onSuccess(run.achievements);
      }

      const remaining = run.items.filter((item) => item.stage !== 'succeeded');

      if (run.sessionExpired) {
        onSessionExpired?.();
        setNotice('Your session expired. Unlock the archive, then retry the remaining artwork.');
      } else if (run.paused) {
        setNotice(
          'The queue paused. No upload slot or storage allowance is free right now; retry the remaining artwork once space is available.'
        );
      } else if (remaining.length === 0) {
        resetQueue();
        onClose();
        return;
      } else if (remaining.some((item) => item.stage === 'unknown')) {
        setNotice(
          'One upload was not confirmed by the server. Retry it: the same upload intent is reused, so no duplicate artwork is created.'
        );
      } else {
        setNotice('Some artwork was not saved. Retry those items or remove them.');
      }
    } finally {
      setRunning(false);
      setStopping(false);
    }
  };

  const handleClose = useCallback(() => {
    if (running) return;
    resetQueue();
    onClose();
  }, [running, resetQueue, onClose]);

  useEffect(() => {
    if (!isOpen) {
      if (triggerRef.current && typeof triggerRef.current.focus === 'function') {
        triggerRef.current.focus();
      }
      return;
    }

    triggerRef.current = document.activeElement as HTMLElement;

    const timer = setTimeout(() => {
      if (modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        focusables[0]?.focus();
      }
    }, 50);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
        return;
      }

      if (event.key === 'Tab' && modalRef.current) {
        const focusables = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;

        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-achievement-title"
      className="gallery-overlay-entry"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        zIndex: 1000,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: '#fff',
          borderRadius: 12,
          maxWidth: 720,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: 28,
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 id="add-achievement-title" style={{ margin: 0, fontSize: '22px', color: '#0f172a' }}>
            Record Artwork Achievements
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            disabled={running}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '20px',
              cursor: running ? 'not-allowed' : 'pointer',
              color: '#64748b',
              padding: 8,
              minWidth: 44,
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        {error && (
          <div
            role="alert"
            style={{
              padding: '12px 16px',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 8,
              color: '#991b1b',
              fontSize: '14px',
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}

        {notice && (
          <div
            role="status"
            aria-live="polite"
            className="gallery-status-transition"
            style={{
              padding: '12px 16px',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 8,
              color: '#1e3a8a',
              fontSize: '14px',
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            {notice}
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          <label
            htmlFor="achievement-file-input"
            style={{ display: 'block', fontWeight: 600, fontSize: '14px', color: '#334155', marginBottom: 6 }}
          >
            Artwork files (JPEG, PNG, WebP — max 10 MiB each, up to {MAX_BATCH_FILES} at once)
          </label>
          <input
            id="achievement-file-input"
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={handleFilesChange}
            disabled={running || items.length >= MAX_BATCH_FILES}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              fontSize: '14px',
            }}
          />
          <p style={{ margin: '8px 0 0 0', fontSize: 13, color: '#64748b', lineHeight: 1.5 }}>
            Each file is uploaded one at a time. A failed file keeps its details, and retrying it
            never duplicates artwork that already saved.
          </p>
        </div>

        <BatchUploadList
          items={items}
          running={running}
          onEdit={(id, patch) => updateItem(id, patch)}
          onRetry={retryItem}
          onRemove={removeItem}
        />

        {(items.length > 0 || running) && (
          <p role="status" aria-live="polite" style={{ margin: '0 0 14px 0', fontSize: 13, color: '#475569' }}>
            {items.length} selected · {queuedCount} ready · {savedCount} saved
            {needsAttention > 0 ? ` · ${needsAttention} need attention` : ''}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          {running && (
            <button
              type="button"
              onClick={() => {
                cancelRef.current = true;
                setStopping(true);
              }}
              disabled={stopping}
              style={{
                padding: '10px 18px',
                backgroundColor: '#fff',
                color: '#475569',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                fontWeight: 500,
                cursor: stopping ? 'not-allowed' : 'pointer',
                opacity: stopping ? 0.7 : 1,
              }}
            >
              {stopping ? 'Stopping after this artwork…' : 'Stop after this artwork'}
            </button>
          )}
          <button
            type="button"
            onClick={handleClose}
            disabled={running}
            style={{
              minHeight: 44,
              padding: '10px 18px',
              backgroundColor: '#f1f5f9',
              color: '#475569',
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              fontWeight: 500,
              cursor: running ? 'not-allowed' : 'pointer',
              opacity: running ? 0.7 : 1,
            }}
          >
            {savedCount > 0 && !running ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={running || queuedCount === 0}
            style={{
              minHeight: 44,
              padding: '10px 22px',
              backgroundColor: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: running || queuedCount === 0 ? 'not-allowed' : 'pointer',
              opacity: running || queuedCount === 0 ? 0.7 : 1,
            }}
          >
            {running
              ? 'Uploading…'
              : queuedCount === 0
                ? 'Upload artwork'
                : queuedCount === 1
                  ? 'Upload artwork'
                  : `Upload ${queuedCount} artworks`}
          </button>
        </div>
      </div>
    </div>
  );
}
