import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDatabase } from '@/lib/db';
import { GET, POST, DELETE } from '@/app/api/finance/session/route';
import { financeCookieName } from '@/lib/finance/auth';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';

describe('finance session', () => {
  beforeEach(async () => { vi.stubEnv('FINANCE_EXPERIMENTAL', 'true'); await resetDatabase(); });
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed when the unfinished finance feature is disabled', async () => {
    vi.stubEnv('FINANCE_EXPERIMENTAL', 'false');
    const { headers } = await createAuthenticatedHeaders();
    const response = await GET(new NextRequest('http://localhost:3000/api/finance/session', { headers }));
    expect(response.status).toBe(503);
  });

  it('allows finance sessions to work without binding every request to the archive session', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const makeRequest = (method: string, body?: object, cookie = headers.cookie) => new NextRequest('http://localhost:3000/api/finance/session', {
      method, headers: { ...headers, cookie }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const registered = await POST(makeRequest('POST', { action: 'register', username: 'artist', password: 'a-secure-test-password' }));
    expect(registered.status).toBe(200);
    const financeCookie = registered.cookies.get(financeCookieName())?.value;
    expect(financeCookie).toBeTruthy();
    const bothCookies = `${headers.cookie}; ${financeCookieName()}=${financeCookie}`;
    const session = await GET(makeRequest('GET', undefined, bothCookies));
    expect(await session.json()).toMatchObject({ authenticated: true, user: { username: 'artist' } });
    const financeOnly = await GET(makeRequest('GET', undefined, `${financeCookieName()}=${financeCookie}`));
    expect(financeOnly.status).toBe(200);
    expect(await financeOnly.json()).toMatchObject({ authenticated: true, user: { username: 'artist' } });
    const otherArchiveSession = await createAuthenticatedHeaders();
    const switchedSession = await GET(makeRequest('GET', undefined, `${otherArchiveSession.headers.cookie}; ${financeCookieName()}=${financeCookie}`));
    expect(await switchedSession.json()).toMatchObject({ authenticated: true, user: { username: 'artist' } });
    const login = await POST(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ action: 'login', username: 'artist', password: 'a-secure-test-password' }),
    }));
    expect(login.status).toBe(200);
    const loginCookie = login.cookies.get(financeCookieName())?.value;
    expect(loginCookie).toBeTruthy();
    const financeOnlyLogin = await GET(makeRequest('GET', undefined, `${financeCookieName()}=${loginCookie}`));
    expect(await financeOnlyLogin.json()).toMatchObject({ authenticated: true, user: { username: 'artist' } });
    const second = await POST(makeRequest('POST', { action: 'register', username: 'other', password: 'a-secure-test-password' }));
    expect(second.status).toBe(409);
    expect((await DELETE(makeRequest('DELETE', undefined, bothCookies))).status).toBe(200);
    expect(await (await GET(makeRequest('GET', undefined, bothCookies))).json()).toEqual({ authenticated: false });
  });

  it('rejects a foreign origin before processing a login', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const request = new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers: { ...headers, origin: 'https://foreign.example' }, body: JSON.stringify({ username: 'artist', password: 'a-secure-test-password' }),
    });
    expect((await POST(request)).status).toBe(403);
  });
});
