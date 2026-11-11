import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { financeBudgets, financeGroupMembers, financeGroups, financeNotes, financeScheduledTasks, financeSources, financeTransactions, financeUsers, financeWallets } from '@/lib/db/schema';
import { formatMoney, parseMoney } from './money';
import { validateCalendarDate } from '@/lib/validation/achievement';
import { lockFinanceSession, type FinanceSessionContext } from './auth';

export class FinanceLedgerError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'FinanceLedgerError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceLedgerError('INVALID_INPUT', `${label} must be a valid UUID.`, 400);
  return value.toLowerCase();
}

export async function readFinanceBody(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new FinanceLedgerError('INVALID_INPUT', 'JSON request body required.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new FinanceLedgerError('INVALID_INPUT', 'Request body is too large.', 413); }
    chunks.push(value);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new FinanceLedgerError('INVALID_INPUT', 'Invalid JSON request body.', 400); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FinanceLedgerError('INVALID_INPUT', 'Request body must be a JSON object.', 400);
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string, max: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new FinanceLedgerError('INVALID_INPUT', `${label} is required.`, 400);
    return null;
  }
  if (typeof value !== 'string') throw new FinanceLedgerError('INVALID_INPUT', `${label} must be text.`, 400);
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > max) throw new FinanceLedgerError('INVALID_INPUT', `${label} must be ${required ? '1' : '0'}–${max} characters.`, 400);
  return trimmed || null;
}

function amountValue(value: unknown): string {
  try { return formatMoney(parseMoney(value)); }
  catch { throw new FinanceLedgerError('INVALID_AMOUNT', 'Amount must be a positive decimal with at most two fractional digits.', 400); }
}

function decimalToMinor(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -result : result;
}

export async function listGroups(db: AppDatabase, userId: string) {
  return db.select({ id: financeGroups.id, name: financeGroups.name, role: financeGroupMembers.role })
    .from(financeGroups).innerJoin(financeGroupMembers, eq(financeGroupMembers.groupId, financeGroups.id))
    .where(eq(financeGroupMembers.userId, userId)).orderBy(desc(financeGroups.createdAt));
}

export async function createGroup(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const name = textValue(input.name, 'Name', 120, true)!;
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [group] = await tx.insert(financeGroups).values({ name, createdBy: context.userId }).returning();
    if (!group) throw new Error('Could not create group');
    await tx.insert(financeGroupMembers).values({ groupId: group.id, userId: context.userId, role: 'owner' });
    await lockFinanceSession(tx, context);
    return { id: group.id, name: group.name, role: 'owner' as const };
  });
}

export async function updateGroup(db: AppDatabase, context: FinanceSessionContext, idValue: unknown, input: Record<string, unknown>) {
  const id = requireUuid(idValue, 'groupId');
  const name = textValue(input.name, 'Name', 120, true)!;
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    await tx.select({ id: financeGroups.id }).from(financeGroups).where(eq(financeGroups.id, id)).for('update');
    await requireGroupManager(tx, id, context.userId);
    const [updated] = await tx.update(financeGroups).set({ name, updatedAt: new Date() }).where(eq(financeGroups.id, id)).returning({ id: financeGroups.id, name: financeGroups.name });
    if (!updated) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
    await lockFinanceSession(tx, context);
    return updated;
  });
}

export async function deleteGroup(db: AppDatabase, context: FinanceSessionContext, idValue: unknown) {
  const id = requireUuid(idValue, 'groupId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [group] = await tx.select({ id: financeGroups.id }).from(financeGroups).where(eq(financeGroups.id, id)).for('update');
    if (!group) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
    await requireGroupOwner(tx, id, context.userId);
    const [wallet] = await tx.select({ id: financeWallets.id }).from(financeWallets).where(eq(financeWallets.groupId, id)).limit(1);
    const [transaction] = await tx.select({ id: financeTransactions.id }).from(financeTransactions).where(eq(financeTransactions.groupId, id)).limit(1);
    const [source] = await tx.select({ id: financeSources.id }).from(financeSources).where(eq(financeSources.groupId, id)).limit(1);
    const [budget] = await tx.select({ id: financeBudgets.id }).from(financeBudgets).where(eq(financeBudgets.groupId, id)).limit(1);
    const [note] = await tx.select({ id: financeNotes.id }).from(financeNotes).where(eq(financeNotes.groupId, id)).limit(1);
    const [task] = await tx.select({ id: financeScheduledTasks.id }).from(financeScheduledTasks).where(eq(financeScheduledTasks.groupId, id)).limit(1);
    if (wallet || transaction || source || budget || note || task) throw new FinanceLedgerError('GROUP_HAS_DATA', 'Groups containing finance or planner data cannot be deleted.', 409);
    await tx.delete(financeGroups).where(eq(financeGroups.id, id));
    await lockFinanceSession(tx, context);
    return { id, deleted: true };
  });
}

export async function updateGroupMemberRole(db: AppDatabase, context: FinanceSessionContext, groupIdValue: unknown, userIdValue: unknown, roleValue: unknown) {
  const groupId = requireUuid(groupIdValue, 'groupId');
  const userId = requireUuid(userIdValue, 'userId');
  if (roleValue !== 'admin' && roleValue !== 'member') throw new FinanceLedgerError('INVALID_INPUT', 'Role must be admin or member.', 400);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    await requireGroupOwner(tx, groupId, context.userId);
    const [target] = await tx.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId))).for('update');
    if (!target || target.role === 'owner') throw new FinanceLedgerError('NOT_FOUND', 'Member not found.', 404);
    await tx.update(financeGroupMembers).set({ role: roleValue }).where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
    await lockFinanceSession(tx, context);
    return { groupId, userId, role: roleValue };
  });
}

export async function removeGroupMember(db: AppDatabase, context: FinanceSessionContext, groupIdValue: unknown, userIdValue: unknown) {
  const groupId = requireUuid(groupIdValue, 'groupId');
  const userId = requireUuid(userIdValue, 'userId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    await requireGroupManager(tx, groupId, context.userId);
    const [actor] = await tx.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, context.userId)));
    const [target] = await tx.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId))).for('update');
    if (!target || target.role === 'owner' || (target.role === 'admin' && actor?.role !== 'owner'))
      throw new FinanceLedgerError('NOT_FOUND', 'Member not found.', 404);
    await tx.delete(financeGroupMembers).where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
    await lockFinanceSession(tx, context);
    return { groupId, userId, removed: true };
  });
}

export async function listWallets(db: AppDatabase, userId: string, groupId: string) {
  const [membership] = await db.select({ id: financeGroupMembers.groupId }).from(financeGroupMembers)
    .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
  if (!membership) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
  const wallets = await db.select({
    id: financeWallets.id, groupId: financeWallets.groupId, name: financeWallets.name,
    type: financeWallets.type, targetAmount: financeWallets.targetAmount, currency: financeWallets.currency,
    defaultCategory: financeWallets.defaultCategory,
    balance: sql<string>`COALESCE(SUM(CASE WHEN ${financeTransactions.type} = 'income' THEN ${financeTransactions.amount} ELSE -${financeTransactions.amount} END), 0)::text`,
  }).from(financeWallets)
    .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeWallets.groupId), eq(financeGroupMembers.userId, userId)))
    .leftJoin(financeTransactions, and(eq(financeTransactions.walletId, financeWallets.id), isNull(financeTransactions.deletedAt)))
    .where(eq(financeWallets.groupId, groupId)).groupBy(financeWallets.id).orderBy(desc(financeWallets.createdAt));
  return wallets.map((wallet) => ({ ...wallet, balance: formatMoney(decimalToMinor(wallet.balance)) }));
}

export async function createWallet(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const groupId = requireUuid(input.groupId, 'groupId');
  const name = textValue(input.name, 'Name', 120, true)!;
  if (input.type !== 'regular' && input.type !== 'goal') throw new FinanceLedgerError('INVALID_INPUT', 'Wallet type must be regular or goal.', 400);
  const type = input.type;
  let targetAmount: string | null = null;
  if (type === 'goal') {
    if (typeof input.targetAmount === 'string' && /^0(?:\.0{1,2})?$/.test(input.targetAmount)) targetAmount = '0.00';
    else targetAmount = amountValue(input.targetAmount);
  } else if (input.targetAmount !== undefined && input.targetAmount !== null && input.targetAmount !== '') {
    throw new FinanceLedgerError('INVALID_INPUT', 'Regular wallets cannot have a target.', 400);
  }
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    await requireGroupManager(tx, groupId, context.userId);
    const [wallet] = await tx.insert(financeWallets).values({ groupId, name, type, targetAmount }).returning();
    if (!wallet) throw new Error('Could not create wallet');
    await lockFinanceSession(tx, context);
    return { id: wallet.id, groupId, name, type, targetAmount, currency: wallet.currency, balance: '0.00' };
  });
}

export async function updateWallet(db: AppDatabase, context: FinanceSessionContext, idValue: unknown, input: Record<string, unknown>) {
  const id = requireUuid(idValue, 'walletId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [current] = await tx.select().from(financeWallets).where(eq(financeWallets.id, id)).for('update');
    if (!current) throw new FinanceLedgerError('NOT_FOUND', 'Wallet not found.', 404);
    await requireGroupManager(tx, current.groupId, context.userId);
    const name = input.name === undefined ? current.name : textValue(input.name, 'Name', 120, true)!;
    const type = input.type === undefined ? current.type : input.type;
    if (type !== 'regular' && type !== 'goal') throw new FinanceLedgerError('INVALID_INPUT', 'Wallet type must be regular or goal.', 400);
    const targetAmount = type === 'regular' ? null : input.targetAmount === undefined ? current.targetAmount : nonnegativeMoney(input.targetAmount);
    if (type === 'goal' && targetAmount === null) throw new FinanceLedgerError('INVALID_INPUT', 'Goal wallets require a target amount.', 400);
    const defaultCategory = input.defaultCategory === undefined ? current.defaultCategory : textValue(input.defaultCategory, 'Default category', 100);
    const [updated] = await tx.update(financeWallets).set({ name, type, targetAmount, defaultCategory, updatedAt: new Date() })
      .where(eq(financeWallets.id, id)).returning({ id: financeWallets.id });
    if (!updated) throw new FinanceLedgerError('NOT_FOUND', 'Wallet not found.', 404);
    await lockFinanceSession(tx, context);
    return { id: updated.id };
  });
}

export async function deleteWallet(db: AppDatabase, context: FinanceSessionContext, idValue: unknown) {
  const id = requireUuid(idValue, 'walletId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [wallet] = await tx.select().from(financeWallets).where(eq(financeWallets.id, id)).for('update');
    if (!wallet) throw new FinanceLedgerError('NOT_FOUND', 'Wallet not found.', 404);
    await requireGroupManager(tx, wallet.groupId, context.userId);
    const [transaction] = await tx.select({ id: financeTransactions.id }).from(financeTransactions)
      .where(eq(financeTransactions.walletId, id)).limit(1);
    if (transaction) throw new FinanceLedgerError('WALLET_HAS_HISTORY', 'Wallets with transaction history cannot be deleted.', 409);
    await tx.delete(financeWallets).where(eq(financeWallets.id, id));
    await lockFinanceSession(tx, context);
    return { id, deleted: true };
  });
}

export async function listTransactions(db: AppDatabase, userId: string, walletId: string) {
  const [wallet] = await db.select({ id: financeWallets.id }).from(financeWallets)
    .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeWallets.groupId), eq(financeGroupMembers.userId, userId)))
    .where(eq(financeWallets.id, walletId));
  if (!wallet) throw new FinanceLedgerError('NOT_FOUND', 'Wallet not found.', 404);
  return db.select({ id: financeTransactions.id, type: financeTransactions.type, amount: financeTransactions.amount, sourceId: financeTransactions.sourceId,
    sourceName: financeSources.name,
    category: financeTransactions.category, notes: financeTransactions.note, transactionDate: financeTransactions.transactionDate,
    createdAt: financeTransactions.createdAt }).from(financeTransactions)
    .innerJoin(financeWallets, eq(financeWallets.id, financeTransactions.walletId))
    .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeWallets.groupId), eq(financeGroupMembers.userId, userId)))
    .leftJoin(financeSources, eq(financeSources.id, financeTransactions.sourceId))
    .where(and(eq(financeTransactions.walletId, walletId), isNull(financeTransactions.deletedAt)))
    .orderBy(desc(financeTransactions.transactionDate), desc(financeTransactions.createdAt), desc(financeTransactions.id)).limit(201);
}

export async function findTransactionByRequestKey(db: AppDatabase, userId: string, key: string) {
  const [row] = await db.select({ id: financeTransactions.id, walletId: financeTransactions.walletId, sourceId: financeTransactions.sourceId,
    type: financeTransactions.type, amount: financeTransactions.amount, category: financeTransactions.category,
    notes: financeTransactions.note, transactionDate: financeTransactions.transactionDate,
    createdAt: financeTransactions.createdAt, deletedAt: financeTransactions.deletedAt })
    .from(financeTransactions)
    .innerJoin(financeWallets, eq(financeWallets.id, financeTransactions.walletId))
    .innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeWallets.groupId), eq(financeGroupMembers.userId, userId)))
    .where(and(eq(financeTransactions.createdBy, userId), eq(financeTransactions.idempotencyKey, key))).limit(1);
  return row ?? null;
}

const walletWriteTails = new WeakMap<AppDatabase, Map<string, Promise<void>>>();

export async function createTransaction(db: AppDatabase, context: FinanceSessionContext, keyValue: unknown, input: Record<string, unknown>) {
  const key = requireUuid(keyValue, 'Idempotency-Key');
  const walletId = requireUuid(input.walletId, 'walletId');
  if (input.type !== 'income' && input.type !== 'expense') throw new FinanceLedgerError('INVALID_INPUT', 'Transaction type must be income or expense.', 400);
  const type = input.type;
  const amount = amountValue(input.amount);
  const sourceId = input.sourceId === undefined || input.sourceId === null || input.sourceId === '' ? null : requireUuid(input.sourceId, 'sourceId');
  const category = textValue(input.category, 'Category', 100);
  const note = textValue(input.notes, 'Notes', 2000);
  let transactionDate: string | null = null;
  if (input.transactionDate !== undefined) {
    try { transactionDate = validateCalendarDate(input.transactionDate); }
    catch { throw new FinanceLedgerError('INVALID_DATE', 'Transaction date must be a valid date in YYYY-MM-DD format.', 400); }
  }

  const work = async () => db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const userId = context.userId;
    // The user row serializes idempotency keys across wallets and the wallet row serializes balance changes across users.
    const [user] = await tx.select({ id: financeUsers.id }).from(financeUsers).where(eq(financeUsers.id, userId)).for('update');
    if (!user) throw new FinanceLedgerError('UNAUTHENTICATED', 'Finance session is no longer valid.', 401);
    const [candidate] = await tx.select({ groupId: financeWallets.groupId }).from(financeWallets).where(eq(financeWallets.id, walletId));
    if (!candidate) throw new FinanceLedgerError('NOT_FOUND', 'Wallet not found.', 404);
    const [member] = await tx.select({ groupId: financeGroupMembers.groupId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, candidate.groupId), eq(financeGroupMembers.userId, userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Wallet not found.', 404);
    const [wallet] = await tx.select({ id: financeWallets.id, groupId: financeWallets.groupId }).from(financeWallets)
      .where(and(eq(financeWallets.id, walletId), eq(financeWallets.groupId, candidate.groupId))).for('update');
    if (!wallet) throw new FinanceLedgerError('NOT_FOUND', 'Wallet not found.', 404);
    if (sourceId) {
      const [source] = await tx.select({ id: financeSources.id }).from(financeSources)
        .where(and(eq(financeSources.id, sourceId), eq(financeSources.groupId, wallet.groupId), isNull(financeSources.deletedAt)));
      if (!source) throw new FinanceLedgerError('NOT_FOUND', 'Source not found.', 404);
    }
    const [existing] = await tx.select().from(financeTransactions)
      .where(and(eq(financeTransactions.createdBy, userId), eq(financeTransactions.idempotencyKey, key)));
    if (existing) {
      if (existing.walletId !== walletId || existing.sourceId !== sourceId || existing.type !== type || existing.amount !== amount || existing.category !== category || existing.note !== note || existing.deletedAt || (transactionDate !== null && existing.transactionDate !== transactionDate)) {
        throw new FinanceLedgerError('IDEMPOTENCY_CONFLICT', 'This key was already used for another transaction.', 409);
      }
      await lockFinanceSession(tx, context);
      return { id: existing.id, replayed: true };
    }
    const [total] = await tx.select({ balance: sql<string>`COALESCE(SUM(CASE WHEN ${financeTransactions.type} = 'income' THEN ${financeTransactions.amount} ELSE -${financeTransactions.amount} END), 0)::text` })
      .from(financeTransactions).where(and(eq(financeTransactions.walletId, walletId), isNull(financeTransactions.deletedAt)));
    if (type === 'expense' && decimalToMinor(total?.balance ?? '0') < parseMoney(amount)) {
      throw new FinanceLedgerError('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient.', 409);
    }
    const [created] = await tx.insert(financeTransactions).values({ groupId: wallet.groupId, walletId, sourceId, type, amount, category, note,
      transactionDate: transactionDate ?? new Date().toISOString().slice(0, 10), createdBy: userId, idempotencyKey: key }).returning({ id: financeTransactions.id });
    if (!created) throw new Error('Could not create transaction');
    await lockFinanceSession(tx, context);
    return { id: created.id, replayed: false };
  });

  // PGlite uses one connection; serialize per wallet locally while PostgreSQL row locks cover other instances.
  const tails = walletWriteTails.get(db) ?? new Map<string, Promise<void>>();
  walletWriteTails.set(db, tails);
  const previous = tails.get(walletId) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(() => undefined, () => undefined);
  tails.set(walletId, settled);
  void settled.then(() => { if (tails.get(walletId) === settled) tails.delete(walletId); });
  return result;
}

export async function updateTransaction(db: AppDatabase, context: FinanceSessionContext, idValue: unknown, input: Record<string, unknown>) {
  const id = requireUuid(idValue, 'transactionId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [current] = await tx.select().from(financeTransactions).where(eq(financeTransactions.id, id)).for('update');
    if (!current) throw new FinanceLedgerError('NOT_FOUND', 'Transaction not found.', 404);
    const [member] = await tx.select({ groupId: financeGroupMembers.groupId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, current.groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member || current.deletedAt) throw new FinanceLedgerError('NOT_FOUND', 'Transaction not found.', 404);
    const [wallet] = await tx.select({ id: financeWallets.id, groupId: financeWallets.groupId }).from(financeWallets)
      .where(and(eq(financeWallets.id, current.walletId), eq(financeWallets.groupId, current.groupId))).for('update');
    if (!wallet) throw new FinanceLedgerError('NOT_FOUND', 'Transaction not found.', 404);

    let type = current.type;
    if (input.type !== undefined) {
      if (input.type !== 'income' && input.type !== 'expense') throw new FinanceLedgerError('INVALID_INPUT', 'Transaction type must be income or expense.', 400);
      type = input.type;
    }
    const amount = input.amount === undefined ? current.amount : amountValue(input.amount);
    const sourceId = input.sourceId === undefined ? current.sourceId : input.sourceId === null || input.sourceId === '' ? null : requireUuid(input.sourceId, 'sourceId');
    if (sourceId && sourceId !== current.sourceId) {
      const [source] = await tx.select({ id: financeSources.id }).from(financeSources)
        .where(and(eq(financeSources.id, sourceId), eq(financeSources.groupId, wallet.groupId), isNull(financeSources.deletedAt)));
      if (!source) throw new FinanceLedgerError('NOT_FOUND', 'Source not found.', 404);
    }
    const category = input.category === undefined ? current.category : textValue(input.category, 'Category', 100);
    const note = input.notes === undefined ? current.note : textValue(input.notes, 'Notes', 2000);
    let transactionDate = current.transactionDate;
    if (input.transactionDate !== undefined) {
      try { transactionDate = validateCalendarDate(input.transactionDate); }
      catch { throw new FinanceLedgerError('INVALID_DATE', 'Transaction date must be a valid date in YYYY-MM-DD format.', 400); }
    }

    const [total] = await tx.select({ balance: sql<string>`COALESCE(SUM(CASE WHEN ${financeTransactions.type} = 'income' THEN ${financeTransactions.amount} ELSE -${financeTransactions.amount} END), 0)::text` })
      .from(financeTransactions).where(and(eq(financeTransactions.walletId, current.walletId), isNull(financeTransactions.deletedAt), ne(financeTransactions.id, id)));
    const baseBalance = decimalToMinor(total?.balance ?? '0');
    const previousBalance = baseBalance + (current.type === 'income' ? parseMoney(current.amount) : -parseMoney(current.amount));
    const nextBalance = baseBalance + (type === 'income' ? parseMoney(amount) : -parseMoney(amount));
    if (nextBalance < 0n && nextBalance < previousBalance) {
      throw new FinanceLedgerError('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient.', 409);
    }
    const [updated] = await tx.update(financeTransactions).set({ type, amount, sourceId, category, note, transactionDate, updatedBy: context.userId })
      .where(eq(financeTransactions.id, id)).returning({ id: financeTransactions.id });
    if (!updated) throw new FinanceLedgerError('NOT_FOUND', 'Transaction not found.', 404);
    await lockFinanceSession(tx, context);
    return { id: updated.id };
  });
}

export async function deleteTransaction(db: AppDatabase, context: FinanceSessionContext, idValue: unknown) {
  const id = requireUuid(idValue, 'transactionId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [current] = await tx.select().from(financeTransactions).where(eq(financeTransactions.id, id)).for('update');
    if (!current) throw new FinanceLedgerError('NOT_FOUND', 'Transaction not found.', 404);
    const [member] = await tx.select({ groupId: financeGroupMembers.groupId }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, current.groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
    if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Transaction not found.', 404);
    if (!current.deletedAt) {
      const [wallet] = await tx.select({ id: financeWallets.id }).from(financeWallets)
        .where(and(eq(financeWallets.id, current.walletId), eq(financeWallets.groupId, current.groupId))).for('update');
      if (!wallet) throw new FinanceLedgerError('NOT_FOUND', 'Transaction not found.', 404);
      if (current.type === 'income') {
        const [total] = await tx.select({ balance: sql<string>`COALESCE(SUM(CASE WHEN ${financeTransactions.type} = 'income' THEN ${financeTransactions.amount} ELSE -${financeTransactions.amount} END), 0)::text` })
          .from(financeTransactions).where(and(eq(financeTransactions.walletId, current.walletId), isNull(financeTransactions.deletedAt)));
        if (decimalToMinor(total?.balance ?? '0') < parseMoney(current.amount)) throw new FinanceLedgerError('INSUFFICIENT_FUNDS', 'Deleting this income would make the wallet balance negative.', 409);
      }
      await tx.update(financeTransactions).set({ deletedAt: new Date(), updatedBy: context.userId }).where(eq(financeTransactions.id, id));
    }
    await lockFinanceSession(tx, context);
    return { id, deleted: true };
  });
}

type FinanceTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

async function requireGroupManager(tx: FinanceTx, groupId: string, userId: string): Promise<void> {
  const [member] = await tx.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
    .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId))).for('update');
  if (member?.role !== 'owner' && member?.role !== 'admin') throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
}

async function requireGroupOwner(tx: FinanceTx, groupId: string, userId: string): Promise<void> {
  const [member] = await tx.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
    .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId))).for('update');
  if (member?.role !== 'owner') throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
}

export async function listSources(db: AppDatabase, userId: string, groupId: string) {
  const [member] = await db.select({ id: financeGroupMembers.groupId }).from(financeGroupMembers)
    .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
  if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
  return db.select({ id: financeSources.id, name: financeSources.name, type: financeSources.type })
    .from(financeSources).innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeSources.groupId), eq(financeGroupMembers.userId, userId)))
    .where(and(eq(financeSources.groupId, groupId), isNull(financeSources.deletedAt)))
    .orderBy(desc(financeSources.createdAt));
}

export async function createSource(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const groupId = requireUuid(input.groupId, 'groupId');
  const name = textValue(input.name, 'Name', 100, true)!;
  const type = input.type ?? 'other';
  if (type !== 'cash' && type !== 'e-wallet' && type !== 'bank' && type !== 'other') throw new FinanceLedgerError('INVALID_INPUT', 'Source type is invalid.', 400);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    await requireGroupManager(tx, groupId, context.userId);
    const [duplicate] = await tx.select({ id: financeSources.id }).from(financeSources)
      .where(and(eq(financeSources.groupId, groupId), eq(financeSources.name, name), isNull(financeSources.deletedAt)));
    if (duplicate) throw new FinanceLedgerError('SOURCE_EXISTS', 'A source with this name already exists in the group.', 409);
    const [source] = await tx.insert(financeSources).values({ groupId, name, type, createdBy: context.userId })
      .returning({ id: financeSources.id, name: financeSources.name, type: financeSources.type });
    if (!source) throw new Error('Could not create source.');
    await lockFinanceSession(tx, context);
    return source;
  });
}

export async function updateSource(db: AppDatabase, context: FinanceSessionContext, idValue: unknown, input: Record<string, unknown>) {
  const id = requireUuid(idValue, 'sourceId');
  const name = textValue(input.name, 'Name', 100, true)!;
  const type = input.type;
  if (type !== 'cash' && type !== 'e-wallet' && type !== 'bank' && type !== 'other') throw new FinanceLedgerError('INVALID_INPUT', 'Source type is invalid.', 400);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [current] = await tx.select().from(financeSources).where(eq(financeSources.id, id)).for('update');
    if (!current || current.deletedAt) throw new FinanceLedgerError('NOT_FOUND', 'Source not found.', 404);
    await requireGroupManager(tx, current.groupId, context.userId);
    const [duplicate] = await tx.select({ id: financeSources.id }).from(financeSources)
      .where(and(eq(financeSources.groupId, current.groupId), eq(financeSources.name, name), ne(financeSources.id, id)));
    if (duplicate) throw new FinanceLedgerError('SOURCE_EXISTS', 'A source with this name already exists in the group.', 409);
    await tx.update(financeSources).set({ name, type, updatedAt: new Date() }).where(eq(financeSources.id, id));
    await lockFinanceSession(tx, context);
    return { id, groupId: current.groupId, name, type };
  });
}

export async function deleteSource(db: AppDatabase, context: FinanceSessionContext, idValue: unknown) {
  const id = requireUuid(idValue, 'sourceId');
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    const [current] = await tx.select().from(financeSources).where(eq(financeSources.id, id)).for('update');
    if (!current || current.deletedAt) throw new FinanceLedgerError('NOT_FOUND', 'Source not found.', 404);
    await requireGroupManager(tx, current.groupId, context.userId);
    await tx.update(financeSources).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(financeSources.id, id));
    await lockFinanceSession(tx, context);
    return { id, deleted: true };
  });
}

function nonnegativeMoney(value: unknown): string {
  if (typeof value === 'string' && /^0(?:\.0{1,2})?$/.test(value)) return '0.00';
  return amountValue(value);
}

export async function getGroupBudget(db: AppDatabase, userId: string, groupId: string) {
  const [member] = await db.select({ id: financeGroupMembers.groupId }).from(financeGroupMembers)
    .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
  if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
  const [budget] = await db.select({ monthlyLimit: financeBudgets.monthlyLimit, currency: financeBudgets.currency, enabled: financeBudgets.enabled })
    .from(financeBudgets).innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeBudgets.groupId), eq(financeGroupMembers.userId, userId)))
    .where(eq(financeBudgets.groupId, groupId));
  return budget ?? { monthlyLimit: null, currency: 'IDR', enabled: false };
}

export async function setGroupBudget(db: AppDatabase, context: FinanceSessionContext, input: Record<string, unknown>) {
  const groupId = requireUuid(input.groupId, 'groupId');
  if (typeof input.enabled !== 'boolean') throw new FinanceLedgerError('INVALID_INPUT', 'enabled must be a boolean.', 400);
  const monthlyLimit = input.monthlyLimit === null || input.monthlyLimit === '' ? null : nonnegativeMoney(input.monthlyLimit);
  if (monthlyLimit === null && input.enabled) throw new FinanceLedgerError('INVALID_INPUT', 'An enabled budget requires a monthly limit.', 400);
  if (input.currency !== undefined && input.currency !== 'IDR') throw new FinanceLedgerError('INVALID_INPUT', 'Only IDR budgets are supported.', 400);
  return db.transaction(async (tx) => {
    await lockFinanceSession(tx, context);
    await requireGroupManager(tx, groupId, context.userId);
    const [budget] = await tx.insert(financeBudgets).values({ groupId, monthlyLimit, enabled: input.enabled as boolean, currency: 'IDR' })
      .onConflictDoUpdate({ target: financeBudgets.groupId, set: { monthlyLimit, enabled: input.enabled as boolean, currency: 'IDR', updatedAt: new Date() } })
      .returning({ monthlyLimit: financeBudgets.monthlyLimit, currency: financeBudgets.currency, enabled: financeBudgets.enabled });
    if (!budget) throw new Error('Could not update group budget.');
    await lockFinanceSession(tx, context);
    return budget;
  });
}

export async function getGroupSummary(db: AppDatabase, userId: string, groupId: string, start: string | null, end: string | null) {
  const [member] = await db.select({ id: financeGroupMembers.groupId }).from(financeGroupMembers)
    .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
  if (!member) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
  const dateFilter = start && end ? and(sql`${financeTransactions.transactionDate} >= ${start}::date`, sql`${financeTransactions.transactionDate} <= ${end}::date`) : undefined;
  const [totals] = await db.select({
    income: sql<string>`COALESCE(SUM(CASE WHEN ${financeTransactions.type} = 'income' THEN ${financeTransactions.amount} ELSE 0 END), 0)::text`,
    expense: sql<string>`COALESCE(SUM(CASE WHEN ${financeTransactions.type} = 'expense' THEN ${financeTransactions.amount} ELSE 0 END), 0)::text`,
  }).from(financeTransactions).innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeTransactions.groupId), eq(financeGroupMembers.userId, userId)))
    .where(and(eq(financeTransactions.groupId, groupId), isNull(financeTransactions.deletedAt), dateFilter));
  const income = decimalToMinor(totals?.income ?? '0');
  const expense = decimalToMinor(totals?.expense ?? '0');
  const [budget] = await db.select({ monthlyLimit: financeBudgets.monthlyLimit, currency: financeBudgets.currency, enabled: financeBudgets.enabled })
    .from(financeBudgets).innerJoin(financeGroupMembers, and(eq(financeGroupMembers.groupId, financeBudgets.groupId), eq(financeGroupMembers.userId, userId)))
    .where(eq(financeBudgets.groupId, groupId));
  return {
    totalIncome: formatMoney(income), totalExpense: formatMoney(expense), balance: formatMoney(income - expense), start, end,
    budget: budget ?? { monthlyLimit: null, currency: 'IDR', enabled: false },
    budgetRemaining: budget?.enabled && budget.monthlyLimit !== null ? formatMoney(decimalToMinor(budget.monthlyLimit) - expense) : null,
  };
}
