'use client';

import { useState, useEffect, useRef, type ChangeEvent, type FormEvent } from 'react';
import { AchievementItem, RestoreRequest } from './types';
import { ArtworkViewer, type ViewerBackground } from './ArtworkViewer';

const RESTORE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB, matches the upload pipeline
const RESTORE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable
  );
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  );
}

interface AchievementDetailModalProps {
  achievement: AchievementItem | null;
  viewerOpen: boolean;
  viewerBackground: ViewerBackground;
  hasPrevious: boolean;
  hasNext: boolean;
  navigationPending: boolean;
  onClose: () => void;
  onViewerOpen: () => void;
  onViewerClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onViewerBackgroundChange: (background: ViewerBackground) => void;
  onUpdate: (updated: AchievementItem) => void;
  onDelete: (deletedId: string) => void;
  restoreRequest: RestoreRequest | null;
  onDismissRestore: () => void;
}

export function AchievementDetailModal({
  achievement,
  viewerOpen,
  viewerBackground,
  hasPrevious,
  hasNext,
  navigationPending,
  onClose,
  onViewerOpen,
  onViewerClose,
  onPrevious,
  onNext,
  onViewerBackgroundChange,
  onUpdate,
  onDelete,
  restoreRequest,
  onDismissRestore,
}: AchievementDetailModalProps) {
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreResolved, setRestoreResolved] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editThumbnailPositionX, setEditThumbnailPositionX] = useState(0.5);
  const [editThumbnailPositionY, setEditThumbnailPositionY] = useState(0.5);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!achievement) {
      setDisplayUrl(null);
      setIsEditing(false);
      setError(null);
      return;
    }

    setEditTitle(achievement.title);
    setEditDate(achievement.completionDate);
    setEditNotes(achievement.notes || '');
    setEditTags(achievement.tags.join(', '));
    setEditThumbnailPositionX(
      Number.isFinite(achievement.thumbnailPositionX) ? achievement.thumbnailPositionX : 0.5
    );
    setEditThumbnailPositionY(
      Number.isFinite(achievement.thumbnailPositionY) ? achievement.thumbnailPositionY : 0.5
    );
    setIsEditing(false);
    setError(null);

    // Fetch short-lived signed display URL
    let isCancelled = false;
    setImageLoading(true);
    setImageError(false);
    setDisplayUrl(null);

    async function loadDisplayAsset() {
      try {
        const res = await fetch(`/api/achievements/${achievement!.id}/assets?type=display`);
        if (!res.ok) {
          throw new Error('Failed to load display asset');
        }
        const data = (await res.json()) as { url?: string };
        if (!isCancelled && data.url) {
          setDisplayUrl(data.url);
        }
      } catch (err) {
        if (!isCancelled) {
          console.error('[ASSET LOAD ERROR]', err);
          setError('Failed to load image asset');
        }
      } finally {
        if (!isCancelled) setImageLoading(false);
      }
    }

    void loadDisplayAsset();

    return () => {
      isCancelled = true;
    };
  }, [achievement]);

  useEffect(() => {
    setRestoreResolved(false);
  }, [achievement?.id, restoreRequest]);

  const detailModalRef = useRef<HTMLDivElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const viewerTriggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const wasViewerOpenRef = useRef(false);

  useEffect(() => {
    if (!achievement) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        if (triggerRef.current && typeof triggerRef.current.focus === 'function') {
          triggerRef.current.focus();
        }
        triggerRef.current = null;
      }
      return;
    }

    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      triggerRef.current = document.activeElement as HTMLElement;
    } else {
      return;
    }

    const timer = setTimeout(() => {
      if (!detailModalRef.current) return;
      const first = getFocusableElements(detailModalRef.current)[0];
      first?.focus();
    }, 50);

    return () => clearTimeout(timer);
  }, [achievement]);

  useEffect(() => {
    if (viewerOpen) {
      wasViewerOpenRef.current = true;
      const timer = setTimeout(() => {
        detailModalRef.current
          ?.querySelector<HTMLElement>('[data-viewer-close]')
          ?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }

    if (wasViewerOpenRef.current) {
      wasViewerOpenRef.current = false;
      viewerTriggerRef.current?.focus();
    }
    return undefined;
  }, [viewerOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (viewerOpen) {
          onViewerClose();
        } else {
          onClose();
        }
        return;
      }

      if (
        viewerOpen &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !isEditableTarget(e.target)
      ) {
        if (e.key === 'ArrowLeft' && hasPrevious) {
          e.preventDefault();
          onPrevious();
        } else if (e.key === 'ArrowRight' && hasNext) {
          e.preventDefault();
          onNext();
        }
        return;
      }

      if (e.key === 'Tab' && detailModalRef.current) {
        const focusContainer = viewerOpen
          ? detailModalRef.current.querySelector<HTMLElement>('[data-artwork-viewer]')
          : detailModalRef.current;
        if (!focusContainer) return;

        const focusables = getFocusableElements(focusContainer);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (first && last) {
          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [viewerOpen, hasPrevious, hasNext, onClose, onViewerClose, onPrevious, onNext]);

  if (!achievement) return null;

  const activeRestoreRequest =
    restoreRequest && restoreRequest.achievementId === achievement.id && !restoreResolved
      ? restoreRequest
      : null;
  const restoreMissingLabels = activeRestoreRequest
    ? (['original', 'display', 'thumbnail'] as const).filter(
        (field) => activeRestoreRequest[field] === 'missing'
      )
    : [];

  const handleDownloadOriginal = async () => {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/achievements/${achievement.id}/assets?type=original&download=true`);
      if (!res.ok) throw new Error('Failed to obtain download URL');
      const data = (await res.json()) as { url?: string };
      if (data.url) {
        // Trigger browser download
        const link = document.createElement('a');
        link.href = data.url;
        link.setAttribute('download', '');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const handleSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const parsedTags = editTags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    try {
      const res = await fetch(`/api/achievements/${achievement.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          title: editTitle.trim(),
          completionDate: editDate,
          notes: editNotes.trim(),
          tags: parsedTags,
          thumbnailPositionX: editThumbnailPositionX,
          thumbnailPositionY: editThumbnailPositionY,
          timezone: clientTimezone,
        }),
      });

      const data = (await res.json()) as { error?: string } & AchievementItem;

      if (!res.ok) {
        throw new Error(data.error || 'Failed to update achievement');
      }

      onUpdate(data);
      setIsEditing(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${achievement.title}"?\nThis removes all artwork images and metadata irreversibly.`
    );
    if (!confirmed) return;

    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/achievements/${achievement.id}`, {
        method: 'DELETE',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Deletion failed');
      }

      onDelete(achievement.id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete achievement');
    } finally {
      setDeleting(false);
    }
  };

  const handleRestoreFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!RESTORE_MIME_TYPES.includes(file.type)) {
      setError('Only JPEG, PNG, and WebP images can be restored.');
      return;
    }
    if (file.size > RESTORE_MAX_BYTES) {
      setError(
        `File size (${(file.size / 1024 / 1024).toFixed(1)} MiB) exceeds the 10 MiB limit.`
      );
      return;
    }

    setRestoring(true);
    setError(null);

    try {
      const intentRes = await fetch('/api/uploads/intents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type, fileSize: file.size }),
      });
      const intentData = (await intentRes.json()) as {
        intentId?: string;
        uploadUrl?: string;
        error?: string;
      };
      if (!intentRes.ok || !intentData.intentId || !intentData.uploadUrl) {
        throw new Error(intentData.error || 'Failed to start the restore upload');
      }

      const uploadRes = await fetch(intentData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!uploadRes.ok) {
        throw new Error('Failed to upload the replacement image');
      }

      const finalizeRes = await fetch(`/api/uploads/${intentData.intentId}/finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ achievementId: achievement.id }),
      });
      const finalizeData = (await finalizeRes.json()) as {
        finalized?: boolean;
        achievement?: AchievementItem;
        asset?: NonNullable<AchievementItem['asset']>;
        error?: string;
      };
      if (!finalizeRes.ok || !finalizeData.finalized || !finalizeData.achievement) {
        throw new Error(finalizeData.error || 'Failed to restore the artwork');
      }

      // Reopening the record re-resolves the signed URL from the new asset.
      setRestoreResolved(true);
      onUpdate({ ...finalizeData.achievement, asset: finalizeData.asset ?? achievement.asset ?? null });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to restore artwork');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div
      ref={detailModalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={viewerOpen ? undefined : 'detail-dialog-title'}
      aria-label={viewerOpen ? `Artwork viewer: ${achievement.title}` : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        inert={viewerOpen || undefined}
        style={{
          backgroundColor: '#fff',
          borderRadius: 12,
          maxWidth: 900,
          width: '100%',
          maxHeight: '92vh',
          overflowY: 'auto',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 24px',
            borderBottom: '1px solid #e2e8f0',
          }}
        >
          <h2
            id="detail-dialog-title"
            style={{
              margin: 0,
              fontSize: '20px',
              fontWeight: 700,
              color: '#0f172a',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '80%',
            }}
          >
            {achievement.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '22px',
              cursor: 'pointer',
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

        {/* Error message */}
        {error && (
          <div
            role="alert"
            style={{
              margin: '16px 24px 0',
              padding: '10px 14px',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 6,
              color: '#991b1b',
              fontSize: '14px',
            }}
          >
            {error}
          </div>
        )}

        {activeRestoreRequest && (
          <div
            data-restore-prompt
            role="region"
            aria-label="Restore artwork prompt"
            style={{
              margin: '16px 24px 0',
              padding: '14px 16px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 8,
            }}
          >
            <div style={{ flex: '1 1 280px' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#1e3a8a' }}>
                {activeRestoreRequest.linkage === 'missing'
                  ? 'Image file not linked'
                  : 'Stored image needs attention'}
              </div>
              <p style={{ margin: '4px 0 0 0', fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
                {activeRestoreRequest.linkage === 'missing'
                  ? 'This artwork record has no linked image asset. '
                  : `The health check could not find the stored ${
                      restoreMissingLabels.length > 0
                        ? restoreMissingLabels.join(', ')
                        : 'image'
                    } ${restoreMissingLabels.length === 1 ? 'file' : 'files'}. `}
                Restoring uploads a replacement image file only. The title, completion date,
                notes, tags, and thumbnail framing are metadata and stay unchanged.
              </p>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                onClick={() => restoreInputRef.current?.click()}
                disabled={restoring}
                style={{
                  minHeight: 44,
                  padding: '9px 14px',
                  backgroundColor: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: restoring ? 'not-allowed' : 'pointer',
                  opacity: restoring ? 0.7 : 1,
                }}
              >
                {restoring ? 'Restoring artwork…' : 'Restore artwork file'}
              </button>
              <button
                type="button"
                onClick={onDismissRestore}
                disabled={restoring}
                style={{
                  minHeight: 44,
                  padding: '9px 14px',
                  backgroundColor: '#fff',
                  color: '#475569',
                  border: '1px solid #cbd5e1',
                  borderRadius: 6,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: restoring ? 'not-allowed' : 'pointer',
                  opacity: restoring ? 0.7 : 1,
                }}
              >
                Not now
              </button>
            </div>
          </div>
        )}

        {/* One file input serves both restore entry points. It stays mounted
            while the display preview loads, so the health prompt can open it. */}
        <input
          ref={restoreInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => void handleRestoreFile(e)}
          disabled={restoring}
          style={{ display: 'none' }}
        />

        {/* Content Body: Responsive Split */}
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', padding: '24px', gap: '24px' }}>
          {/* Left: Image Display */}
          <div
            style={{
              flex: '1 1 420px',
              minHeight: 320,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#0f172a',
              borderRadius: 8,
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            {imageLoading && (
              <div style={{ color: '#94a3b8', fontSize: '15px' }}>Loading artwork...</div>
            )}
            {!imageLoading && displayUrl && !imageError && (
              <img
                src={displayUrl}
                alt={achievement.title}
                decoding="async"
                onError={() => {
                  setDisplayUrl(null);
                  setImageError(true);
                }}
                style={{
                  maxWidth: '100%',
                  maxHeight: 520,
                  objectFit: 'contain',
                }}
              />
            )}
            {achievement.asset && !imageError && (
              <button
                ref={viewerTriggerRef}
                type="button"
                onClick={onViewerOpen}
                style={{
                  position: 'absolute',
                  right: 12,
                  bottom: 12,
                  minHeight: 44,
                  padding: '9px 14px',
                  borderRadius: 6,
                  border: '1px solid #cbd5e1',
                  backgroundColor: 'rgba(15, 23, 42, 0.9)',
                  color: '#f8fafc',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                View fullscreen
              </button>
            )}
            {!imageLoading && (imageError || !displayUrl) && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  padding: 24,
                  textAlign: 'center',
                }}
              >
                <span aria-hidden="true" style={{ fontSize: '36px' }}>
                  🖼️
                </span>
                <div style={{ color: '#e2e8f0', fontSize: '16px', fontWeight: 600 }}>
                  Preview unavailable
                </div>
                <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px', maxWidth: 340, lineHeight: 1.5 }}>
                  The artwork preview couldn&apos;t be loaded. If the stored file was lost,
                  re-attach the original to restore it. The title, date, notes and tags stay
                  unchanged.
                </p>
                <button
                  type="button"
                  onClick={() => restoreInputRef.current?.click()}
                  disabled={restoring}
                  style={{
                    padding: '10px 18px',
                    minHeight: 44,
                    backgroundColor: '#2563eb',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: '14px',
                    cursor: restoring ? 'not-allowed' : 'pointer',
                    opacity: restoring ? 0.7 : 1,
                  }}
                >
                  {restoring ? 'Restoring artwork...' : '📎 Restore artwork'}
                </button>
              </div>
            )}
          </div>

          {/* Right: Metadata & Actions */}
          <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column' }}>
            {!isEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                {/* Completion Date */}
                <div style={{ marginBottom: 16 }}>
                  <span style={{ fontSize: '13px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Completed
                  </span>
                  <div style={{ fontSize: '16px', fontWeight: 600, color: '#1e293b', marginTop: 2 }}>
                    {achievement.completionDate}
                  </div>
                </div>

                {/* Notes */}
                <div style={{ marginBottom: 20 }}>
                  <span style={{ fontSize: '13px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Artist Notes & Reflections
                  </span>
                  <div
                    style={{
                      fontSize: '14px',
                      color: '#334155',
                      lineHeight: 1.6,
                      marginTop: 4,
                      whiteSpace: 'pre-wrap',
                      backgroundColor: '#f8fafc',
                      padding: '12px',
                      borderRadius: 6,
                      border: '1px solid #e2e8f0',
                      minHeight: 60,
                    }}
                  >
                    {achievement.notes || <em style={{ color: '#94a3b8' }}>No notes recorded for this piece.</em>}
                  </div>
                </div>

                {/* Tags */}
                <div style={{ marginBottom: 24 }}>
                  <span style={{ fontSize: '13px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Tags
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {achievement.tags.length > 0 ? (
                      achievement.tags.map((tag) => (
                        <span
                          key={tag}
                          style={{
                            fontSize: '13px',
                            backgroundColor: '#e0e7ff',
                            color: '#3730a3',
                            padding: '4px 10px',
                            borderRadius: 12,
                            fontWeight: 500,
                          }}
                        >
                          #{tag}
                        </span>
                      ))
                    ) : (
                      <span style={{ color: '#94a3b8', fontSize: '13px' }}>None</span>
                    )}
                  </div>
                </div>

                {/* Action Buttons */}
                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => void handleDownloadOriginal()}
                    disabled={downloading}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      padding: '11px 16px',
                      backgroundColor: '#0f172a',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontWeight: 600,
                      cursor: downloading ? 'not-allowed' : 'pointer',
                      fontSize: '14px',
                    }}
                  >
                    📥 {downloading ? 'Preparing download...' : 'Download Original Asset'}
                  </button>

                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => setIsEditing(true)}
                      style={{
                        flex: 1,
                        padding: '9px 14px',
                        backgroundColor: '#f8fafc',
                        color: '#334155',
                        border: '1px solid #cbd5e1',
                        borderRadius: 6,
                        fontWeight: 500,
                        cursor: 'pointer',
                        fontSize: '14px',
                      }}
                    >
                      ✏️ Edit Details
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={deleting}
                      style={{
                        padding: '9px 14px',
                        backgroundColor: '#fef2f2',
                        color: '#b91c1c',
                        border: '1px solid #fecaca',
                        borderRadius: 6,
                        fontWeight: 500,
                        cursor: deleting ? 'not-allowed' : 'pointer',
                        fontSize: '14px',
                      }}
                    >
                      🗑️ {deleting ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Edit Form */
              <form onSubmit={(e) => void handleSaveEdit(e)} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ marginBottom: 14 }}>
                  <label htmlFor="edit-title-input" style={{ display: 'block', fontWeight: 600, fontSize: '13px', color: '#334155', marginBottom: 4 }}>
                    Title * ({editTitle.length}/120)
                  </label>
                  <input
                    id="edit-title-input"
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    maxLength={120}
                    required
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid #cbd5e1',
                      fontSize: '14px',
                    }}
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label htmlFor="edit-date-input" style={{ display: 'block', fontWeight: 600, fontSize: '13px', color: '#334155', marginBottom: 4 }}>
                    Completion Date *
                  </label>
                  <input
                    id="edit-date-input"
                    type="date"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    required
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid #cbd5e1',
                      fontSize: '14px',
                    }}
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label htmlFor="edit-notes-input" style={{ display: 'block', fontWeight: 600, fontSize: '13px', color: '#334155', marginBottom: 4 }}>
                    Notes ({editNotes.length}/2000)
                  </label>
                  <textarea
                    id="edit-notes-input"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    maxLength={2000}
                    rows={4}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid #cbd5e1',
                      fontSize: '14px',
                      resize: 'vertical',
                    }}
                  />
                </div>

                <div style={{ marginBottom: 20 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: '13px', color: '#334155', marginBottom: 6 }}>
                    Gallery Thumbnail Framing
                  </span>
                  <div
                    style={{
                      width: '100%',
                      maxWidth: 320,
                      aspectRatio: '4 / 3',
                      backgroundColor: '#f1f5f9',
                      borderRadius: 8,
                      border: '1px solid #cbd5e1',
                      overflow: 'hidden',
                      marginBottom: 10,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {displayUrl ? (
                      <img
                        data-thumbnail-preview
                        src={displayUrl}
                        alt="Gallery thumbnail framing preview"
                        style={{
                          display: 'block',
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          objectPosition: `${editThumbnailPositionX * 100}% ${editThumbnailPositionY * 100}%`,
                        }}
                      />
                    ) : (
                      <span style={{ color: '#64748b', fontSize: '13px' }}>
                        {imageLoading ? 'Loading preview...' : 'Preview unavailable'}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
                    <label
                      htmlFor="edit-thumbnail-position-x"
                      style={{ flex: '1 1 180px', minWidth: 160, fontSize: '13px', color: '#334155' }}
                    >
                      <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                        Horizontal ({Math.round(editThumbnailPositionX * 100)}%)
                      </span>
                      <input
                        id="edit-thumbnail-position-x"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={editThumbnailPositionX}
                        aria-valuetext={`${Math.round(editThumbnailPositionX * 100)}%`}
                        onChange={(e) => setEditThumbnailPositionX(Number(e.target.value))}
                        style={{ width: '100%', minHeight: 44, accentColor: '#2563eb' }}
                      />
                    </label>
                    <label
                      htmlFor="edit-thumbnail-position-y"
                      style={{ flex: '1 1 180px', minWidth: 160, fontSize: '13px', color: '#334155' }}
                    >
                      <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                        Vertical ({Math.round(editThumbnailPositionY * 100)}%)
                      </span>
                      <input
                        id="edit-thumbnail-position-y"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={editThumbnailPositionY}
                        aria-valuetext={`${Math.round(editThumbnailPositionY * 100)}%`}
                        onChange={(e) => setEditThumbnailPositionY(Number(e.target.value))}
                        style={{ width: '100%', minHeight: 44, accentColor: '#2563eb' }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setEditThumbnailPositionX(0.5);
                        setEditThumbnailPositionY(0.5);
                      }}
                      style={{
                        minHeight: 44,
                        padding: '8px 16px',
                        backgroundColor: '#f8fafc',
                        color: '#334155',
                        border: '1px solid #cbd5e1',
                        borderRadius: 6,
                        fontWeight: 600,
                        fontSize: '13px',
                        cursor: 'pointer',
                      }}
                    >
                      Center
                    </button>
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#64748b' }}>
                    Framing changes only the gallery card. The full artwork and original download stay unchanged.
                  </p>
                </div>

                <div style={{ marginBottom: 20 }}>
                  <label htmlFor="edit-tags-input" style={{ display: 'block', fontWeight: 600, fontSize: '13px', color: '#334155', marginBottom: 4 }}>
                    Tags (comma-separated, max 10)
                  </label>
                  <input
                    id="edit-tags-input"
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    placeholder="oil, portrait, study"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid #cbd5e1',
                      fontSize: '14px',
                    }}
                  />
                </div>

                <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    disabled={saving}
                    style={{
                      padding: '8px 14px',
                      backgroundColor: '#f1f5f9',
                      color: '#475569',
                      border: '1px solid #cbd5e1',
                      borderRadius: 6,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    style={{
                      padding: '8px 18px',
                      backgroundColor: '#2563eb',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontWeight: 600,
                      cursor: saving ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      {viewerOpen && (
        <ArtworkViewer
          achievement={achievement}
          background={viewerBackground}
          hasPrevious={hasPrevious}
          hasNext={hasNext}
          navigationPending={navigationPending}
          onClose={onViewerClose}
          onPrevious={onPrevious}
          onNext={onNext}
          onBackgroundChange={onViewerBackgroundChange}
        />
      )}
    </div>
  );
}
