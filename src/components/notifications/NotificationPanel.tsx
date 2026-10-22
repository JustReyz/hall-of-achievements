'use client';

import { useState, useEffect, useCallback } from 'react';

export interface ActiveSubscriptionInfo {
  id: string;
  userAgent: string | null;
  status: string;
  createdAt: string;
  isCurrentDevice: boolean;
}

/**
 * Converts a base64url string to a Uint8Array for pushManager applicationServerKey.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function NotificationPanel() {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [isIosSafari, setIsIosSafari] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [subscriptions, setSubscriptions] = useState<ActiveSubscriptionInfo[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(
    null
  );
  const [cooldownRemaining, setCooldownRemaining] = useState<number>(0);

  // 1. Feature detection and environment assessment
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const hasSW = 'serviceWorker' in navigator;
    const hasPush = 'PushManager' in window;
    const hasNotif = 'Notification' in window;

    // Detect iOS
    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
    setIsIosSafari(isIos);

    if (hasSW && hasPush && hasNotif) {
      setIsSupported(true);
      setPermission(Notification.permission);
    } else {
      setIsSupported(false);
      setPermission('unsupported');
    }
  }, []);

  // 2. Fetch server-side subscriptions list
  const refreshSubscriptions = useCallback(async () => {
    try {
      const res = await fetch('/api/push/subscriptions');
      if (res.ok) {
        const data = (await res.json()) as { subscriptions: ActiveSubscriptionInfo[] };
        setSubscriptions(data.subscriptions || []);

        // Check if current browser service worker has an active subscription
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration('/sw.js');
          const sub = await reg?.pushManager.getSubscription();
          setIsSubscribed(Boolean(sub && data.subscriptions.some((s) => s.isCurrentDevice)));
        }
      }
    } catch {
      // Ignore background fetch error
    }
  }, []);

  useEffect(() => {
    if (isSupported) {
      void refreshSubscriptions();
    }
  }, [isSupported, refreshSubscriptions]);

  // 3. Cooldown timer countdown
  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    const interval = setInterval(() => {
      setCooldownRemaining((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownRemaining]);

  // 4. Action: "Enable notifications on this device"
  // SENDS ZERO PUSHES. Strictly click-initiated.
  const handleEnableNotifications = async () => {
    setLoading(true);
    setFeedback(null);

    try {
      if (!isSupported) {
        setFeedback({
          type: 'info',
          message: isIosSafari
            ? "To enable notifications on iOS, tap the Share icon and select 'Add to Home Screen' first."
            : 'Web Push is not supported in this browser.',
        });
        return;
      }

      // Explicit user click requests browser notification permission
      const perm = await Notification.requestPermission();
      setPermission(perm);

      if (perm !== 'granted') {
        setFeedback({
          type: 'info',
          message:
            perm === 'denied'
              ? 'Notification permission was denied. Please update your browser site settings to allow notifications.'
              : 'Notification permission was dismissed.',
        });
        return;
      }

      // Register minimal service worker
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      // Fetch VAPID public key
      const keyRes = await fetch('/api/push/vapid-public-key');
      if (!keyRes.ok) {
        throw new Error('Failed to retrieve application server key from server');
      }
      const { publicKey } = (await keyRes.json()) as { publicKey: string };

      // Subscribe via PushManager
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });

      const subJson = sub.toJSON();

      // Send subscription to server - SENDS ZERO PUSHES
      const saveRes = await fetch('/api/push/subscriptions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: subJson.keys?.p256dh,
            auth: subJson.keys?.auth,
          },
          userAgent: navigator.userAgent,
        }),
      });

      const saveResult = (await saveRes.json()) as { error?: string; success?: boolean };

      if (!saveRes.ok) {
        throw new Error(saveResult.error || 'Failed to save subscription on server');
      }

      setIsSubscribed(true);
      setFeedback({
        type: 'success',
        message: 'Notifications enabled for this device. Zero test notifications were sent.',
      });
      await refreshSubscriptions();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: (err as Error).message || 'Failed to enable notifications',
      });
    } finally {
      setLoading(false);
    }
  };

  // 5. Action: "Disable notifications on this device"
  // SENDS ZERO PUSHES. Unsubscribes locally and disables subscription on server.
  const handleDisableNotifications = async () => {
    setLoading(true);
    setFeedback(null);

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
        }
      }

      const res = await fetch('/api/push/subscriptions', {
        method: 'DELETE',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to disable subscription');
      }

      setIsSubscribed(false);
      setFeedback({
        type: 'success',
        message: 'Notifications disabled for this device.',
      });
      await refreshSubscriptions();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: (err as Error).message || 'Failed to disable notifications',
      });
    } finally {
      setLoading(false);
    }
  };

  // 6. Action: "Send reminder now"
  // Authenticated manual trigger. Enforces 60-second cooldown and idempotency.
  const handleSendReminder = async () => {
    if (cooldownRemaining > 0 || loading) return;

    setLoading(true);
    setFeedback(null);

    try {
      const idempotencyKey = crypto.randomUUID();
      const targetIds =
        selectedTargetId === 'all'
          ? undefined
          : [selectedTargetId];

      const res = await fetch('/api/reminders/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          idempotencyKey,
          targetSubscriptionIds: targetIds,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        outcome?: string;
        cooldownSeconds?: number;
        retryAfter?: number;
        error?: string;
        replayed?: boolean;
      };

      if (res.status === 429) {
        const retryAfter = data.retryAfter || 60;
        setCooldownRemaining(retryAfter);
        setFeedback({
          type: 'info',
          message: `Reminder cooldown active. Please wait ${retryAfter}s before sending another reminder.`,
        });
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || 'Failed to dispatch push reminder');
      }

      const cooldown = data.cooldownSeconds || 60;
      setCooldownRemaining(cooldown);

      const statusText =
        data.outcome === 'accepted'
          ? 'Accepted by push provider'
          : data.outcome === 'partial'
            ? 'Partially accepted by push provider'
            : 'Rejected by push provider';

      setFeedback({
        type: 'success',
        message: data.replayed
          ? `Reminder attempt replayed (cached outcome: ${statusText}).`
          : `Reminder dispatched successfully: ${statusText}.`,
      });

      await refreshSubscriptions();
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: (err as Error).message || 'Failed to send reminder',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      aria-label="Notification Controls"
      style={{
        backgroundColor: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        padding: 16,
        marginBottom: 20,
        boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        {/* Title and Status Indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '20px' }}>🔔</span>
          <div>
            <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>
              Web Push Reminders
            </h2>
            <div style={{ fontSize: '12px', color: '#64748b' }}>
              Status:{' '}
              {isSupported === false ? (
                <span style={{ color: '#dc2626' }}>Unsupported</span>
              ) : permission === 'denied' ? (
                <span style={{ color: '#dc2626' }}>Blocked in browser settings</span>
              ) : isSubscribed ? (
                <span style={{ color: '#16a34a', fontWeight: 500 }}>Active on this device</span>
              ) : (
                <span style={{ color: '#64748b' }}>Not enabled on this device</span>
              )}
              {subscriptions.length > 0 && ` • ${subscriptions.length} active device(s)`}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {/* Target Selector (if multiple active subscriptions exist) */}
          {subscriptions.length > 1 && (
            <select
              value={selectedTargetId}
              onChange={(e) => setSelectedTargetId(e.target.value)}
              aria-label="Select target device"
              style={{
                padding: '7px 10px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: '13px',
                color: '#334155',
                backgroundColor: '#fff',
                outline: 'none',
              }}
            >
              <option value="all">All active devices ({subscriptions.length})</option>
              {subscriptions.map((s, idx) => (
                <option key={s.id} value={s.id}>
                  {s.isCurrentDevice
                    ? `This device (Device ${idx + 1})`
                    : `Device ${idx + 1} (${s.userAgent ? s.userAgent.slice(0, 20) + '...' : 'Unknown'})`}
                </option>
              ))}
            </select>
          )}

          {/* Primary Action: Send Reminder Now */}
          <button
            type="button"
            onClick={() => void handleSendReminder()}
            disabled={subscriptions.length === 0 || cooldownRemaining > 0 || loading}
            aria-label="Send reminder now"
            style={{
              padding: '7px 14px',
              backgroundColor: subscriptions.length === 0 || cooldownRemaining > 0 ? '#94a3b8' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              fontSize: '13px',
              cursor:
                subscriptions.length === 0 || cooldownRemaining > 0 || loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {cooldownRemaining > 0
              ? `Cooldown (${cooldownRemaining}s)`
              : loading
                ? 'Sending...'
                : 'Send reminder now'}
          </button>

          {/* Opt-in / Opt-out Button */}
          {!isSubscribed ? (
            <button
              type="button"
              onClick={() => void handleEnableNotifications()}
              disabled={loading || permission === 'denied' || isSupported === false}
              aria-label="Enable notifications on this device"
              style={{
                padding: '7px 14px',
                backgroundColor: '#fff',
                color: '#2563eb',
                border: '1px solid #2563eb',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: '13px',
                cursor: loading || permission === 'denied' || isSupported === false ? 'not-allowed' : 'pointer',
                opacity: permission === 'denied' || isSupported === false ? 0.6 : 1,
              }}
            >
              Enable notifications on this device
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleDisableNotifications()}
              disabled={loading}
              aria-label="Disable notifications on this device"
              style={{
                padding: '7px 12px',
                backgroundColor: '#fff',
                color: '#64748b',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                fontWeight: 500,
                fontSize: '13px',
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              Disable notifications
            </button>
          )}
        </div>
      </div>

      {/* Explanatory Fallback Banners (AC7) */}
      {permission === 'denied' && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 6,
            backgroundColor: '#fef2f2',
            color: '#991b1b',
            fontSize: '13px',
            border: '1px solid #fecaca',
          }}
        >
          Notifications are blocked in your browser settings. To enable them, click the padlock or site settings
          icon in your address bar and reset notifications to Allow.
        </div>
      )}

      {isSupported === false && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 6,
            backgroundColor: '#fef3c7',
            color: '#92400e',
            fontSize: '13px',
            border: '1px solid #fde68a',
          }}
        >
          {isIosSafari
            ? 'Web Push on iOS requires adding this web app to your Home Screen. Tap the Share button in Safari and choose "Add to Home Screen".'
            : 'Web Push notifications are not supported by this browser environment.'}
        </div>
      )}

      {/* Feedback Messages */}
      {feedback && (
        <div
          role="status"
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 6,
            backgroundColor:
              feedback.type === 'success'
                ? '#f0fdf4'
                : feedback.type === 'error'
                  ? '#fef2f2'
                  : '#f8fafc',
            color:
              feedback.type === 'success'
                ? '#166534'
                : feedback.type === 'error'
                  ? '#991b1b'
                  : '#334155',
            fontSize: '13px',
            border: `1px solid ${
              feedback.type === 'success'
                ? '#bbf7d0'
                : feedback.type === 'error'
                  ? '#fecaca'
                  : '#e2e8f0'
            }`,
          }}
        >
          {feedback.message}
        </div>
      )}
    </section>
  );
}
