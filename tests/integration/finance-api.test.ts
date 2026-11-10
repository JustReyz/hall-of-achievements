import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDatabase } from '@/lib/db';
import { financeCookieName } from '@/lib/finance/auth';
import { POST as register } from '@/app/api/finance/session/route';
import { POST as createGroup } from '@/app/api/finance/groups/route';
import { POST as createWallet, GET as getWallets } from '@/app/api/finance/wallets/route';
import { DELETE as deleteWallet, PATCH as patchWallet } from '@/app/api/finance/wallets/[id]/route';
import { POST as createTransaction } from '@/app/api/finance/transactions/route';
import { POST as createInvitation } from '@/app/api/finance/invitations/route';
import { DELETE as deleteTransaction, PATCH as patchTransaction } from '@/app/api/finance/transactions/[id]/route';
import { POST as createSource, GET as getSources } from '@/app/api/finance/sources/route';
import { PUT as setBudget, GET as getBudget } from '@/app/api/finance/budgets/route';
import { GET as getSummary } from '@/app/api/finance/summary/route';
import { GET as exportFinance } from '@/app/api/finance/export/route';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import sharp from 'sharp';
import { PUT as uploadProfile, DELETE as deleteProfile } from '@/app/api/finance/profile-picture/route';
import { GET as getSession } from '@/app/api/finance/session/route';

describe('finance API', () => {
  beforeEach(async () => { vi.stubEnv('FINANCE_EXPERIMENTAL', 'true'); await resetDatabase(); });
  afterEach(() => vi.unstubAllEnvs());

  it('validates and stores a private profile picture for the signed-in user', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const registration = await register(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers, body: JSON.stringify({ action: 'register', username: 'profile-owner', password: 'secure-password-for-test' }),
    }));
    const token = registration.cookies.get(financeCookieName())?.value;
    const authHeaders = { ...headers, cookie: `${headers.cookie}; ${financeCookieName()}=${token}` };
    const call = (body: Uint8Array, requestHeaders = authHeaders) => uploadProfile(new NextRequest('http://localhost:3000/api/finance/profile-picture', {
      method: 'PUT', headers: requestHeaders, body: body as BodyInit,
    }));
    expect((await call(new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect((await call(new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
    const original = await sharp({ create: { width: 12, height: 18, channels: 3, background: '#2a7755' } }).png().toBuffer();
    expect((await call(new Uint8Array(original), { ...authHeaders, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(new Uint8Array(original))).status).toBe(200);
    const session = await getSession(new NextRequest('http://localhost:3000/api/finance/session', { headers: authHeaders }));
    expect((await session.json()).user.profilePicture).toMatch(/^data:image\/webp;base64,/);
    const login = await register(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers: { origin: 'http://localhost:3000' }, body: JSON.stringify({ action: 'login', username: 'profile-owner', password: 'secure-password-for-test' }),
    }));
    expect((await login.json()).user.profilePicture).toMatch(/^data:image\/webp;base64,/);
    expect((await deleteProfile(new NextRequest('http://localhost:3000/api/finance/profile-picture', { method: 'DELETE', headers: authHeaders }))).status).toBe(200);
    const cleared = await getSession(new NextRequest('http://localhost:3000/api/finance/session', { headers: authHeaders }));
    expect((await cleared.json()).user.profilePicture).toBeNull();
  });

  it('creates an authenticated group, wallet and idempotent transaction', async () => {
    const { headers } = await createAuthenticatedHeaders();
    const registration = await register(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers, body: JSON.stringify({ action: 'register', username: 'owner', password: 'secure-password-for-test' }),
    }));
    expect(registration.status).toBe(200);
    const token = registration.cookies.get(financeCookieName())?.value;
    expect(token).toBeTruthy();
    const { user } = await registration.clone().json() as { user: { id: string } };
    const authHeaders = { ...headers, cookie: `${headers.cookie}; ${financeCookieName()}=${token}` };
    const groupResponse = await createGroup(new NextRequest('http://localhost:3000/api/finance/groups', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Household' }),
    }));
    expect(groupResponse.status).toBe(201);
    const group = (await groupResponse.json()).group as { id: string };
    const invitationResponse = await createInvitation(new NextRequest('http://localhost:3000/api/finance/invitations', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ groupId: group.id }),
    }));
    expect(invitationResponse.status).toBe(201);
    expect((await createInvitation(new NextRequest('http://localhost:3000/api/finance/invitations', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ groupId: group.id }),
    }))).status).toBe(201);
    const invitation = (await invitationResponse.json()).invitation as { url: string };
    const inviteToken = new URL(invitation.url).searchParams.get('invite');
    const memberRegistration = await register(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ action: 'register', username: 'member', password: 'another-secure-password', inviteToken }),
    }));
    expect(memberRegistration.status).toBe(200);
    const memberCookie = memberRegistration.cookies.get(financeCookieName())?.value;
    const replayedInvitation = await register(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ action: 'register', username: 'replay', password: 'another-secure-password', inviteToken }),
    }));
    expect(replayedInvitation.status).toBe(400);
    const memberGroups = await import('@/app/api/finance/groups/route').then(({ GET }) => GET(new NextRequest('http://localhost:3000/api/finance/groups', {
      headers: { cookie: `${financeCookieName()}=${memberCookie}` },
    })));
    expect((await memberGroups.json()).groups).toEqual([expect.objectContaining({ id: group.id, role: 'member' })]);
    expect((await createInvitation(new NextRequest('http://localhost:3000/api/finance/invitations', {
      method: 'POST', headers: { cookie: `${financeCookieName()}=${memberCookie}`, origin: 'http://localhost:3000' }, body: JSON.stringify({ groupId: group.id }),
    }))).status).toBe(404);
    const sourceResponse = await createSource(new NextRequest('http://localhost:3000/api/finance/sources', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ groupId: group.id, name: 'Checking', type: 'bank' }),
    }));
    expect(sourceResponse.status).toBe(201);
    const source = (await sourceResponse.json()).source as { id: string };
    expect((await (await getSources(new NextRequest(`http://localhost:3000/api/finance/sources?groupId=${group.id}`, { headers: authHeaders }))).json()).sources).toHaveLength(1);
    expect((await setBudget(new NextRequest('http://localhost:3000/api/finance/budgets', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ groupId: group.id, monthlyLimit: '100', enabled: true }),
    }))).status).toBe(200);
    expect((await (await getBudget(new NextRequest(`http://localhost:3000/api/finance/budgets?groupId=${group.id}`, { headers: authHeaders }))).json()).budget).toMatchObject({ monthlyLimit: '100.00', enabled: true });
    const walletResponse = await createWallet(new NextRequest('http://localhost:3000/api/finance/wallets', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ groupId: group.id, name: 'Savings', type: 'regular' }),
    }));
    expect(walletResponse.status).toBe(201);
    const wallet = (await walletResponse.json()).wallet as { id: string };
    expect((await patchWallet(new NextRequest(`http://localhost:3000/api/finance/wallets/${wallet.id}`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ name: 'Emergency savings', defaultCategory: 'Emergency' }),
    }), { params: Promise.resolve({ id: wallet.id }) })).status).toBe(200);
    const key = crypto.randomUUID();
    const transaction = () => new NextRequest('http://localhost:3000/api/finance/transactions', {
      method: 'POST', headers: { ...authHeaders, 'Idempotency-Key': key, 'X-Finance-Actor': user.id },
      body: JSON.stringify({ walletId: wallet.id, sourceId: source.id, type: 'income', amount: '25.50' }),
    });
    expect((await createTransaction(transaction())).status).toBe(201);
    expect((await createTransaction(transaction())).status).toBe(200);
    const exportResponse = await exportFinance(new NextRequest(`http://localhost:3000/api/finance/export?groupId=${group.id}`, { headers: authHeaders }));
    expect(exportResponse.headers.get('content-type')).toContain('text/csv');
    expect(await exportResponse.text()).toContain('"Emergency savings","income","","Checking","25.50"');
    const wallets = await getWallets(new NextRequest(`http://localhost:3000/api/finance/wallets?groupId=${group.id}`, { headers: authHeaders }));
    expect((await wallets.json()).wallets[0].balance).toBe('25.50');
    expect((await (await getSummary(new NextRequest(`http://localhost:3000/api/finance/summary?groupId=${group.id}`, { headers: authHeaders }))).json()).summary)
      .toMatchObject({ totalIncome: '25.50', totalExpense: '0.00', budgetRemaining: '100.00' });
    const transactionResponse = await (await import('@/app/api/finance/transactions/route')).GET(new NextRequest(`http://localhost:3000/api/finance/transactions?walletId=${wallet.id}`, { headers: authHeaders }));
    const savedTransaction = (await transactionResponse.json()).transactions[0] as { id: string };
    expect((await patchTransaction(new NextRequest(`http://localhost:3000/api/finance/transactions/${savedTransaction.id}`, {
      method: 'PATCH', headers: { ...authHeaders, 'X-Finance-Actor': user.id }, body: JSON.stringify({ amount: '10.00' }),
    }), { params: Promise.resolve({ id: savedTransaction.id }) })).status).toBe(200);
    expect((await (await getWallets(new NextRequest(`http://localhost:3000/api/finance/wallets?groupId=${group.id}`, { headers: authHeaders }))).json()).wallets[0].balance).toBe('10.00');
    expect((await deleteTransaction(new NextRequest(`http://localhost:3000/api/finance/transactions/${savedTransaction.id}`, {
      method: 'DELETE', headers: { ...authHeaders, origin: 'http://localhost:3000', 'X-Finance-Actor': user.id },
    }), { params: Promise.resolve({ id: savedTransaction.id }) })).status).toBe(200);
    expect((await deleteWallet(new NextRequest(`http://localhost:3000/api/finance/wallets/${wallet.id}`, {
      method: 'DELETE', headers: authHeaders,
    }), { params: Promise.resolve({ id: wallet.id }) })).status).toBe(409);
    expect((await (await getWallets(new NextRequest(`http://localhost:3000/api/finance/wallets?groupId=${group.id}`, { headers: authHeaders }))).json()).wallets[0].balance).toBe('0.00');
  });
});
