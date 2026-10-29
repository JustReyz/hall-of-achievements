'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AchievementItem } from './types';
import {
  CONTACT_SHEET_MAX_ITEMS,
  getContactSheetCell,
  getContactSheetLayout,
  truncateCanvasText,
} from '@/lib/image/contact-sheet';

const CONTACT_SHEET_FILENAME = 'artwork-contact-sheet.png';
const CAPTION_FONT = '20px system-ui, -apple-system, "Segoe UI", sans-serif';

type ContactSheetStatus =
  | { phase: 'idle' }
  | { phase: 'working'; completed: number; total: number }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string }
  | { phase: 'canceled'; message: string };

interface ContactSheetExportProps {
  selectedItems: AchievementItem[];
  loadedCount: number;
  scopeKey: string;
  focusRequest?: number;
  onSelectLoaded: () => void;
  onClear: () => void;
  onExit: () => void;
  onSessionExpired: () => void;
}

async function readFailureDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // The response was not JSON; fall back to the status below.
  }
  return `the server returned HTTP ${response.status}`;
}

async function drawArtwork(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  item: AchievementItem,
  layout: ReturnType<typeof getContactSheetLayout>,
  index: number
): Promise<void> {
  const cell = getContactSheetCell(layout, index);
  const scale = Math.min(
    cell.image.width / bitmap.width,
    cell.image.height / bitmap.height
  );
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  const x = cell.image.x + (cell.image.width - width) / 2;
  const y = cell.image.y + (cell.image.height - height) / 2;

  context.drawImage(bitmap, x, y, width, height);

  context.fillStyle = '#111827';
  context.font = CAPTION_FONT;
  context.textBaseline = 'middle';
  const caption = truncateCanvasText(item.title || 'Untitled', cell.caption.width, (value) =>
    context.measureText(value).width
  );
  context.fillText(caption, cell.caption.x, cell.caption.baselineY);
}

export function ContactSheetExport({
  selectedItems,
  loadedCount,
  scopeKey,
  focusRequest = 0,
  onSelectLoaded,
  onClear,
  onExit,
  onSessionExpired,
}: ContactSheetExportProps) {
  const [status, setStatus] = useState<ContactSheetStatus>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const aliveRef = useRef(true);
  const selectLoadedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    runRef.current++;
    setStatus({ phase: 'idle' });
  }, [scopeKey]);

  useEffect(() => {
    selectLoadedRef.current?.focus();
  }, [focusRequest]);

  const cancelExport = useCallback(() => {
    if (status.phase !== 'working') return;
    runRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus({ phase: 'canceled', message: 'Export canceled. Nothing was downloaded.' });
  }, [status.phase]);

  const startExport = useCallback(async () => {
    if (status.phase === 'working' || selectedItems.length === 0) return;

    const items = selectedItems;
    const layout = getContactSheetLayout(items.length);
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');

    if (!context) {
      setStatus({
        phase: 'error',
        message: 'Export could not start because this browser has no canvas support.',
      });
      return;
    }

    const controller = new AbortController();
    const runId = ++runRef.current;
    abortRef.current = controller;

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, layout.width, layout.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    setStatus({ phase: 'working', completed: 0, total: items.length });

    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!item) throw new Error('The selection changed before export started.');

        const response = await fetch(
          `/api/achievements/${encodeURIComponent(item.id)}/assets?type=display&delivery=inline`,
          {
            signal: controller.signal,
            credentials: 'same-origin',
            cache: 'no-store',
          }
        );

        if (response.status === 401) {
          onSessionExpired();
          return;
        }

        if (!response.ok) {
          throw new Error(
            `Could not load “${item.title}”: ${await readFailureDetail(response)}.`
          );
        }

        const blob = await response.blob();
        if (blob.size === 0) {
          throw new Error(`Could not load “${item.title}”: the display image was empty.`);
        }

        let bitmap: ImageBitmap | null = null;
        try {
          bitmap = await createImageBitmap(blob);
          if (controller.signal.aborted) return;
          await drawArtwork(context, bitmap, item, layout, index);
        } catch (error) {
          if (controller.signal.aborted) return;
          const detail = error instanceof Error ? error.message : 'the image could not be decoded.';
          throw new Error(`Could not load “${item.title}”: ${detail}`);
        } finally {
          bitmap?.close();
        }

        if (controller.signal.aborted || runId !== runRef.current) return;
        setStatus({ phase: 'working', completed: index + 1, total: items.length });
      }

      if (controller.signal.aborted || runId !== runRef.current) return;

      const sheet = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/png');
      });

      if (controller.signal.aborted || runId !== runRef.current) return;
      if (!sheet) throw new Error('the finished canvas could not be encoded as PNG.');

      const objectUrl = URL.createObjectURL(sheet);
      try {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = CONTACT_SHEET_FILENAME;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }

      if (!aliveRef.current) return;
      setStatus({
        phase: 'success',
        message: `Downloaded ${CONTACT_SHEET_FILENAME} (${layout.width} × ${layout.height} px).`,
      });
    } catch (error) {
      if (controller.signal.aborted || runId !== runRef.current || !aliveRef.current) return;
      const detail = error instanceof Error ? error.message : 'The export failed unexpectedly.';
      setStatus({
        phase: 'error',
        message: `${detail}${detail.endsWith('.') ? '' : '.'} No sheet was downloaded.`,
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      canvas.width = 0;
      canvas.height = 0;
    }
  }, [onSessionExpired, selectedItems, status.phase]);

  const working = status.phase === 'working';
  const selectionFull = selectedItems.length >= CONTACT_SHEET_MAX_ITEMS;

  return (
    <section aria-label="Contact sheet export" className="gallery-contact-sheet">
      <div className="gallery-contact-sheet-controls">
        <strong className="gallery-contact-sheet-count">
          {selectedItems.length} of {CONTACT_SHEET_MAX_ITEMS} selected
        </strong>

        <button
          ref={selectLoadedRef}
          type="button"
          className="gallery-button"
          onClick={onSelectLoaded}
          disabled={working || selectionFull || loadedCount === 0}
        >
          Select loaded
        </button>

        <button
          type="button"
          className="gallery-button"
          onClick={onClear}
          disabled={working || selectedItems.length === 0}
        >
          Clear selection
        </button>

        <button
          type="button"
          className="gallery-button gallery-button-primary"
          onClick={() => void startExport()}
          disabled={working || selectedItems.length === 0}
        >
          Export PNG
        </button>

        {working ? (
          <button type="button" className="gallery-button gallery-button-danger" onClick={cancelExport}>
            Cancel export
          </button>
        ) : (
          <button type="button" className="gallery-button gallery-button-quiet" onClick={onExit}>
            Exit selection
          </button>
        )}
      </div>

      <p className="gallery-contact-sheet-note">
        Select loaded includes only the {loadedCount} {loadedCount === 1 ? 'artwork' : 'artworks'}{' '}
        currently loaded in this view, up to {CONTACT_SHEET_MAX_ITEMS}. Artworks on unseen pages are
        never added. Images appear in the order you select them.
      </p>

      {working && (
        <div className="gallery-contact-sheet-progress">
          <progress
            aria-label="Contact sheet export progress"
            value={status.completed}
            max={status.total}
          />
          <p role="status" aria-live="polite">
            Preparing image {Math.min(status.completed + 1, status.total)} of {status.total}...
          </p>
        </div>
      )}

      {(status.phase === 'error' ||
        status.phase === 'success' ||
        status.phase === 'canceled') && (
        <p
          role={status.phase === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className="gallery-contact-sheet-status"
          data-phase={status.phase}
        >
          {status.message}
        </p>
      )}
    </section>
  );
}
