'use client';

import { useState, useEffect, useRef, type FormEvent } from 'react';
import { AchievementItem } from './types';

interface AchievementDetailModalProps {
  achievement: AchievementItem | null;
  onClose: () => void;
  onUpdate: (updated: AchievementItem) => void;
  onDelete: (deletedId: string) => void;
}

export function AchievementDetailModal({
  achievement,
  onClose,
  onUpdate,
  onDelete,
}: AchievementDetailModalProps) {
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
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
    setIsEditing(false);
    setError(null);

    // Fetch short-lived signed display URL
    let isCancelled = false;
    setImageLoading(true);

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

  const detailModalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!achievement) {
      if (triggerRef.current && typeof triggerRef.current.focus === 'function') {
        triggerRef.current.focus();
      }
      return;
    }

    triggerRef.current = document.activeElement as HTMLElement;

    const timer = setTimeout(() => {
      if (detailModalRef.current) {
        const focusables = detailModalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        const first = focusables[0];
        if (first) {
          first.focus();
        }
      }
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'Tab' && detailModalRef.current) {
        const focusables = detailModalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
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
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [achievement, onClose]);

  if (!achievement) return null;

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-dialog-title"
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
        ref={detailModalRef}
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
            {!imageLoading && displayUrl && (
              <img
                src={displayUrl}
                alt={achievement.title}
                decoding="async"
                style={{
                  maxWidth: '100%',
                  maxHeight: 520,
                  objectFit: 'contain',
                }}
              />
            )}
            {!imageLoading && !displayUrl && (
              <div style={{ color: '#ef4444', fontSize: '14px' }}>Unable to display image</div>
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
    </div>
  );
}
