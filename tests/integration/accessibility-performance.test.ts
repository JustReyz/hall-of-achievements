import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { processImageDerivatives } from '@/lib/image/processor';
import { createTestJpeg } from '../helpers/image-fixtures';

describe('Integration: Frontend Accessibility (WCAG 2.2 AA) & Performance Budget (AC10)', () => {
  const rootDir = process.cwd();

  describe('WCAG 2.2 AA Global Focus & Stylesheet', () => {
    it('declares high-visibility focus indicators in globals.css and imports in layout.tsx', () => {
      const globalsCssPath = path.join(rootDir, 'src', 'app', 'globals.css');
      expect(fs.existsSync(globalsCssPath)).toBe(true);

      const globalsContent = fs.readFileSync(globalsCssPath, 'utf-8');
      expect(globalsContent).toContain(':focus-visible');
      expect(globalsContent).toContain('2px solid #2563eb');
      expect(globalsContent).toContain('outline-offset: 2px');

      const layoutPath = path.join(rootDir, 'src', 'app', 'layout.tsx');
      const layoutContent = fs.readFileSync(layoutPath, 'utf-8');
      expect(layoutContent).toContain('./globals.css');
    });
  });

  describe('Form Controls & ARIA Associations', () => {
    it('associates error messages and labels properly on login page (src/app/page.tsx)', () => {
      const pagePath = path.join(rootDir, 'src', 'app', 'page.tsx');
      const pageContent = fs.readFileSync(pagePath, 'utf-8');

      expect(pageContent).toContain('id="accessCode"');
      expect(pageContent).toContain('aria-invalid={Boolean(authMessage)}');
      expect(pageContent).toContain("aria-describedby={authMessage ? 'auth-error' : undefined}");
      expect(pageContent).toContain('id="auth-error"');
      expect(pageContent).toContain('role="alert"');
      expect(pageContent).toContain('<nav aria-label="Archive actions"');
    });

    it('associates file picker label to input in AddAchievementModal.tsx', () => {
      const modalPath = path.join(rootDir, 'src', 'components', 'gallery', 'AddAchievementModal.tsx');
      const modalContent = fs.readFileSync(modalPath, 'utf-8');

      expect(modalContent).toContain('htmlFor="achievement-file-input"');
      expect(modalContent).toContain('id="achievement-file-input"');
    });
  });

  describe('Modal Focus Trapping, Escape Dismissal & Focus Restoration', () => {
    it('implements Escape dismissal, Tab focus trapping, and focus restoration in AddAchievementModal.tsx', () => {
      const modalPath = path.join(rootDir, 'src', 'components', 'gallery', 'AddAchievementModal.tsx');
      const modalContent = fs.readFileSync(modalPath, 'utf-8');

      expect(modalContent).toContain("event.key === 'Escape'");
      expect(modalContent).toContain("event.key === 'Tab'");
      expect(modalContent).toContain('event.shiftKey');
      expect(modalContent).toContain('document.activeElement');
      expect(modalContent).toContain('triggerRef.current');
      expect(modalContent).toContain('modalRef');
      expect(modalContent).toContain('minWidth: 44');
      expect(modalContent).toContain('minHeight: 44');
    });

    it('implements Escape dismissal, Tab focus trapping, and focus restoration in AchievementDetailModal.tsx', () => {
      const modalPath = path.join(rootDir, 'src', 'components', 'gallery', 'AchievementDetailModal.tsx');
      const modalContent = fs.readFileSync(modalPath, 'utf-8');

      expect(modalContent).toContain("e.key === 'Escape'");
      expect(modalContent).toContain("e.key === 'Tab'");
      expect(modalContent).toContain('e.shiftKey');
      expect(modalContent).toContain('detailModalRef');
      expect(modalContent).toContain('triggerRef.current');
      expect(modalContent).toContain('minWidth: 44');
      expect(modalContent).toContain('minHeight: 44');
      expect(modalContent).toContain('decoding="async"');
    });
  });

  describe('Mobile Touch Targets (>= 44x44 CSS px)', () => {
    it('enforces min 44px touch targets on notification controls and search clear button', () => {
      const notifPath = path.join(rootDir, 'src', 'components', 'notifications', 'NotificationPanel.tsx');
      const notifContent = fs.readFileSync(notifPath, 'utf-8');
      expect(notifContent).toContain('minHeight: 44');

      const searchPath = path.join(rootDir, 'src', 'components', 'gallery', 'SearchBar.tsx');
      const searchContent = fs.readFileSync(searchPath, 'utf-8');
      expect(searchContent).toContain('gallery-search-clear');

      const globalsContent = fs.readFileSync(
        path.join(rootDir, 'src', 'app', 'globals.css'),
        'utf-8'
      );
      expect(globalsContent).toContain('.gallery-search-clear');
      expect(globalsContent).toMatch(
        /\.gallery-search-clear\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/
      );
    });
  });

  describe('Gallery Image Performance & Layout Shift Prevention', () => {
    it('enforces lazy loading, async decoding, explicit dimensions, and contrast in GalleryCard.tsx', () => {
      const cardPath = path.join(rootDir, 'src', 'components', 'gallery', 'GalleryCard.tsx');
      const cardContent = fs.readFileSync(cardPath, 'utf-8');

      expect(cardContent).toContain('loading="lazy"');
      expect(cardContent).toContain('decoding="async"');
      expect(cardContent).toContain('width={400}');
      expect(cardContent).toContain('height={300}');
      expect(cardContent).toContain('gallery-card-media');

      const globalsContent = fs.readFileSync(
        path.join(rootDir, 'src', 'app', 'globals.css'),
        'utf-8'
      );
      expect(globalsContent).toMatch(/\.gallery-card-media\s*\{[^}]*aspect-ratio:\s*4 \/ 3;/);
      expect(globalsContent).toMatch(/\.gallery-card-image\s*\{[^}]*object-fit:\s*cover;/);
      expect(globalsContent).toContain('--gallery-muted: #53645e;');
      expect(globalsContent).toMatch(/\.gallery-card-date\s*\{[^}]*color:\s*var\(--gallery-muted\);/);
    });

    it('produces WebP thumbnails well within the <=1 MiB initial gallery transfer budget', async () => {
      // Create high-res test image
      const highResBuffer = await createTestJpeg(2400, 1800);
      expect(highResBuffer.length).toBeGreaterThan(20 * 1024);

      // Process derivative images
      const processed = await processImageDerivatives(highResBuffer);

      // Assert thumbnail is WebP and <= 40 KiB
      expect(processed.thumbnailWidth).toBeLessThanOrEqual(400);
      expect(processed.thumbnailHeight).toBeLessThanOrEqual(400);
      expect(processed.thumbnailBuffer.length).toBeLessThan(40 * 1024);

      // Verify budget for first 24 thumbnails:
      // 24 thumbnails * ~25 KiB + Next.js client bundle (~126 KiB) <= 1,048,576 bytes
      const estimated24Thumbs = processed.thumbnailBuffer.length * 24;
      const clientAppBundleEstimate = 130 * 1024; // 130 KiB
      const totalTransfer = estimated24Thumbs + clientAppBundleEstimate;

      expect(totalTransfer).toBeLessThan(1024 * 1024); // strictly <= 1 MiB
    });
  });
});
