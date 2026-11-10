import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createInMemoryDb, type AppDatabase } from '@/lib/db';
import { authState, financeGroups, financeSessions, financeTransactions, financeUsers, financeWallets, sessions } from '@/lib/db/schema';
import { deriveAuthVersion } from '@/lib/auth/crypto';
import { eq } from 'drizzle-orm';
import type { FinanceSessionContext } from '@/lib/finance/auth';
import { createGroup, createSource, createTransaction, createWallet, deleteTransaction, deleteWallet, getGroupBudget, getGroupSummary, listGroups, listTransactions, listWallets, setGroupBudget, updateTransaction, updateWallet } from '@/lib/finance/ledger';

describe('finance ledger', () => {
  let db: AppDatabase;
  let pglite: PGlite;
  let owner: string;
  let outsider: string;
  let ownerContext: FinanceSessionContext;

  beforeEach(async () => {
    vi.stubEnv('FINANCE_EXPERIMENTAL', 'true');
    ({ db, pglite } = await createInMemoryDb());
    const [a, b] = await db.insert(financeUsers).values([
      { username: 'owner', displayName: 'Owner', passwordHash: 'unused' },
      { username: 'outsider', displayName: 'Outsider', passwordHash: 'unused' },
    ]).returning({ id: financeUsers.id });
    owner = a!.id;
    outsider = b!.id;
    const version = deriveAuthVersion();
    await db.update(authState).set({ currentVersion: version }).where(eq(authState.id, 1));
    const hallTokenHash = 'a'.repeat(64);
    const financeTokenHash = 'b'.repeat(64);
    const expiry = new Date(Date.now() + 60_000);
    await db.insert(sessions).values({ tokenHash: hallTokenHash, authStateVersion: version, expiresAt: expiry, idleExpiresAt: expiry });
    await db.insert(financeSessions).values({ tokenHash: financeTokenHash, hallSessionTokenHash: null, userId: owner, expiresAt: expiry, idleExpiresAt: expiry });
    ownerContext = { userId: owner, financeTokenHash, hallTokenHash: null };
  });

  afterEach(async () => { await pglite.close(); vi.unstubAllEnvs(); });

  it('isolates groups and wallets, replays idempotent writes and rejects key reuse', async () => {
    const group = await createGroup(db, ownerContext, { name: 'Household' });
    const wallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Savings', type: 'goal', targetAmount: '1000' });
    expect(await listGroups(db, outsider)).toEqual([]);
    await expect(listWallets(db, outsider, group.id)).rejects.toMatchObject({ status: 404 });
    await expect(listTransactions(db, outsider, wallet.id)).rejects.toMatchObject({ status: 404 });
    const key = crypto.randomUUID();
    const body = { walletId: wallet.id, type: 'income', amount: '42.10', category: 'Gift', notes: '', transactionDate: '2026-10-01' };
    const first = await createTransaction(db, ownerContext, key, body);
    expect(await createTransaction(db, ownerContext, key, body)).toEqual({ id: first.id, replayed: true });
    await expect(createTransaction(db, ownerContext, key, { ...body, amount: '43' })).rejects.toMatchObject({ status: 409 });
    await expect(createTransaction(db, ownerContext, key, { ...body, transactionDate: '2026-10-02' })).rejects.toMatchObject({ status: 409 });
    await expect(createTransaction(db, ownerContext, crypto.randomUUID(), { ...body, transactionDate: '2026-02-30' })).rejects.toMatchObject({ status: 400 });
    expect((await listWallets(db, owner, group.id))[0]?.balance).toBe('42.10');
    expect(await listTransactions(db, owner, wallet.id)).toHaveLength(1);
    const concurrentKey = crypto.randomUUID();
    const concurrent = await Promise.all([
      createTransaction(db, ownerContext, concurrentKey, body),
      createTransaction(db, ownerContext, concurrentKey, body),
    ]);
    expect(concurrent[0]?.id).toBe(concurrent[1]?.id);
    expect(concurrent.filter((result) => result.replayed)).toHaveLength(1);
    expect((await listWallets(db, owner, group.id))[0]?.balance).toBe('84.20');
  });

  it('prevents two concurrent withdrawals from overspending', async () => {
    const group = await createGroup(db, ownerContext, { name: 'Household' });
    const wallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Wallet', type: 'regular' });
    await createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, type: 'income', amount: '100' });
    const results = await Promise.allSettled([
      createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, type: 'expense', amount: '80' }),
      createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, type: 'expense', amount: '80' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await listWallets(db, owner, group.id))[0]?.balance).toBe('20.00');
  });

  it('edits and soft-deletes ledger entries while enforcing the resulting balance', async () => {
    const group = await createGroup(db, ownerContext, { name: 'Edits' });
    const wallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Wallet', type: 'regular' });
    const income = await createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, type: 'income', amount: '100' });
    const expense = await createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, type: 'expense', amount: '40' });

    await expect(updateTransaction(db, ownerContext, expense.id, { type: 'expense', amount: '101' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await updateTransaction(db, ownerContext, expense.id, { type: 'expense', amount: '60', category: 'Bills', notes: 'Updated', transactionDate: '2026-11-01' });
    expect((await listWallets(db, owner, group.id))[0]?.balance).toBe('40.00');
    await deleteTransaction(db, ownerContext, expense.id);
    await deleteTransaction(db, ownerContext, expense.id);
    expect((await listWallets(db, owner, group.id))[0]?.balance).toBe('100.00');
    expect(await listTransactions(db, owner, wallet.id)).toHaveLength(1);
    expect(income.id).not.toBe(expense.id);
  });

  it('scopes sources and budgets to group membership and summarizes exact ledger totals', async () => {
    const group = await createGroup(db, ownerContext, { name: 'Monthly budget' });
    const wallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Main', type: 'regular' });
    const source = await createSource(db, ownerContext, { groupId: group.id, name: 'Bank', type: 'bank' });
    await setGroupBudget(db, ownerContext, { groupId: group.id, monthlyLimit: '100.00', currency: 'IDR', enabled: true });
    await createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, sourceId: source.id, type: 'income', amount: '150.50', transactionDate: '2026-11-02' });
    await createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, sourceId: source.id, type: 'expense', amount: '75.25', transactionDate: '2026-11-03' });
    const anotherGroup = await createGroup(db, ownerContext, { name: 'Another group' });
    const anotherWallet = await createWallet(db, ownerContext, { groupId: anotherGroup.id, name: 'Other wallet', type: 'regular' });
    await expect(createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: anotherWallet.id, sourceId: source.id, type: 'income', amount: '10' }))
      .rejects.toMatchObject({ status: 404 });

    expect(await getGroupBudget(db, owner, group.id)).toMatchObject({ monthlyLimit: '100.00', enabled: true });
    expect(await getGroupSummary(db, owner, group.id, '2026-11-01', '2026-11-30')).toMatchObject({
      totalIncome: '150.50', totalExpense: '75.25', balance: '75.25', budgetRemaining: '24.75',
    });
    await expect(getGroupBudget(db, outsider, group.id)).rejects.toMatchObject({ status: 404 });
    const outsiderHash = 'c'.repeat(64);
    const expiry = new Date(Date.now() + 60_000);
    await db.insert(financeSessions).values({ tokenHash: outsiderHash, userId: outsider, hallSessionTokenHash: null, expiresAt: expiry, idleExpiresAt: expiry });
    await expect(createSource(db, { userId: outsider, financeTokenHash: outsiderHash, hallTokenHash: null }, { groupId: group.id, name: 'Forbidden' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('updates wallet settings and only deletes wallets with no ledger history', async () => {
    const group = await createGroup(db, ownerContext, { name: 'Wallet lifecycle' });
    const wallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Old name', type: 'goal', targetAmount: '500' });
    await updateWallet(db, ownerContext, wallet.id, { name: 'New name', type: 'goal', targetAmount: '750', defaultCategory: 'Savings' });
    expect((await listWallets(db, owner, group.id))[0]).toMatchObject({ name: 'New name', targetAmount: '750.00', defaultCategory: 'Savings' });
    await createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, type: 'income', amount: '1' });
    await expect(deleteWallet(db, ownerContext, wallet.id)).rejects.toMatchObject({ status: 409 });
    const emptyWallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Empty', type: 'regular' });
    await deleteWallet(db, ownerContext, emptyWallet.id);
    await expect(listWallets(db, owner, group.id)).resolves.toHaveLength(1);
  });

  it.each(['finance logout', 'expired finance', 'forged user'] as const)(
    'rejects every write after %s using a previously authenticated context', async (kind) => {
      const group = await createGroup(db, ownerContext, { name: 'Existing' });
      const wallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Existing', type: 'regular' });
      let staleContext = ownerContext;
      if (kind === 'finance logout') await db.update(financeSessions).set({ revokedAt: new Date() }).where(eq(financeSessions.tokenHash, ownerContext.financeTokenHash));
      if (kind === 'expired finance') await db.update(financeSessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(financeSessions.tokenHash, ownerContext.financeTokenHash));
      if (kind === 'forged user') staleContext = { ...ownerContext, userId: outsider };

      await expect(createGroup(db, staleContext, { name: 'Rejected' })).rejects.toMatchObject({ status: 401 });
      await expect(createWallet(db, staleContext, { groupId: group.id, name: 'Rejected', type: 'regular' })).rejects.toMatchObject({ status: 401 });
      await expect(createTransaction(db, staleContext, crypto.randomUUID(), { walletId: wallet.id, type: 'income', amount: '10' })).rejects.toMatchObject({ status: 401 });
      expect(await db.select().from(financeGroups)).toHaveLength(1);
      expect(await db.select().from(financeWallets)).toHaveLength(1);
      expect(await db.select().from(financeTransactions)).toHaveLength(0);
    }
  );

  it('keeps finance writes independent when the Hall archive session is revoked and rotated', async () => {
    const group = await createGroup(db, ownerContext, { name: 'Independent finance' });
    const wallet = await createWallet(db, ownerContext, { groupId: group.id, name: 'Personal', type: 'regular' });
    await db.update(sessions).set({ revoked: true, revokedAt: new Date() }).where(eq(sessions.tokenHash, 'a'.repeat(64)));
    await db.update(authState).set({ currentVersion: 'f'.repeat(64) }).where(eq(authState.id, 1));

    await expect(createTransaction(db, ownerContext, crypto.randomUUID(), { walletId: wallet.id, type: 'income', amount: '10' }))
      .resolves.toMatchObject({ replayed: false });
  });
});
