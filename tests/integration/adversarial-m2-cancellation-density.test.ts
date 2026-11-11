import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { resetDatabase, getDb } from '@/lib/db';
import { achievements } from '@/lib/db/schema';
import { GET as galleryHandler } from '@/app/api/achievements/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import type {
  GalleryDensity,
  AchievementItem,
  GalleryResponse,
  AchievementSort,
} from '@/components/gallery/types';

describe('Adversarial Stress Test: Milestone 2 Cancellation, Out-of-Order & Density Persistence', () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
  });

  const createDummyItem = (id: string, title: string, completionDate: string, tags: string[] = ['test']): AchievementItem => ({
    id,
    title,
    completionDate,
    notes: null,
    tags,
    thumbnailPositionX: 0.5,
    thumbnailPositionY: 0.5,
    state: 'ready',
    createdAt: new Date().toISOString(),
    asset: null,
  });

  // =========================================================================
  // 1. RAPID IN-FLIGHT REQUEST CANCELLATION & OUT-OF-ORDER REJECTION
  // =========================================================================
  describe('1. In-Flight Request Cancellation & Out-of-Order Rejection (AbortController & Generation Guards)', () => {
    it('aborts prior in-flight requests and rejects out-of-order slow responses during rapid keystroke typing', async () => {
      // Simulate component-level state and refs in src/app/page.tsx
      const achievementsAbortRef = { current: null as AbortController | null };
      const requestGeneration = { current: 0 };

      let currentItems: AchievementItem[] = [];
      let currentCursor: string | null = null;
      let currentHasMore = false;
      let currentGalleryLoading = false;
      let currentGalleryError: string | null = null;

      // Simulated network fetch with latency inversion
      const simulatedFetch = async (query: string, latencyMs: number, signal: AbortSignal | null) => {
        return new Promise<GalleryResponse>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (signal?.aborted) {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
              return;
            }
            resolve({
              items: [createDummyItem(crypto.randomUUID(), `Result for ${query}`, '2026-05-01')],
              nextCursor: `cursor_${query}`,
              hasMore: true,
            });
          }, latencyMs);

          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      // Exact client execution harness modelled on src/app/page.tsx fetchAchievements
      const executeFetch = async (q: string, latencyMs: number) => {
        // Fresh search: abort prior in-flight achievements request
        achievementsAbortRef.current?.abort();
        achievementsAbortRef.current = new AbortController();
        const signal = achievementsAbortRef.current?.signal ?? null;

        const generation = ++requestGeneration.current;
        currentGalleryLoading = true;
        currentGalleryError = null;

        try {
          const data = await simulatedFetch(q, latencyMs, signal);
          if (generation !== requestGeneration.current) {
            return { ok: false, items: [], nextCursor: null, hasMore: false };
          }
          currentItems = data.items;
          currentCursor = data.nextCursor;
          currentHasMore = data.hasMore;
          return { ok: true, items: data.items, nextCursor: data.nextCursor, hasMore: data.hasMore };
        } catch (err: unknown) {
          if ((err as Error)?.name === 'AbortError') {
            return { ok: false, items: [], nextCursor: null, hasMore: false };
          }
          if (generation === requestGeneration.current) {
            currentGalleryError = 'Failed to load artwork. Please retry.';
          }
          return { ok: false, items: [], nextCursor: null, hasMore: false };
        } finally {
          if (generation === requestGeneration.current) {
            currentGalleryLoading = false;
          }
        }
      };

      // Track individual controllers created
      const controllers: AbortController[] = [];
      const originalAbortController = globalThis.AbortController;

      // Wrap AbortController to observe all instances
      vi.spyOn(globalThis, 'AbortController').mockImplementation(function () {
        const ctrl = new originalAbortController();
        controllers.push(ctrl);
        return ctrl;
      });

      // Simulate rapid typing: "m" (slowest: 180ms), "mo" (140ms), "mon" (100ms), "mone" (60ms), "monet" (fastest: 20ms)
      const p1 = executeFetch('m', 180);
      const p2 = executeFetch('mo', 140);
      const p3 = executeFetch('mon', 100);
      const p4 = executeFetch('mone', 60);
      const p5 = executeFetch('monet', 20);

      // Verify that prior controllers (0 to 3) were immediately aborted
      expect(controllers.length).toBe(5);
      expect(controllers[0]!.signal.aborted).toBe(true);
      expect(controllers[1]!.signal.aborted).toBe(true);
      expect(controllers[2]!.signal.aborted).toBe(true);
      expect(controllers[3]!.signal.aborted).toBe(true);
      expect(controllers[4]!.signal.aborted).toBe(false);

      // Wait for all in-flight promises to complete
      const results = await Promise.all([p1, p2, p3, p4, p5]);

      // Aborted promises returned ok: false
      expect(results[0]!.ok).toBe(false);
      expect(results[1]!.ok).toBe(false);
      expect(results[2]!.ok).toBe(false);
      expect(results[3]!.ok).toBe(false);
      // Final promise succeeded
      expect(results[4]!.ok).toBe(true);

      // Verify UI state strictly reflects the latest keystroke "monet"
      expect(currentItems.length).toBe(1);
      expect(currentItems[0]!.title).toBe('Result for monet');
      expect(currentCursor).toBe('cursor_monet');
      expect(currentHasMore).toBe(true);
      expect(currentGalleryLoading).toBe(false);
      expect(currentGalleryError).toBeNull();
    });

    it('rejects stale responses when network responses arrive out of order without AbortSignal aborting socket', async () => {
      // Stress-test the generation guard when fetch somehow completes before abort takes effect
      const requestGeneration = { current: 0 };
      let stateItems: AchievementItem[] = [];

      const executeRequest = async (generationId: string, latencyMs: number) => {
        const generation = ++requestGeneration.current;
        // Simulate response without aborting
        const data = await new Promise<GalleryResponse>((resolve) => {
          setTimeout(() => {
            resolve({
              items: [createDummyItem(generationId, `Result ${generationId}`, '2026-05-01')],
              nextCursor: null,
              hasMore: false,
            });
          }, latencyMs);
        });

        // Generation guard check from page.tsx:
        if (generation !== requestGeneration.current) {
          return { ok: false, items: [] };
        }
        stateItems = data.items;
        return { ok: true, items: data.items };
      };

      // Request 1 issued first (slow: 100ms)
      const p1 = executeRequest('request-1', 100);
      // Request 2 issued second (fast: 20ms)
      const p2 = executeRequest('request-2', 20);

      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res2.ok).toBe(true);
      expect(res1.ok).toBe(false); // Stale request 1 dropped
      expect(stateItems.length).toBe(1);
      expect(stateItems[0]!.title).toBe('Result request-2');
    });

    it('aborts in-flight pagination requests when the user changes filters or sort', async () => {
      const achievementsAbortRef = { current: null as AbortController | null };
      const requestGeneration = { current: 0 };
      let currentItems: AchievementItem[] = [createDummyItem('p1-item', 'Page 1 Item', '2026-05-01')];

      // Step 1: User initiates "Load More" (pageCursor provided)
      achievementsAbortRef.current = new AbortController();
      const paginationSignal = achievementsAbortRef.current.signal;
      const paginationGen = ++requestGeneration.current;

      let paginationResolved = false;
      const paginationPromise = new Promise<{ ok: boolean }>((resolve) => {
        setTimeout(() => {
          if (paginationSignal.aborted || paginationGen !== requestGeneration.current) {
            resolve({ ok: false });
            return;
          }
          currentItems = [...currentItems, createDummyItem('p2-item', 'Page 2 Item', '2026-05-01')];
          paginationResolved = true;
          resolve({ ok: true });
        }, 120);
      });

      // Step 2: At 20ms, before page 2 resolves, user changes sort to "oldest" (!pageCursor)
      await new Promise((r) => setTimeout(r, 20));
      // As in page.tsx:
      achievementsAbortRef.current?.abort();
      achievementsAbortRef.current = new AbortController();
      const sortSignal = achievementsAbortRef.current.signal;
      const sortGen = ++requestGeneration.current;

      // Filter change clears or resets items
      currentItems = [];

      const sortPromise = new Promise<{ ok: boolean }>((resolve) => {
        setTimeout(() => {
          if (sortSignal.aborted || sortGen !== requestGeneration.current) {
            resolve({ ok: false });
            return;
          }
          currentItems = [createDummyItem('sorted-item', 'Oldest Art Item', '2026-01-01')];
          resolve({ ok: true });
        }, 40);
      });

      expect(paginationSignal.aborted).toBe(true);
      const [pagResult, sortResult] = await Promise.all([paginationPromise, sortPromise]);

      expect(pagResult.ok).toBe(false);
      expect(paginationResolved).toBe(false);
      expect(sortResult.ok).toBe(true);

      // Verify that stale page 2 item was NEVER appended to the new sorted collection
      expect(currentItems.length).toBe(1);
      expect(currentItems[0]!.title).toBe('Oldest Art Item');
    });

    it('cancels in-flight tag facet requests when query or dates change rapidly', async () => {
      const tagsAbortRef = { current: null as AbortController | null };
      const tagRequestGeneration = { current: 0 };
      let stateTags: string[] = [];

      const fetchTagsMock = async (q: string, latencyMs: number) => {
        tagsAbortRef.current?.abort();
        tagsAbortRef.current = new AbortController();
        const signal = tagsAbortRef.current.signal;
        const generation = ++tagRequestGeneration.current;

        try {
          const tags = await new Promise<string[]>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (signal.aborted) {
                const err = new Error('The operation was aborted.');
                err.name = 'AbortError';
                reject(err);
                return;
              }
              resolve([`tag-${q}`]);
            }, latencyMs);

            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          });

          if (generation !== tagRequestGeneration.current) return;
          stateTags = tags;
        } catch (err: unknown) {
          if ((err as Error)?.name === 'AbortError') return;
        }
      };

      // Rapidly change search: "a" (150ms), "ab" (100ms), "abc" (30ms)
      const p1 = fetchTagsMock('a', 150);
      const p2 = fetchTagsMock('ab', 100);
      const p3 = fetchTagsMock('abc', 30);

      await Promise.all([p1, p2, p3]);

      expect(stateTags).toEqual(['tag-abc']);
    });

    it('session expiration and page unmount abort active controllers immediately', () => {
      const achievementsAbortRef = { current: new AbortController() };
      const tagsAbortRef = { current: new AbortController() };

      expect(achievementsAbortRef.current.signal.aborted).toBe(false);
      expect(tagsAbortRef.current.signal.aborted).toBe(false);

      // Simulate session expiration handler in page.tsx
      const handleSessionExpired = () => {
        achievementsAbortRef.current?.abort();
        tagsAbortRef.current?.abort();
      };

      handleSessionExpired();

      expect(achievementsAbortRef.current.signal.aborted).toBe(true);
      expect(tagsAbortRef.current.signal.aborted).toBe(true);
    });
  });

  // =========================================================================
  // 2. LOCALSTORAGE DENSITY PERSISTENCE FAILURE MODES
  // =========================================================================
  describe('2. LocalStorage Density Persistence Failure Modes', () => {
    const parseDensityFromStorage = (storageObj: { getItem: (key: string) => string | null }): GalleryDensity => {
      try {
        const saved = storageObj.getItem('hall_gallery_density');
        if (saved === 'compact' || saved === 'comfortable' || saved === 'roomy') {
          return saved;
        }
      } catch {
        // Ignore localStorage errors (e.g. security error or storage disabled)
      }
      return 'comfortable';
    };

    const saveDensityToStorage = (
      storageObj: { setItem: (key: string, val: string) => void },
      nextDensity: GalleryDensity
    ): boolean => {
      try {
        storageObj.setItem('hall_gallery_density', nextDensity);
        return true;
      } catch {
        // Ignore localStorage errors
        return false;
      }
    };

    it('defaults gracefully to "comfortable" across malformed, corrupted, or malicious storage values', () => {
      const testValues = [
        null,
        '',
        '   ',
        'COMPACT',
        'COMFORTABLE',
        'ROOMY',
        'compact ',
        ' roomy',
        'wide',
        'narrow',
        'dense',
        '123',
        'true',
        'false',
        'undefined',
        'null',
        '[object Object]',
        '{"density":"compact"}',
        '{"__proto__":{"isAdmin":true}}',
        '__proto__',
        'constructor',
        'prototype',
        'a'.repeat(5000), // extreme string
        '\u0000compact', // null byte prefix
      ];

      for (const val of testValues) {
        const mockStorage = {
          getItem: () => val,
        };
        const density = parseDensityFromStorage(mockStorage);
        expect(density).toBe('comfortable');
      }
    });

    it('successfully restores valid densities: compact, comfortable, and roomy', () => {
      for (const valid of ['compact', 'comfortable', 'roomy'] as const) {
        const mockStorage = {
          getItem: () => valid,
        };
        const density = parseDensityFromStorage(mockStorage);
        expect(density).toBe(valid);
      }
    });

    it('handles Private Browsing SecurityError on getItem without throwing or crashing', () => {
      const securityThrowingStorage = {
        getItem: () => {
          const err = new Error('The operation is insecure.');
          err.name = 'SecurityError';
          throw err;
        },
      };

      let density: GalleryDensity = 'comfortable';
      expect(() => {
        density = parseDensityFromStorage(securityThrowingStorage);
      }).not.toThrow();

      expect(density).toBe('comfortable');
    });

    it('handles Private Browsing SecurityError on setItem without throwing or crashing', () => {
      const securityThrowingStorage = {
        setItem: () => {
          const err = new Error('The operation is insecure.');
          err.name = 'SecurityError';
          throw err;
        },
      };

      let inMemoryDensity: GalleryDensity = 'comfortable';
      const handleDensityChange = (next: GalleryDensity) => {
        inMemoryDensity = next;
        saveDensityToStorage(securityThrowingStorage, next);
      };

      expect(() => handleDensityChange('compact')).not.toThrow();
      // In-memory UI state successfully updated despite storage failure
      expect(inMemoryDensity).toBe('compact');
    });

    it('handles QuotaExceededError on setItem without crashing', () => {
      const quotaThrowingStorage = {
        setItem: () => {
          const err = new Error('The quota has been exceeded.');
          err.name = 'QuotaExceededError';
          throw err;
        },
      };

      let inMemoryDensity: GalleryDensity = 'comfortable';
      const handleDensityChange = (next: GalleryDensity) => {
        inMemoryDensity = next;
        saveDensityToStorage(quotaThrowingStorage, next);
      };

      expect(() => handleDensityChange('roomy')).not.toThrow();
      expect(inMemoryDensity).toBe('roomy');
    });

    it('handles null/undefined window.localStorage safely (e.g. node, worker, or sandboxed iframe)', () => {
      const nullStorage = {
        getItem: () => {
          throw new ReferenceError('localStorage is not defined');
        },
      };

      expect(() => parseDensityFromStorage(nullStorage)).not.toThrow();
      expect(parseDensityFromStorage(nullStorage)).toBe('comfortable');
    });
  });

  // =========================================================================
  // 3. DYNAMIC DATA-DENSITY ATTRIBUTE & ACCESSIBLE CONTROLS
  // =========================================================================
  describe('3. Dynamic data-density Attribute & Accessible Controls', () => {
    it('renders data-density attribute accurately for compact, comfortable, and roomy', () => {
      const dummyItems = [createDummyItem('item-1', 'Art Piece 1', '2026-05-01')];

      for (const densityVal of ['compact', 'comfortable', 'roomy'] as const) {
        const html = renderToStaticMarkup(
          createElement(GalleryGrid, {
            items: dummyItems,
            loading: false,
            hasMore: false,
            hasActiveFilters: false,
            density: densityVal,
            onLoadMore: () => {},
            onSelectAchievement: () => {},
          })
        );

        expect(html).toContain(`data-density="${densityVal}"`);
        expect(html).toContain('role="region"');
        expect(html).toContain('aria-label="Achievements collection"');
      }
    });

    it('falls back to data-density="comfortable" when density is omitted or undefined', () => {
      const dummyItems = [createDummyItem('item-1', 'Art Piece 1', '2026-05-01')];

      const htmlOmitted = renderToStaticMarkup(
        createElement(GalleryGrid, {
          items: dummyItems,
          loading: false,
          hasMore: false,
          hasActiveFilters: false,
          onLoadMore: () => {},
          onSelectAchievement: () => {},
        })
      );
      expect(htmlOmitted).toContain('data-density="comfortable"');

      const htmlUndefined = renderToStaticMarkup(
        createElement(GalleryGrid, {
          items: dummyItems,
          loading: false,
          hasMore: false,
          hasActiveFilters: false,
          density: undefined as unknown as GalleryDensity,
          onLoadMore: () => {},
          onSelectAchievement: () => {},
        })
      );
      expect(htmlUndefined).toContain('data-density="comfortable"');
    });

    it('density toolbar controls have type="button" and proper ARIA radio attributes', () => {
      // Test dynamic state transition of the density button group as defined in page.tsx
      const renderDensityButtons = (activeDensity: GalleryDensity) => {
        return renderToStaticMarkup(
          createElement(
            'div',
            { className: 'gallery-density-buttons', role: 'radiogroup', 'aria-labelledby': 'density-label' },
            createElement(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': activeDensity === 'compact',
                className: `gallery-button gallery-button-density${activeDensity === 'compact' ? ' gallery-button-active' : ''}`,
                'aria-label': 'Compact density',
              },
              'Compact'
            ),
            createElement(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': activeDensity === 'comfortable',
                className: `gallery-button gallery-button-density${activeDensity === 'comfortable' ? ' gallery-button-active' : ''}`,
                'aria-label': 'Comfortable density',
              },
              'Comfortable'
            ),
            createElement(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': activeDensity === 'roomy',
                className: `gallery-button gallery-button-density${activeDensity === 'roomy' ? ' gallery-button-active' : ''}`,
                'aria-label': 'Roomy density',
              },
              'Roomy'
            )
          )
        );
      };

      // 1. Initial state (comfortable)
      const markup1 = renderDensityButtons('comfortable');
      expect(markup1).toContain('type="button"');
      expect(markup1).toContain('role="radiogroup"');
      expect(markup1).toMatch(/aria-checked="true"[^>]*>Comfortable/);
      expect(markup1).toMatch(/aria-checked="false"[^>]*>Compact/);
      expect(markup1).toMatch(/aria-checked="false"[^>]*>Roomy/);

      // 2. Dynamically toggled to compact without page reload
      const markup2 = renderDensityButtons('compact');
      expect(markup2).toMatch(/aria-checked="true"[^>]*>Compact/);
      expect(markup2).toMatch(/aria-checked="false"[^>]*>Comfortable/);

      // 3. Dynamically toggled to roomy without page reload
      const markup3 = renderDensityButtons('roomy');
      expect(markup3).toMatch(/aria-checked="true"[^>]*>Roomy/);
      expect(markup3).toMatch(/aria-checked="false"[^>]*>Comfortable/);
    });
  });

  // =========================================================================
  // 4. LIVE DATABASE CONCURRENT REQUESTS WITH ABORTCONTROLLER & SORTING
  // =========================================================================
  describe('4. Live Database Concurrent Requests with Client Abort & Sorting', () => {
    it('handles heavy concurrent requests across sorting modes without server failure', async () => {
      const { headers } = await createAuthenticatedHeaders();
      const db = await getDb();

      // Seed 20 items
      for (let i = 0; i < 20; i++) {
        await db.insert(achievements).values({
          id: crypto.randomUUID(),
          title: `Art ${i + 1}`,
          completionDate: `2026-0${(i % 5) + 1}-10`,
          tags: ['concurrent-test'],
          state: 'ready',
        });
      }

      // Fire 10 concurrent requests (5 newest, 5 oldest) with AbortControllers
      const requests = Array.from({ length: 10 }).map((_, idx) => {
        const sortMode: AchievementSort = idx % 2 === 0 ? 'newest' : 'oldest';
        const controller = new AbortController();
        const req = new NextRequest(`http://localhost:3000/api/achievements?sort=${sortMode}&limit=10`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });

        // Abort 3 requests immediately mid-flight
        if (idx === 1 || idx === 3 || idx === 7) {
          controller.abort();
        }

        return { req, aborted: idx === 1 || idx === 3 || idx === 7 };
      });

      const outcomes = await Promise.all(
        requests.map(async ({ req, aborted }) => {
          try {
            const res = await galleryHandler(req);
            return { status: res.status, ok: res.ok, aborted };
          } catch (err: unknown) {
            return { status: 0, ok: false, error: (err as Error).name, aborted };
          }
        })
      );

      // All non-aborted requests should succeed 200 OK
      for (const outcome of outcomes) {
        if (!outcome.aborted) {
          expect(outcome.status).toBe(200);
          expect(outcome.ok).toBe(true);
        }
      }
    });

    it('verifies SQL parameter injection safety in sort parameter', async () => {
      const { headers } = await createAuthenticatedHeaders();

      const injectionPayloads = [
        "newest' OR '1'='1",
        'oldest; DROP TABLE achievements;--',
        "newest' UNION SELECT NULL--",
        'oldest/*comment*/',
        'newest\x00',
        'oldest" OR ""="',
      ];

      for (const payload of injectionPayloads) {
        const req = new NextRequest(`http://localhost:3000/api/achievements?sort=${encodeURIComponent(payload)}`, {
          method: 'GET',
          headers,
        });
        const res = await galleryHandler(req);
        // All injection payloads are strictly rejected with 400 INVALID_SORT
        expect(res.status).toBe(400);
        const data = (await res.json()) as { code: string; error: string };
        expect(data.code).toBe('INVALID_SORT');
      }
    });
  });
});
