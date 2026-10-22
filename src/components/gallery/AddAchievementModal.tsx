'use client';

import { useState, useRef, type FormEvent, type ChangeEvent } from 'react';
import { AchievementItem } from './types';

interface AddAchievementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newAchievement: AchievementItem) => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB

export function AddAchievementModal({ isOpen, onClose, onSuccess }: AddAchievementModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [completionDate, setCompletionDate] = useState(() => {
    // Client local date in YYYY-MM-DD
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });
  const [notes, setNotes] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const selected = e.target.files?.[0];
    if (!selected) return;

    // Client-side file type check
    const validMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validMimes.includes(selected.type)) {
      setError('Only JPEG, PNG, and WebP images are allowed. Disallowed formats (SVG, GIF, etc.) are rejected.');
      return;
    }

    // Client-side file size check
    if (selected.size > MAX_FILE_SIZE) {
      setError(`File size (${(selected.size / 1024 / 1024).toFixed(1)} MiB) exceeds the 10 MiB limit.`);
      return;
    }

    setFile(selected);
    const objUrl = URL.createObjectURL(selected);
    setPreviewUrl(objUrl);

    if (!title.trim()) {
      const suggestedTitle = selected.name.replace(/\.[^/.]+$/, '');
      setTitle(suggestedTitle.slice(0, 120));
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Please select an artwork image file.');
      return;
    }

    if (!title.trim()) {
      setError('Title is required.');
      return;
    }

    setUploading(true);
    setError(null);
    setUploadStatus('Requesting direct upload capability...');

    try {
      // Step 1: Create upload intent
      const intentRes = await fetch('/api/uploads/intents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        }),
      });

      const intentData = (await intentRes.json()) as {
        intentId?: string;
        uploadUrl?: string;
        error?: string;
      };

      if (!intentRes.ok || !intentData.intentId || !intentData.uploadUrl) {
        throw new Error(intentData.error || 'Failed to create upload intent');
      }

      const { intentId, uploadUrl } = intentData;

      // Step 2: Direct upload to private storage quarantine
      setUploadStatus('Uploading artwork directly to secure storage...');
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
        },
        body: file,
      });

      if (!uploadRes.ok) {
        throw new Error('Failed to upload image bytes to storage capability');
      }

      // Step 3: Finalize upload with metadata
      setUploadStatus('Verifying byte signatures and generating derivatives...');
      const parsedTags = tagsInput
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);

      const clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

      const finalizeRes = await fetch(`/api/uploads/${intentId}/finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          title: title.trim(),
          completionDate,
          notes: notes.trim(),
          tags: parsedTags,
          timezone: clientTimezone,
        }),
      });

      const finalizeData = (await finalizeRes.json()) as {
        finalized?: boolean;
        achievement?: AchievementItem;
        error?: string;
      };

      if (!finalizeRes.ok || !finalizeData.achievement) {
        throw new Error(finalizeData.error || 'Finalization failed');
      }

      // Success!
      onSuccess(finalizeData.achievement);
      handleClose();
    } catch (err: unknown) {
      console.error('[UPLOAD ERROR]', err);
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setError(msg);
    } finally {
      setUploading(false);
      setUploadStatus(null);
    }
  };

  const handleClose = () => {
    if (uploading) return;
    setFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setTitle('');
    setNotes('');
    setTagsInput('');
    setError(null);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-achievement-title"
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
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style={{
          backgroundColor: '#fff',
          borderRadius: 12,
          maxWidth: 620,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: 28,
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 id="add-achievement-title" style={{ margin: 0, fontSize: '22px', color: '#0f172a' }}>
            Record Artwork Achievement
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            disabled={uploading}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '20px',
              cursor: 'pointer',
              color: '#64748b',
              padding: 4,
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
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)}>
          {/* File Picker */}
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: 'block', fontWeight: 600, fontSize: '14px', color: '#334155', marginBottom: 6 }}>
              Artwork File (JPEG, PNG, WebP — max 10 MiB, &le; 20 MP) *
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              disabled={uploading}
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
            {previewUrl && (
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <img
                  src={previewUrl}
                  alt="Selected artwork preview"
                  style={{
                    maxHeight: 180,
                    maxWidth: '100%',
                    objectFit: 'contain',
                    borderRadius: 6,
                    border: '1px solid #e2e8f0',
                  }}
                />
              </div>
            )}
          </div>

          {/* Title */}
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="achievement-title-input" style={{ display: 'block', fontWeight: 600, fontSize: '14px', color: '#334155', marginBottom: 6 }}>
              Title * ({title.length}/120)
            </label>
            <input
              id="achievement-title-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              required
              disabled={uploading}
              placeholder="e.g. Mountain Summit at Sunset"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: '15px',
              }}
            />
          </div>

          {/* Completion Date */}
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="achievement-date-input" style={{ display: 'block', fontWeight: 600, fontSize: '14px', color: '#334155', marginBottom: 6 }}>
              Completion Date * (YYYY-MM-DD)
            </label>
            <input
              id="achievement-date-input"
              type="date"
              value={completionDate}
              onChange={(e) => setCompletionDate(e.target.value)}
              required
              disabled={uploading}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: '15px',
              }}
            />
          </div>

          {/* Notes */}
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="achievement-notes-input" style={{ display: 'block', fontWeight: 600, fontSize: '14px', color: '#334155', marginBottom: 6 }}>
              Notes / Reflections ({notes.length}/2000)
            </label>
            <textarea
              id="achievement-notes-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={uploading}
              placeholder="Medium, technique, reflections, challenges overcome..."
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: '14px',
                resize: 'vertical',
              }}
            />
          </div>

          {/* Tags */}
          <div style={{ marginBottom: 24 }}>
            <label htmlFor="achievement-tags-input" style={{ display: 'block', fontWeight: 600, fontSize: '14px', color: '#334155', marginBottom: 6 }}>
              Tags (comma-separated, max 10 tags, 24 chars each)
            </label>
            <input
              id="achievement-tags-input"
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              disabled={uploading}
              placeholder="oil, landscape, portrait, study"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: '14px',
              }}
            />
          </div>

          {/* Progress Status */}
          {uploadStatus && (
            <div style={{ marginBottom: 16, fontSize: '14px', color: '#2563eb', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>⏳</span> {uploadStatus}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={handleClose}
              disabled={uploading}
              style={{
                padding: '10px 18px',
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
              disabled={uploading}
              style={{
                padding: '10px 22px',
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 600,
                cursor: uploading ? 'not-allowed' : 'pointer',
                opacity: uploading ? 0.7 : 1,
              }}
            >
              {uploading ? 'Processing...' : 'Save Achievement'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
