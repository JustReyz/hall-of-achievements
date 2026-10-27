'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AchievementItem } from './types';
import {
  clampViewerTransform,
  type ViewTransform,
  type ViewerSize,
} from '@/lib/image/viewer-transform';

export type ViewerBackground = 'light' | 'gray' | 'black';

export const VIEWER_BACKGROUNDS: Array<{
  value: ViewerBackground;
  label: string;
  color: string;
}> = [
  { value: 'light', label: 'Light', color: '#ffffff' },
  { value: 'gray', label: 'Gray', color: '#808080' },
  { value: 'black', label: 'Black', color: '#000000' },
];

interface ArtworkViewerProps {
  achievement: AchievementItem;
  background: ViewerBackground;
  hasPrevious: boolean;
  hasNext: boolean;
  navigationPending: boolean;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onBackgroundChange: (background: ViewerBackground) => void;
}

const ZOOM_STEP = 0.5;

function fitInsideViewport(viewport: ViewerSize, aspectRatio: number): ViewerSize {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { width: 0, height: 0 };
  }

  const aspect = aspectRatio > 0 ? aspectRatio : 1;
  const width =
    viewport.width / viewport.height > aspect ? viewport.height * aspect : viewport.width;

  return { width, height: width / aspect };
}

function toolbarButtonStyle(disabled = false) {
  return {
    minWidth: 44,
    minHeight: 44,
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #475569',
    backgroundColor: '#1e293b',
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  } as const;
}

export function ArtworkViewer({
  achievement,
  background,
  hasPrevious,
  hasNext,
  navigationPending,
  onClose,
  onPrevious,
  onNext,
  onBackgroundChange,
}: ArtworkViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const [viewport, setViewport] = useState<ViewerSize>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ViewTransform>({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [displayAsset, setDisplayAsset] = useState<{
    achievementId: string;
    url: string;
  } | null>(null);
  const [imageState, setImageState] = useState<{
    achievementId: string;
    status: 'loading' | 'ready' | 'error';
  }>({ achievementId: achievement.id, status: 'loading' });
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);

  const displayRequestRef = useRef(0);
  const autoRetriedImageRef = useRef(false);

  const assetWidth = achievement.asset?.width ?? 0;
  const assetHeight = achievement.asset?.height ?? 0;
  const aspectRatio = assetWidth > 0 && assetHeight > 0 ? assetWidth / assetHeight : 1;
  const fittedImage = fitInsideViewport(viewport, aspectRatio);
  const currentImageStatus =
    imageState.achievementId === achievement.id ? imageState.status : 'loading';
  const currentDisplayUrl =
    displayAsset?.achievementId === achievement.id ? displayAsset.url : null;

  useEffect(() => {
    setTransform({ zoom: 1, x: 0, y: 0 });
    dragRef.current = null;
    setDragging(false);
  }, [achievement.id]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateViewport = () => {
      setViewport((previous) =>
        previous.width === element.clientWidth && previous.height === element.clientHeight
          ? previous
          : { width: element.clientWidth, height: element.clientHeight }
      );
    };

    updateViewport();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateViewport);
    observer?.observe(element);
    window.addEventListener('resize', updateViewport);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateViewport);
    };
  }, []);

  useEffect(() => {
    setTransform((previous) => {
      const next = clampViewerTransform(previous, viewport, fittedImage);
      return next.zoom === previous.zoom && next.x === previous.x && next.y === previous.y
        ? previous
        : next;
    });
  }, [viewport.width, viewport.height, fittedImage.width, fittedImage.height]);

  const loadDisplayAsset = useCallback(async () => {
    const requestId = ++displayRequestRef.current;
    const achievementId = achievement.id;
    setImageState({ achievementId, status: 'loading' });
    setDisplayAsset(null);

    try {
      const response = await fetch(
        `/api/achievements/${achievementId}/assets?type=display`
      );
      if (requestId !== displayRequestRef.current) return;
      if (!response.ok) throw new Error('Failed to load the display asset');
      const data = (await response.json()) as { url?: string };
      if (requestId !== displayRequestRef.current) return;
      if (!data.url) throw new Error('Missing display asset URL');
      setDisplayAsset({ achievementId, url: data.url });
      setImageState({ achievementId, status: 'ready' });
    } catch {
      if (requestId !== displayRequestRef.current) return;
      setDisplayAsset(null);
      setImageState({ achievementId, status: 'error' });
    }
  }, [achievement.id]);

  useEffect(() => {
    autoRetriedImageRef.current = false;
    void loadDisplayAsset();

    return () => {
      displayRequestRef.current++;
    };
  }, [loadDisplayAsset]);

  useEffect(() => {
    setFullscreenSupported(typeof rootRef.current?.requestFullscreen === 'function');

    const handleFullscreenChange = () => {
      const fullscreenElement = document.fullscreenElement;
      setNativeFullscreen(
        Boolean(
          fullscreenElement &&
            rootRef.current &&
            (fullscreenElement === rootRef.current ||
              rootRef.current.contains(fullscreenElement))
        )
      );
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const changeZoom = (delta: number) => {
    setTransform((previous) =>
      clampViewerTransform(
        { ...previous, zoom: previous.zoom + delta },
        viewport,
        fittedImage
      )
    );
  };

  const resetTransform = () => {
    setTransform({ zoom: 1, x: 0, y: 0 });
  };

  const retryImage = () => {
    autoRetriedImageRef.current = false;
    void loadDisplayAsset();
  };

  const handleImageError = () => {
    if (!autoRetriedImageRef.current) {
      autoRetriedImageRef.current = true;
      void loadDisplayAsset();
      return;
    }

    displayRequestRef.current++;
    setDisplayAsset(null);
    setImageState({ achievementId: achievement.id, status: 'error' });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (transform.zoom <= 1) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    setTransform(
      clampViewerTransform(
        {
          zoom: transform.zoom,
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY,
        },
        viewport,
        fittedImage
      )
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleFullscreen = async () => {
    const root = rootRef.current;
    if (!root) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await root.requestFullscreen();
      }
    } catch {
      // Native fullscreen can be denied; the viewport-filling viewer stays usable.
    }
  };

  const backgroundColor =
    VIEWER_BACKGROUNDS.find((choice) => choice.value === background)?.color ?? '#000000';

  return (
    <div
      ref={rootRef}
      data-artwork-viewer=""
      role="group"
      aria-label={`Artwork viewer: ${achievement.title}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor,
        color: '#f8fafc',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '10px 14px',
          backgroundColor: 'rgba(15, 23, 42, 0.94)',
          borderBottom: '1px solid #334155',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 220px' }}>
          <p
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {achievement.title}
          </p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#94a3b8' }}>
            {navigationPending ? 'Loading the next artwork…' : 'Drag to pan when zoomed'}
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onPrevious}
            disabled={!hasPrevious}
            aria-label="Previous artwork"
            style={toolbarButtonStyle(!hasPrevious)}
          >
            ← Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext}
            aria-label="Next artwork"
            style={toolbarButtonStyle(!hasNext)}
          >
            Next →
          </button>

          <div
            role="group"
            aria-label="Viewer background"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {VIEWER_BACKGROUNDS.map((choice) => {
              const active = choice.value === background;
              return (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => onBackgroundChange(choice.value)}
                  aria-pressed={active}
                  aria-label={`${choice.label} background`}
                  style={{
                    minHeight: 44,
                    padding: '7px 10px',
                    borderRadius: 6,
                    border: active ? '2px solid #60a5fa' : '1px solid #475569',
                    backgroundColor: '#1e293b',
                    color: '#f8fafc',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      backgroundColor: choice.color,
                      border: '1px solid #94a3b8',
                    }}
                  />
                  {choice.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => changeZoom(-ZOOM_STEP)}
            disabled={transform.zoom <= 1}
            aria-label="Zoom out"
            style={toolbarButtonStyle(transform.zoom <= 1)}
          >
            Zoom out
          </button>
          <button
            type="button"
            onClick={() => changeZoom(ZOOM_STEP)}
            disabled={transform.zoom >= 4}
            aria-label="Zoom in"
            style={toolbarButtonStyle(transform.zoom >= 4)}
          >
            Zoom in
          </button>
          <button
            type="button"
            onClick={resetTransform}
            aria-label="Fit artwork"
            style={toolbarButtonStyle()}
          >
            Fit
          </button>

          {fullscreenSupported && (
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              aria-label={nativeFullscreen ? 'Exit full screen' : 'Enter full screen'}
              aria-pressed={nativeFullscreen}
              style={toolbarButtonStyle()}
            >
              {nativeFullscreen ? 'Exit full screen' : 'Full screen'}
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close viewer"
            data-viewer-close=""
            style={{
              ...toolbarButtonStyle(),
              backgroundColor: '#f8fafc',
              color: '#0f172a',
              border: '1px solid #f8fafc',
            }}
          >
            Close viewer
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        data-viewer-viewport=""
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          touchAction: 'none',
          cursor: transform.zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        {currentImageStatus === 'loading' && (
          <p
            role="status"
            style={{
              margin: 0,
              padding: '10px 16px',
              borderRadius: 6,
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              fontSize: 15,
            }}
          >
            Loading artwork…
          </p>
        )}

        {currentImageStatus === 'error' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              padding: 24,
              textAlign: 'center',
              backgroundColor: 'rgba(15, 23, 42, 0.86)',
              borderRadius: 8,
            }}
          >
            <p role="alert" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              Preview unavailable
            </p>
            <p style={{ margin: 0, fontSize: 13, color: '#cbd5e1', maxWidth: 360 }}>
              The display image could not be loaded. Close the viewer to restore the
              artwork, or retry the signed image now.
            </p>
            <button
              type="button"
              onClick={retryImage}
              style={{ ...toolbarButtonStyle(), backgroundColor: '#2563eb', borderColor: '#2563eb' }}
            >
              Retry image
            </button>
          </div>
        )}

        {currentDisplayUrl && currentImageStatus !== 'error' && (
          <img
            className="artwork-viewer-artwork"
            src={currentDisplayUrl}
            alt={achievement.title}
            draggable={false}
            decoding="async"
            onDragStart={(event) => event.preventDefault()}
            onError={handleImageError}
            style={{
              width: fittedImage.width,
              height: fittedImage.height,
              maxWidth: 'none',
              maxHeight: 'none',
              flex: '0 0 auto',
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
              transformOrigin: 'center center',
              transition: dragging ? 'none' : undefined,
              userSelect: 'none',
            }}
          />
        )}

        <p
          aria-live="polite"
          style={{
            position: 'absolute',
            left: 14,
            bottom: 12,
            margin: 0,
            padding: '6px 10px',
            borderRadius: 6,
            backgroundColor: 'rgba(15, 23, 42, 0.78)',
            color: '#e2e8f0',
            fontSize: 12,
          }}
        >
          Zoom {Math.round(transform.zoom * 100)}% · Arrow keys browse
        </p>
      </div>
    </div>
  );
}
