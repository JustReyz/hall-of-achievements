'use client';

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { AchievementItem, GalleryResponse, StorageQuotaInfo } from '@/components/gallery/types';
import { SearchBar } from '@/components/gallery/SearchBar';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { AddAchievementModal } from '@/components/gallery/AddAchievementModal';
import { AchievementDetailModal } from '@/components/gallery/AchievementDetailModal';
import { NotificationPanel } from '@/components/notifications/NotificationPanel';

interface SessionStatus {
  authenticated: boolean;
  expiresAt?: string;
  idleExpiresAt?: string;
  error?: string;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [quota, setQuota] = useState<StorageQuotaInfo | null>(null);

  // Modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedAchievement, setSelectedAchievement] = useState<AchievementItem | null>(null);

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

  // 3. Fetch Achievements (first page or with search)
  const fetchAchievements = useCallback(async (q: string = '') => {
    setGalleryLoading(true);
    try {
      const params = new URLSearchParams({ limit: '24' });
      if (q) params.set('q', q);

      const res = await fetch(`/api/achievements?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as GalleryResponse;
        setItems(data.items);
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
      }
    } catch (err) {
      console.error('[GALLERY FETCH ERROR]', err);
    } finally {
      setGalleryLoading(false);
    }
  }, []);

  // 4. Load More (Cursor Pagination)
  const handleLoadMore = async () => {
    if (!cursor || galleryLoading) return;
    setGalleryLoading(true);
    try {
      const params = new URLSearchParams({ limit: '24', cursor });
      if (searchQuery) params.set('q', searchQuery);

      const res = await fetch(`/api/achievements?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as GalleryResponse;
        setItems((prev) => [...prev, ...data.items]);
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
      }
    } catch (err) {
      console.error('[LOAD MORE ERROR]', err);
    } finally {
      setGalleryLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    void checkSession().then((isAuth) => {
      if (isAuth) {
        void fetchAchievements();
        void fetchQuota();
      }
    });
  }, [checkSession, fetchAchievements, fetchQuota]);

  // Handle Search input from SearchBar
  const handleSearch = (q: string) => {
    setSearchQuery(q);
    void fetchAchievements(q);
  };

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
          void fetchAchievements();
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
      setSession({ authenticated: false });
      setItems([]);
    } catch {
      // Ignore
    }
  };

  // Callback when a new achievement is added
  const handleAddSuccess = (newAchievement: AchievementItem) => {
    setItems((prev) => [newAchievement, ...prev]);
    void fetchQuota();
  };

  // Callback when an achievement is updated
  const handleUpdateAchievement = (updated: AchievementItem) => {
    setItems((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item))
    );
    setSelectedAchievement(updated);
  };

  // Callback when an achievement is deleted
  const handleDeleteAchievement = (deletedId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== deletedId));
    setSelectedAchievement(null);
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
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '10px 14px',
                  borderRadius: 6,
                  border: '1px solid #cbd5e1',
                  fontSize: '15px',
                  outline: 'none',
                }}
              />
            </div>

            <button
              type="submit"
              disabled={authLoading}
              style={{
                width: '100%',
                padding: '11px 16px',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* Storage Quota Badge */}
            {quota && (
              <div
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
                padding: '8px 16px',
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
                padding: '8px 14px',
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
          </div>
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
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: 24,
          }}
        >
          <SearchBar onSearch={handleSearch} disabled={galleryLoading && items.length === 0} />

          <div style={{ fontSize: '14px', color: '#64748b' }}>
            {items.length} {items.length === 1 ? 'artwork' : 'artworks'} recorded
          </div>
        </div>

        {/* Gallery Grid */}
        <GalleryGrid
          items={items}
          loading={galleryLoading}
          hasMore={hasMore}
          searchQuery={searchQuery}
          onLoadMore={() => void handleLoadMore()}
          onSelectAchievement={(item) => setSelectedAchievement(item)}
          onOpenAddModal={() => setIsAddModalOpen(true)}
        />
      </main>

      {/* Modals */}
      <AddAchievementModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={handleAddSuccess}
      />

      <AchievementDetailModal
        achievement={selectedAchievement}
        onClose={() => setSelectedAchievement(null)}
        onUpdate={handleUpdateAchievement}
        onDelete={handleDeleteAchievement}
      />
    </div>
  );
}
