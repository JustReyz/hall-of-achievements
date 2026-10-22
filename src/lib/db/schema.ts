import {
  pgTable,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
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
