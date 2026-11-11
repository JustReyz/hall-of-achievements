import { jsonError } from '@/lib/auth/api-guard';
import { financeErrorResponse } from './auth';
import { FinanceLedgerError, readFinanceBody } from './ledger';

export function pushErrorResponse(error: unknown) {
  return error instanceof FinanceLedgerError ? jsonError(error.message, error.status, error.code) : financeErrorResponse(error);
}

export async function readPushBody(request: Request): Promise<Record<string, unknown>> {
  return readFinanceBody(request, 8192);
}
