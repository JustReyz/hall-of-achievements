import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import {
  CollectionError,
  deleteCollection,
  getCollectionDetail,
  renameCollection,
} from '@/lib/operations/collections';
import {
  validateCollectionId,
  validateCollectionName,
} from '@/lib/validation/collection';
import { ValidationError } from '@/lib/validation/achievement';

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof ValidationError) {
    return jsonError(err.message, err.statusCode, err.code);
  }
  if (err instanceof CollectionError) {
    return jsonError(err.message, err.statusCode, err.code);
  }
  console.error(fallback, err);
  return jsonError('Collection request failed', 500, 'COLLECTION_FAILED');
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { errorResponse: authError } = await authenticateApiRequest(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const db = await getDb();
    return jsonResponse(await getCollectionDetail(db, validateCollectionId(id)));
  } catch (err) {
    return errorResponse(err, '[GET /api/collections/:id ERROR]');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { errorResponse: authError } = await authenticateApiRequest(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body', 400, 'INVALID_INPUT');
  }

  try {
    const { id } = await params;
    const name = validateCollectionName(
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).name
        : undefined
    );
    const db = await getDb();
    return jsonResponse({ collection: await renameCollection(db, validateCollectionId(id), name) });
  } catch (err) {
    return errorResponse(err, '[PATCH /api/collections/:id ERROR]');
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { errorResponse: authError } = await authenticateApiRequest(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const db = await getDb();
    await deleteCollection(db, validateCollectionId(id));
    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return errorResponse(err, '[DELETE /api/collections/:id ERROR]');
  }
}