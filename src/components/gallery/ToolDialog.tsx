'use client';

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

interface ToolDialogProps {
  open: boolean;
  label: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  shouldRestoreFocus?: () => boolean;
  children?: ReactNode;
}

export function ToolDialog({
  open,
  label,
  onClose,
  returnFocus = null,
  shouldRestoreFocus,
  children,
}: ToolDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef(returnFocus);
  const shouldRestoreFocusRef = useRef(shouldRestoreFocus);

  useLayoutEffect(() => {
    returnFocusRef.current = returnFocus;
    shouldRestoreFocusRef.current = shouldRestoreFocus;
  }, [returnFocus, shouldRestoreFocus]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    const previousOverflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';

    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;

      const target = returnFocusRef.current;
      const restoreAllowed = shouldRestoreFocusRef.current?.() ?? true;
      if (!restoreAllowed) return;

      requestAnimationFrame(() => {
        if (!target?.isConnected) return;
        if (!target.getClientRects().length) return;
        if (document.querySelector('dialog[open]')) return;
        const parentDialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (parentDialog && !parentDialog.contains(target)) return;
        target.focus({ preventScroll: true });
      });
    };
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.getClientRects().length > 0);

    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    const activeInside = active instanceof Node && dialog.contains(active);

    if (event.shiftKey) {
      if (!activeInside || active === first) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (!activeInside || active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="gallery-tool-dialog"
      aria-label={label}
      onKeyDown={handleKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="gallery-tool-dialog-header">
        <span>{label}</span>
        <button type="button" className="gallery-button" onClick={onClose} aria-label={`Close ${label}`}>
          Close
        </button>
      </div>
      <div className="gallery-tool-dialog-body">{children}</div>
    </dialog>
  );
}
