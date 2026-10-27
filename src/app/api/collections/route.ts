import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import { createCollection, listCollections } from '@/lib/operations/collections';
import { validateCollectionName } from '@/lib/validation/collection';
import { ValidationError } from '@/lib/validation/achievement';

export async function GET(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  try {
    const db = await getDb();
    return jsonResponse({ collections: await listCollections(db) });
  } catch (err) {
    console.error('[GET /api/collections ERROR]', err);
    return jsonError('Failed to load collections', 500, 'COLLECTIONS_READ_FAILED');
  }
}

export async function POST(request: NextRequest) {
  const { errorResponse } = await authenticateApiRequest(request);
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }

  try {
    const name = validateCollectionName(
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).name
        : undefined
    );
    const db = await getDb();
    const collection = await createCollection(db, name);
    return jsonResponse({ collection }, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return jsonError(err.message, err.statusCode, err.code);
    }
    console.error('[POST /api/collections ERROR]', err);
    return jsonError('Failed to create the collection', 500, 'COLLECTION_CREATE_FAILED');
  }
}