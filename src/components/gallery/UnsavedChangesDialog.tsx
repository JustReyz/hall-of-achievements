'use client';

import { useEffect, useRef, useState } from 'react';
import { ToolDialog } from './ToolDialog';

interface UnsavedChangesDialogProps {
  open: boolean;
  busy: boolean;
  error: string | null;
  returnFocus?: HTMLElement | null;
  onContinue: () => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function DraftPrivacyNotice() {
  return (
    <p className="gallery-draft-disclosure">
      Drafts keep private files and details in this browser, unencrypted, even after logout.
      Anyone using this browser profile may access them. They do not sync or create artwork.
      Clearing site data, private browsing, or browser storage eviction can remove them.
      Save again after making changes; closing the browser does not save automatically.
    </p>
  );
}

export function UnsavedChangesDialog({ open, busy, error, returnFocus, onContinue, onSave, onDiscard }: UnsavedChangesDialogProps) {
  const [fallbackFocus] = useState(() => typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) continueRef.current?.focus();
  }, [open]);

  return (
    <ToolDialog open={open} label="Unsaved changes" onClose={() => { if (!busy) onContinue(); }} returnFocus={returnFocus ?? fallbackFocus}>
      <p>Keep editing, save a local draft, or discard these changes?</p>
      <DraftPrivacyNotice />
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Updating local draft…</p>}
      <div className="gallery-draft-actions" aria-busy={busy}>
        <button ref={continueRef} type="button" className="gallery-button" disabled={busy} onClick={onContinue}>Continue editing</button>
        <button type="button" className="gallery-button" disabled={busy} onClick={onSave}>Save draft</button>
        <button type="button" className="gallery-button" disabled={busy} onClick={onDiscard}>Discard changes</button>
      </div>
    </ToolDialog>
  );
}
