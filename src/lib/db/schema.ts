import {
  pgTable,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  uuid,
  varchar,
  date,
} from 'drizzle-orm/pg-core';

/**
 * Singleton authentication state storing the active HMAC version and rotation audit metadata.
 */
export const authState = pgTable('auth_state', {
  id: integer('id').primaryKey().default(1),
  currentVersion: text('current_version').notNull(),
  rotationMetadata: jsonb('rotation_metadata').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * Active and revoked device sessions. Raw tokens are never stored; only SHA-256 hashes.
 */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    authStateVersion: text('auth_state_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('idx_sessions_expires_revoked').on(table.expiresAt, table.revoked),
    index('idx_sessions_auth_version').on(table.authStateVersion),
  ]
);

/**
 * Durable atomic rate limiting tracking failed attempts per salted IP hash.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    scope: text('scope').notNull().default('login_ip'),
    attemptCount: integer('attempt_count').notNull().default(1),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_rate_limits_window').on(table.windowStart),
  ]
);

export type AuthState = typeof authState.$inferSelect;
export type InsertAuthState = typeof authState.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type InsertSession = typeof sessions.$inferInsert;

export type RateLimit = typeof rateLimits.$inferSelect;
export type InsertRateLimit = typeof rateLimits.$inferInsert;

/**
 * Achievements table: individual artwork achievement domain records.
 */
export const achievements = pgTable(
  'achievements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 120 }).notNull(),
    completionDate: date('completion_date').notNull(),
    notes: text('notes'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    state: text('state')
      .$type<'pending' | 'ready' | 'deleting'>()
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_achievements_state_cursor').on(
      table.state,
      table.completionDate.desc(),
      table.id.desc()
    ),
    index('idx_achievements_completion_date').on(table.completionDate.desc()),
    index('idx_achievements_state').on(table.state),
  ]
);

/**
 * Assets table: original and derivative image metadata and storage keys.
 */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    achievementId: uuid('achievement_id')
      .notNull()
      .references(() => achievements.id, { onDelete: 'cascade' }),
    originalKey: text('original_key').notNull(),
    displayKey: text('display_key').notNull(),
    thumbnailKey: text('thumbnail_key').notNull(),
    originalBytes: integer('original_bytes').notNull(),
    mimeType: varchar('mime_type', { length: 50 }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    checksum: varchar('checksum', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_assets_achievement_id').on(table.achievementId),
    index('idx_assets_checksum').on(table.checksum),
  ]
);

/**
 * Upload intents table: tracks direct upload reservations against the 70% storage ceiling.
 */
export const uploadIntents = pgTable(
  'upload_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    achievementId: uuid('achievement_id').references(() => achievements.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 50 }).notNull(),
    declaredSize: integer('declared_size').notNull(),
    reservedBytes: integer('reserved_bytes').notNull(),
    quarantineKey: text('quarantine_key').notNull(),
    status: text('status')
      .$type<'pending' | 'consumed' | 'expired' | 'cleaned'>()
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_upload_intents_status').on(table.status),
    index('idx_upload_intents_expires').on(table.expiresAt),
    index('idx_upload_intents_token_hash').on(table.tokenHash),
  ]
);

export type Achievement = typeof achievements.$inferSelect;
export type InsertAchievement = typeof achievements.$inferInsert;

export type Asset = typeof assets.$inferSelect;
export type InsertAsset = typeof assets.$inferInsert;

export type UploadIntent = typeof uploadIntents.$inferSelect;
export type InsertUploadIntent = typeof uploadIntents.$inferInsert;

