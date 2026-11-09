import { type NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { achievements, assets } from '@/lib/db/schema';
import { normalVisibilityConditions } from '@/lib/gallery/query';

export async function POST(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  let body: unknown;
  try { body = await request.json(); } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }
  const checksum = (body as { checksum?: unknown })?.checksum;
  if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum)) {
    return jsonError('A valid SHA-256 checksum is required', 400, 'INVALID_CHECKSUM');
  }

  try {
    const db = await getDb();
    const matches = await db.select({ id: achievements.id, title: achievements.title, completionDate: achievements.completionDate })
      .from(assets)
      .innerJoin(achievements, eq(assets.achievementId, achievements.id))
      .where(and(eq(assets.checksum, checksum.toLowerCase()), ...normalVisibilityConditions()))
      .orderBy(desc(achievements.completionDate))
      .limit(5);
    return jsonResponse({ matches });
  } catch (err) {
    console.error('[POST /api/achievements/duplicates ERROR]', err);
    return jsonError('Could not check for duplicate artwork', 500, 'DUPLICATE_CHECK_FAILED');
  }
}
