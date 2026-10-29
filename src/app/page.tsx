'use client';

import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { AchievementItem, GalleryResponse, StorageQuotaInfo } from '@/components/gallery/types';
import type { GalleryFilters, RestoreRequest } from '@/components/gallery/types';
import { SearchBar } from '@/components/gallery/SearchBar';
import { TagBrowser } from '@/components/gallery/TagBrowser';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { AddAchievementModal } from '@/components/gallery/AddAchievementModal';
import { AchievementDetailModal } from '@/components/gallery/AchievementDetailModal';
import { ArchiveHealthPanel } from '@/components/gallery/ArchiveHealthPanel';
import { TrashPanel } from '@/components/gallery/TrashPanel';
import { ToolDialog } from '@/components/gallery/ToolDialog';
import { CollectionPanel } from '@/components/gallery/CollectionPanel';
import type { CollectionSummary } from '@/components/gallery/types';
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

type GalleryTool =
  | 'archive'
  | 'filters'
  | 'collections'
  | 'health'
  | 'trash'
  | 'notifications';

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
  const [activeTool, setActiveTool] = useState<GalleryTool | null>(null);
  const [toolReturnTarget, setToolReturnTarget] = useState<HTMLElement | null>(null);
  const [contactSheetFocusRequest, setContactSheetFocusRequest] = useState(0);
  const archiveToolsButtonRef = useRef<HTMLButtonElement>(null);
  const filtersButtonRef = useRef<HTMLButtonElement>(null);
  const collectionsButtonRef = useRef<HTMLButtonElement>(null);
  const suppressArchiveFocusRestore = useRef(false);
  const detailReturnTarget = useRef<HTMLElement | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<AchievementItem | null>(null);
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [viewerBackground, setViewerBackground] = useState<ViewerBackground>('black');
  const [contactSheetMode, setContactSheetMode] = useState(false);
  const [contactSheetSelection, setContactSheetSelection] = useState<string[]>([]);
  const [contactSheetScope, setContactSheetScope] = useState(0);
  const [restoreRequest, setRestoreRequest] = useState<RestoreRequest | null>(null);
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [selectedCollection, setSelectedCollection] = useState<CollectionSummary | null>(null);
  // Read at request time so a collection change can never race an in-flight page.
  const collectionRef = useRef<CollectionSummary | null>(null);

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
    setRestoreRequest(null);
  }, [invalidateNavigation]);

  const closeDetailWithReturn = useCallback(() => {
    const target = detailReturnTarget.current;
    detailReturnTarget.current = null;
    closeDetail();
    if (!target) return;

    requestAnimationFrame(() => {
      if (!target.isConnected || !target.getClientRects().length) return;
      if (document.querySelector('dialog[open]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      target.focus({ preventScroll: true });
    });
  }, [closeDetail]);

  const openTool = useCallback((tool: GalleryTool, returnTarget: HTMLElement | null) => {
    closeDetail();
    suppressArchiveFocusRestore.current = false;
    setToolReturnTarget(returnTarget);
    setActiveTool(tool);
  }, [closeDetail]);

  const closeTool = useCallback(() => {
    invalidateNavigation();
    setActiveTool(null);
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

  const startContactSheet = useCallback(() => {
    suppressArchiveFocusRestore.current = true;
    closeTool();
    resetContactSheetSelection();
    setContactSheetMode(true);
    setContactSheetFocusRequest((request) => request + 1);
  }, [closeTool, resetContactSheetSelection]);

  const exitContactSheet = useCallback(() => {
    resetContactSheetSelection();
    setContactSheetMode(false);
  }, [resetContactSheetSelection]);

  const handleSessionExpired = useCallback(() => {
    requestGeneration.current++;
    tagRequestGeneration.current++;
    setActiveTool(null);
    setToolReturnTarget(null);
    suppressArchiveFocusRestore.current = false;
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
      detailReturnTarget.current = null;
      setSelectedId(item.id);
      setSelectedSnapshot(item);
      setIsViewerOpen(false);
      setRestoreRequest(null);
    },
    [invalidateNavigation]
  );

  const selectForViewer = useCallback(
    (item: AchievementItem) => {
      invalidateNavigation();
      detailReturnTarget.current = null;
      setSelectedId(item.id);
      setSelectedSnapshot(item);
      setRestoreRequest(null);
    },
    [invalidateNavigation]
  );

  const openRestoreRequest = useCallback(
    async (request: RestoreRequest) => {
      invalidateNavigation();
      const navigation = navigationGeneration.current;
      const generation = requestGeneration.current;
      const isCurrent = () =>
        navigation === navigationGeneration.current && generation === requestGeneration.current;
      const loaded = items.find((item) => item.id === request.achievementId);
      if (loaded) {
        detailReturnTarget.current = archiveToolsButtonRef.current;
        setActiveTool(null);
        setSelectedId(loaded.id);
        setSelectedSnapshot(loaded);
        setIsViewerOpen(false);
        setRestoreRequest(request);
        return;
      }

      let response: Response;
      try {
        response = await fetch(`/api/achievements/${request.achievementId}`);
      } catch {
        if (!isCurrent()) return;
        throw new Error('Could not open this artwork. Please retry.');
      }

      if (!isCurrent()) return;
      if (response.status === 401) {
        handleSessionExpired();
        throw new Error('Your session expired. Unlock the archive and check again.');
      }
      if (!response.ok) {
        throw new Error('Could not open this artwork. Please retry.');
      }

      let item: AchievementItem;
      try {
        item = (await response.json()) as AchievementItem;
      } catch {
        if (!isCurrent()) return;
        throw new Error('Could not open this artwork. Please retry.');
      }
      if (!isCurrent()) return;

      detailReturnTarget.current = archiveToolsButtonRef.current;
      setActiveTool(null);
      setSelectedId(item.id);
      setSelectedSnapshot(item);
      setIsViewerOpen(false);
      setRestoreRequest(request);
    },
    [handleSessionExpired, invalidateNavigation, items]
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
      pageCursor: string | null = null,
      options: { preserveItems?: boolean } = {}
    ): Promise<GalleryRequestResult> => {
      const collection = collectionRef.current;
      const appendKey = pageCursor
        ? `${active.q}\u0000${active.from}\u0000${active.to}\u0000${active.tag}\u0000${collection?.id ?? ''}\u0000${pageCursor}`
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
        // A background refresh (edit or revision bump) keeps the mounted cards so
        // focus can return to the artwork the owner was viewing.
        if (!options.preserveItems) setItems([]);
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
          const endpoint = collection
            ? `/api/collections/${collection.id}/items`
            : '/api/achievements';
          const response = await fetch(`${endpoint}?${params}`);
          if (generation !== requestGeneration.current) {
            return { ok: false, items: [], nextCursor: null, hasMore: false };
          }
          if (response.status === 401) {
            handleSessionExpired();
            return { ok: false, items: [], nextCursor: null, hasMore: false };
          }
          if (response.status === 409 && collection) {
            setGalleryError('This collection changed. Reloading its first page…');
            setFailedCursor(null);
            setGalleryLoading(false);
            void fetchAchievements(active, null);
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
        const collection = collectionRef.current;
        if (collection) params.set('collectionId', collection.id);
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
    closeTool();
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
    setArchiveRevision((revision) => revision + 1);
    void fetchAchievements(filters);
    void fetchTags(filters);
    void fetchQuota();
  };

  // Callback when an achievement is updated
  const handleUpdateAchievement = (updated: AchievementItem) => {
    resetContactSheetSelection();
    setArchiveRevision((revision) => revision + 1);
    setRestoreRequest(null);
    if (!matchesGalleryFilters(updated, filters)) {
      closeDetail();
    } else {
      setSelectedSnapshot(updated);
    }
    void fetchAchievements(filters, null, { preserveItems: true });
    void fetchTags(filters);
  };

  // Callback when an achievement is deleted
  const handleDeleteAchievement = () => {
    resetContactSheetSelection();
    setArchiveRevision((revision) => revision + 1);
    closeDetail();
    void fetchAchievements(filters);
    void fetchTags(filters);
    void fetchQuota();
  };

  // Applying a collection replaces the gallery source. The cursor, contact-sheet
  // selection, and viewer navigation belong to the previous scope and are cleared.
  const applyCollection = useCallback(
    (collection: CollectionSummary | null) => {
      collectionRef.current = collection;
      setSelectedCollection(collection);
      invalidateNavigation();
      resetContactSheetSelection();
      closeDetail();
      setGalleryError(null);
      void fetchAchievements(filters, null);
      void fetchTags(filters);
    },
    [invalidateNavigation, resetContactSheetSelection, closeDetail, fetchAchievements, fetchTags, filters]
  );

  // Reordering or re-membering a collection changes the curated page, so refresh
  // the gallery in its current scope as well as the panels keyed on the revision.
  const handleCollectionsChanged = useCallback(() => {
    setArchiveRevision((revision) => revision + 1);
    void fetchAchievements(filters, null);
    void fetchTags(filters);
  }, [fetchAchievements, fetchTags, filters]);

  // Trash actions change what the gallery and tags should show without changing
  // the active filters.
  const handleTrashChanged = useCallback(() => {
    resetContactSheetSelection();
    setArchiveRevision((revision) => revision + 1);
    closeDetail();
    void fetchAchievements(filters);
    void fetchTags(filters);
    void fetchQuota();
  }, [resetContactSheetSelection, closeDetail, fetchAchievements, fetchTags, fetchQuota, filters]);

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
  const storageWarning = usagePercent > 80;
  const hasAppliedScope = Boolean(
    selectedCollection || filters.from || filters.to || filters.tag
  );
  const dateScope = filters.from && filters.to
    ? `${filters.from} to ${filters.to}`
    : filters.from
      ? `From ${filters.from}`
      : `Through ${filters.to}`;

  return (
    <div className="gallery-page">
      <header className="gallery-header">
        <div className="gallery-shell gallery-header-inner">
          <div className="gallery-brand">
            <h1>Hall of Achievements</h1>
            <p>Private art archive</p>
          </div>
          <nav aria-label="Archive actions" className="gallery-header-actions">
            <button
              type="button"
              className="gallery-button gallery-button-primary"
              aria-haspopup="dialog"
              onClick={() => setIsAddModalOpen(true)}
            >
              <span aria-hidden="true">+</span> Add artwork
            </button>
            <button
              ref={archiveToolsButtonRef}
              type="button"
              className="gallery-button gallery-button-quiet"
              aria-haspopup="dialog"
              onClick={() => openTool('archive', archiveToolsButtonRef.current)}
            >
              Archive tools
              {storageWarning && (
                <span className="gallery-tools-warning">Storage {usagePercent}% full</span>
              )}
            </button>
          </nav>
        </div>
      </header>

      <main className="gallery-shell gallery-main">
        <div className="gallery-collection-header">
          <h2>Your collection</h2>
          <p role="status" aria-live="polite" className="gallery-collection-count">
            {galleryError
              ? 'Could not load artwork'
              : galleryLoading && items.length === 0
                ? 'Loading artwork...'
                : `${items.length} ${items.length === 1 ? 'artwork' : 'artworks'} loaded${
                    selectedCollection ? ` in "${selectedCollection.name}"` : ''
                  }`}
          </p>
        </div>

        <div className="gallery-toolbar">
          <div className="gallery-search"><SearchBar onSearch={handleSearch} /></div>
          <nav aria-label="Gallery tools" className="gallery-toolbar-actions">
            <button
              ref={filtersButtonRef}
              type="button"
              className="gallery-button"
              aria-haspopup="dialog"
              onClick={() => openTool('filters', filtersButtonRef.current)}
            >
              Filters
            </button>
            <button
              ref={collectionsButtonRef}
              type="button"
              className="gallery-button"
              aria-haspopup="dialog"
              onClick={() => openTool('collections', collectionsButtonRef.current)}
            >
              Collections
            </button>
          </nav>
        </div>

        {hasAppliedScope && (
          <div className="gallery-scope" aria-label="Applied gallery scope">
            {selectedCollection && (
              <span>Collection <strong>{selectedCollection.name}</strong></span>
            )}
            {(filters.from || filters.to) && (
              <span>Dates <strong>{dateScope}</strong></span>
            )}
            {filters.tag && <span>Tag <strong>#{filters.tag}</strong></span>}
          </div>
        )}

        <div className="gallery-results">
          {contactSheetMode && (
            <ContactSheetExport
              selectedItems={contactSheetItems}
              loadedCount={items.length}
              scopeKey={String(contactSheetScope)}
              focusRequest={contactSheetFocusRequest}
              onSelectLoaded={selectLoadedForContactSheet}
              onClear={resetContactSheetSelection}
              onExit={exitContactSheet}
              onSessionExpired={handleSessionExpired}
            />
          )}

          {galleryError && (
            <div role="alert" className="gallery-error">
              <p>{galleryError}</p>
              <button
                type="button"
                className="gallery-button"
                disabled={galleryLoading}
                onClick={() => void fetchAchievements(filters, failedCursor)}
              >
                Retry loading artwork
              </button>
            </div>
          )}

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
        </div>
      </main>

      <ToolDialog
        open={activeTool === 'archive'}
        label="Archive tools"
        onClose={closeTool}
        returnFocus={toolReturnTarget}
        shouldRestoreFocus={() => !suppressArchiveFocusRestore.current}
      >
        <div className="gallery-archive-tools">
          <div className="gallery-storage-summary">
            <div>
              <p className="gallery-storage-label">Storage</p>
              <p className="gallery-storage-value">{usageMb} MB of {ceilingMb} MB</p>
            </div>
            <span className="gallery-storage-percent">{usagePercent}%</span>
          </div>
          <p className="gallery-storage-note">
            Accounted against the 70% safe provider ceiling.
          </p>
          {storageWarning && (
            <p role="status" className="gallery-storage-warning">
              Storage is at {usagePercent}% of the safe ceiling. Remove artwork or export a
              backup before adding more.
            </p>
          )}

          <div className="gallery-tool-list">
            <button
              type="button"
              className="gallery-tool-entry"
              aria-haspopup="dialog"
              onClick={() => openTool('health', archiveToolsButtonRef.current)}
            >
              <span className="gallery-tool-entry-label">Archive health</span>
              <span className="gallery-tool-entry-detail">
                Check stored files, metadata, and missing previews.
              </span>
            </button>
            <button
              type="button"
              className="gallery-tool-entry"
              aria-haspopup="dialog"
              onClick={() => openTool('trash', archiveToolsButtonRef.current)}
            >
              <span className="gallery-tool-entry-label">Trash</span>
              <span className="gallery-tool-entry-detail">
                Review deleted artwork before purging it.
              </span>
            </button>
            <button
              type="button"
              className="gallery-tool-entry"
              aria-haspopup="dialog"
              onClick={() => openTool('notifications', archiveToolsButtonRef.current)}
            >
              <span className="gallery-tool-entry-label">Notifications</span>
              <span className="gallery-tool-entry-detail">
                Manage push alerts and delivery tests.
              </span>
            </button>
            <button
              type="button"
              className="gallery-tool-entry"
              onClick={startContactSheet}
              disabled={items.length === 0}
            >
              <span className="gallery-tool-entry-label">Select for contact sheet</span>
              <span className="gallery-tool-entry-detail">
                Choose up to 24 loaded artworks and export a PNG.
              </span>
            </button>
          </div>

          <div className="gallery-tools-footer">
            <button type="button" className="gallery-button gallery-button-quiet" onClick={() => void handleLogout()}>
              Log out
            </button>
          </div>
        </div>
      </ToolDialog>

      <ToolDialog
        open={activeTool === 'filters'}
        label="Filters"
        onClose={closeTool}
        returnFocus={toolReturnTarget}
      >
        <section className="gallery-filters" aria-labelledby="gallery-filters-heading">
          <h2 id="gallery-filters-heading">Filter artwork</h2>
          <p>Choose completion dates and a tag to narrow the gallery.</p>
          <form onSubmit={handleApplyDates} aria-label="Filter by completion date" className="gallery-date-form">
            <label htmlFor="completed-from">
              Completed from
              <input
                id="completed-from"
                type="date"
                value={draftFrom}
                onChange={(event) => setDraftFrom(event.target.value)}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? 'date-range-error' : undefined}
              />
            </label>
            <label htmlFor="completed-through">
              Completed through
              <input
                id="completed-through"
                type="date"
                value={draftTo}
                onChange={(event) => setDraftTo(event.target.value)}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? 'date-range-error' : undefined}
              />
            </label>
            <button type="submit" className="gallery-button gallery-button-primary">Apply dates</button>
            <button type="button" className="gallery-button" onClick={handleClearDates}>Clear dates</button>
            {dateError && <p id="date-range-error" role="alert" className="gallery-date-error">{dateError}</p>}
          </form>
          <TagBrowser
            tags={tags}
            selectedTag={filters.tag}
            loading={tagLoading}
            error={tagError}
            onSelect={handleSelectTag}
            onRetry={() => void fetchTags(filters)}
          />
        </section>
      </ToolDialog>
      <ToolDialog
        open={activeTool === 'collections'}
        label="Collections"
        onClose={closeTool}
        returnFocus={toolReturnTarget}
      >
        <CollectionPanel
          selectedCollectionId={selectedCollection?.id ?? null}
          revision={archiveRevision}
          onSelect={(collection) => {
            applyCollection(collection);
            closeTool();
          }}
          onChanged={handleCollectionsChanged}
          onSessionExpired={handleSessionExpired}
        />
      </ToolDialog>
      <ToolDialog
        open={activeTool === 'health'}
        label="Archive health"
        onClose={closeTool}
        returnFocus={toolReturnTarget}
      >
        <ArchiveHealthPanel
          filters={filters}
          revision={archiveRevision}
          onOpenRestore={openRestoreRequest}
          onSessionExpired={handleSessionExpired}
        />
      </ToolDialog>
      <ToolDialog
        open={activeTool === 'trash'}
        label="Trash"
        onClose={closeTool}
        returnFocus={toolReturnTarget}
      >
        <TrashPanel revision={archiveRevision} onChanged={handleTrashChanged} onSessionExpired={handleSessionExpired} />
      </ToolDialog>
      <ToolDialog
        open={activeTool === 'notifications'}
        label="Notifications"
        onClose={closeTool}
        returnFocus={toolReturnTarget}
      >
        <NotificationPanel />
      </ToolDialog>

      {/* Modals */}
      <AddAchievementModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={handleAddSuccess}
        onSessionExpired={handleSessionExpired}
      />

      <AchievementDetailModal
        achievement={selectedAchievement}
        viewerOpen={isViewerOpen}
        viewerBackground={viewerBackground}
        hasPrevious={hasPreviousArtwork}
        hasNext={hasNextArtwork}
        navigationPending={navigationPending}
        onClose={closeDetailWithReturn}
        onViewerOpen={() => setIsViewerOpen(true)}
        onViewerClose={closeViewer}
        onPrevious={goPrevious}
        onNext={() => void goNext()}
        onViewerBackgroundChange={setViewerBackground}
        onUpdate={handleUpdateAchievement}
        onDelete={handleDeleteAchievement}
        restoreRequest={restoreRequest}
        onDismissRestore={() => setRestoreRequest(null)}
        onCollectionChanged={() => setArchiveRevision((revision) => revision + 1)}
      />
    </div>
  );
}
