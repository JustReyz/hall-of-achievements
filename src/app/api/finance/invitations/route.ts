import type { NextRequest } from 'next/server';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { generateSessionToken } from '@/lib/auth/crypto';
import { getDb } from '@/lib/db';
import { financeGroupMembers, financeGroups, financeInvitations, financeUsers } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { financeErrorResponse, lockFinanceSession, requireFinanceUser } from '@/lib/finance/auth';
import { FinanceLedgerError, readFinanceBody, requireUuid } from '@/lib/finance/ledger';

function errorResponse(error: unknown) {
  return error instanceof FinanceLedgerError
    ? jsonError(error.message, error.status, error.code)
    : financeErrorResponse(error);
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireFinanceUser(request);
    const groupId = requireUuid(request.nextUrl.searchParams.get('groupId'), 'groupId');
    const db = await getDb();
    const [membership] = await db.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
      .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, userId)));
    if (!membership) throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
    const members = await db.select({ id: financeGroupMembers.userId, username: financeUsers.username, role: financeGroupMembers.role })
      .from(financeGroupMembers).innerJoin(financeUsers, eq(financeUsers.id, financeGroupMembers.userId))
      .where(eq(financeGroupMembers.groupId, groupId)).orderBy(desc(financeGroupMembers.createdAt));
    return jsonResponse({ members });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireFinanceUser(request);
    const body = await readFinanceBody(request);
    const groupId = requireUuid(body.groupId, 'groupId');
    const db = await getDb();
    const { rawToken, tokenHash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invitation = await db.transaction(async (tx) => {
      await lockFinanceSession(tx, context);
      const [group] = await tx.select({ id: financeGroups.id }).from(financeGroups).where(eq(financeGroups.id, groupId)).for('update');
      const [membership] = await tx.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
        .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, context.userId)));
      if (!group || (membership?.role !== 'owner' && membership?.role !== 'admin'))
        throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
      const active = await tx.select({ tokenHash: financeInvitations.tokenHash }).from(financeInvitations)
        .where(and(eq(financeInvitations.groupId, groupId), isNull(financeInvitations.claimedAt), isNull(financeInvitations.revokedAt), gt(financeInvitations.expiresAt, new Date()))).limit(10);
      if (active.length >= 10) throw new FinanceLedgerError('INVITATION_LIMIT', 'This group already has ten active invitations.', 409);
      const [created] = await tx.insert(financeInvitations).values({
        tokenHash, groupId, invitedBy: context.userId, role: 'member', expiresAt,
      }).returning({ expiresAt: financeInvitations.expiresAt });
      await lockFinanceSession(tx, context);
      return created;
    });
    if (!invitation) throw new Error('Could not create invitation.');
    const url = new URL('/finance', env.APP_ORIGIN);
    url.searchParams.set('invite', rawToken);
    return jsonResponse({ invitation: { url: url.toString(), expiresAt: invitation.expiresAt } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    const context = await requireFinanceUser(request);
    const groupId = requireUuid(request.nextUrl.searchParams.get('groupId'), 'groupId');
    const db = await getDb();
    const revoked = await db.transaction(async (tx) => {
      await lockFinanceSession(tx, context);
      const [membership] = await tx.select({ role: financeGroupMembers.role }).from(financeGroupMembers)
        .where(and(eq(financeGroupMembers.groupId, groupId), eq(financeGroupMembers.userId, context.userId))).for('update');
      if (membership?.role !== 'owner' && membership?.role !== 'admin') throw new FinanceLedgerError('NOT_FOUND', 'Group not found.', 404);
      const rows = await tx.update(financeInvitations).set({ revokedAt: new Date() })
        .where(and(eq(financeInvitations.groupId, groupId), isNull(financeInvitations.claimedAt), isNull(financeInvitations.revokedAt)))
        .returning({ tokenHash: financeInvitations.tokenHash });
      await lockFinanceSession(tx, context);
      return rows.length;
    });
    return jsonResponse({ revoked });
  } catch (error) { return errorResponse(error); }
}
