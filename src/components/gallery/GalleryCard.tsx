'use client';

import { useState, useEffect } from 'react';
import { AchievementItem } from './types';

interface GalleryCardProps {
  achievement: AchievementItem;
  onClick: (item: AchievementItem) => void;
  selectable?: boolean;
  selected?: boolean;
  selectionDisabled?: boolean;
  onToggleSelection?: ((item: AchievementItem) => void) | undefined;
}

export function GalleryCard({
  achievement,
  onClick,
  selectable = false,
  selected = false,
  selectionDisabled = false,
  onToggleSelection,
}: GalleryCardProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);
  const thumbnailPositionX = Number.isFinite(achievement.thumbnailPositionX)
    ? achievement.thumbnailPositionX
    : 0.5;
  const thumbnailPositionY = Number.isFinite(achievement.thumbnailPositionY)
    ? achievement.thumbnailPositionY
    : 0.5;

  // Re-resolve the signed URL whenever the artwork changes (for example after a
  // missing image is restored from the detail modal).
  useEffect(() => {
    let isCancelled = false;

    setThumbUrl(null);
    setImageFailed(false);
    setImageLoading(true);

    async function loadThumb() {
      try {
        const res = await fetch(`/api/achievements/${achievement.id}/assets?type=thumbnail`);
        if (res.ok) {
          const data = (await res.json()) as { url?: string };
          if (!isCancelled && data.url) {
            setThumbUrl(data.url);
            return;
          }
        }
        if (!isCancelled) {
          setImageFailed(true);
          setImageLoading(false);
        }
      } catch {
        if (!isCancelled) {
          setImageFailed(true);
          setImageLoading(false);
        }
      }
    }

    void loadThumb();

    return () => {
      isCancelled = true;
    };
  }, [achievement.id, achievement.updatedAt]);

  return (
    <div className="gallery-card" data-selected={selected ? 'true' : 'false'}>
      {selectable && (
        <label
          className="gallery-card-select"
          title={
            selectionDisabled
              ? 'A contact sheet can include up to 24 artworks.'
              : `Select ${achievement.title} for the contact sheet`
          }
        >
          <input
            type="checkbox"
            checked={selected}
            disabled={selectionDisabled}
            onChange={() => onToggleSelection?.(achievement)}
            aria-label={`Select ${achievement.title} for the contact sheet`}
          />
        </label>
      )}

      <article
        className="gallery-card-trigger"
        tabIndex={0}
        role="button"
        aria-label={`View achievement: ${achievement.title}, completed ${achievement.completionDate}`}
        onClick={() => onClick(achievement)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick(achievement);
          }
        }}
      >
        <div className="gallery-card-media">
          {imageLoading && (
            <div className="gallery-card-state" aria-hidden="true">
              Loading preview...
            </div>
          )}
          {thumbUrl && !imageFailed && (
            <img
              className="gallery-card-image"
              src={thumbUrl}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              width={400}
              height={300}
              onLoad={() => setImageLoading(false)}
              onError={() => {
                // A broken <img> would render the browser's broken-image glyph and
                // the alt text across the card. Drop it and show our own state.
                setThumbUrl(null);
                setImageFailed(true);
                setImageLoading(false);
              }}
              style={{
                objectPosition: `${thumbnailPositionX * 100}% ${thumbnailPositionY * 100}%`,
                opacity: imageLoading ? 0 : 1,
              }}
            />
          )}
          {!imageLoading && (imageFailed || !thumbUrl) && (
            <div className="gallery-card-state">
              <span className="gallery-card-state-title">Preview unavailable</span>
              <span>Open to restore the image</span>
            </div>
          )}
        </div>

        <div className="gallery-card-caption">
          <h3 className="gallery-card-title">{achievement.title}</h3>
          <time className="gallery-card-date" dateTime={achievement.completionDate}>
            {achievement.completionDate}
          </time>
        </div>
      </article>
    </div>
  );
}
