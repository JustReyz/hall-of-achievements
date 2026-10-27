'use client';

import { AchievementItem } from './types';
import { GalleryCard } from './GalleryCard';

interface GalleryGridProps {
  items: AchievementItem[];
  loading: boolean;
  hasMore: boolean;
  hasActiveFilters: boolean;
  onLoadMore: () => void;
  onSelectAchievement: (item: AchievementItem) => void;
  onOpenAddModal?: () => void;
}

export function GalleryGrid({
  items,
  loading,
  hasMore,
  hasActiveFilters,
  onLoadMore,
  onSelectAchievement,
  onOpenAddModal,
}: GalleryGridProps) {
  // Skeleton placeholders
  const renderSkeletons = (count: number) => {
    return Array.from({ length: count }).map((_, i) => (
      <div
        key={`skeleton-${i}`}
        aria-hidden="true"
        style={{
          backgroundColor: '#fff',
          borderRadius: 8,
          border: '1px solid #e2e8f0',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          height: 280,
        }}
      >
        <div style={{ width: '100%', height: 180, backgroundColor: '#e2e8f0' }} />
        <div style={{ padding: 14 }}>
          <div style={{ width: '70%', height: 16, backgroundColor: '#e2e8f0', borderRadius: 4, marginBottom: 8 }} />
          <div style={{ width: '40%', height: 12, backgroundColor: '#f1f5f9', borderRadius: 4 }} />
        </div>
      </div>
    ));
  };

  if (!loading && items.length === 0) {
    if (hasActiveFilters) {
      return (
        <div
          role="status"
          style={{
            textAlign: 'center',
            padding: '60px 20px',
            backgroundColor: '#f8fafc',
            borderRadius: 12,
            border: '1px dashed #cbd5e1',
            margin: '20px 0',
          }}
        >
          <div style={{ fontSize: '36px', marginBottom: 12 }}>🔍</div>
          <h3 style={{ margin: '0 0 8px 0', color: '#1e293b', fontSize: '18px' }}>
            No matching achievements
          </h3>
          <p style={{ margin: 0, color: '#64748b', fontSize: '14px' }}>
            No artwork matches the current filters. Change your search or clear the dates.
          </p>
        </div>
      );
    }

    return (
      <div
        role="status"
        style={{
          textAlign: 'center',
          padding: '60px 20px',
          backgroundColor: '#f8fafc',
          borderRadius: 12,
          border: '1px dashed #cbd5e1',
          margin: '20px 0',
        }}
      >
        <div style={{ fontSize: '42px', marginBottom: 12 }}>🖼️</div>
        <h3 style={{ margin: '0 0 8px 0', color: '#1e293b', fontSize: '20px' }}>
          Your archive is waiting for your art
        </h3>
        <p style={{ margin: '0 0 20px 0', color: '#64748b', fontSize: '14px' }}>
          Record your first completed masterpiece to build your private collection.
        </p>
        {onOpenAddModal && (
          <button
            type="button"
            onClick={onOpenAddModal}
            style={{
              padding: '10px 20px',
              backgroundColor: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            + Add Achievement
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div
        role="region"
        aria-label="Achievements collection"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '20px',
        }}
      >
        {items.map((item) => (
          <GalleryCard
            key={item.id}
            achievement={item}
            onClick={onSelectAchievement}
          />
        ))}

        {loading && items.length === 0 && renderSkeletons(8)}
      </div>

      {/* Pagination Controls */}
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 32, marginBottom: 40 }}>
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            style={{
              padding: '12px 28px',
              backgroundColor: '#fff',
              color: '#1e293b',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: '15px',
              cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Loading more artwork...' : 'Load More Artwork'}
          </button>
        </div>
      )}
    </div>
  );
}
