import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { ValidationError } from '@/lib/validation/achievement';
import { checkArchiveHealth, validateHealthIds } from '@/lib/storage/health';

export async function POST(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }

  const rawIds =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).ids
      : undefined;

  let ids: string[];
  try {
    ids = validateHealthIds(rawIds);
  } catch (error) {
    if (error instanceof ValidationError) {
      return jsonError(error.message, error.statusCode, error.code);
    }
    throw error;
  }

  try {
    const results = await checkArchiveHealth(ids);
    return jsonResponse({ results });
  } catch (error) {
    console.error('[POST /api/archive/health ERROR]', error);
    return jsonError('Failed to check archive health', 500, 'HEALTH_CHECK_FAILED');
  }
}
