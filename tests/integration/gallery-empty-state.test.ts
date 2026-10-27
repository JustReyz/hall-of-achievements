import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';

describe('gallery empty state', () => {
  it.each([true, false])('renders the correct empty state when filters are %s', (hasActiveFilters) => {
    const html = renderToStaticMarkup(
      createElement(GalleryGrid, {
        items: [],
        loading: false,
        hasMore: false,
        hasActiveFilters,
        onLoadMore: () => {},
        onSelectAchievement: () => {},
      })
    );
    expect(html).toContain(
      hasActiveFilters ? 'No matching achievements' : 'Your archive is waiting for your art'
    );
    expect(html).not.toContain(
      hasActiveFilters ? 'Your archive is waiting for your art' : 'No matching achievements'
    );
  });
});
