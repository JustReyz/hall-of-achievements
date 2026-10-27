import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { finalizeUpload } from '@/lib/uploads/finalize';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  const { id: intentId } = await params;
  if (!intentId) {
    return jsonError('Missing intent ID', 400, 'INVALID_INPUT');
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonError('Request body must be a JSON object', 400, 'INVALID_INPUT');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    // The body is optional on a finalize retry.
  }

  if (body.achievementId !== undefined && typeof body.achievementId !== 'string') {
    return jsonError('achievementId must be a string', 400, 'INVALID_INPUT');
  }

  const result = await finalizeUpload(intentId, body);
  if (!result.ok) {
    return jsonError(result.message, result.status, result.code);
  }

  return jsonResponse(result.payload);
}
