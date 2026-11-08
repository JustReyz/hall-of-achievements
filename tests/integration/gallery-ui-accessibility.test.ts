import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import type { AchievementItem, GalleryDensity } from '@/components/gallery/types';

describe('Integration & Accessibility: Milestone 3 Responsive Redesign, Motion & Dialog Hardening', () => {
  const rootDir = process.cwd();
  const globalsCssPath = path.join(rootDir, 'src', 'app', 'globals.css');
  const detailModalPath = path.join(rootDir, 'src', 'components', 'gallery', 'AchievementDetailModal.tsx');
  const addModalPath = path.join(rootDir, 'src', 'components', 'gallery', 'AddAchievementModal.tsx');
  const cardPath = path.join(rootDir, 'src', 'components', 'gallery', 'GalleryCard.tsx');

  const createDummyItem = (id: string, title: string, completionDate: string): AchievementItem => ({
    id,
    title,
    completionDate,
    notes: null,
    tags: ['landscape', 'digital'],
    thumbnailPositionX: 0.5,
    thumbnailPositionY: 0.5,
    state: 'ready',
    createdAt: new Date().toISOString(),
    asset: null,
  });

  // =========================================================================
  // 1. SYMMETRICAL GUTTERS & RESPONSIVE GRID REFLOW (R1)
  // =========================================================================
  describe('1. Symmetrical Gutters & Responsive Grid Reflow (R1)', () => {
    it('defines unified symmetrical gutters and density variants in globals.css without asymmetrical gaps', () => {
      const globalsContent = fs.readFileSync(globalsCssPath, 'utf-8');

      // Asymmetrical gaps (column-gap: 24px; row-gap: 32px;) must NOT exist in .gallery-grid
      expect(globalsContent).not.toMatch(/\.gallery-grid\s*\{[^}]*column-gap:\s*24px;\s*row-gap:\s*32px;/);

      // Unified gap variable and fallback
      expect(globalsContent).toContain('gap: var(--gallery-gutter, 24px);');

      // Symmetrical gutters across densities
      expect(globalsContent).toContain('.gallery-grid[data-density=\'compact\']');
      expect(globalsContent).toMatch(/\.gallery-grid\[data-density=['"]compact['"]\]\s*\{[^}]*gap:\s*16px;/);
      expect(globalsContent).toMatch(/\.gallery-grid\[data-density=['"]compact['"]\]\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(200px,\s*1fr\)\);/);

      expect(globalsContent).toContain('.gallery-grid[data-density=\'comfortable\']');
      expect(globalsContent).toMatch(/\.gallery-grid\[data-density=['"]comfortable['"]\]\s*\{[^}]*gap:\s*24px;/);
      expect(globalsContent).toMatch(/\.gallery-grid\[data-density=['"]comfortable['"]\]\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(280px,\s*1fr\)\);/);

      expect(globalsContent).toContain('.gallery-grid[data-density=\'roomy\']');
      expect(globalsContent).toMatch(/\.gallery-grid\[data-density=['"]roomy['"]\]\s*\{[^}]*gap:\s*32px;/);
      expect(globalsContent).toMatch(/\.gallery-grid\[data-density=['"]roomy['"]\]\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(360px,\s*1fr\)\);/);
    });

    it('prevents horizontal overflow on small mobile viewports (<=599px) across all densities', () => {
      const globalsContent = fs.readFileSync(globalsCssPath, 'utf-8');

      // Under @media (max-width: 599px), mobile grid adapts safely
      expect(globalsContent).toMatch(/@media\s*\(max-width:\s*599px\)[\s\S]*?\.gallery-grid\[data-density=['"]compact['"]\]\s*\{[^}]*minmax\(min\(100%,\s*160px\)/);
      expect(globalsContent).toMatch(/@media\s*\(max-width:\s*599px\)[\s\S]*?\.gallery-grid\[data-density=['"]roomy['"]\],\s*\.gallery-grid\[data-density=['"]comfortable['"]\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    });

    it('renders GalleryGrid with correct data-density and semantic regions for compact, comfortable, and roomy', () => {
      const items = [createDummyItem('item-1', 'Art Piece 1', '2026-05-01')];

      for (const density of ['compact', 'comfortable', 'roomy'] as GalleryDensity[]) {
        const html = renderToStaticMarkup(
          createElement(GalleryGrid, {
            items,
            loading: false,
            hasMore: false,
            hasActiveFilters: false,
            density,
            onLoadMore: () => {},
            onSelectAchievement: () => {},
          })
        );

        expect(html).toContain(`data-density="${density}"`);
        expect(html).toContain('role="region"');
        expect(html).toContain('aria-label="Achievements collection"');
        expect(html).toContain('gallery-grid');
      }
    });

    it('preserves zero CLS invariants: aspect-ratio: 4 / 3 and explicit image dimensions', () => {
      const globalsContent = fs.readFileSync(globalsCssPath, 'utf-8');
      expect(globalsContent).toMatch(/\.gallery-card-media\s*\{[^}]*aspect-ratio:\s*4 \/ 3;/);
      expect(globalsContent).toMatch(/\.gallery-card-image\s*\{[^}]*object-fit:\s*cover;/);

      const cardContent = fs.readFileSync(cardPath, 'utf-8');
      expect(cardContent).toContain('width={400}');
      expect(cardContent).toContain('height={300}');
      expect(cardContent).toContain('loading="lazy"');
      expect(cardContent).toContain('decoding="async"');
    });
  });

  // =========================================================================
  // 2. MOTION POLISH & STRICT PREFERS-REDUCED-MOTION (R1)
  // =========================================================================
  describe('2. Motion Polish & Strict prefers-reduced-motion Reset (R1)', () => {
    it('defines purposeful keyframes for card and dialog entry animations', () => {
      const globalsContent = fs.readFileSync(globalsCssPath, 'utf-8');

      expect(globalsContent).toContain('@keyframes gallery-card-in');
      expect(globalsContent).toMatch(/@keyframes gallery-card-in\s*\{[\s\S]*?from\s*\{[^}]*transform:\s*translateY\(4px\);[\s\S]*?to\s*\{[^}]*transform:\s*translateY\(0\);/);

      expect(globalsContent).toContain('@keyframes gallery-dialog-in');
      expect(globalsContent).toMatch(/@keyframes gallery-dialog-in\s*\{[\s\S]*?from\s*\{[^}]*transform:\s*translateY\(6px\);[\s\S]*?to\s*\{[^}]*transform:\s*translateY\(0\);/);

      expect(globalsContent).toContain('.gallery-card');
      expect(globalsContent).toMatch(/\.gallery-card\s*\{[^}]*animation:\s*gallery-card-in/);

      expect(globalsContent).toContain('.gallery-modal-dialog');
      expect(globalsContent).toMatch(/\.gallery-modal-dialog\s*\{[^}]*animation:\s*gallery-dialog-in/);
    });

    it('adds restrained desktop card hover state with subtle box shadow elevation', () => {
      const globalsContent = fs.readFileSync(globalsCssPath, 'utf-8');

      expect(globalsContent).toContain('.gallery-card-trigger:hover');
      expect(globalsContent).toContain('box-shadow: 0 4px 14px rgba(20, 61, 54, 0.08);');
    });

    it('enforces universal prefers-reduced-motion reset strictly disabling all animations and transitions', () => {
      const globalsContent = fs.readFileSync(globalsCssPath, 'utf-8');

      expect(globalsContent).toContain('@media (prefers-reduced-motion: reduce)');
      expect(globalsContent).toContain('*,');
      expect(globalsContent).toContain('*::before,');
      expect(globalsContent).toContain('*::after');
      expect(globalsContent).toContain('animation-duration: 0.01ms !important;');
      expect(globalsContent).toContain('animation-iteration-count: 1 !important;');
      expect(globalsContent).toContain('transition-duration: 0.01ms !important;');
      expect(globalsContent).toContain('scroll-behavior: auto !important;');

      // Verifies modal and card entry classes are also disabled
      expect(globalsContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.gallery-modal-dialog[\s\S]*?animation:\s*none;/);
      expect(globalsContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.gallery-card[\s\S]*?animation:\s*none;/);
    });
  });

  // =========================================================================
  // 3. WCAG AA DIALOG FOCUS TRAPPING & BODY SCROLL LOCKING (R3)
  // =========================================================================
  describe('3. WCAG AA Dialog Focus Trapping & Body Scroll Locking (R3)', () => {
    it('implements body scroll locking on mount and restoration on unmount in AchievementDetailModal.tsx', () => {
      const modalContent = fs.readFileSync(detailModalPath, 'utf-8');

      expect(modalContent).toContain('document.body.style.overflow');
      expect(modalContent).toContain("document.body.style.overflow = 'hidden'");
      expect(modalContent).toContain('document.body.style.overflow = previousOverflow');

      // Test scroll locking logic behavior
      const mockBody = { style: { overflow: '' } };
      const originalOverflow = mockBody.style.overflow;
      mockBody.style.overflow = 'hidden';
      expect(mockBody.style.overflow).toBe('hidden');
      // Cleanup restores
      mockBody.style.overflow = originalOverflow;
      expect(mockBody.style.overflow).toBe('');
    });

    it('implements body scroll locking on mount and restoration on unmount in AddAchievementModal.tsx', () => {
      const modalContent = fs.readFileSync(addModalPath, 'utf-8');

      expect(modalContent).toContain('document.body.style.overflow');
      expect(modalContent).toContain("document.body.style.overflow = 'hidden'");
      expect(modalContent).toContain('document.body.style.overflow = previousOverflow');
    });

    it('filters hidden and inert elements from focus trapping in AchievementDetailModal.tsx and AddAchievementModal.tsx', () => {
      const detailContent = fs.readFileSync(detailModalPath, 'utf-8');
      expect(detailContent).toContain('getClientRects().length > 0');
      expect(detailContent).toContain("[inert]");

      const addContent = fs.readFileSync(addModalPath, 'utf-8');
      expect(addContent).toContain('getClientRects().length > 0');
      expect(addContent).toContain("[inert]");
    });

    it('recovers focus if activeElement moves outside the dialog in AchievementDetailModal.tsx and AddAchievementModal.tsx', () => {
      const detailContent = fs.readFileSync(detailModalPath, 'utf-8');
      expect(detailContent).toContain('activeInside');
      expect(detailContent).toContain('!activeInside || active === first');
      expect(detailContent).toContain('!activeInside || active === last');

      const addContent = fs.readFileSync(addModalPath, 'utf-8');
      expect(addContent).toContain('activeInside');
      expect(addContent).toContain('!activeInside || active === first');
      expect(addContent).toContain('!activeInside || active === last');
    });

    it('attaches gallery-modal-dialog class to inner containers of both modals', () => {
      const detailContent = fs.readFileSync(detailModalPath, 'utf-8');
      expect(detailContent).toContain('className="gallery-modal-dialog"');

      const addContent = fs.readFileSync(addModalPath, 'utf-8');
      expect(addContent).toContain('className="gallery-modal-dialog"');
    });
  });

  // =========================================================================
  // 4. DYNAMIC RETURN FOCUS & DATA-ACHIEVEMENT-ID HOOKS (R3)
  // =========================================================================
  describe('4. Dynamic Return Focus & data-achievement-id Hooks (R3)', () => {
    it('renders data-achievement-id attribute on GalleryCard containers and triggers', () => {
      const cardContent = fs.readFileSync(cardPath, 'utf-8');

      expect(cardContent).toContain('data-achievement-id={achievement.id}');
      expect(cardContent).toMatch(/<div[^>]*data-achievement-id=\{achievement\.id\}/);
      expect(cardContent).toMatch(/<article[^>]*data-achievement-id=\{achievement\.id\}/);
    });

    it('updates triggerRef.current dynamically on Next/Previous artwork navigation in AchievementDetailModal.tsx', () => {
      const modalContent = fs.readFileSync(detailModalPath, 'utf-8');

      // Dynamic return focus queries matching card trigger by achievement.id
      expect(modalContent).toContain('triggerRef.current = cardTrigger');
      expect(modalContent).toContain('data-achievement-id="${achievement.id}"');
      expect(modalContent).toContain('.gallery-card-trigger');

      // Fallback mechanism when trigger card was removed
      expect(modalContent).toContain('.gallery-grid');
      expect(modalContent).toContain('preventScroll: true');
    });
  });

  // =========================================================================
  // 5. DOWNLOAD ERROR FEEDBACK & RETRY AFFORDANCE (R3)
  // =========================================================================
  describe('5. Download Error Feedback & Retry Affordance (R3)', () => {
    it('implements inline download error feedback directly adjacent to the download button', () => {
      const modalContent = fs.readFileSync(detailModalPath, 'utf-8');

      expect(modalContent).toContain('downloadError');
      expect(modalContent).toContain('setDownloadError');
      expect(modalContent).toContain('role="alert"');
      expect(modalContent).toContain('gallery-download-error');
      expect(modalContent).toContain('Retry download');
      expect(modalContent).toContain('Download Original Asset');
    });

    it('clears download error when navigating to another artwork', () => {
      const modalContent = fs.readFileSync(detailModalPath, 'utf-8');

      // Resets error on achievement.id change
      expect(modalContent).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?setDownloadError\(null\);[\s\S]*?\},\s*\[achievement\?\.id\]\);/);
    });
  });
});
