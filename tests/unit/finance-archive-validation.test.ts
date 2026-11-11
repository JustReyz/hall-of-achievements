import { describe, expect, it } from 'vitest';
import { financeArchiveSchema } from '@/lib/operations/finance-archive';

const userId = '00000000-0000-4000-8000-000000000001';
const groupId = '00000000-0000-4000-8000-000000000002';
const at = '2026-01-01T00:00:00.000Z';
const base = {
  users: [{ id: userId, username: 'owner', passwordHash: `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`, displayName: 'Owner', createdAt: at, updatedAt: at }],
  groups: [{ id: groupId, name: 'Group', createdBy: userId, createdAt: at, updatedAt: at }],
  members: [{ groupId, userId, role: 'owner', createdAt: at }],
  sources: [], budgets: [], wallets: [], transactions: [], notes: [], reminders: [], scheduledTasks: [],
};

describe('finance archive validation', () => {
  it('accepts a legacy finance archive with one group owner', () => {
    expect(financeArchiveSchema.parse(base).importRecords).toEqual([]);
  });
  it('rejects missing owners and duplicate memberships', () => {
    expect(financeArchiveSchema.safeParse({ ...base, members: [] }).success).toBe(false);
    expect(financeArchiveSchema.safeParse({ ...base, members: [base.members[0], base.members[0]] }).success).toBe(false);
  });
});
