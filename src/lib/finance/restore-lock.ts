import { sql } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';

type FinanceTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export async function lockFinanceRestore(tx: FinanceTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(1213153614, 1179209281)`);
}
