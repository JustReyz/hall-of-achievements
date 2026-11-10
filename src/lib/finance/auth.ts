import type { NextRequest } from 'next/server';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { jsonError } from '@/lib/auth/api-guard';
import { constantTimeCompare, deriveAuthVersion, hashSessionToken } from '@/lib/auth/crypto';
import { getDb, type AppDatabase } from '@/lib/db';
import { authState, financeSessions, sessions } from '@/lib/db/schema';
import { IDLE_TIMEOUT_MS } from '@/lib/auth/session';
import { env } from '@/lib/env';

export class FinanceAuthError extends Error {
  constructor(message: string, readonly status = 401) { super(message); }
}

export function financeCookieName(): string {
  return env.COOKIE_SECURE ? '__Host-finance_session' : 'finance_session';
}

export function checkFinanceOrigin(request: NextRequest): void {
  if (process.env.FINANCE_EXPERIMENTAL !== 'true') {
    throw new FinanceAuthError('Finance is not yet enabled.', 503);
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return;
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(env.APP_ORIGIN).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new FinanceAuthError('Invalid request origin.', 403);
  }
}

export interface FinanceSessionContext {
  userId: string;
  financeTokenHash: string;
  hallTokenHash: string | null;
}

export async function requireFinanceUser(request: NextRequest): Promise<FinanceSessionContext> {
  checkFinanceOrigin(request);
  const token = request.cookies.get(financeCookieName())?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new FinanceAuthError('Finance login required.');
  const db = await getDb();
  const now = new Date();
  const financeTokenHash = hashSessionToken(token);
  const [session] = await db.select({ userId: financeSessions.userId, hallTokenHash: financeSessions.hallSessionTokenHash }).from(financeSessions).where(and(
    eq(financeSessions.tokenHash, financeTokenHash),
    isNull(financeSessions.revokedAt), gt(financeSessions.expiresAt, now), gt(financeSessions.idleExpiresAt, now)
  )).limit(1);
  if (!session) throw new FinanceAuthError('Finance session expired.');
  return { userId: session.userId, financeTokenHash, hallTokenHash: session.hallTokenHash };
}

type FinanceTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** The first finance account is bootstrapped by the Hall owner session. */
export async function lockHallSession(tx: FinanceTransaction, hallTokenHash: string): Promise<void> {
  const [state] = await tx.select().from(authState).where(eq(authState.id, 1)).for('update');
  const [hall] = await tx.select().from(sessions).where(eq(sessions.tokenHash, hallTokenHash)).for('update');
  if (!state || !hall || !constantTimeCompare(state.currentVersion, deriveAuthVersion()) || hall.revoked || hall.revokedAt !== null ||
      !constantTimeCompare(hall.authStateVersion, state.currentVersion) || hall.expiresAt.getTime() <= Date.now() ||
      hall.idleExpiresAt.getTime() <= Date.now() || hall.lastAccessedAt.getTime() + IDLE_TIMEOUT_MS <= Date.now()) {
    throw new FinanceAuthError('Archive session is no longer valid.');
  }
}

/** Revalidate the finance session after acquiring its row lock. */
export async function lockFinanceSession(tx: FinanceTransaction, context: FinanceSessionContext): Promise<void> {
  if (!context?.userId || !context.financeTokenHash) {
    throw new FinanceAuthError('Finance session required.');
  }
  const [finance] = await tx.select().from(financeSessions).where(eq(financeSessions.tokenHash, context.financeTokenHash)).for('update');
  const now = Date.now();
  if (!finance || finance.userId !== context.userId || finance.hallSessionTokenHash !== context.hallTokenHash ||
      finance.revokedAt !== null || finance.expiresAt.getTime() <= now || finance.idleExpiresAt.getTime() <= now) {
    throw new FinanceAuthError('Finance session is no longer valid.');
  }
}

export function financeErrorResponse(error: unknown) {
  if (error instanceof FinanceAuthError) return jsonError(error.message, error.status, 'FINANCE_AUTH');
  console.error('[FINANCE ERROR] Request failed.');
  return jsonError('Finance request failed.', 500, 'FINANCE_ERROR');
}
