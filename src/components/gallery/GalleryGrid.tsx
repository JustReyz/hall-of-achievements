'use client';

import { AchievementItem } from './types';
import { GalleryCard } from './GalleryCard';
import { CONTACT_SHEET_MAX_ITEMS } from '@/lib/image/contact-sheet';

interface GalleryGridProps {
  items: AchievementItem[];
  loading: boolean;
  hasMore: boolean;
  hasActiveFilters: boolean;
  onLoadMore: () => void;
  onSelectAchievement: (item: AchievementItem) => void;
  onOpenAddModal?: () => void;
  selectionMode?: boolean;
  selectedIds?: string[];
  onToggleSelection?: (item: AchievementItem) => void;
}

export function GalleryGrid({
  items,
  loading,
  hasMore,
  hasActiveFilters,
  onLoadMore,
  onSelectAchievement,
  onOpenAddModal,
  selectionMode = false,
  selectedIds = [],
  onToggleSelection,
}: GalleryGridProps) {
  const renderSkeletons = (count: number) => {
    return Array.from({ length: count }).map((_, i) => (
      <div key={`skeleton-${i}`} className="gallery-card-skeleton" aria-hidden="true">
        <div className="gallery-skeleton-media" />
        <div className="gallery-skeleton-caption">
          <div className="gallery-skeleton-line" />
          <div className="gallery-skeleton-line gallery-skeleton-line-short" />
        </div>
      </div>
    ));
  };

  if (!loading && items.length === 0) {
    if (hasActiveFilters) {
      return (
        <div role="status" className="gallery-empty">
          <h3>No matching achievements</h3>
          <p>No artwork matches the current filters. Change your search or clear the dates in Filters.</p>
        </div>
      );
    }

    return (
      <div role="status" className="gallery-empty">
        <h3>Your archive is waiting for your art</h3>
        <p>Record your first completed artwork to build your private collection.</p>
        {onOpenAddModal && (
          <button type="button" className="gallery-button gallery-button-primary" onClick={onOpenAddModal}>
            Add artwork
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div role="region" aria-label="Achievements collection" className="gallery-grid">
        {items.map((item) => (
          <GalleryCard
            key={item.id}
            achievement={item}
            onClick={onSelectAchievement}
            selectable={selectionMode}
            selected={selectedIds.includes(item.id)}
            selectionDisabled={
              selectionMode &&
              selectedIds.length >= CONTACT_SHEET_MAX_ITEMS &&
              !selectedIds.includes(item.id)
            }
            onToggleSelection={onToggleSelection}
          />
        ))}

        {loading && items.length === 0 && renderSkeletons(6)}
      </div>

      {hasMore && (
        <div className="gallery-pagination">
          <button type="button" className="gallery-button" onClick={onLoadMore} disabled={loading}>
            {loading ? 'Loading more artwork...' : 'Load more artwork'}
          </button>
        </div>
      )}
    </div>
  );
}
