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

  useEffect(() => {
    let isCancelled = false;
    setImageLoading(true);

    async function loadThumb() {
      try {
        const res = await fetch(`/api/achievements/${achievement.id}/assets?type=thumbnail`);
        if (res.ok) {
          const data = (await res.json()) as { url?: string };
          if (!isCancelled && data.url) {
            setThumbUrl(data.url);
          }
        }
      } catch {
        // Thumbnail load error
      } finally {
        if (!isCancelled) setImageLoading(false);
      }
    }

    void loadThumb();

    return () => {
      isCancelled = true;
    };
  }, [achievement.id]);

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
          <div style={{ color: '#475569', fontSize: '13px' }}>Loading...</div>
        )}
        {!imageLoading && thumbUrl && (
          <img
            src={thumbUrl}
            alt={achievement.title}
            loading="lazy"
            decoding="async"
            width={400}
            height={300}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        )}
        {!imageLoading && !thumbUrl && (
          <div style={{ color: '#475569', fontSize: '28px' }}>🎨</div>
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
