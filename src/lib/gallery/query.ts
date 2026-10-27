import { eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { achievements } from '@/lib/db/schema';
import type { GalleryFilters } from '@/components/gallery/types';

/**
 * The single definition of normal visibility: a finished artwork that is not in
 * Trash. Gallery, tags, items, assets, health, and replay all consume this.
 */
export function normalVisibilityConditions(): SQL[] {
  return [eq(achievements.state, 'ready'), isNull(achievements.trashedAt)];
}

export function buildGalleryConditions(filters: GalleryFilters): SQL[] {
  const conditions: SQL[] = normalVisibilityConditions();

  if (filters.from) {
    conditions.push(gte(achievements.completionDate, filters.from));
  }
  if (filters.to) {
    conditions.push(lte(achievements.completionDate, filters.to));
  }

  const q = filters.q.trim();
  if (q) {
    // Escape SQL LIKE wildcards ('%', '_', and '\') to ensure literal matching.
    const escapedQ = q.replace(/[%_\\]/g, '\\$&');
    const sanitizedQ = `%${escapedQ}%`;
    conditions.push(
      or(
        sql`${achievements.title} ILIKE ${sanitizedQ}`,
        sql`${achievements.tags}::text ILIKE ${sanitizedQ}`,
        sql`${achievements.notes} ILIKE ${sanitizedQ}`
      )!
    );
  }

  if (filters.tag) {
    conditions.push(
      sql`${achievements.tags} @> ${JSON.stringify([filters.tag])}::jsonb`
    );
  }

  return conditions;
}
