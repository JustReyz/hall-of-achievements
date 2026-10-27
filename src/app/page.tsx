'use client';

import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { AchievementItem, GalleryResponse, StorageQuotaInfo } from '@/components/gallery/types';
import type { GalleryFilters } from '@/components/gallery/types';
import { SearchBar } from '@/components/gallery/SearchBar';
import { TagBrowser } from '@/components/gallery/TagBrowser';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { AddAchievementModal } from '@/components/gallery/AddAchievementModal';
import { AchievementDetailModal } from '@/components/gallery/AchievementDetailModal';
import { ContactSheetExport } from '@/components/gallery/ContactSheetExport';
import type { ViewerBackground } from '@/components/gallery/ArtworkViewer';
import { NotificationPanel } from '@/components/notifications/NotificationPanel';
import { validateDateRange } from '@/lib/validation/achievement';
import { CONTACT_SHEET_MAX_ITEMS } from '@/lib/image/contact-sheet';

interface SessionStatus {
  authenticated: boolean;
  expiresAt?: string;
  idleExpiresAt?: string;
  error?: string;
}

const EMPTY_FILTERS: GalleryFilters = { q: '', from: '', to: '', tag: '' };

interface GalleryRequestResult {
  ok: boolean;
  items: AchievementItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

function matchesGalleryFilters(item: AchievementItem, filters: GalleryFilters): boolean {
  if (filters.from && item.completionDate < filters.from) return false;
  if (filters.to && item.completionDate > filters.to) return false;
  if (filters.tag && !item.tags.includes(filters.tag)) return false;

  const query = filters.q.trim().toLowerCase();
  if (!query) return true;

  return (
    item.title.toLowerCase().includes(query) ||
    (item.notes ?? '').toLowerCase().includes(query) ||
    JSON.stringify(item.tags).toLowerCase().includes(query)
  );
}

export default function HomePage() {
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [accessCode, setAccessCode] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  // Gallery state
  const [items, setItems] = useState<AchievementItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [filters, setFilters] = useState<GalleryFilters>(EMPTY_FILTERS);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagLoading, setTagLoading] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const tagRequestGeneration = useRef(0);
  const appendRequests = useRef(new Map<string, Promise<GalleryRequestResult>>());
  const navigationGeneration = useRef(0);
  const navigationRequestId = useRef(0);
  const [navigationPending, setNavigationPending] = useState(false);
  const [quota, setQuota] = useState<StorageQuotaInfo | null>(null);

  // Modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<AchievementItem | null>(null);
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [viewerBackground, setViewerBackground] = useState<ViewerBackground>('black');
  const [contactSheetMode, setContactSheetMode] = useState(false);
  const [contactSheetSelection, setContactSheetSelection] = useState<string[]>([]);
  const [contactSheetScope, setContactSheetScope] = useState(0);

  const loadedById = new Map(items.map((item) => [item.id, item]));
  const contactSheetItems = contactSheetSelection
    .map((id) => loadedById.get(id))
    .filter((item): item is AchievementItem => Boolean(item));

  const selectedAchievement =
    (selectedId ? items.find((item) => item.id === selectedId) : undefined) ??
    (selectedSnapshot && selectedSnapshot.id === selectedId ? selectedSnapshot : null);
  const selectedIndex = selectedAchievement
    ? items.findIndex((item) => item.id === selectedAchievement.id)
    : -1;
  const hasPreviousArtwork = selectedIndex > 0;
  const hasNextArtwork =
    selectedIndex >= 0 && (selectedIndex < items.length - 1 || hasMore);

  const invalidateNavigation = useCallback(() => {
    navigationGeneration.current++;
    navigationRequestId.current++;
    setNavigationPending(false);
  }, []);

  const closeDetail = useCallback(() => {
    invalidateNavigation();
    setSelectedId(null);
    setSelectedSnapshot(null);
    setIsViewerOpen(false);
  }, [invalidateNavigation]);

  const closeViewer = useCallback(() => {
    invalidateNavigation();
    setIsViewerOpen(false);
  }, [invalidateNavigation]);

  const resetContactSheetSelection = useCallback(() => {
    setContactSheetSelection([]);
    setContactSheetScope((generation) => generation + 1);
  }, []);

  const toggleContactSheetSelection = useCallback((item: AchievementItem) => {
    setContactSheetSelection((previous) => {
      if (previous.includes(item.id)) {
        return previous.filter((id) => id !== item.id);
      }
      if (previous.length >= CONTACT_SHEET_MAX_ITEMS) return previous;
      return [...previous, item.id];
    });
  }, []);

  const selectLoadedForContactSheet = useCallback(() => {
    setContactSheetSelection((previous) => {
      if (previous.length >= CONTACT_SHEET_MAX_ITEMS) return previous;
      const next = [...previous];
      for (const item of items) {
        if (next.length >= CONTACT_SHEET_MAX_ITEMS) break;
        if (!next.includes(item.id)) next.push(item.id);
      }
      return next;
    });
  }, [items]);

  const handleSessionExpired = useCallback(() => {
    requestGeneration.current++;
    tagRequestGeneration.current++;
    setSession({ authenticated: false });
    setGalleryLoading(false);
    setTagLoading(false);
    setItems([]);
    setTags([]);
    setQuota(null);
    setCursor(null);
    setHasMore(false);
    setGalleryError(null);
    setFailedCursor(null);
    setTagError(null);
    setContactSheetMode(false);
    resetContactSheetSelection();
    closeDetail();
  }, [closeDetail, resetContactSheetSelection]);

  const selectForDetail = useCallback(
    (item: AchievementItem) => {
      invalidateNavigation();
      setSelectedId(item.id);
      setSelectedSnapshot(item);
      setIsViewerOpen(false);
    },
    [invalidateNavigation]
  );

  const selectForViewer = useCallback(
    (item: AchievementItem) => {
      invalidateNavigation();
      setSelectedId(item.id);
      setSelectedSnapshot(item);
    },
    [invalidateNavigation]
  );

  // 1. Session verification
  const checkSession = useCallback(async () => {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = (await res.json()) as SessionStatus;
        setSession(data);
        return data.authenticated;
      } else {
        setSession({ authenticated: false });
        return false;
      }
    } catch {
      setSession({ authenticated: false });
      return false;
    }
  }, []);

  // 2. Fetch Storage Quota Stats
  const fetchQuota = useCallback(async () => {
    try {
      const res = await fetch('/api/storage/quota');
      if (res.ok) {
        const data = (await res.json()) as StorageQuotaInfo;
        setQuota(data);
      }
    } catch {
      // Ignore quota fetch error
    }
  }, []);

  // 3. Fetch Achievements (first page or append)
  const fetchAchievements = useCallback(
    async (
      active: GalleryFilters,
      pageCursor: string | null = null
    ): Promise<GalleryRequestResult> => {
      const appendKey = pageCursor
        ? `${active.q}\u0000${active.from}\u0000${active.to}\u0000${active.tag}\u0000${pageCursor}`
        : null;

      if (appendKey) {
        const existing = appendRequests.current.get(appendKey);
        if (existing) return existing;
      }

      const generation = ++requestGeneration.current;
      setGalleryLoading(true);
      setGalleryError(null);
      setFailedCursor(null);
      if (!pageCursor) {
        setItems([]);
        setCursor(null);
        setHasMore(false);
      }

      const request = (async (): Promise<GalleryRequestResult> => {
        try {
          const params = new URLSearchParams({ limit: '24' });
          if (active.q) params.set('q', active.q);
          if (active.from) params.set('from', active.from);
          if (active.to) params.set('to', active.to);
          if (active.tag) params.set('tag', active.tag);
          if (pageCursor) params.set('cursor', pageCursor);
          const response = await fetch(`/api/achievements?${params}`);
          if (generation !== requestGeneration.current) {
            return { ok: false, items: [], nextCursor: null, hasMore: false };
          }
          if (response.status === 401) {
            handleSessionExpired();
            return { ok: false, items: [], nextCursor: null, hasMore: false };
          }
          if (!response.ok) throw new Error('Failed to load artwork. Please retry.');
          const data = (await response.json()) as GalleryResponse;
          if (generation !== requestGeneration.current) {
            return { ok: false, items: [], nextCursor: null, hasMore: false };
          }
          setItems((previous) => (pageCursor ? [...previous, ...data.items] : data.items));
          setCursor(data.nextCursor);
          setHasMore(data.hasMore);
          return {
            ok: true,
            items: data.items,
            nextCursor: data.nextCursor,
            hasMore: data.hasMore,
          };
        } catch {
          if (generation === requestGeneration.current) {
            setGalleryError('Failed to load artwork. Please retry.');
            setFailedCursor(pageCursor);
          }
          return { ok: false, items: [], nextCursor: null, hasMore: false };
        } finally {
          if (generation === requestGeneration.current) {
            setGalleryLoading(false);
          }
        }
      })();

      if (appendKey) {
        appendRequests.current.set(appendKey, request);
        void request.finally(() => {
          if (appendRequests.current.get(appendKey) === request) {
            appendRequests.current.delete(appendKey);
          }
        });
      }

      return request;
    },
    [handleSessionExpired]
  );

  // 4. Fetch the tag facet for the active search and date filters.
  const fetchTags = useCallback(
    async (active: GalleryFilters) => {
      const generation = ++tagRequestGeneration.current;
      setTagLoading(true);
      setTagError(null);

      try {
        const params = new URLSearchParams();
        if (active.q) params.set('q', active.q);
        if (active.from) params.set('from', active.from);
        if (active.to) params.set('to', active.to);
        const query = params.toString();
        const response = await fetch(`/api/tags${query ? `?${query}` : ''}`);
        if (generation !== tagRequestGeneration.current) return;
        if (response.status === 401) {
          handleSessionExpired();
          return;
        }
        if (!response.ok) throw new Error('Failed to load tags. Please retry.');
        const data = (await response.json()) as { tags: string[] };
        if (generation !== tagRequestGeneration.current) return;
        setTags(data.tags);
      } catch {
        if (generation === tagRequestGeneration.current) {
          setTagError('Failed to load tags. Please retry.');
        }
      } finally {
        if (generation === tagRequestGeneration.current) {
          setTagLoading(false);
        }
      }
    },
    [handleSessionExpired]
  );

  // Initial load
  useEffect(() => {
    void checkSession().then((isAuth) => {
      if (isAuth) {
        void fetchAchievements(EMPTY_FILTERS);
        void fetchTags(EMPTY_FILTERS);
        void fetchQuota();
      }
    });
  }, [checkSession, fetchAchievements, fetchQuota, fetchTags]);

  // Invalidate in-flight requests when the page unmounts.
  useEffect(
    () => () => {
      requestGeneration.current++;
      tagRequestGeneration.current++;
    },
    []
  );

  const applyFilters = useCallback(
    (next: GalleryFilters) => {
      // SearchBar re-emits its debounced value after Clear; an unchanged filter set
      // must not close an open detail dialog or refetch the gallery.
      if (
        next.q === filters.q &&
        next.from === filters.from &&
        next.to === filters.to &&
        next.tag === filters.tag
      ) {
        return;
      }
      closeDetail();
      resetContactSheetSelection();
      setFilters(next);
      void fetchAchievements(next);
      void fetchTags(next);
    },
    [closeDetail, fetchAchievements, fetchTags, filters, resetContactSheetSelection]
  );

  // Handle Search input from SearchBar
  const handleSearch = useCallback(
    (q: string) => {
      applyFilters({ ...filters, q });
    },
    [applyFilters, filters]
  );

  // The tag facet ignores the selected tag, so selecting one refreshes only the gallery.
  const handleSelectTag = useCallback(
    (tag: string) => {
      if (tag === filters.tag) return;
      closeDetail();
      resetContactSheetSelection();
      const next = { ...filters, tag };
      setFilters(next);
      void fetchAchievements(next);
    },
    [closeDetail, fetchAchievements, filters, resetContactSheetSelection]
  );

  const handleApplyDates = (event: FormEvent) => {
    event.preventDefault();
    try {
      const range = validateDateRange(draftFrom, draftTo);
      setDateError(null);
      applyFilters({ ...filters, ...range });
    } catch (error) {
      setDateError(error instanceof Error ? error.message : 'Enter a valid date range.');
    }
  };

  const handleClearDates = () => {
    setDraftFrom('');
    setDraftTo('');
    setDateError(null);
    applyFilters({ ...filters, from: '', to: '' });
  };

  const handleLoadMore = async () => {
    if (cursor) await fetchAchievements(filters, cursor);
  };

  const goPrevious = useCallback(() => {
    if (selectedIndex <= 0) return;
    const previous = items[selectedIndex - 1];
    if (previous) selectForViewer(previous);
  }, [items, selectForViewer, selectedIndex]);

  const goNext = useCallback(async () => {
    if (selectedIndex < 0) return;

    if (selectedIndex < items.length - 1) {
      const next = items[selectedIndex + 1];
      if (next) selectForViewer(next);
      return;
    }

    if (!hasMore || !cursor) return;

    invalidateNavigation();
    const generation = navigationGeneration.current;
    const requestId = ++navigationRequestId.current;
    setNavigationPending(true);

    const result = await fetchAchievements(filters, cursor);

    if (
      generation !== navigationGeneration.current ||
      requestId !== navigationRequestId.current
    ) {
      return;
    }

    setNavigationPending(false);
    if (!result.ok) return;

    const next = result.items[0];
    if (next) selectForViewer(next);
  }, [
    cursor,
    fetchAchievements,
    filters,
    hasMore,
    invalidateNavigation,
    items,
    selectForViewer,
    selectedIndex,
  ]);

  // Handle Login
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthMessage(null);

    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ code: accessCode }),
      });

      const data = (await res.json()) as { error?: string; authenticated?: boolean };

      if (res.ok) {
        setAccessCode('');
        const isAuth = await checkSession();
        if (isAuth) {
          setFilters(EMPTY_FILTERS);
          setDraftFrom('');
          setDraftTo('');
          setDateError(null);
          setContactSheetMode(false);
          resetContactSheetSelection();
          void fetchAchievements(EMPTY_FILTERS);
          void fetchTags(EMPTY_FILTERS);
          void fetchQuota();
        }
      } else {
        setAuthMessage(data.error ?? 'Authentication failed');
      }
    } catch {
      setAuthMessage('Failed to connect to authentication service');
    } finally {
      setAuthLoading(false);
    }
  };

  // Handle Logout
  const handleLogout = async () => {
    try {
      await fetch('/api/session', {
        method: 'DELETE',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
    } catch {
      // Ignore network failures; local state still closes the archive.
    }
    handleSessionExpired();
    setFilters(EMPTY_FILTERS);
    setDraftFrom('');
    setDraftTo('');
    setDateError(null);
  };

  // Callback when a new achievement is added
  const handleAddSuccess = () => {
    resetContactSheetSelection();
    void fetchAchievements(filters);
    void fetchTags(filters);
    void fetchQuota();
  };

  // Callback when an achievement is updated
  const handleUpdateAchievement = (updated: AchievementItem) => {
    resetContactSheetSelection();
    if (!matchesGalleryFilters(updated, filters)) {
      closeDetail();
    } else {
      setSelectedSnapshot(updated);
    }
    void fetchAchievements(filters);
    void fetchTags(filters);
  };

  // Callback when an achievement is deleted
  const handleDeleteAchievement = () => {
    resetContactSheetSelection();
    closeDetail();
    void fetchAchievements(filters);
    void fetchTags(filters);
    void fetchQuota();
  };

  // If session check still pending
  if (session === null) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc' }}>
        <div style={{ color: '#64748b', fontSize: '16px' }}>Loading archive...</div>
      </main>
    );
  }

  // Unauthenticated View: Owner Login Screen
  if (!session.authenticated) {
    return (
      <main style={{ maxWidth: 440, margin: '80px auto', padding: '0 20px' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '48px', marginBottom: 8 }}>🏛️</div>
          <h1 style={{ margin: '0 0 6px 0', fontSize: '28px', color: '#0f172a' }}>Hall of Achievements</h1>
          <p style={{ margin: 0, color: '#64748b', fontSize: '15px' }}>Private Art Archive & Milestone Vault</p>
        </div>

        <div
          style={{
            backgroundColor: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: 28,
            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
          }}
        >
          <form onSubmit={(e) => void handleLogin(e)}>
            <div style={{ marginBottom: 16 }}>
              <label
                htmlFor="accessCode"
                style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: '14px', color: '#334155' }}
              >
                Owner Access Code:
              </label>
              <input
                id="accessCode"
                type="password"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="Enter private access code"
                autoFocus
                required
                disabled={authLoading}
                aria-invalid={Boolean(authMessage)}
                aria-describedby={authMessage ? 'auth-error' : undefined}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '10px 14px',
                  borderRadius: 6,
                  border: '1px solid #cbd5e1',
                  fontSize: '15px',
                  minHeight: 44,
                }}
              />
            </div>

            <button
              type="submit"
              disabled={authLoading}
              style={{
                width: '100%',
                padding: '11px 16px',
                minHeight: 44,
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: '15px',
                cursor: authLoading ? 'not-allowed' : 'pointer',
                opacity: authLoading ? 0.7 : 1,
              }}
            >
              {authLoading ? 'Verifying...' : 'Unlock Archive'}
            </button>
          </form>

          {authMessage && (
            <div
              id="auth-error"
              role="alert"
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 6,
                backgroundColor: '#fef2f2',
                color: '#991b1b',
                fontSize: '14px',
                border: '1px solid #fecaca',
              }}
            >
              {authMessage}
            </div>
          )}
        </div>
      </main>
    );
  }

  // Authenticated View: Full Gallery Experience
  const usageMb = quota ? (quota.totalAccountedBytes / 1024 / 1024).toFixed(1) : '0';
  const ceilingMb = quota ? (quota.ceilingBytes / 1024 / 1024).toFixed(1) : '751.6';
  const usagePercent = quota && quota.ceilingBytes > 0
    ? Math.round((quota.totalAccountedBytes / quota.ceilingBytes) * 100)
    : 0;

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f8fafc', color: '#0f172a' }}>
      {/* Top Application Header */}
      <header
        style={{
          backgroundColor: '#fff',
          borderBottom: '1px solid #e2e8f0',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            padding: '14px 20px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          {/* Logo / Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '24px' }}>🎨</span>
            <div>
              <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                Hall of Achievements
              </h1>
              <span style={{ fontSize: '12px', color: '#64748b' }}>Private Art Archive</span>
            </div>
          </div>

          {/* Controls: Quota, Add button, Logout */}
          <nav aria-label="Archive actions" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* Storage Quota Badge */}
            {quota && (
              <div
                role="status"
                title={`Accounted: ${usageMb} MB of ${ceilingMb} MB (70% safe provider ceiling)`}
                style={{
                  fontSize: '12px',
                  padding: '5px 10px',
                  borderRadius: 16,
                  backgroundColor: usagePercent > 80 ? '#fef3c7' : '#f1f5f9',
                  color: usagePercent > 80 ? '#92400e' : '#475569',
                  border: '1px solid #e2e8f0',
                  fontWeight: 500,
                }}
              >
                Storage: {usageMb} / {ceilingMb} MB ({usagePercent}%)
              </div>
            )}

            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 16px',
                minHeight: 44,
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              <span>+</span> Add Achievement
            </button>

            <button
              type="button"
              onClick={() => void handleLogout()}
              style={{
                padding: '10px 14px',
                minHeight: 44,
                backgroundColor: '#fff',
                color: '#475569',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                fontWeight: 500,
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              Log Out
            </button>
          </nav>
        </div>
      </header>

      {/* Main Gallery Area */}
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 60px' }}>
        {/* Web Push Notification Controls (M3) */}
        <NotificationPanel />

        {/* Search & Filter Bar */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: 12,
          }}
        >
          <SearchBar onSearch={handleSearch} />

          <form
            onSubmit={handleApplyDates}
            aria-label="Filter by completion date"
            style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 12 }}
          >
            <label htmlFor="completed-from" style={{ fontSize: '14px', color: '#334155', fontWeight: 500 }}>
              Completed from
              <input
                id="completed-from"
                type="date"
                value={draftFrom}
                onChange={(event) => setDraftFrom(event.target.value)}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? 'date-range-error' : undefined}
                style={{
                  display: 'block',
                  minHeight: 44,
                  marginTop: 4,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #cbd5e1',
                  fontSize: '14px',
                  color: '#1e293b',
                  backgroundColor: '#fff',
                }}
              />
            </label>
            <label htmlFor="completed-through" style={{ fontSize: '14px', color: '#334155', fontWeight: 500 }}>
              Completed through
              <input
                id="completed-through"
                type="date"
                value={draftTo}
                onChange={(event) => setDraftTo(event.target.value)}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? 'date-range-error' : undefined}
                style={{
                  display: 'block',
                  minHeight: 44,
                  marginTop: 4,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #cbd5e1',
                  fontSize: '14px',
                  color: '#1e293b',
                  backgroundColor: '#fff',
                }}
              />
            </label>
            <button
              type="submit"
              style={{
                minWidth: 44,
                minHeight: 44,
                padding: '10px 16px',
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Apply dates
            </button>
            <button
              type="button"
              onClick={handleClearDates}
              style={{
                minWidth: 44,
                minHeight: 44,
                padding: '10px 14px',
                backgroundColor: '#fff',
                color: '#475569',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                fontWeight: 500,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Clear dates
            </button>
            {dateError && (
              <p id="date-range-error" role="alert" style={{ margin: 0, color: '#991b1b', fontSize: '14px' }}>
                {dateError}
              </p>
            )}
          </form>
        </div>

        <TagBrowser
          tags={tags}
          selectedTag={filters.tag}
          loading={tagLoading}
          error={tagError}
          onSelect={handleSelectTag}
          onRetry={() => void fetchTags(filters)}
        />

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            margin: '0 0 20px 0',
          }}
        >
          <p
            role="status"
            aria-live="polite"
            style={{ margin: 0, fontSize: '14px', color: '#64748b' }}
          >
            {galleryLoading
              ? 'Loading artwork...'
              : galleryError
                ? ''
                : `${items.length} ${items.length === 1 ? 'artwork' : 'artworks'} loaded`}
          </p>

          {!contactSheetMode && (
            <button
              type="button"
              onClick={() => {
                setContactSheetSelection([]);
                setContactSheetScope((generation) => generation + 1);
                setContactSheetMode(true);
              }}
              disabled={items.length === 0}
              style={{
                minHeight: 44,
                minWidth: 44,
                padding: '9px 16px',
                backgroundColor: '#fff',
                color: '#1e293b',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 14,
                cursor: items.length === 0 ? 'not-allowed' : 'pointer',
                opacity: items.length === 0 ? 0.6 : 1,
              }}
            >
              Select for contact sheet
            </button>
          )}
        </div>

        {contactSheetMode && (
          <ContactSheetExport
            selectedItems={contactSheetItems}
            loadedCount={items.length}
            scopeKey={String(contactSheetScope)}
            onSelectLoaded={selectLoadedForContactSheet}
            onClear={resetContactSheetSelection}
            onExit={() => {
              resetContactSheetSelection();
              setContactSheetMode(false);
            }}
            onSessionExpired={handleSessionExpired}
          />
        )}

        {galleryError && (
          <div
            role="alert"
            style={{
              marginBottom: 20,
              padding: 14,
              borderRadius: 8,
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
            }}
          >
            <p style={{ margin: '0 0 10px 0', fontSize: '14px' }}>{galleryError}</p>
            <button
              type="button"
              disabled={galleryLoading}
              onClick={() => void fetchAchievements(filters, failedCursor)}
              style={{
                minWidth: 44,
                minHeight: 44,
                padding: '10px 16px',
                backgroundColor: '#fff',
                color: '#991b1b',
                border: '1px solid #fca5a5',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: '14px',
                cursor: galleryLoading ? 'not-allowed' : 'pointer',
                opacity: galleryLoading ? 0.7 : 1,
              }}
            >
              Retry loading artwork
            </button>
          </div>
        )}

        {/* Gallery Grid */}
        {(!galleryError || items.length > 0) && (
          <GalleryGrid
            items={items}
            loading={galleryLoading}
            hasMore={hasMore && !galleryError}
            hasActiveFilters={Boolean(filters.q || filters.from || filters.to || filters.tag)}
            onLoadMore={() => void handleLoadMore()}
            onSelectAchievement={selectForDetail}
            onOpenAddModal={() => setIsAddModalOpen(true)}
            selectionMode={contactSheetMode}
            selectedIds={contactSheetSelection}
            onToggleSelection={toggleContactSheetSelection}
          />
        )}
      </main>

      {/* Modals */}
      <AddAchievementModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={handleAddSuccess}
      />

      <AchievementDetailModal
        achievement={selectedAchievement}
        viewerOpen={isViewerOpen}
        viewerBackground={viewerBackground}
        hasPrevious={hasPreviousArtwork}
        hasNext={hasNextArtwork}
        navigationPending={navigationPending}
        onClose={closeDetail}
        onViewerOpen={() => setIsViewerOpen(true)}
        onViewerClose={closeViewer}
        onPrevious={goPrevious}
        onNext={() => void goNext()}
        onViewerBackgroundChange={setViewerBackground}
        onUpdate={handleUpdateAchievement}
        onDelete={handleDeleteAchievement}
      />
    </div>
  );
}
