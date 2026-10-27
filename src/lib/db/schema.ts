import { sql } from 'drizzle-orm';
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
  customType,
  real,
  check,
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
    thumbnailPositionX: real('thumbnail_position_x').notNull().default(0.5),
    thumbnailPositionY: real('thumbnail_position_y').notNull().default(0.5),
    state: text('state')
      .$type<'pending' | 'ready' | 'deleting'>()
      .notNull()
      .default('pending'),
    /** Set when the owner moves a finished artwork to Trash. */
    trashedAt: timestamp('trashed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'achievements_thumbnail_position_x_check',
      sql`${table.thumbnailPositionX} >= 0 AND ${table.thumbnailPositionX} <= 1`
    ),
    check(
      'achievements_thumbnail_position_y_check',
      sql`${table.thumbnailPositionY} >= 0 AND ${table.thumbnailPositionY} <= 1`
    ),
    index('idx_achievements_state_cursor').on(
      table.state,
      table.completionDate.desc(),
      table.id.desc()
    ),
    index('idx_achievements_completion_date').on(table.completionDate.desc()),
    index('idx_achievements_state').on(table.state),
    index('idx_achievements_trashed_at').on(table.trashedAt),
  ]
);

/**
 * A superseded asset version whose objects still need removing. The entry is
 * dropped only after every key in it is gone, so a failed cleanup stays visible
 * to the next attempt and stays counted against quota.
 */
export interface RetiredObject {
  keys: string[];
  accountedBytes: number;
}

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
    retiredObjects: jsonb('retired_objects').$type<RetiredObject[]>().notNull().default([]),
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
    permanentKeys: jsonb('permanent_keys').$type<string[]>().notNull().default([]),
    quarantineCleanedAt: timestamp('quarantine_cleaned_at', { withTimezone: true, mode: 'date' }),
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

/**
 * Web push subscriptions authorized by the authenticated owner.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    status: text('status')
      .$type<'active' | 'disabled'>()
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_push_subscriptions_status_created').on(table.status, table.createdAt),
    index('idx_push_subscriptions_token_hash').on(table.tokenHash),
    index('idx_push_subscriptions_endpoint').on(table.endpoint),
  ]
);

/**
 * Durable ledger for reminder attempts, cooldown enforcement, and idempotency tracking.
 */
export const reminderAttempts = pgTable(
  'reminder_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull().unique(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    targetIds: jsonb('target_ids').$type<string[]>().notNull().default([]),
    outcome: text('outcome').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_reminder_attempts_token_attempted').on(table.tokenHash, table.attemptedAt.desc()),
    index('idx_reminder_attempts_idempotency').on(table.idempotencyKey),
    index('idx_reminder_attempts_attempted_at').on(table.attemptedAt.desc()),
  ]
);

export type PushSubscriptionRecord = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = typeof pushSubscriptions.$inferInsert;

export type ReminderAttempt = typeof reminderAttempts.$inferSelect;
export type InsertReminderAttempt = typeof reminderAttempts.$inferInsert;

/**
 * Durable storage objects table for serverless environments.
 */
export const storageObjects = pgTable(
  'storage_objects',
  {
    key: text('key').primaryKey(),
    data: customType<{ data: Buffer }>({
      dataType() {
        return 'bytea';
      },
    })('data').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_storage_objects_created').on(table.createdAt),
  ]
);

export type StorageObject = typeof storageObjects.$inferSelect;
export type InsertStorageObject = typeof storageObjects.$inferInsert;


