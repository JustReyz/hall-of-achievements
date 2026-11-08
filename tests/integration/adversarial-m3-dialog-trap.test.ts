// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AchievementDetailModal } from '@/components/gallery/AchievementDetailModal';
import { AddAchievementModal } from '@/components/gallery/AddAchievementModal';
import type { AchievementItem } from '@/components/gallery/types';

vi.mock('@/lib/drafts/local-drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drafts/local-drafts')>();
  return {
    ...actual,
    loadDraft: async () => null,
  };
});

// Configure React act environment
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Adversarial Stress Test: Milestone 3 Dialog Focus Trap, Escape Recovery, Scroll Lock & Inline Errors', () => {
  let container: HTMLDivElement;
  let outsideButton: HTMLButtonElement;
  let root: Root;

  const mockRect = {
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    top: 0,
    right: 100,
    bottom: 40,
    left: 0,
    toJSON: () => mockRect,
  };

  const createDummyAchievement = (id: string, title: string): AchievementItem => ({
    id,
    title,
    completionDate: '2026-05-01',
    notes: 'Adversarial test notes for ' + title,
    tags: ['oil', 'landscape'],
    thumbnailPositionX: 0.5,
    thumbnailPositionY: 0.5,
    state: 'ready',
    createdAt: new Date().toISOString(),
    asset: {
      id: `asset-${id}`,
      originalBytes: 2048,
      mimeType: 'image/png',
      width: 800,
      height: 600,
      checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });

  beforeEach(() => {
    // Realistic client rects mock: visible elements return 1 rect; hidden, display:none,
    // zero-size or elements within hidden parents return 0 rects.
    Element.prototype.getClientRects = function (this: HTMLElement) {
      if (
        this.hasAttribute('hidden') ||
        this.style.display === 'none' ||
        this.style.visibility === 'hidden' ||
        this.getAttribute('aria-hidden') === 'true' ||
        this.getAttribute('data-zero-size') === 'true' ||
        (this.style.width === '0px' && this.style.height === '0px')
      ) {
        return [] as unknown as DOMRectList;
      }

      let parent = this.parentElement;
      while (parent) {
        if (
          parent.hasAttribute('hidden') ||
          parent.style.display === 'none' ||
          parent.style.visibility === 'hidden'
        ) {
          return [] as unknown as DOMRectList;
        }
        parent = parent.parentElement;
      }

      return [mockRect] as unknown as DOMRectList;
    };

    container = document.createElement('div');
    container.id = 'modal-root';
    document.body.appendChild(container);

    outsideButton = document.createElement('button');
    outsideButton.id = 'outside-anchor-button';
    outsideButton.textContent = 'Outside Dialog';
    document.body.appendChild(outsideButton);

    root = createRoot(container);

    // Mock fetch for relative API routes
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/collections')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ collections: [] }),
          };
        }
        if (url.includes('/assets?type=display')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://cdn.example.com/display.jpg' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      })
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    outsideButton.remove();
    document.body.style.overflow = '';
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. DIALOG FOCUS TRAPPING: TAB & SHIFT+TAB WRAP-AROUND
  // =========================================================================
  describe('1. Dialog Focus Trapping & Bi-Directional Wrap-Around', () => {
    it('AchievementDetailModal: wraps Tab from last focusable to first focusable and prevents default', async () => {
      const achievement = createDummyAchievement('ach-trap-1', 'Detail Trap');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      expect(modalContainer).not.toBeNull();

      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.length).toBeGreaterThan(1);
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      // Place focus on last element
      last.focus();
      expect(document.activeElement).toBe(last);

      // Press Tab on last focusable
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(tabEvent);

      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
    });

    it('AchievementDetailModal: wraps Shift+Tab from first focusable to last focusable and prevents default', async () => {
      const achievement = createDummyAchievement('ach-trap-2', 'Detail Shift Trap');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      // Place focus on first element
      first.focus();
      expect(document.activeElement).toBe(first);

      // Press Shift+Tab on first focusable
      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(shiftTabEvent);

      expect(shiftTabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });

    it('AchievementDetailModal: allows standard tab traversal on intermediate focusables without blocking default', async () => {
      const achievement = createDummyAchievement('ach-trap-3', 'Detail Intermediate Trap');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.length).toBeGreaterThan(2);
      const intermediate = focusables[1]!;
      intermediate.focus();
      expect(document.activeElement).toBe(intermediate);

      // Forward Tab on intermediate element
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(tabEvent);
      expect(tabEvent.defaultPrevented).toBe(false);

      // Backward Shift+Tab on intermediate element
      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(shiftTabEvent);
      expect(shiftTabEvent.defaultPrevented).toBe(false);
    });

    it('AddAchievementModal: wraps Tab from last to first and Shift+Tab from first to last', async () => {
      await act(async () => {
        root.render(
          React.createElement(AddAchievementModal, {
            isOpen: true,
            onClose: vi.fn(),
            onSuccess: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      expect(modalContainer).not.toBeNull();

      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.length).toBeGreaterThan(1);
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      // Tab on last element -> wraps to first
      last.focus();
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(tabEvent);
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      // Shift+Tab on first element -> wraps to last
      first.focus();
      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(shiftTabEvent);
      expect(shiftTabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });
  });

  // =========================================================================
  // 2. FOCUS ESCAPE RECOVERY: ACTIVE ELEMENT OUTSIDE DIALOG CONTAINER
  // =========================================================================
  describe('2. Focus Escape Recovery (Adversarial Focus Hijack Prevention)', () => {
    it('AchievementDetailModal: recovers focus to first element when activeElement is outside and Tab is pressed', async () => {
      const achievement = createDummyAchievement('ach-esc-1', 'Detail Escape Tab');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
      const first = focusables[0]!;

      // Adversarially set activeElement outside modal to outsideButton
      outsideButton.focus();
      expect(document.activeElement).toBe(outsideButton);
      expect(modalContainer.contains(document.activeElement)).toBe(false);

      // User presses Tab while focus was hijacked outside
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(tabEvent);

      // Modal intercepts and pulls focus back inside to first focusable
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
      expect(modalContainer.contains(document.activeElement)).toBe(true);
    });

    it('AchievementDetailModal: recovers focus to last element when activeElement is outside and Shift+Tab is pressed', async () => {
      const achievement = createDummyAchievement('ach-esc-2', 'Detail Escape ShiftTab');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
      const last = focusables[focusables.length - 1]!;

      // Adversarially force focus to body
      document.body.focus();
      expect(modalContainer.contains(document.activeElement)).toBe(false);

      // User presses Shift+Tab while focus was outside
      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(shiftTabEvent);

      // Modal intercepts and pulls focus back inside to last focusable
      expect(shiftTabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
      expect(modalContainer.contains(document.activeElement)).toBe(true);
    });

    it('AddAchievementModal: recovers focus when activeElement lands outside dialog container', async () => {
      await act(async () => {
        root.render(
          React.createElement(AddAchievementModal, {
            isOpen: true,
            onClose: vi.fn(),
            onSuccess: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      // Escape recovery with Tab
      outsideButton.focus();
      expect(modalContainer.contains(document.activeElement)).toBe(false);

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(tabEvent);
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      // Escape recovery with Shift+Tab
      outsideButton.focus();
      expect(modalContainer.contains(document.activeElement)).toBe(false);

      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(shiftTabEvent);
      expect(shiftTabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });

    it('respects open sub-dialogs without stealing focus away from child dialogs', async () => {
      const achievement = createDummyAchievement('ach-sub-dialog', 'Sub-dialog Guard');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      // Inject an open native dialog representing a confirmation prompt
      const subDialog = document.createElement('dialog');
      subDialog.setAttribute('open', '');
      const subButton = document.createElement('button');
      subButton.textContent = 'Confirm Action';
      subDialog.appendChild(subButton);
      document.body.appendChild(subDialog);

      subButton.focus();
      expect(document.activeElement).toBe(subButton);

      // Tab inside open sub-dialog
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      subButton.dispatchEvent(tabEvent);

      // Must NOT prevent default or steal focus to parent modal
      expect(tabEvent.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(subButton);

      subDialog.remove();
    });
  });

  // =========================================================================
  // 3. INVISIBLE, DISABLED & INERT ELEMENT EXCLUSION
  // =========================================================================
  describe('3. Invisible, Disabled & Inert Element Exclusion from Focusable Cycle', () => {
    it('excludes disabled buttons from focusable elements list', async () => {
      const achievement = createDummyAchievement('ach-disabled-1', 'Disabled Button Check');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      expect(modalContainer).not.toBeNull();

      // Dynamically insert a disabled button inside the dialog
      const testDisabledBtn = document.createElement('button');
      testDisabledBtn.id = 'adversarial-disabled-button';
      testDisabledBtn.disabled = true;
      testDisabledBtn.textContent = 'Disabled Action';
      modalContainer.appendChild(testDisabledBtn);

      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.includes(testDisabledBtn)).toBe(false);
      testDisabledBtn.remove();
    });

    it('excludes hidden inputs (display: none) such as the restore file input', async () => {
      const achievement = createDummyAchievement('ach-hidden-1', 'Hidden Input Check');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      // Find the file input in DOM
      const fileInput = document.querySelector('input[type="file"]') as HTMLElement;
      expect(fileInput).not.toBeNull();
      expect(fileInput.style.display).toBe('none');

      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.includes(fileInput)).toBe(false);
    });

    it('excludes elements with zero-size (getClientRects().length === 0)', async () => {
      const achievement = createDummyAchievement('ach-zerosize-1', 'Zero Size Check');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;

      // Add a zero-size button
      const zeroSizeBtn = document.createElement('button');
      zeroSizeBtn.id = 'zero-size-btn';
      zeroSizeBtn.style.width = '0px';
      zeroSizeBtn.style.height = '0px';
      modalContainer.appendChild(zeroSizeBtn);

      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.includes(zeroSizeBtn)).toBe(false);
      zeroSizeBtn.remove();
    });

    it('excludes interactive elements residing within an inert ancestor', async () => {
      const achievement = createDummyAchievement('ach-inert-1', 'Inert Ancestor Check');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;

      // Create an inert wrapper containing a button
      const inertWrapper = document.createElement('div');
      inertWrapper.setAttribute('inert', '');
      const inertButton = document.createElement('button');
      inertButton.textContent = 'Trapped in inert';
      inertWrapper.appendChild(inertButton);
      modalContainer.appendChild(inertWrapper);

      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.includes(inertButton)).toBe(false);
      inertWrapper.remove();
    });

    it('scopes focus trap to artwork viewer when viewerOpen is true', async () => {
      const achievement = createDummyAchievement('ach-viewer-1', 'Viewer Focus Trap');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: true,
            viewerBackground: 'black',
            hasPrevious: true,
            hasNext: true,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const viewerContainer = document.querySelector('[data-artwork-viewer]') as HTMLElement;
      expect(viewerContainer).not.toBeNull();

      const viewerFocusables = Array.from(
        viewerContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(viewerFocusables.length).toBeGreaterThan(0);
      const first = viewerFocusables[0]!;
      const last = viewerFocusables[viewerFocusables.length - 1]!;

      // Tab on last element in viewer should wrap to first element in viewer
      last.focus();
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(tabEvent);

      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
      expect(viewerContainer.contains(document.activeElement)).toBe(true);
    });
  });

  // =========================================================================
  // 4. BODY SCROLL LOCKING & RAPID CYCLE STRESS HARNESS
  // =========================================================================
  describe('4. Body Scroll Locking & Rapid Hammering Stress Harness', () => {
    it('sets document.body.style.overflow to hidden when AchievementDetailModal opens and restores on close', async () => {
      document.body.style.overflow = '';
      const achievement = createDummyAchievement('ach-scroll-1', 'Scroll Lock');

      // Open modal
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      expect(document.body.style.overflow).toBe('hidden');

      // Close modal (achievement = null)
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: null,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      expect(document.body.style.overflow).toBe('');
    });

    it('preserves and restores existing non-empty body overflow setting (e.g. scroll or auto)', async () => {
      document.body.style.overflow = 'scroll';
      const achievement = createDummyAchievement('ach-scroll-preserve', 'Preserve Custom Overflow');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      expect(document.body.style.overflow).toBe('hidden');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: null,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      expect(document.body.style.overflow).toBe('scroll');
    });

    it('sets and restores body scroll locking in AddAchievementModal', async () => {
      document.body.style.overflow = '';

      // Open Add modal
      await act(async () => {
        root.render(
          React.createElement(AddAchievementModal, {
            isOpen: true,
            onClose: vi.fn(),
            onSuccess: vi.fn(),
          })
        );
      });

      expect(document.body.style.overflow).toBe('hidden');

      // Close Add modal
      await act(async () => {
        root.render(
          React.createElement(AddAchievementModal, {
            isOpen: false,
            onClose: vi.fn(),
            onSuccess: vi.fn(),
          })
        );
      });

      expect(document.body.style.overflow).toBe('');
    });

    it('maintains scroll lock during artwork navigation without leaking or un-locking', async () => {
      document.body.style.overflow = '';
      const ach1 = createDummyAchievement('ach-nav-1', 'Piece 1');
      const ach2 = createDummyAchievement('ach-nav-2', 'Piece 2');

      // Mount piece 1
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: ach1,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: true,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });
      expect(document.body.style.overflow).toBe('hidden');

      // Navigate to piece 2
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: ach2,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: true,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });
      expect(document.body.style.overflow).toBe('hidden');

      // Dismiss modal
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: null,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });
      expect(document.body.style.overflow).toBe('');
    });

    it('stress test: 50 rapid sequential open/close cycles do not leak hidden body overflow', async () => {
      document.body.style.overflow = '';
      const dummy = createDummyAchievement('ach-stress-hammer', 'Stress Hammer Piece');

      for (let i = 0; i < 50; i++) {
        // Alternating between Detail Modal and Add Modal
        if (i % 2 === 0) {
          await act(async () => {
            root.render(
              React.createElement(AchievementDetailModal, {
                achievement: dummy,
                viewerOpen: false,
                viewerBackground: 'black',
                hasPrevious: false,
                hasNext: false,
                navigationPending: false,
                onClose: vi.fn(),
                onViewerOpen: vi.fn(),
                onViewerClose: vi.fn(),
                onPrevious: vi.fn(),
                onNext: vi.fn(),
                onViewerBackgroundChange: vi.fn(),
                onUpdate: vi.fn(),
                onDelete: vi.fn(),
                restoreRequest: null,
                onDismissRestore: vi.fn(),
              })
            );
          });
          expect(document.body.style.overflow).toBe('hidden');

          await act(async () => {
            root.render(
              React.createElement(AchievementDetailModal, {
                achievement: null,
                viewerOpen: false,
                viewerBackground: 'black',
                hasPrevious: false,
                hasNext: false,
                navigationPending: false,
                onClose: vi.fn(),
                onViewerOpen: vi.fn(),
                onViewerClose: vi.fn(),
                onPrevious: vi.fn(),
                onNext: vi.fn(),
                onViewerBackgroundChange: vi.fn(),
                onUpdate: vi.fn(),
                onDelete: vi.fn(),
                restoreRequest: null,
                onDismissRestore: vi.fn(),
              })
            );
          });
          expect(document.body.style.overflow).toBe('');
        } else {
          await act(async () => {
            root.render(
              React.createElement(AddAchievementModal, {
                isOpen: true,
                onClose: vi.fn(),
                onSuccess: vi.fn(),
              })
            );
          });
          expect(document.body.style.overflow).toBe('hidden');

          await act(async () => {
            root.render(
              React.createElement(AddAchievementModal, {
                isOpen: false,
                onClose: vi.fn(),
                onSuccess: vi.fn(),
              })
            );
          });
          expect(document.body.style.overflow).toBe('');
        }
      }

      // Final post-stress invariant check
      expect(document.body.style.overflow).toBe('');
    });
  });

  // =========================================================================
  // 5. INLINE DOWNLOAD ERROR: ADJACENT, ROLE=ALERT, RETRY & RESET
  // =========================================================================
  describe('5. Inline Download Error: Adjacency, ARIA Alert, Working Retry & Navigation Reset', () => {
    it('renders error immediately adjacent below download button with role="alert" and working retry button', async () => {
      const achievement = createDummyAchievement('ach-download-err', 'Download Error Test');

      // Mock fetch failure for original asset download
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/api/collections')) {
            return { ok: true, status: 200, json: async () => ({ collections: [] }) };
          }
          if (url.includes('/assets?type=display')) {
            return { ok: true, status: 200, json: async () => ({ url: 'https://cdn.example.com/display.jpg' }) };
          }
          if (url.includes('/assets?type=original&download=true')) {
            return {
              ok: false,
              status: 500,
              json: async () => ({ error: 'Storage capability signature expired. Please retry.' }),
            };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        })
      );

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      // Confirm clean initial state
      expect(document.querySelector('.gallery-download-error')).toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();

      // Find the "Download Original Asset" button
      const downloadButton = Array.from(document.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Download Original Asset')
      );
      expect(downloadButton).toBeDefined();

      // Click download button to trigger failure
      await act(async () => {
        downloadButton!.click();
      });

      // Find the rendered error element
      const errorAlert = document.querySelector('.gallery-download-error') as HTMLElement;
      expect(errorAlert).not.toBeNull();

      // Verify immediate adjacency below download button
      expect(downloadButton!.nextElementSibling).toBe(errorAlert);

      // Verify ARIA role="alert"
      expect(errorAlert.getAttribute('role')).toBe('alert');

      // Verify exact error message text content
      expect(errorAlert.textContent).toContain('Storage capability signature expired. Please retry.');

      // Verify working Retry button exists inside error container
      const retryButton = errorAlert.querySelector('button') as HTMLButtonElement;
      expect(retryButton).not.toBeNull();
      expect(retryButton.textContent).toContain('Retry download');

      // Mock successful response on retry
      let downloadInitiated = false;
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
        const el = originalCreateElement(tagName, options);
        if (tagName.toLowerCase() === 'a') {
          el.click = () => {
            downloadInitiated = true;
          };
        }
        return el;
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/assets?type=original&download=true')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ url: 'https://cdn.example.com/asset-original.png' }),
            };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        })
      );

      // Click retry button
      await act(async () => {
        retryButton.click();
      });

      // Verify retry proceeded and initiated asset download
      expect(downloadInitiated).toBe(true);
      // Verify download error alert was dismissed
      expect(document.querySelector('.gallery-download-error')).toBeNull();
    });

    it('clears download error immediately when navigating to another achievement', async () => {
      const achA = createDummyAchievement('ach-download-a', 'Piece A');
      const achB = createDummyAchievement('ach-download-b', 'Piece B');

      // Mock initial failure
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/api/collections')) {
            return { ok: true, status: 200, json: async () => ({ collections: [] }) };
          }
          if (url.includes('/assets?type=original&download=true')) {
            return {
              ok: false,
              status: 503,
              json: async () => ({ error: 'Transient storage error' }),
            };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        })
      );

      // Mount Piece A
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: achA,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: true,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      // Trigger download failure on Piece A
      const downloadButtonA = Array.from(document.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Download Original Asset')
      );
      expect(downloadButtonA).toBeDefined();

      await act(async () => {
        downloadButtonA!.click();
      });

      expect(document.querySelector('.gallery-download-error')).not.toBeNull();
      expect(document.querySelector('.gallery-download-error')?.textContent).toContain(
        'Transient storage error'
      );

      // Navigate to Piece B
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: achB,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: true,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      // Error must be completely cleared on the new achievement
      expect(document.querySelector('.gallery-download-error')).toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    it('AchievementDetailModal: invokes onSessionExpired callback when download returns 401', async () => {
      const achievement = createDummyAchievement('ach-down-401', 'Session Expired Test');
      const onSessionExpired = vi.fn();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/api/collections')) {
            return { ok: true, status: 200, json: async () => ({ collections: [] }) };
          }
          if (url.includes('/assets?type=original&download=true')) {
            return {
              ok: false,
              status: 401,
              json: async () => ({ error: 'Unauthorized' }),
            };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        })
      );

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
            onSessionExpired,
          })
        );
      });

      const downloadButton = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Download Original Asset')
      );
      expect(downloadButton).toBeDefined();

      await act(async () => {
        downloadButton!.click();
      });

      expect(onSessionExpired).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 6. DYNAMIC RETURN FOCUS, EDIT MODE TRAPPING & KEYSTROKE COMPLIANCE
  // =========================================================================
  describe('6. Dynamic Return Focus, Edit Mode Trapping & Keystroke Compliance', () => {
    it('AchievementDetailModal: updates return focus target to matching card upon navigation and restores focus on close', async () => {
      const grid = document.createElement('div');
      grid.className = 'gallery-grid';
      document.body.appendChild(grid);

      const card1 = document.createElement('div');
      card1.setAttribute('data-achievement-id', 'ach-ret-1');
      const trigger1 = document.createElement('button');
      trigger1.className = 'gallery-card-trigger';
      trigger1.textContent = 'Card 1 Trigger';
      card1.appendChild(trigger1);
      grid.appendChild(card1);

      const card2 = document.createElement('div');
      card2.setAttribute('data-achievement-id', 'ach-ret-2');
      const trigger2 = document.createElement('button');
      trigger2.className = 'gallery-card-trigger';
      trigger2.textContent = 'Card 2 Trigger';
      card2.appendChild(trigger2);
      grid.appendChild(card2);

      trigger1.focus();
      expect(document.activeElement).toBe(trigger1);

      const ach1 = createDummyAchievement('ach-ret-1', 'Card 1');
      const ach2 = createDummyAchievement('ach-ret-2', 'Card 2');

      // Open modal on ach1
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: ach1,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: true,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      // Navigate to ach2
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: ach2,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: true,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      // Close modal
      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement: null,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      // Return focus must land on trigger2, NOT trigger1!
      expect(document.activeElement).toBe(trigger2);

      grid.remove();
    });

    it('AchievementDetailModal: maintains Tab and Shift+Tab trapping in edit form mode', async () => {
      const achievement = createDummyAchievement('ach-edit-trap', 'Edit Trap Test');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const editButton = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Edit Details')
      );
      expect(editButton).toBeDefined();

      await act(async () => {
        editButton!.click();
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      expect(modalContainer).not.toBeNull();

      const focusables = Array.from(
        modalContainer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);

      expect(focusables.length).toBeGreaterThan(2);
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      // Tab on last element in form wraps to first
      last.focus();
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(tabEvent);
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      // Shift+Tab on first element wraps to last element
      first.focus();
      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(shiftTabEvent);
      expect(shiftTabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
    });

    it('AchievementDetailModal: restores body scroll lock when component unmounts unexpectedly', async () => {
      document.body.style.overflow = '';
      const achievement = createDummyAchievement('ach-unmount', 'Unmount Test');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      expect(document.body.style.overflow).toBe('hidden');

      // Direct unmount of root without setting achievement = null
      await act(async () => {
        root.unmount();
        // Re-create root for afterEach cleanup
        root = createRoot(container);
      });

      expect(document.body.style.overflow).toBe('');
    });

    it('AchievementDetailModal: does not intercept non-Tab/non-Escape keystrokes (Enter, Space, ArrowDown)', async () => {
      const achievement = createDummyAchievement('ach-key-pass', 'Keystroke Pass-Through');

      await act(async () => {
        root.render(
          React.createElement(AchievementDetailModal, {
            achievement,
            viewerOpen: false,
            viewerBackground: 'black',
            hasPrevious: false,
            hasNext: false,
            navigationPending: false,
            onClose: vi.fn(),
            onViewerOpen: vi.fn(),
            onViewerClose: vi.fn(),
            onPrevious: vi.fn(),
            onNext: vi.fn(),
            onViewerBackgroundChange: vi.fn(),
            onUpdate: vi.fn(),
            onDelete: vi.fn(),
            restoreRequest: null,
            onDismissRestore: vi.fn(),
          })
        );
      });

      const modalContainer = document.querySelector('.gallery-modal-dialog') as HTMLElement;
      const first = modalContainer.querySelector('button')!;
      first.focus();

      for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'KeyA']) {
        const event = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
    });
  });
});

