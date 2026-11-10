import { z } from 'zod';

const id = z.string().uuid();
const money = z.string().regex(/^-?\d{1,14}(?:\.\d{1,2})?$/);
const inputSchema = z.object({
  users: z.array(z.object({ id }).passthrough()),
  wallets: z.array(z.object({ id, current_balance: money }).passthrough()),
  wallet_members: z.array(z.object({ wallet_id: id, user_id: id }).passthrough()),
  transactions: z.array(z.object({ id, wallet_id: id, user_id: id, type: z.enum(['income', 'expense']), amount: money }).passthrough()),
}).passthrough();

function minor(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -amount : amount;
}

function formatMinor(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const amount = value < 0n ? -value : value;
  return `${sign}${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export function preflightSaversExport(input: unknown) {
  const data = inputSchema.parse(input);
  const problems: string[] = [];
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) problems.push(`Duplicate ${label} identifiers.`);
  };
  unique(data.users.map((row) => row.id), 'user');
  unique(data.wallets.map((row) => row.id), 'wallet');
  unique(data.transactions.map((row) => row.id), 'transaction');
  unique(data.wallet_members.map((row) => `${row.wallet_id}:${row.user_id}`), 'wallet membership');
  const users = new Set(data.users.map((row) => row.id));
  const balances = new Map(data.wallets.map((row) => [row.id, 0n]));
  const counts = new Map(data.wallets.map((row) => [row.id, 0]));
  for (const member of data.wallet_members) {
    if (!users.has(member.user_id) || !balances.has(member.wallet_id)) problems.push('A wallet membership references a missing user or wallet.');
    else counts.set(member.wallet_id, (counts.get(member.wallet_id) ?? 0) + 1);
  }
  for (const tx of data.transactions) {
    const amount = minor(tx.amount);
    if (amount <= 0n) problems.push(`Transaction ${tx.id} has a non-positive amount.`);
    if (!users.has(tx.user_id) || !balances.has(tx.wallet_id)) {
      problems.push(`Transaction ${tx.id} references a missing user or wallet.`);
      continue;
    }
    balances.set(tx.wallet_id, balances.get(tx.wallet_id)! + (tx.type === 'income' ? amount : -amount));
  }
  const wallets = data.wallets.map((wallet) => {
    const expected = minor(wallet.current_balance);
    const calculated = balances.get(wallet.id) ?? 0n;
    const members = counts.get(wallet.id) ?? 0;
    if (!members) problems.push(`Wallet ${wallet.id} has no members.`);
    if (expected !== calculated) problems.push(`Wallet ${wallet.id} balance does not match its transaction history.`);
    return { id: wallet.id, members, recordedBalance: formatMinor(expected), calculatedBalance: formatMinor(calculated), matches: expected === calculated };
  });
  return { valid: problems.length === 0, counts: { users: data.users.length, wallets: data.wallets.length, memberships: data.wallet_members.length, transactions: data.transactions.length }, wallets, problems };
}
