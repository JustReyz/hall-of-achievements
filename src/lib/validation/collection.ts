import { ValidationError } from './achievement';

export const MAX_COLLECTION_NAME_LENGTH = 120;
export const MAX_COLLECTION_MEMBERS = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collection names are trimmed and bounded. Empty or whitespace-only names are
 * rejected rather than silently stored.
 */
export function validateCollectionName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('INVALID_COLLECTION_NAME', 'Collection name must be a string.', 400);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('INVALID_COLLECTION_NAME', 'Collection name is required.', 400);
  }
  if (trimmed.length > MAX_COLLECTION_NAME_LENGTH) {
    throw new ValidationError(
      'INVALID_COLLECTION_NAME',
      `Collection name must be at most ${MAX_COLLECTION_NAME_LENGTH} characters.`,
      400
    );
  }

  return trimmed;
}

export function validateCollectionId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new ValidationError('INVALID_COLLECTION_ID', 'Collection ID must be a UUID.', 400);
  }
  return value.trim().toLowerCase();
}

export function validateRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      'INVALID_REVISION',
      'Revision must be a non-negative integer.',
      400
    );
  }
  return value;
}

export interface CollectionOrderWrite {
  revision: number;
  achievementIds: string[];
}

/**
 * A membership write is always the complete ordered list plus the revision it
 * was prepared against. Duplicates, unknown IDs, and oversized lists are
 * rejected before any database work.
 */
export function validateOrderWrite(value: unknown): CollectionOrderWrite {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('INVALID_ORDER_WRITE', 'Send a revision and an ordered ID list.', 400);
  }

  const body = value as Record<string, unknown>;
  const revision = validateRevision(body.revision);
  const rawIds = body.achievementIds;

  if (!Array.isArray(rawIds)) {
    throw new ValidationError('INVALID_ORDER_WRITE', 'achievementIds must be an array.', 400);
  }
  if (rawIds.length > MAX_COLLECTION_MEMBERS) {
    throw new ValidationError(
      'COLLECTION_LIMIT',
      `A collection holds at most ${MAX_COLLECTION_MEMBERS} artworks.`,
      400
    );
  }

  const seen = new Set<string>();
  const achievementIds: string[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw.trim())) {
      throw new ValidationError('INVALID_ORDER_WRITE', 'Every artwork ID must be a UUID.', 400);
    }
    const id = raw.trim().toLowerCase();
    if (seen.has(id)) {
      throw new ValidationError('DUPLICATE_MEMBER', 'An artwork appears twice in this order.', 400);
    }
    seen.add(id);
    achievementIds.push(id);
  }

  return { revision, achievementIds };
}
