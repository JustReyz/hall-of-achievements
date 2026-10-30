'use client';

import { useState, useRef, useEffect, useCallback, type ChangeEvent } from 'react';
import { AchievementItem } from './types';
import { BatchUploadList } from './BatchUploadList';
import { DraftPrivacyNotice, UnsavedChangesDialog } from './UnsavedChangesDialog';
import { deleteDraft, DraftConflictError, loadDraft, saveUploadDraft, type UploadDraft } from '@/lib/drafts/local-drafts';
import { useBeforeUnload } from '@/lib/drafts/use-before-unload';
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

function queueSnapshot(items: UploadQueueItem[]): string {
  return JSON.stringify(items.map(({ uploadUrl: _url, error: _error, file, ...item }) => ({
    ...item, file: [file.name, file.type, file.size, file.lastModified],
  })));
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
  const [draft, setDraft] = useState<UploadDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftChoice, setDraftChoice] = useState<'offer' | 'new' | 'ready'>('ready');
  const [confirmation, setConfirmation] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [ownsDraft, setOwnsDraft] = useState(false);
  const [replacementApproved, setReplacementApproved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictReviewed, setConflictReviewed] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(false);
  const operationRef = useRef(false);
  const aliveRef = useRef(false);
  const itemsRef = useRef<UploadQueueItem[]>([]);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const unfinished = items.some((item) => item.stage !== 'succeeded');
  const busy = running || draftBusy;
  const blocked = busy || draftChoice !== 'ready';
  useBeforeUnload(isOpen && (busy || (unfinished && queueSnapshot(items) !== savedSnapshot)));

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; cancelRef.current = true; };
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setDraftBusy(true);
    operationRef.current = true;
    setDraftError(null);
    void loadDraft('upload').then((stored) => {
      if (cancelled) return;
      if (stored?.kind === 'upload') {
        setDraft(stored);
        setDraftChoice('offer');
      } else {
        setDraft(null);
        setDraftChoice('ready');
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setDraftError(cause instanceof Error ? cause.message : 'Could not load the local draft.');
    }).finally(() => {
      if (!cancelled) { setDraftBusy(false); operationRef.current = false; }
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  const reportDraftError = (cause: unknown) => {
    if (!aliveRef.current) return;
    setDraftError(cause instanceof Error ? cause.message : 'The local draft could not be updated. Try again.');
    if (cause instanceof DraftConflictError) {
      setConflict(true);
      setConflictReviewed(false);
      setReplacementApproved(false);
    }
  };

  const reviewLatestDraft = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setDraftBusy(true);
    try {
      const stored = await loadDraft('upload');
      if (!aliveRef.current) return;
      setDraft(stored?.kind === 'upload' ? stored : null);
      setOwnsDraft(false);
      setReplacementApproved(false);
      setConflict(true);
      setConflictReviewed(true);
      setDraftError(null);
      setNotice(stored ? `The latest draft was saved ${new Date(stored.savedAt).toLocaleString()}. Your current form is unchanged.` : 'The saved draft was removed. Your current form is unchanged.');
    } catch (cause) { reportDraftError(cause); }
    finally { operationRef.current = false; if (aliveRef.current) setDraftBusy(false); }
  };

  const saveLocalDraft = async (closeAfter: boolean) => {
    if (operationRef.current) return;
    if ((draft && !ownsDraft && !replacementApproved) || conflict) {
      setDraftError('Review the latest saved draft, then explicitly choose to keep this form before replacing it. Continue editing to review it.');
      return;
    }
    operationRef.current = true;
    setDraftBusy(true);
    setDraftError(null);
    try {
      const stored = await saveUploadDraft(items, draft?.revision ?? null);
      if (!aliveRef.current) return;
      setDraft(stored);
      setOwnsDraft(true);
      setSavedSnapshot(queueSnapshot(items));
      setNotice(`Draft saved ${new Date(stored.savedAt).toLocaleString()} in this browser.`);
      if (closeAfter) {
        setConfirmation(false);
        setItems([]);
        setSavedSnapshot(null);
        setOwnsDraft(false);
        onClose();
      }
    } catch (cause) { reportDraftError(cause); }
    finally { operationRef.current = false; if (aliveRef.current) setDraftBusy(false); }
  };

  const discardLocalDraft = async (closeAfter: boolean) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setDraftBusy(true);
    setDraftError(null);
    try {
      await deleteDraft('upload', draft?.revision ?? null);
      if (!aliveRef.current) return;
      setDraft(null);
      setOwnsDraft(false);
      setSavedSnapshot(null);
      setItems([]);
      setConfirmation(false);
      setDraftChoice('ready');
      setConflict(false);
      setNotice(null);
      if (closeAfter) onClose();
    } catch (cause) { reportDraftError(cause); }
    finally { operationRef.current = false; if (aliveRef.current) setDraftBusy(false); }
  };

  const queuedCount = items.filter((item) => item.stage === 'queued').length;
  const savedCount = items.filter((item) => item.stage === 'succeeded').length;
  const needsAttention = items.filter(
    (item) => item.stage === 'unknown' || item.stage === 'failed'
  ).length;

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (blocked || operationRef.current) return;
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
    setSavedSnapshot(null);
    setOwnsDraft(false);
    setReplacementApproved(false);
    setConfirmation(false);
    setConflict(false);
    setConflictReviewed(false);
    cancelRef.current = false;
  }, []);

  const handleUpload = async () => {
    if (blocked || operationRef.current || confirmation) return;

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

    operationRef.current = true;
    setRunning(true);
    setStopping(false);
    setError(null);
    setNotice(null);
    cancelRef.current = false;

    const uploadItems = items;
    itemsRef.current = uploadItems;
    const hasSavedDraft = Boolean(draft);
    let checkpointRevision = draft?.revision ?? null;
    let checkpointFailure = false;

    // A resumed draft is updated after every item. The intent and confirmed
    // achievement ID are durable before the next item starts, so a browser
    // failure cannot make a recovered draft upload a completed file again.
    const checkpoint = async (nextItems: UploadQueueItem[]) => {
      if (!hasSavedDraft || checkpointFailure) return;
      try {
        const saved = await saveUploadDraft(nextItems, checkpointRevision);
        checkpointRevision = saved.revision;
        if (!aliveRef.current) return;
        setDraft(saved);
        setOwnsDraft(true);
        setSavedSnapshot(queueSnapshot(nextItems));
      } catch (cause) {
        checkpointFailure = true;
        cancelRef.current = true;
        if (aliveRef.current) reportDraftError(cause);
      }
    };

    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const run = await runUploadQueue(
        uploadItems,
        // The browser's fetch needs its window receiver; pass a bound call rather
        // than the bare global so calling it through the dependency object works.
        { fetch: (input, init) => fetch(input, init), timezone },
        async (updated) => {
          if (!aliveRef.current) return;
          const nextItems = itemsRef.current.map((item) =>
            item.id === updated.id ? updated : item
          );
          itemsRef.current = nextItems;
          setItems(nextItems);
          await checkpoint(nextItems);
        },
        () => cancelRef.current
      );

      if (!aliveRef.current) return;
      itemsRef.current = run.items;
      setItems(run.items);

      if (run.achievements.length > 0) {
        onSuccess(run.achievements);
      }

      const remaining = run.items.filter((item) => item.stage !== 'succeeded');

      if (run.sessionExpired) {
        onSessionExpired?.();
        return;
      } else if (checkpointFailure) {
        setNotice(
          'Uploads stopped because the local draft checkpoint could not be updated. Keep this form open and save the draft again before leaving.'
        );
        return;
      } else if (run.paused) {
        setNotice(
          'The queue paused. No upload slot or storage allowance is free right now; retry the remaining artwork once space is available.'
        );
      } else if (remaining.length === 0) {
        if (hasSavedDraft) {
          try {
            await deleteDraft('upload', checkpointRevision);
            if (!aliveRef.current) return;
            setDraft(null);
            setOwnsDraft(false);
            setSavedSnapshot(null);
          } catch (cause) {
            if (!aliveRef.current) return;
            reportDraftError(cause);
            setNotice(
              'All artwork was saved, but the local draft could not be removed. Keep this form open and discard the saved draft after fixing the storage error.'
            );
            return;
          }
        }
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
    } catch (cause) {
      reportDraftError(cause);
    } finally {
      operationRef.current = false;
      if (aliveRef.current) {
        setRunning(false);
        setStopping(false);
      }
    }
  };

  const handleClose = useCallback(() => {
    if (operationRef.current || busy || confirmation) return;
    if (unfinished) {
      setDraftError(null);
      setConfirmation(true);
      return;
    }
    resetQueue();
    onClose();
  }, [busy, unfinished, confirmation, resetQueue, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    triggerRef.current = document.activeElement as HTMLElement;
    return () => {
      document.body.style.overflow = previousOverflow;
      const target = triggerRef.current;
      requestAnimationFrame(() => { if (target?.isConnected) target.focus({ preventScroll: true }); });
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      if (modalRef.current && !document.querySelector('dialog[open]') && !modalRef.current.contains(document.activeElement)) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        focusables[0]?.focus();
      }
    }, 50);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (confirmation || document.querySelector('dialog[open]')) return;
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
  }, [isOpen, handleClose, confirmation]);

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
        inert={confirmation || undefined}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) lastFocusRef.current = event.target;
        }}
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
            disabled={busy}
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

        {draftBusy && <p role="status">Updating local draft…</p>}
        {draftError && <p role="alert">{draftError}</p>}
        {draftError && !confirmation && <button type="button" className="gallery-button" disabled={busy} onClick={() => void reviewLatestDraft()}>Review latest draft</button>}
        {conflict && !confirmation && (
          <div className="gallery-draft-actions">
            <button type="button" className="gallery-button" disabled={busy} onClick={() => void reviewLatestDraft()}>Reload draft information</button>
            {conflictReviewed && <button type="button" className="gallery-button" disabled={busy} onClick={() => {
              setConflict(false); setReplacementApproved(true); setDraftError(null);
            }}>Keep this form and replace the reviewed draft when saving</button>}
          </div>
        )}
        {draft && draftChoice === 'offer' && (
          <section aria-label="Saved upload draft">
            <p>A local upload draft was saved {new Date(draft.savedAt).toLocaleString()}.</p>
            <div className="gallery-draft-actions">
              <button type="button" className="gallery-button" disabled={busy} onClick={() => {
                setItems(draft.items);
                setOwnsDraft(true);
                setSavedSnapshot(queueSnapshot(draft.items));
                setDraftChoice('ready');
                setNotice('Draft resumed. Review the queue and explicitly retry interrupted uploads.');
              }}>Resume draft</button>
              <button type="button" className="gallery-button" disabled={busy} onClick={() => void discardLocalDraft(false)}>Discard draft</button>
              <button type="button" className="gallery-button" disabled={busy} onClick={() => setDraftChoice('new')}>Start a new upload</button>
            </div>
          </section>
        )}
        {draftChoice === 'new' && (
          <section aria-label="Replace upload draft">
            <p>There is one saved upload draft in this browser. Saving a new upload replaces it. Until then, the existing draft stays saved.</p>
            <div className="gallery-draft-actions">
              <button type="button" className="gallery-button" onClick={() => setDraftChoice('offer')}>Back to saved draft</button>
              <button type="button" className="gallery-button" onClick={() => {
                setReplacementApproved(true); setOwnsDraft(false); setDraftChoice('ready');
              }}>Start new upload and allow draft replacement</button>
            </div>
          </section>
        )}
        <DraftPrivacyNotice />
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
            disabled={blocked || items.length >= MAX_BATCH_FILES}
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
          running={blocked}
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
          <button type="button" className="gallery-button" disabled={blocked || !unfinished} onClick={() => void saveLocalDraft(false)}>Save draft</button>
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
            disabled={busy}
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
            disabled={blocked || queuedCount === 0}
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
        {ownsDraft && <p className="gallery-draft-disclosure">Upload progress updates this saved snapshot. A completed queue removes it; a failed or paused queue keeps the remaining work recoverable.</p>}
        {items.some((item) => item.intentId !== null) && <p className="gallery-draft-disclosure">Existing upload intents may count toward quota until their normal cleanup. Saving or discarding a local draft does not remove remote uploads.</p>}
      </div>
      {confirmation && <UnsavedChangesDialog open busy={busy} error={draftError} returnFocus={lastFocusRef.current} onContinue={() => {
        if (!operationRef.current) setConfirmation(false);
      }} onSave={() => void saveLocalDraft(true)} onDiscard={() => void discardLocalDraft(true)} />}
    </div>
  );
}
