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
  primaryKey,
  uniqueIndex,
  numeric,
  foreignKey,
} from 'drizzle-orm/pg-core';

/** Separate identities for the finance area; Hall archive sessions remain unchanged. */
export const financeUsers = pgTable('finance_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 100 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: varchar('display_name', { length: 120 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_finance_users_username').on(table.username),
  check('finance_users_username_normalized_check', sql`${table.username} = lower(btrim(${table.username})) AND length(${table.username}) > 0`),
]);

export const financeSessions = pgTable('finance_sessions', {
  tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => financeUsers.id, { onDelete: 'cascade' }),
  hallSessionTokenHash: text('hall_session_token_hash').references(() => sessions.tokenHash, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
}, (table) => [index('idx_finance_sessions_user').on(table.userId)]);

export const financeGroups = pgTable('finance_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  createdBy: uuid('created_by').notNull().references(() => financeUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const financeGroupMembers = pgTable('finance_group_members', {
  groupId: uuid('group_id').notNull().references(() => financeGroups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => financeUsers.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).$type<'owner' | 'admin' | 'member'>().notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.groupId, table.userId] }),
  index('idx_finance_group_members_user').on(table.userId),
  check('finance_group_members_role_check', sql`${table.role} IN ('owner', 'admin', 'member')`),
]);

export const financeInvitations = pgTable('finance_invitations', {
  tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
  groupId: uuid('group_id').notNull().references(() => financeGroups.id, { onDelete: 'cascade' }),
  invitedBy: uuid('invited_by').notNull().references(() => financeUsers.id),
  role: varchar('role', { length: 16 }).$type<'admin' | 'member'>().notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  index('idx_finance_invitations_group').on(table.groupId, table.expiresAt),
  check('finance_invitations_role_check', sql`${table.role} IN ('admin', 'member')`),
]);

export const financeSources = pgTable('finance_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => financeGroups.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 16 }).$type<'cash' | 'e-wallet' | 'bank' | 'other'>().notNull().default('other'),
  createdBy: uuid('created_by').notNull().references(() => financeUsers.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_finance_sources_group_id').on(table.groupId, table.id),
  uniqueIndex('idx_finance_sources_group_name').on(table.groupId, table.name),
  check('finance_sources_type_check', sql`${table.type} IN ('cash', 'e-wallet', 'bank', 'other')`),
]);

export const financeBudgets = pgTable('finance_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().unique().references(() => financeGroups.id, { onDelete: 'cascade' }),
  monthlyLimit: numeric('monthly_limit', { precision: 18, scale: 2 }),
  currency: varchar('currency', { length: 3 }).notNull().default('IDR'),
  enabled: boolean('enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  check('finance_budgets_limit_check', sql`${table.monthlyLimit} IS NULL OR (${table.monthlyLimit} >= 0 AND ${table.monthlyLimit} <> 'NaN'::numeric)`),
  check('finance_budgets_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
]);

export const financeWallets = pgTable('finance_wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => financeGroups.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 120 }).notNull(),
  type: varchar('type', { length: 16 }).$type<'regular' | 'goal'>().notNull(),
  targetAmount: numeric('target_amount', { precision: 18, scale: 2 }),
  currency: varchar('currency', { length: 3 }).notNull().default('IDR'),
  defaultCategory: varchar('default_category', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_finance_wallets_group_id').on(table.groupId, table.id),
  check('finance_wallets_type_target_check', sql`(${table.type} = 'regular' AND ${table.targetAmount} IS NULL) OR (${table.type} = 'goal' AND ${table.targetAmount} IS NOT NULL AND ${table.targetAmount} >= 0 AND ${table.targetAmount} <> 'NaN'::numeric)`),
  check('finance_wallets_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
]);

export const financeTransactions = pgTable('finance_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull(),
  walletId: uuid('wallet_id').notNull(),
  sourceId: uuid('source_id'),
  type: varchar('type', { length: 16 }).$type<'income' | 'expense'>().notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  category: varchar('category', { length: 100 }),
  note: text('note'),
  transactionDate: date('transaction_date').notNull(),
  createdBy: uuid('created_by').notNull().references(() => financeUsers.id),
  updatedBy: uuid('updated_by').references(() => financeUsers.id),
  idempotencyKey: uuid('idempotency_key'),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.groupId, table.walletId], foreignColumns: [financeWallets.groupId, financeWallets.id], name: 'finance_transactions_wallet_group_fk' }).onDelete('restrict'),
  foreignKey({ columns: [table.groupId, table.sourceId], foreignColumns: [financeSources.groupId, financeSources.id], name: 'finance_transactions_source_group_fk' }).onDelete('restrict'),
  uniqueIndex('idx_finance_transactions_creator_idempotency').on(table.createdBy, table.idempotencyKey),
  index('idx_finance_transactions_wallet_date').on(table.walletId, table.transactionDate, table.id),
  check('finance_transactions_type_check', sql`${table.type} IN ('income', 'expense')`),
  check('finance_transactions_amount_check', sql`${table.amount} > 0 AND ${table.amount} <> 'NaN'::numeric`),
]);

/**
 * Singleton authentication state storing the active HMAC version and rotation audit metadata.
 */
export const authState = pgTable('auth_state', {
  id: integer('id').primaryKey().default(1),
  currentVersion: text('current_version').notNull(),
  rotationMetadata: jsonb('rotation_metadata')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
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
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
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
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('idx_rate_limits_window').on(table.windowStart)]
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
    imageDescription: text('image_description').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    thumbnailPositionX: real('thumbnail_position_x').notNull().default(0.5),
    thumbnailPositionY: real('thumbnail_position_y').notNull().default(0.5),
    state: text('state').$type<'pending' | 'ready' | 'deleting'>().notNull().default('pending'),
    /** Set when the owner moves a finished artwork to Trash. */
    trashedAt: timestamp('trashed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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
    achievementId: uuid('achievement_id').references(() => achievements.id, {
      onDelete: 'cascade',
    }),
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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
 * Curated collections. The revision counter invalidates curated cursors and
 * order writes that were prepared against an older membership list.
 */
export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    revision: integer('revision').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('idx_collections_created').on(table.createdAt.desc())]
);

/**
 * Ordered membership. Removing a collection removes only these rows; removing a
 * member never removes artwork. Permanent purge cascades through achievementId.
 */
export const collectionItems = pgTable(
  'collection_items',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    achievementId: uuid('achievement_id')
      .notNull()
      .references(() => achievements.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.achievementId] }),
    uniqueIndex('idx_collection_items_position').on(table.collectionId, table.position),
    index('idx_collection_items_achievement').on(table.achievementId),
  ]
);

export type Collection = typeof collections.$inferSelect;
export type CollectionItem = typeof collectionItems.$inferSelect;

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
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('idx_storage_objects_created').on(table.createdAt)]
);

export type StorageObject = typeof storageObjects.$inferSelect;
export type InsertStorageObject = typeof storageObjects.$inferInsert;
