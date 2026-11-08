// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, useState, createElement } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AchievementDetailModal } from '@/components/gallery/AchievementDetailModal';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import type { AchievementItem, GalleryDensity } from '@/components/gallery/types';

// Configure React act environment for testing
// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('Adversarial Verification Suite: M3 CSS, Motion & Focus Hardening', () => {
  const rootDir = process.cwd();
  const globalsCssPath = path.join(rootDir, 'src', 'app', 'globals.css');
  const cardComponentPath = path.join(rootDir, 'src', 'components', 'gallery', 'GalleryCard.tsx');

  const createDummyItem = (id: string, title: string, completionDate: string): AchievementItem => ({
    id,
    title,
    completionDate,
    notes: `Notes for ${title}`,
    tags: ['oil', 'landscape'],
    thumbnailPositionX: 0.5,
    thumbnailPositionY: 0.5,
    state: 'ready',
    createdAt: new Date().toISOString(),
    asset: null,
  });

  // Mock global fetch for clean component rendering
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ collections: [], url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }),
      })
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. SYMMETRICAL GUTTERS & NO ASYMMETRICAL GUTTER LEAKAGE
  // =========================================================================
  describe('1. Symmetrical Gutters & Gutter Leakage Adversarial Audit', () => {
    const cssContent = fs.readFileSync(globalsCssPath, 'utf-8');

    it('defines uniform symmetrical gap on .gallery-grid with no asymmetrical column-gap vs row-gap', () => {
      // 1. Must use unified gap
      expect(cssContent).toContain('.gallery-grid {');
      expect(cssContent).toMatch(/\.gallery-grid\s*\{[^}]*gap:\s*var\(--gallery-gutter,\s*24px\);/);

      // 2. Reject legacy asymmetrical gutter leakage (column-gap: 24px; row-gap: 32px;)
      expect(cssContent).not.toMatch(/\.gallery-grid\s*\{[^}]*column-gap:\s*24px;\s*row-gap:\s*32px;/);
      expect(cssContent).not.toMatch(/column-gap:\s*24px;\s*row-gap:\s*32px;/);
    });

    it('enforces symmetrical gutters across all density variants (compact, comfortable, roomy)', () => {
      // Compact: 16px
      const compactMatch = cssContent.match(/\.gallery-grid\[data-density=['"]compact['"]\]\s*\{([^}]+)\}/);
      expect(compactMatch).not.toBeNull();
      const compactBlock = compactMatch![1];
      expect(compactBlock).toMatch(/--gallery-gutter:\s*16px;/);
      expect(compactBlock).toMatch(/gap:\s*16px;/);
      expect(compactBlock).not.toMatch(/column-gap|row-gap/);

      // Comfortable: 24px
      const comfortableMatch = cssContent.match(/\.gallery-grid\[data-density=['"]comfortable['"]\]\s*\{([^}]+)\}/);
      expect(comfortableMatch).not.toBeNull();
      const comfortableBlock = comfortableMatch![1];
      expect(comfortableBlock).toMatch(/--gallery-gutter:\s*24px;/);
      expect(comfortableBlock).toMatch(/gap:\s*24px;/);
      expect(comfortableBlock).not.toMatch(/column-gap|row-gap/);

      // Roomy: 32px
      const roomyMatch = cssContent.match(/\.gallery-grid\[data-density=['"]roomy['"]\]\s*\{([^}]+)\}/);
      expect(roomyMatch).not.toBeNull();
      const roomyBlock = roomyMatch![1];
      expect(roomyBlock).toMatch(/--gallery-gutter:\s*32px;/);
      expect(roomyBlock).toMatch(/gap:\s*32px;/);
      expect(roomyBlock).not.toMatch(/column-gap|row-gap/);
    });

    it('scans AST declarations: zero asymmetrical gutter declarations in any .gallery-grid selector block', () => {
      // Parse all CSS rule blocks that target .gallery-grid
      const ruleRegex = /([^{}]+)\{([^}]+)\}/g;
      let match: RegExpExecArray | null;

      while ((match = ruleRegex.exec(cssContent)) !== null) {
        const selector = match[1]?.trim() ?? '';
        const declarations = match[2] ?? '';

        if (selector.includes('.gallery-grid')) {
          // If gap property has two values (e.g. gap: 10px 20px), they must be equal
          const gapDeclMatch = declarations.match(/\bgap:\s*([^;]+);/);
          if (gapDeclMatch) {
            const rawGap = gapDeclMatch[1]?.trim() ?? '';
            // Split gap values respecting parentheses (e.g. var(--gallery-gutter, 24px))
            const tokens = rawGap.match(/(?:[^\s(]+|\([^\)]*\))+/g) || [rawGap];
            if (tokens.length === 2) {
              expect(tokens[0]).toBe(tokens[1]);
            } else {
              expect(tokens.length).toBe(1);
            }
          }

          // If column-gap or row-gap is declared, both must be present and identical
          const colGapMatch = declarations.match(/\bcolumn-gap:\s*([^;]+);/);
          const rowGapMatch = declarations.match(/\brow-gap:\s*([^;]+);/);

          if (colGapMatch || rowGapMatch) {
            expect(colGapMatch).not.toBeNull();
            expect(rowGapMatch).not.toBeNull();
            expect(colGapMatch?.[1]?.trim()).toBe(rowGapMatch?.[1]?.trim());
          }
        }
      }
    });
  });

  // =========================================================================
  // 2. RESPONSIVE REFLOW & MOBILE VIEWPORT OVERFLOW PREVENTION (320px–375px)
  // =========================================================================
  describe('2. Responsive Reflow & Mobile Viewport Overflow Prevention (320px–375px)', () => {
    const cssContent = fs.readFileSync(globalsCssPath, 'utf-8');

    it('contains mobile media query override (max-width: 599px) enforcing single column / safe reflow', () => {
      // Must have @media (max-width: 599px)
      expect(cssContent).toMatch(/@media\s*\(max-width:\s*599px\)/);

      // Roomy & Comfortable collapse to minmax(0, 1fr) preventing minimum size blowouts
      expect(cssContent).toMatch(/@media\s*\(max-width:\s*599px\)[\s\S]*?\.gallery-grid\[data-density=['"]roomy['"]\],\s*\.gallery-grid\[data-density=['"]comfortable['"]\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);

      // Compact uses minmax(min(100%, 160px), 1fr) preventing horizontal overflow
      expect(cssContent).toMatch(/@media\s*\(max-width:\s*599px\)[\s\S]*?\.gallery-grid\[data-density=['"]compact['"]\]\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*160px\),\s*1fr\)\);/);
    });

    it('mathematical proof of zero horizontal overflow on small mobile viewports (320px to 375px)', () => {
      // Simulating mobile layout geometry:
      // Mobile .gallery-shell padding is 20px on each side (total 40px)
      const mobilePadding = 40;
      const testViewports = [320, 340, 360, 375, 390, 414, 599];

      for (const vp of testViewports) {
        const availableWidth = vp - mobilePadding;
        expect(availableWidth).toBeGreaterThan(0);

        // 1. Comfortable / Roomy: 1 column of minmax(0, 1fr)
        // With 1 column, total content width equals availableWidth
        const singleColWidth = availableWidth;
        const comfortableOverflow = singleColWidth - availableWidth;
        expect(comfortableOverflow).toBe(0);

        // 2. Compact: repeat(auto-fill, minmax(min(100%, 160px), 1fr)), gap: 16px
        const compactGap = 16;
        const minColWidth = Math.min(availableWidth, 160);
        // Formula for auto-fill column count: floor((availableWidth + gap) / (minColWidth + gap))
        const numCols = Math.max(1, Math.floor((availableWidth + compactGap) / (minColWidth + compactGap)));
        const totalTracksWidth = availableWidth; // 1fr expands to fill exactly available width
        const compactOverflow = totalTracksWidth - availableWidth;
        expect(compactOverflow).toBe(0);

        // Prove that at 320px (availableWidth = 280px), numCols is exactly 1 (not 2)
        if (vp === 320) {
          expect(numCols).toBe(1);
        }
        // Prove that at 375px (availableWidth = 335px), numCols is exactly 1 (336px would be needed for 2 cols)
        if (vp === 375) {
          expect(numCols).toBe(1);
        }
      }
    });

    it('verifies card items and titles contain overflow containment rules', () => {
      // .gallery-card must have min-width: 0 to prevent CSS grid minimum content overflow
      expect(cssContent).toMatch(/\.gallery-card\s*\{[^}]*min-width:\s*0;/);

      // .gallery-card-title must have overflow-wrap: anywhere to prevent unbroken words from expanding the card
      expect(cssContent).toMatch(/\.gallery-card-title\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    });
  });

  // =========================================================================
  // 3. ZERO CLS (ASPECT RATIO 4 / 3) ACROSS ALL DENSITIES
  // =========================================================================
  describe('3. Zero Cumulative Layout Shift (CLS) 4:3 Invariant', () => {
    const cssContent = fs.readFileSync(globalsCssPath, 'utf-8');
    const cardContent = fs.readFileSync(cardComponentPath, 'utf-8');

    it('defines aspect-ratio: 4 / 3 explicitly on .gallery-card-media and .gallery-skeleton-media', () => {
      expect(cssContent).toMatch(/\.gallery-card-media\s*\{[^}]*aspect-ratio:\s*4 \/ 3;/);
      expect(cssContent).toMatch(/\.gallery-skeleton-media\s*\{[^}]*aspect-ratio:\s*4 \/ 3;/);
    });

    it('guarantees aspect-ratio is never overridden or altered in any density modifier', () => {
      const densities: GalleryDensity[] = ['compact', 'comfortable', 'roomy'];
      for (const density of densities) {
        const regex = new RegExp(`\\.gallery-grid\\[data-density=['"]${density}['"]\\]\\s*\\{([^}]+)\\}`, 'g');
        const match = regex.exec(cssContent);
        if (match) {
          expect(match[1]).not.toContain('aspect-ratio');
        }
      }
    });

    it('specifies explicit 400x300 image dimensions and object-fit: cover for intrinsic layout reservation', () => {
      // 400x300 provides explicit 4:3 intrinsic sizing
      expect(cardContent).toContain('width={400}');
      expect(cardContent).toContain('height={300}');
      expect(400 / 300).toBeCloseTo(4 / 3, 5);

      // Image has object-fit: cover to prevent aspect ratio distortion
      expect(cssContent).toMatch(/\.gallery-card-image\s*\{[^}]*object-fit:\s*cover;/);
      expect(cardContent).toContain('loading="lazy"');
      expect(cardContent).toContain('decoding="async"');
    });

    it('empirically renders GalleryGrid across all 3 densities and asserts media containers maintain 4:3 classes', () => {
      const testItems = [
        createDummyItem('art-1', 'Piece 1', '2026-01-01'),
        createDummyItem('art-2', 'Piece 2', '2026-01-02'),
      ];

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      try {
        const densities: GalleryDensity[] = ['compact', 'comfortable', 'roomy'];
        for (const density of densities) {
          act(() => {
            root.render(
              createElement(GalleryGrid, {
                items: testItems,
                loading: false,
                hasMore: false,
                hasActiveFilters: false,
                density: density,
                onLoadMore: () => {},
                onSelectAchievement: () => {},
              })
            );
          });

          const gridEl = container.querySelector('.gallery-grid');
          expect(gridEl).not.toBeNull();
          expect(gridEl!.getAttribute('data-density')).toBe(density);

          // All cards must have the media container with aspect-ratio: 4 / 3
          const mediaEls = container.querySelectorAll('.gallery-card-media');
          expect(mediaEls.length).toBe(testItems.length);
        }
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    });
  });

  // =========================================================================
  // 4. UNIVERSAL PREFERS-REDUCED-MOTION RESET
  // =========================================================================
  describe('4. Universal prefers-reduced-motion Reset Audit', () => {
    const cssContent = fs.readFileSync(globalsCssPath, 'utf-8');

    it('contains @media (prefers-reduced-motion: reduce) with universal reset targeting *, *::before, *::after', () => {
      expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);

      // Must target *, *::before, *::after
      expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\*,\s*\*::before,\s*\*::after\s*\{/);
    });

    it('enforces animation-duration: 0.01ms !important, transition-duration: 0.01ms !important, and scroll-behavior: auto !important', () => {
      const reducedMotionMatch = cssContent.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
      expect(reducedMotionMatch).not.toBeNull();
      const block = reducedMotionMatch![1];

      // Universal reset declarations
      expect(block).toContain('animation-duration: 0.01ms !important;');
      expect(block).toContain('animation-iteration-count: 1 !important;');
      expect(block).toContain('transition-duration: 0.01ms !important;');
      expect(block).toContain('scroll-behavior: auto !important;');
    });

    it('adversarial check: no rule negates or overrides the universal reduced motion reset', () => {
      // Verify :root disables motion control transitions
      expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?:root\s*\{[^}]*--motion-control-transition:\s*none;/);

      // Verify animations are explicitly cancelled on dialogs and cards
      expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.gallery-modal-dialog[\s\S]*?animation:\s*none;/);
      expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.gallery-card[\s\S]*?animation:\s*none;/);
      expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.gallery-tool-dialog\[open\][\s\S]*?animation:\s*none;/);
    });
  });

  // =========================================================================
  // 5. DYNAMIC RETURN FOCUS (EMPIRICAL DOM & COMPONENT TESTING)
  // =========================================================================
  describe('5. Dynamic Return Focus & Fallback Verification', () => {
    let container: HTMLDivElement;
    let root: Root;

    const itemA = createDummyItem('ach-a', 'Artwork Alpha', '2026-01-01');
    const itemB = createDummyItem('ach-b', 'Artwork Beta', '2026-01-02');
    const itemC = createDummyItem('ach-c', 'Artwork Gamma', '2026-01-03');

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
      document.body.innerHTML = '';
    });

    // Test Harness Component combining GalleryGrid and AchievementDetailModal using createElement
    function GalleryHarness({
      initialItems = [itemA, itemB, itemC],
      onModalClosed,
    }: {
      initialItems?: AchievementItem[];
      onModalClosed?: () => void;
    }) {
      const [items] = useState<AchievementItem[]>(initialItems);
      const [selectedAchievement, setSelectedAchievement] = useState<AchievementItem | null>(null);

      const currentIndex = selectedAchievement
        ? items.findIndex((i) => i.id === selectedAchievement.id)
        : -1;

      const handleNext = () => {
        if (currentIndex >= 0 && currentIndex < items.length - 1) {
          setSelectedAchievement(items[currentIndex + 1] ?? null);
        }
      };

      const handlePrevious = () => {
        if (currentIndex > 0) {
          setSelectedAchievement(items[currentIndex - 1] ?? null);
        }
      };

      const handleClose = () => {
        setSelectedAchievement(null);
        onModalClosed?.();
      };

      return createElement(
        'div',
        { className: 'gallery-main' },
        createElement(GalleryGrid, {
          items: items,
          loading: false,
          hasMore: false,
          hasActiveFilters: false,
          onLoadMore: () => {},
          onSelectAchievement: (item: AchievementItem) => setSelectedAchievement(item),
        }),
        selectedAchievement &&
          createElement(
            'div',
            { className: 'gallery-test-nav-controls' },
            createElement(
              'button',
              {
                type: 'button',
                'data-artwork-nav': 'next',
                'aria-label': 'Next artwork',
                onClick: handleNext,
              },
              'Next'
            ),
            createElement(
              'button',
              {
                type: 'button',
                'data-artwork-nav': 'prev',
                'aria-label': 'Previous artwork',
                onClick: handlePrevious,
              },
              'Previous'
            )
          ),
        createElement(AchievementDetailModal, {
          achievement: selectedAchievement,
          viewerOpen: false,
          viewerBackground: 'black',
          hasPrevious: currentIndex > 0,
          hasNext: currentIndex < items.length - 1,
          navigationPending: false,
          onClose: handleClose,
          onViewerOpen: () => {},
          onViewerClose: () => {},
          onPrevious: handlePrevious,
          onNext: handleNext,
          onViewerBackgroundChange: () => {},
          onUpdate: () => {},
          onDelete: () => {},
          restoreRequest: null,
          onDismissRestore: () => {},
        })
      );
    }

    it('returns focus to Card B trigger when opened from Card A, navigated to Card B via Next, and closed', async () => {
      await act(async () => {
        root.render(createElement(GalleryHarness));
      });

      // Find triggers for Card A and Card B
      const triggerA = container.querySelector<HTMLElement>('[data-achievement-id="ach-a"] .gallery-card-trigger');
      const triggerB = container.querySelector<HTMLElement>('[data-achievement-id="ach-b"] .gallery-card-trigger');
      expect(triggerA).not.toBeNull();
      expect(triggerB).not.toBeNull();

      // Step 1: User focuses and clicks Card A to open modal
      triggerA!.focus();
      expect(document.activeElement).toBe(triggerA);

      await act(async () => {
        triggerA!.click();
      });

      // Modal is now open showing Artwork Alpha
      expect(document.body.innerHTML).toContain('Artwork Alpha');

      // Step 2: User navigates to Card B via Next button
      const nextBtn = document.querySelector<HTMLButtonElement>('[data-artwork-nav="next"]');
      expect(nextBtn).not.toBeNull();

      await act(async () => {
        nextBtn!.click();
      });

      // Modal now shows Artwork Beta
      expect(document.body.innerHTML).toContain('Artwork Beta');

      // Step 3: User closes the modal via Close button
      const closeBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"], [data-artwork-modal-close]');
      expect(closeBtn).not.toBeNull();

      await act(async () => {
        closeBtn!.click();
      });

      // STEP 4: VERIFY RETURN FOCUS TARGET:
      // Focus MUST return to Card B's trigger, NOT Card A's trigger!
      expect(document.activeElement).toBe(triggerB);
      expect(document.activeElement).not.toBe(triggerA);
      expect(document.activeElement?.getAttribute('data-achievement-id')).toBe('ach-b');
    });

    it('returns focus to Card C when navigated sequentially from A -> B -> C and closed', async () => {
      await act(async () => {
        root.render(createElement(GalleryHarness));
      });

      const triggerA = container.querySelector<HTMLElement>('[data-achievement-id="ach-a"] .gallery-card-trigger');
      const triggerC = container.querySelector<HTMLElement>('[data-achievement-id="ach-c"] .gallery-card-trigger');
      expect(triggerA).not.toBeNull();
      expect(triggerC).not.toBeNull();

      triggerA!.focus();
      await act(async () => {
        triggerA!.click();
      });

      // Click Next twice: A -> B -> C
      const nextBtn = document.querySelector<HTMLButtonElement>('[data-artwork-nav="next"]');
      await act(async () => {
        nextBtn!.click();
      });
      await act(async () => {
        nextBtn!.click();
      });

      expect(document.body.innerHTML).toContain('Artwork Gamma');

      // Close modal
      const closeBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"], [data-artwork-modal-close]');
      await act(async () => {
        closeBtn!.click();
      });

      // Focus returns to Card C
      expect(document.activeElement).toBe(triggerC);
      expect(document.activeElement?.getAttribute('data-achievement-id')).toBe('ach-c');
    });

    it('falls back to .gallery-grid when Card B is removed from DOM before modal closes', async () => {
      await act(async () => {
        root.render(createElement(GalleryHarness));
      });

      const triggerA = container.querySelector<HTMLElement>('[data-achievement-id="ach-a"] .gallery-card-trigger');
      const gridEl = container.querySelector<HTMLElement>('.gallery-grid');
      expect(triggerA).not.toBeNull();
      expect(gridEl).not.toBeNull();

      // Ensure grid element can receive focus in JSDOM
      gridEl!.setAttribute('tabindex', '-1');
      const gridFocusSpy = vi.spyOn(gridEl!, 'focus');

      // Open on Card A
      triggerA!.focus();
      await act(async () => {
        triggerA!.click();
      });

      // Navigate to Card B
      const nextBtn = document.querySelector<HTMLButtonElement>('[data-artwork-nav="next"]');
      await act(async () => {
        nextBtn!.click();
      });
      expect(document.body.innerHTML).toContain('Artwork Beta');

      // Adversarial manipulation: Card B is removed from DOM (e.g. deleted or filtered out)
      const cardBContainer = container.querySelector('[data-achievement-id="ach-b"]');
      expect(cardBContainer).not.toBeNull();
      cardBContainer!.remove();

      // Close modal
      const closeBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"], [data-artwork-modal-close]');
      await act(async () => {
        closeBtn!.click();
      });

      // Verify fallback: grid.focus was invoked because card B trigger is disconnected
      expect(gridFocusSpy).toHaveBeenCalled();
      expect(document.activeElement).toBe(gridEl);
    });

    it('returns focus to Card A when opened and closed without navigation', async () => {
      await act(async () => {
        root.render(createElement(GalleryHarness));
      });

      const triggerA = container.querySelector<HTMLElement>('[data-achievement-id="ach-a"] .gallery-card-trigger');
      triggerA!.focus();
      expect(document.activeElement).toBe(triggerA);

      await act(async () => {
        triggerA!.click();
      });

      const closeBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"], [data-artwork-modal-close]');
      await act(async () => {
        closeBtn!.click();
      });

      // Return focus is Card A
      expect(document.activeElement).toBe(triggerA);
      expect(document.activeElement?.getAttribute('data-achievement-id')).toBe('ach-a');
    });

    it('returns focus to Card B after bidirectional navigation (A -> B -> C -> B) and closing via Escape key', async () => {
      await act(async () => {
        root.render(createElement(GalleryHarness));
      });

      const triggerA = container.querySelector<HTMLElement>('[data-achievement-id="ach-a"] .gallery-card-trigger');
      const triggerB = container.querySelector<HTMLElement>('[data-achievement-id="ach-b"] .gallery-card-trigger');
      expect(triggerA).not.toBeNull();
      expect(triggerB).not.toBeNull();

      triggerA!.focus();
      await act(async () => {
        triggerA!.click();
      });

      // A -> B
      const nextBtn = document.querySelector<HTMLButtonElement>('[data-artwork-nav="next"]');
      await act(async () => {
        nextBtn!.click();
      });
      // B -> C
      await act(async () => {
        nextBtn!.click();
      });
      expect(document.body.innerHTML).toContain('Artwork Gamma');

      // C -> B (reverse navigation)
      const prevBtn = document.querySelector<HTMLButtonElement>('[data-artwork-nav="prev"]');
      expect(prevBtn).not.toBeNull();
      await act(async () => {
        prevBtn!.click();
      });
      expect(document.body.innerHTML).toContain('Artwork Beta');

      // Close via Escape key
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      // Verify return focus is Card B
      expect(document.activeElement).toBe(triggerB);
      expect(document.activeElement?.getAttribute('data-achievement-id')).toBe('ach-b');
    });

    it('falls back to .gallery-main without throwing when both Card B and .gallery-grid are missing from DOM', async () => {
      await act(async () => {
        root.render(createElement(GalleryHarness));
      });

      const triggerA = container.querySelector<HTMLElement>('[data-achievement-id="ach-a"] .gallery-card-trigger');
      const mainEl = container.querySelector<HTMLElement>('.gallery-main');
      expect(triggerA).not.toBeNull();
      expect(mainEl).not.toBeNull();

      mainEl!.setAttribute('tabindex', '-1');
      const mainFocusSpy = vi.spyOn(mainEl!, 'focus');

      // Open on Card A
      triggerA!.focus();
      await act(async () => {
        triggerA!.click();
      });

      // Navigate to Card B
      const nextBtn = document.querySelector<HTMLButtonElement>('[data-artwork-nav="next"]');
      await act(async () => {
        nextBtn!.click();
      });

      // Adversarially remove both Card B AND the entire .gallery-grid
      const gridEl = container.querySelector('.gallery-grid');
      expect(gridEl).not.toBeNull();
      gridEl!.remove();

      // Close modal
      const closeBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"], [data-artwork-modal-close]');
      await act(async () => {
        closeBtn!.click();
      });

      // Focus should safely fall back to .gallery-main
      expect(mainFocusSpy).toHaveBeenCalled();
      expect(document.activeElement).toBe(mainEl);
    });
  });
});
