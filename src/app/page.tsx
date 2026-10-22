'use client';

import { useState, useEffect, type FormEvent } from 'react';

interface SessionStatus {
  authenticated: boolean;
  expiresAt?: string;
  idleExpiresAt?: string;
  error?: string;
}

export default function HomePage() {
  const [accessCode, setAccessCode] = useState('');
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function checkSession() {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = (await res.json()) as SessionStatus;
        setStatus(data);
      } else {
        setStatus({ authenticated: false });
      }
    } catch {
      setStatus({ authenticated: false });
    }
  }

  useEffect(() => {
    void checkSession();
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

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
        setMessage('Authenticated successfully');
        setAccessCode('');
        await checkSession();
      } else {
        setMessage(data.error ?? 'Authentication failed');
      }
    } catch {
      setMessage('Failed to connect to authentication service');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    try {
      const res = await fetch('/api/session', {
        method: 'DELETE',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (res.ok) {
        setMessage('Logged out successfully');
        await checkSession();
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRevokeAll() {
    setLoading(true);
    try {
      const res = await fetch('/api/sessions/revoke-all', {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (res.ok) {
        setMessage('All sessions revoked');
        await checkSession();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 600, margin: '60px auto', padding: '0 20px' }}>
      <h1>Hall of Achievements</h1>
      <p style={{ color: '#666' }}>Foundation & Authentication System</p>

      <div
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: 24,
          marginTop: 24,
        }}
      >
        <h2>System Status</h2>
        <p>
          Status:{' '}
          <strong style={{ color: status?.authenticated ? '#16a34a' : '#dc2626' }}>
            {status?.authenticated ? 'Authenticated' : 'Unauthenticated'}
          </strong>
        </p>

        {status?.authenticated && (
          <div>
            <p>Idle Expiration: {status.idleExpiresAt ?? 'N/A'}</p>
            <p>Absolute Expiration: {status.expiresAt ?? 'N/A'}</p>
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => void handleLogout()}
                disabled={loading}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#dc2626',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Log Out
              </button>
              <button
                type="button"
                onClick={() => void handleRevokeAll()}
                disabled={loading}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#475569',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Revoke All Sessions
              </button>
            </div>
          </div>
        )}

        {!status?.authenticated && (
          <form onSubmit={(e) => void handleLogin(e)} style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <label
                htmlFor="accessCode"
                style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}
              >
                Owner Access Code:
              </label>
              <input
                id="accessCode"
                type="password"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="Enter access code"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '8px 12px',
                  borderRadius: 4,
                  border: '1px solid #cbd5e1',
                }}
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '8px 16px',
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>
        )}

        {message && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              borderRadius: 4,
              backgroundColor: '#f1f5f9',
              color: '#334155',
            }}
          >
            {message}
          </div>
        )}
      </div>
    </main>
  );
}
