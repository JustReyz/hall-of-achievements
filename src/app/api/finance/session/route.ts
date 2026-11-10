import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { generateSessionToken, hashSessionToken } from '@/lib/auth/crypto';
import { getDb } from '@/lib/db';
import { financeGroupMembers, financeInvitations, financeSessions, financeUsers } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { checkRateLimit, extractClientIp, recordFailedAttempt, resetRateLimit } from '@/lib/security/rate-limit';
import { checkFinanceOrigin, financeCookieName, financeErrorResponse, FinanceAuthError, lockHallSession, requireFinanceUser } from '@/lib/finance/auth';
import { hashFinancePassword, verifyFinancePassword } from '@/lib/finance/password';

const SESSION_SECONDS = 8 * 60 * 60;
const DUMMY_HASH = `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    const db = await getDb();
    const [user] = await db.select({ id: financeUsers.id, username: financeUsers.username, profilePicture: financeUsers.profilePicture }).from(financeUsers).where(eq(financeUsers.id, userId)).limit(1);
    if (!user) return jsonResponse({ authenticated: false });
    return jsonResponse({ authenticated: true, user });
  } catch (error) {
    if (error instanceof FinanceAuthError && error.status === 401) return jsonResponse({ authenticated: false });
    return financeErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    checkFinanceOrigin(request);
    const ip = `finance:${extractClientIp(request)}`;
    const limit = await checkRateLimit(ip);
    if (!limit.allowed) return jsonError('Too many attempts. Please try again later.', 429, 'RATE_LIMITED');
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError('Invalid JSON.', 400, 'INVALID_INPUT'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Invalid request.', 400, 'INVALID_INPUT');
    const { action, username, password, inviteToken: rawInviteToken } = body as Record<string, unknown>;
    let invitationHash: string | null = null;
    if (action === 'register' && rawInviteToken !== undefined) {
      if (typeof rawInviteToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawInviteToken))
        return jsonError('Invalid invitation.', 400, 'INVALID_INVITATION');
      invitationHash = hashSessionToken(rawInviteToken);
    }
    let auth: Awaited<ReturnType<typeof authenticateApiRequest>>['auth'];
    if (action === 'register' && invitationHash === null) {
      const result = await authenticateApiRequest(request);
      if (result.errorResponse) return result.errorResponse;
      auth = result.auth;
    }
    if (typeof username !== 'string' || !/^[a-z0-9_.-]{3,50}$/.test(username.trim().toLowerCase()) || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 256) {
      return jsonError('Invalid username or password.', 400, 'INVALID_INPUT');
    }
    const name = username.trim().toLowerCase();
    const accountKey = `finance-account:${name}`;
    const accountLimit = await checkRateLimit(accountKey);
    if (!accountLimit.allowed) return jsonError('Too many attempts. Please try again later.', 429, 'RATE_LIMITED');
    const db = await getDb();
    let passwordHash: string;
    let existingId: string | undefined;
    if (action === 'register') {
      if (password.length < 12) return jsonError('Password must be at least 12 characters.', 400, 'INVALID_INPUT');
      passwordHash = await hashFinancePassword(password);
    } else if (action === undefined || action === 'login') {
      const [found] = await db.select().from(financeUsers).where(eq(financeUsers.username, name)).limit(1);
      const dummyHash = found?.passwordHash ?? DUMMY_HASH;
      if (!await verifyFinancePassword(password, dummyHash) || !found) {
        await recordFailedAttempt(ip);
        await recordFailedAttempt(accountKey);
        return jsonError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
      }
      existingId = found.id;
      passwordHash = found.passwordHash;
    } else return jsonError('Invalid action.', 400, 'INVALID_INPUT');
    const { rawToken, tokenHash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
    const user = await db.transaction(async (tx) => {
      if (action === 'register') {
        if (invitationHash) {
          const [invitation] = await tx.select().from(financeInvitations).where(eq(financeInvitations.tokenHash, invitationHash)).for('update');
          if (!invitation || invitation.claimedAt || invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now())
            throw new FinanceAuthError('Invitation is invalid or expired.', 400);
        } else {
          await lockHallSession(tx, auth!.tokenHash);
          const [existing] = await tx.select({ id: financeUsers.id }).from(financeUsers).limit(1);
          if (existing) return undefined;
        }
        const [sameName] = await tx.select({ id: financeUsers.id }).from(financeUsers).where(eq(financeUsers.username, name)).limit(1);
        if (sameName) throw new FinanceAuthError('Username is already in use.', 409);
        const [created] = await tx.insert(financeUsers).values({ username: name, displayName: name, passwordHash }).returning({ id: financeUsers.id, username: financeUsers.username, profilePicture: financeUsers.profilePicture });
        if (!created) throw new Error('Finance account creation failed.');
        if (invitationHash) {
          const [invitation] = await tx.select().from(financeInvitations).where(eq(financeInvitations.tokenHash, invitationHash));
          if (!invitation) throw new FinanceAuthError('Invitation is invalid or expired.', 400);
          await tx.insert(financeGroupMembers).values({ groupId: invitation.groupId, userId: created.id, role: invitation.role });
          await tx.update(financeInvitations).set({ claimedAt: new Date() }).where(eq(financeInvitations.tokenHash, invitationHash));
        }
        await tx.insert(financeSessions).values({ tokenHash, userId: created.id, hallSessionTokenHash: null, expiresAt, idleExpiresAt: expiresAt });
        return created;
      }
      const [current] = await tx.select().from(financeUsers).where(eq(financeUsers.id, existingId!)).for('update');
      if (!current || current.passwordHash !== passwordHash) throw new FinanceAuthError('Invalid username or password.');
      await tx.insert(financeSessions).values({ tokenHash, userId: current.id, hallSessionTokenHash: null, expiresAt, idleExpiresAt: expiresAt });
      return { id: current.id, username: current.username, profilePicture: current.profilePicture };
    });
    if (!user) return jsonError('The first finance account already exists.', 409, 'REGISTRATION_CLOSED');
    await resetRateLimit(ip);
    await resetRateLimit(accountKey);
    const response = jsonResponse({ authenticated: true, user });
    response.cookies.set(financeCookieName(), rawToken, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS });
    return response;
  } catch (error) { return financeErrorResponse(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireFinanceUser(request);
    const token = request.cookies.get(financeCookieName())?.value;
    if (token) {
      const db = await getDb();
      await db.update(financeSessions).set({ revokedAt: new Date() }).where(eq(financeSessions.tokenHash, hashSessionToken(token)));
    }
    const response = jsonResponse({ authenticated: false });
    response.cookies.set(financeCookieName(), '', { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: 0 });
    return response;
  } catch (error) { return financeErrorResponse(error); }
}
