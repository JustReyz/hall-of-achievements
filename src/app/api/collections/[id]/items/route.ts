import { type NextRequest } from 'next/server';
import { authenticateApiRequest, jsonError, jsonResponse } from '@/lib/auth/api-guard';
import { getDb } from '@/lib/db';
import {
  CollectionError,
  listCollectionItems,
  replaceCollectionItems,
} from '@/lib/operations/collections';
import {
  validateCollectionId,
  validateOrderWrite,
} from '@/lib/validation/collection';
import { ValidationError } from '@/lib/validation/achievement';
import { validateDateRange, validateTagFilter } from '@/lib/validation/achievement';
import type { GalleryFilters } from '@/components/gallery/types';

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
    const collectionId = validateCollectionId(id);
    const url = new URL(request.url);
    const range = validateDateRange(url.searchParams.get('from'), url.searchParams.get('to'));
    const filters: GalleryFilters = {
      q: url.searchParams.get('q')?.trim() || '',
      from: range.from,
      to: range.to,
      tag: validateTagFilter(url.searchParams.get('tag')),
    };
    const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

    const db = await getDb();
    const page = await listCollectionItems(db, collectionId, {
      cursor: url.searchParams.get('cursor'),
      filters,
      ...(limit ? { limit } : {}),
    });

    return jsonResponse(page);
  } catch (err) {
    return errorResponse(err, '[GET /api/collections/:id/items ERROR]');
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const collectionId = validateCollectionId(id);
    const write = validateOrderWrite(body);
    const db = await getDb();
    const result = await replaceCollectionItems(
      db,
      collectionId,
      write.revision,
      write.achievementIds
    );
    return jsonResponse({ revision: result.revision });
  } catch (err) {
    return errorResponse(err, '[PUT /api/collections/:id/items ERROR]');
  }
}