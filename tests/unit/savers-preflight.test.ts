import { describe, expect, it } from 'vitest';
import { preflightSaversExport } from '@/lib/finance/savers-preflight';

const user = '00000000-0000-4000-8000-000000000001';
const wallet = '00000000-0000-4000-8000-000000000002';
const tx1 = '00000000-0000-4000-8000-000000000003';
const tx2 = '00000000-0000-4000-8000-000000000004';

function sample() {
  return {
    users: [{ id: user, password_hash: 'not-returned' }],
    wallets: [{ id: wallet, current_balance: '900719925474.09' }],
    wallet_members: [{ user_id: user, wallet_id: wallet }],
    transactions: [
      { id: tx1, wallet_id: wallet, user_id: user, type: 'income', amount: '900719925474.10' },
      { id: tx2, wallet_id: wallet, user_id: user, type: 'expense', amount: '0.01' },
    ],
  };
}

describe('Savers import preflight', () => {
  it('reconciles exact decimal balances without exposing credentials', () => {
    const result = preflightSaversExport(sample());
    expect(result.valid).toBe(true);
    expect(result.wallets[0]?.calculatedBalance).toBe('900719925474.09');
    expect(JSON.stringify(result)).not.toContain('not-returned');
  });

  it('reports mismatched balances, missing members, and duplicate transactions', () => {
    const data = sample();
    data.wallets[0]!.current_balance = '0';
    data.wallet_members = [];
    data.transactions.push(data.transactions[0]!);
    const result = preflightSaversExport(data);
    expect(result.valid).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      'Duplicate transaction identifiers.',
      `Wallet ${wallet} has no members.`,
      `Wallet ${wallet} balance does not match its transaction history.`,
    ]));
  });

  it('rejects numeric money values rather than silently rounding them', () => {
    const data = sample();
    expect(() => preflightSaversExport({ ...data, wallets: [{ id: wallet, current_balance: 1.23 }] })).toThrow();
  });
});
