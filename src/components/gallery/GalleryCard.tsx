'use client';

import { useState, useEffect } from 'react';
import { AchievementItem } from './types';

interface GalleryCardProps {
  achievement: AchievementItem;
  onClick: (item: AchievementItem) => void;
}

export function GalleryCard({ achievement, onClick }: GalleryCardProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);

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
    <article
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
      style={{
        backgroundColor: '#fff',
        borderRadius: 8,
        border: '1px solid #e2e8f0',
        overflow: 'hidden',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.08)';
        e.currentTarget.style.borderColor = '#cbd5e1';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.borderColor = '#e2e8f0';
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = '#2563eb';
        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(37, 99, 235, 0.25)';
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = '#e2e8f0';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {/* Thumbnail Aspect Ratio Box */}
      <div
        style={{
          width: '100%',
          aspectRatio: '4 / 3',
          backgroundColor: '#f1f5f9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {imageLoading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#64748b',
              fontSize: '13px',
              backgroundColor: '#f1f5f9',
            }}
          >
            Loading...
          </div>
        )}
        {thumbUrl && !imageFailed && (
          <img
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
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: imageLoading ? 0 : 1,
              transition: 'opacity 0.2s ease',
            }}
          />
        )}
        {!imageLoading && (imageFailed || !thumbUrl) && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              color: '#64748b',
              fontSize: '12px',
              textAlign: 'center',
              padding: '0 16px',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '28px' }}>
              🖼️
            </span>
            <span>Preview unavailable</span>
            <span style={{ fontSize: '11px', color: '#94a3b8' }}>
              Open to restore the image
            </span>
          </div>
        )}
      </div>

      {/* Card Body */}
      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <h3
          style={{
            margin: '0 0 6px 0',
            fontSize: '16px',
            fontWeight: 600,
            color: '#0f172a',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {achievement.title}
        </h3>

        <div style={{ fontSize: '13px', color: '#475569', marginBottom: 10 }}>
          {achievement.completionDate}
        </div>

        {/* Tags preview */}
        {achievement.tags && achievement.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 'auto' }}>
            {achievement.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: '11px',
                  backgroundColor: '#f1f5f9',
                  color: '#475569',
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontWeight: 500,
                }}
              >
                #{tag}
              </span>
            ))}
            {achievement.tags.length > 3 && (
              <span style={{ fontSize: '11px', color: '#475569', alignSelf: 'center' }}>
                +{achievement.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
