import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb, resetDatabase } from '@/lib/db';
import { financeSessions, financeUsers } from '@/lib/db/schema';
import { generateSessionToken, hashSessionToken } from '@/lib/auth/crypto';
import { financeCookieName } from '@/lib/finance/auth';
import { createAuthenticatedHeaders } from '../helpers/auth-helper';
import { GET as getGroups, POST as postGroup } from '@/app/api/finance/groups/route';
import { GET as getWallets, POST as postWallet } from '@/app/api/finance/wallets/route';
import { GET as getTransactions, POST as postTransaction } from '@/app/api/finance/transactions/route';
import { PATCH as patchTransaction } from '@/app/api/finance/transactions/[id]/route';
import { POST as financeLogin } from '@/app/api/finance/session/route';
import * as financePassword from '@/lib/finance/password';

describe('finance API authorization', () => {
  beforeEach(async () => { vi.stubEnv('FINANCE_EXPERIMENTAL', 'true'); await resetDatabase(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('requires both sessions, rejects foreign origins, and isolates group members', async () => {
    const db = await getDb();
    const [owner, outsider] = await db.insert(financeUsers).values([
      { username: 'owner', displayName: 'Owner', passwordHash: 'unused' },
      { username: 'outsider', displayName: 'Outsider', passwordHash: 'unused' },
    ]).returning({ id: financeUsers.id });
    const ownerToken = generateSessionToken();
    const outsiderToken = generateSessionToken();
    const expiry = new Date(Date.now() + 60_000);
    const { headers: archiveHeaders, rawToken: archiveToken } = await createAuthenticatedHeaders();
    const hallSessionTokenHash = hashSessionToken(archiveToken);
    await db.insert(financeSessions).values([
      { tokenHash: ownerToken.tokenHash, userId: owner!.id, hallSessionTokenHash, idleExpiresAt: expiry, expiresAt: expiry },
      { tokenHash: outsiderToken.tokenHash, userId: outsider!.id, hallSessionTokenHash, idleExpiresAt: expiry, expiresAt: expiry },
    ]);
    const headers = { ...archiveHeaders, cookie: `${archiveHeaders.cookie}; ${financeCookieName()}=${ownerToken.rawToken}` };
    const otherHeaders = { ...archiveHeaders, cookie: `${archiveHeaders.cookie}; ${financeCookieName()}=${outsiderToken.rawToken}` };
    const ownerHeaders = { ...headers, 'X-Finance-Actor': owner!.id };
    const outsiderHeaders = { ...otherHeaders, 'X-Finance-Actor': outsider!.id };

    const unauthenticated = await getGroups(new NextRequest('http://localhost:3000/api/finance/groups'));
    expect(unauthenticated.status).toBe(401);
    const foreign = await postGroup(new NextRequest('http://localhost:3000/api/finance/groups', {
      method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify({ name: 'No' }),
    }));
    expect(foreign.status).toBe(403);
    const oversized = await postGroup(new NextRequest('http://localhost:3000/api/finance/groups', {
      method: 'POST', headers, body: 'x'.repeat(65537),
    }));
    expect(oversized.status).toBe(413);
    const groupResponse = await postGroup(new NextRequest('http://localhost:3000/api/finance/groups', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Home' }),
    }));
    expect(groupResponse.status).toBe(201);
    const { group } = await groupResponse.json() as { group: { id: string } };
    const walletResponse = await postWallet(new NextRequest('http://localhost:3000/api/finance/wallets', {
      method: 'POST', headers, body: JSON.stringify({ groupId: group.id, name: 'Savings', type: 'regular' }),
    }));
    expect(walletResponse.status).toBe(201);
    const { wallet } = await walletResponse.json() as { wallet: { id: string } };
    const hidden = await getWallets(new NextRequest(`http://localhost:3000/api/finance/wallets?groupId=${group.id}`, { headers: otherHeaders }));
    expect(hidden.status).toBe(404);
    const noKey = await postTransaction(new NextRequest('http://localhost:3000/api/finance/transactions', {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ walletId: wallet.id, type: 'income', amount: '10' }),
    }));
    expect(noKey.status).toBe(400);
    const crossMember = await postTransaction(new NextRequest('http://localhost:3000/api/finance/transactions', {
      method: 'POST', headers: { ...outsiderHeaders, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ walletId: wallet.id, type: 'income', amount: '10' }),
    }));
    expect(crossMember.status).toBe(404);
    const key = crypto.randomUUID();
    const created = await postTransaction(new NextRequest('http://localhost:3000/api/finance/transactions', {
      method: 'POST', headers: { ...ownerHeaders, 'Idempotency-Key': key },
      body: JSON.stringify({ walletId: wallet.id, type: 'income', amount: '10', transactionDate: '2026-10-01' }),
    }));
    expect(created.status).toBe(201);
    const { transaction } = await created.json() as { transaction: { id: string } };
    const hiddenEdit = await patchTransaction(new NextRequest(`http://localhost:3000/api/finance/transactions/${transaction.id}`, {
      method: 'PATCH', headers: { ...outsiderHeaders, origin: 'http://localhost:3000' }, body: JSON.stringify({ amount: '99' }),
    }), { params: Promise.resolve({ id: transaction.id }) });
    expect(hiddenEdit.status).toBe(404);
    const found = await getTransactions(new NextRequest(`http://localhost:3000/api/finance/transactions?requestKey=${key}`, { headers: ownerHeaders }));
    expect((await found.json()).transaction).toMatchObject({ walletId: wallet.id, amount: '10.00', transactionDate: '2026-10-01' });
    const hiddenResult = await getTransactions(new NextRequest(`http://localhost:3000/api/finance/transactions?requestKey=${key}`, { headers: outsiderHeaders }));
    expect((await hiddenResult.json()).transaction).toBeNull();
    const invalid = await getTransactions(new NextRequest('http://localhost:3000/api/finance/transactions?requestKey=invalid', { headers: ownerHeaders }));
    expect(invalid.status).toBe(400);
  });

  it('reserves rate-limit capacity before expensive concurrent password checks', async () => {
    const verify = vi.spyOn(financePassword, 'verifyFinancePassword').mockResolvedValue(false);
    const attempt = () => financeLogin(new NextRequest('http://localhost:3000/api/finance/session', {
      method: 'POST', headers: { origin: 'http://localhost:3000' }, body: JSON.stringify({ action: 'login', username: 'unknown-user', password: 'wrong-password' }),
    }));
    const results = await Promise.all(Array.from({ length: 12 }, attempt));
    expect(results.filter((response) => response.status === 401)).toHaveLength(5);
    expect(results.filter((response) => response.status === 429)).toHaveLength(7);
    expect(verify).toHaveBeenCalledTimes(5);
    const oversized = await financeLogin(new NextRequest('http://localhost:3000/api/finance/session', { method: 'POST', headers: { origin: 'http://localhost:3000', 'x-vercel-forwarded-for': '203.0.113.24' }, body: 'x'.repeat(8193) }));
    expect(oversized.status).toBe(413);
  });
});
