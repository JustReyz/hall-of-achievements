interface UpgradeClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

// CREATE TABLE IF NOT EXISTS never adds columns to a database created by an
// earlier release. Every upgrade here must be safe to run on both fresh and
// existing schemas, and the migration entry point must surface any failure.
const ARCHIVE_SCHEMA_UPGRADES = [
  `ALTER TABLE achievements
    ADD COLUMN IF NOT EXISTS image_description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE achievements
    ADD COLUMN IF NOT EXISTS thumbnail_position_x REAL NOT NULL DEFAULT 0.5`,
  `ALTER TABLE achievements
    ADD COLUMN IF NOT EXISTS thumbnail_position_y REAL NOT NULL DEFAULT 0.5`,
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'achievements_thumbnail_position_x_check'
        AND conrelid = 'achievements'::regclass
    ) THEN
      ALTER TABLE achievements
        ADD CONSTRAINT achievements_thumbnail_position_x_check
        CHECK (thumbnail_position_x >= 0 AND thumbnail_position_x <= 1);
    END IF;
  END
  $$;`,
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'achievements_thumbnail_position_y_check'
        AND conrelid = 'achievements'::regclass
    ) THEN
      ALTER TABLE achievements
        ADD CONSTRAINT achievements_thumbnail_position_y_check
        CHECK (thumbnail_position_y >= 0 AND thumbnail_position_y <= 1);
    END IF;
  END
  $$;`,
  `ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS retired_objects JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE upload_intents
    ADD COLUMN IF NOT EXISTS permanent_keys JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE upload_intents
    ADD COLUMN IF NOT EXISTS quarantine_cleaned_at TIMESTAMPTZ`,
  `ALTER TABLE achievements
    ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_achievements_trashed_at ON achievements (trashed_at)`,
  `CREATE TABLE IF NOT EXISTS collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_collections_created ON collections (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS collection_items (
    collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    achievement_id UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (collection_id, achievement_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_items_position
    ON collection_items (collection_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_collection_items_achievement
    ON collection_items (achievement_id)`,
];

const FINANCE_SCHEMA_UPGRADES = [
  `CREATE TABLE IF NOT EXISTS finance_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(100) NOT NULL,
    password_hash TEXT NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finance_users_username_normalized_check
      CHECK (username = lower(btrim(username)) AND length(username) > 0)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_users_username ON finance_users (username)`,
  `ALTER TABLE finance_users ADD COLUMN IF NOT EXISTS profile_picture TEXT`,
  `CREATE TABLE IF NOT EXISTS finance_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES finance_users(id) ON DELETE CASCADE,
    hall_session_token_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idle_expires_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  )`,
  `ALTER TABLE finance_sessions ADD COLUMN IF NOT EXISTS hall_session_token_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE`,
  `ALTER TABLE finance_sessions ALTER COLUMN hall_session_token_hash DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_finance_sessions_user ON finance_sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS finance_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    created_by UUID NOT NULL REFERENCES finance_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS finance_group_members (
    group_id UUID NOT NULL REFERENCES finance_groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES finance_users(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id),
    CONSTRAINT finance_group_members_role_check CHECK (role IN ('owner', 'admin', 'member'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_finance_group_members_user ON finance_group_members (user_id)`,
  `CREATE TABLE IF NOT EXISTS finance_invitations (
    token_hash VARCHAR(64) PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES finance_groups(id) ON DELETE CASCADE,
    invited_by UUID NOT NULL REFERENCES finance_users(id),
    role VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_finance_invitations_group ON finance_invitations (group_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS finance_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES finance_groups(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(16) NOT NULL DEFAULT 'other' CHECK (type IN ('cash', 'e-wallet', 'bank', 'other')),
    created_by UUID NOT NULL REFERENCES finance_users(id),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_sources_group_id ON finance_sources (group_id, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_sources_group_name ON finance_sources (group_id, name)`,
  `CREATE TABLE IF NOT EXISTS finance_budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL UNIQUE REFERENCES finance_groups(id) ON DELETE CASCADE,
    monthly_limit NUMERIC(18,2),
    currency VARCHAR(3) NOT NULL DEFAULT 'IDR',
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finance_budgets_limit_check CHECK (monthly_limit IS NULL OR (monthly_limit >= 0 AND monthly_limit <> 'NaN'::numeric)),
    CONSTRAINT finance_budgets_currency_check CHECK (currency ~ '^[A-Z]{3}$')
  )`,
  `CREATE TABLE IF NOT EXISTS finance_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES finance_groups(id) ON DELETE RESTRICT,
    name VARCHAR(120) NOT NULL,
    type VARCHAR(16) NOT NULL,
    target_amount NUMERIC(18,2),
    currency VARCHAR(3) NOT NULL DEFAULT 'IDR',
    default_category VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finance_wallets_type_target_check CHECK (
      (type = 'regular' AND target_amount IS NULL) OR
      (type = 'goal' AND target_amount IS NOT NULL AND target_amount >= 0 AND target_amount <> 'NaN'::numeric)
    ),
    CONSTRAINT finance_wallets_currency_check CHECK (currency ~ '^[A-Z]{3}$')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_wallets_group_id ON finance_wallets (group_id, id)`,
  `CREATE TABLE IF NOT EXISTS finance_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL,
    wallet_id UUID NOT NULL,
    type VARCHAR(16) NOT NULL,
    amount NUMERIC(18,2) NOT NULL,
    category VARCHAR(100),
    note TEXT,
    transaction_date DATE NOT NULL,
    created_by UUID NOT NULL REFERENCES finance_users(id),
    updated_by UUID REFERENCES finance_users(id),
    idempotency_key UUID,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finance_transactions_wallet_group_fk FOREIGN KEY (group_id, wallet_id)
      REFERENCES finance_wallets(group_id, id) ON DELETE RESTRICT,
    CONSTRAINT finance_transactions_type_check CHECK (type IN ('income', 'expense')),
    CONSTRAINT finance_transactions_amount_check CHECK (amount > 0 AND amount <> 'NaN'::numeric)
  )`,
  `ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS source_id UUID`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_transactions_source_group_fk') THEN
      ALTER TABLE finance_transactions ADD CONSTRAINT finance_transactions_source_group_fk
        FOREIGN KEY (group_id, source_id) REFERENCES finance_sources(group_id, id) ON DELETE RESTRICT;
    END IF;
  END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_transactions_creator_idempotency
    ON finance_transactions (created_by, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_finance_transactions_wallet_date
    ON finance_transactions (wallet_id, transaction_date, id)`,
  `CREATE TABLE IF NOT EXISTS finance_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES finance_groups(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES finance_users(id),
    title VARCHAR(200) NOT NULL,
    content TEXT,
    target_at TIMESTAMPTZ,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_completed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_notes_group_id ON finance_notes(group_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_finance_notes_group_target ON finance_notes(group_id, target_at)`,
  `CREATE TABLE IF NOT EXISTS finance_note_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL,
    note_id UUID NOT NULL,
    created_by UUID NOT NULL,
    reminder_type VARCHAR(16) NOT NULL DEFAULT 'relative' CHECK (reminder_type IN ('relative', 'recurring')),
    lead_minutes INTEGER,
    remind_at TIMESTAMPTZ NOT NULL,
    recurrence VARCHAR(16) NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly', 'monthly', 'yearly')),
    until_date DATE,
    message TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
    delivered_count INTEGER NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
    last_notified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finance_note_reminders_note_group_fk FOREIGN KEY (group_id, note_id) REFERENCES finance_notes(group_id, id) ON DELETE CASCADE,
    CONSTRAINT finance_note_reminders_creator_fk FOREIGN KEY (created_by) REFERENCES finance_users(id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_finance_note_reminders_due ON finance_note_reminders(status, remind_at)`,
  `CREATE TABLE IF NOT EXISTS finance_scheduled_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES finance_groups(id) ON DELETE CASCADE,
    created_by UUID NOT NULL,
    title VARCHAR(200) NOT NULL,
    details TEXT,
    schedule_at TIMESTAMPTZ NOT NULL,
    recurrence VARCHAR(16) NOT NULL DEFAULT 'once' CHECK (recurrence IN ('once', 'daily', 'weekly', 'monthly')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_notified_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finance_scheduled_tasks_creator_fk FOREIGN KEY (created_by) REFERENCES finance_users(id) ON DELETE RESTRICT
  )`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_note_reminders_member_group_fk' AND conrelid = 'finance_note_reminders'::regclass) THEN
      ALTER TABLE finance_note_reminders DROP CONSTRAINT finance_note_reminders_member_group_fk;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_note_reminders_creator_fk' AND conrelid = 'finance_note_reminders'::regclass) THEN
      ALTER TABLE finance_note_reminders ADD CONSTRAINT finance_note_reminders_creator_fk FOREIGN KEY (created_by) REFERENCES finance_users(id) ON DELETE RESTRICT;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_scheduled_tasks_member_group_fk' AND conrelid = 'finance_scheduled_tasks'::regclass) THEN
      ALTER TABLE finance_scheduled_tasks DROP CONSTRAINT finance_scheduled_tasks_member_group_fk;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_scheduled_tasks_creator_fk' AND conrelid = 'finance_scheduled_tasks'::regclass) THEN
      ALTER TABLE finance_scheduled_tasks ADD CONSTRAINT finance_scheduled_tasks_creator_fk FOREIGN KEY (created_by) REFERENCES finance_users(id) ON DELETE RESTRICT;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_finance_scheduled_tasks_group_schedule ON finance_scheduled_tasks(group_id, schedule_at)`,
  `CREATE TABLE IF NOT EXISTS finance_import_records (
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('wallet', 'transaction', 'note', 'reminder', 'task')),
    legacy_id UUID NOT NULL,
    target_id UUID NOT NULL,
    group_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, legacy_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_import_records_target ON finance_import_records (kind, target_id)`,
  `CREATE TABLE IF NOT EXISTS finance_push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES finance_users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_push_endpoint ON finance_push_subscriptions (endpoint)`,
  `CREATE INDEX IF NOT EXISTS idx_finance_push_user ON finance_push_subscriptions (user_id, status)`,
  `CREATE TABLE IF NOT EXISTS finance_push_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES finance_users(id) ON DELETE CASCADE,
    reminder_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    target_ids JSONB NOT NULL,
    outcome VARCHAR(16) NOT NULL DEFAULT 'in_progress' CHECK (outcome IN ('in_progress', 'complete')),
    results JSONB NOT NULL DEFAULT '[]'::jsonb,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_push_attempt_idempotency ON finance_push_attempts (user_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_finance_push_attempt_user_time ON finance_push_attempts (user_id, attempted_at)`,
];

export async function applyArchiveSchemaUpgrades(client: UpgradeClient): Promise<void> {
  for (const statement of ARCHIVE_SCHEMA_UPGRADES) {
    await client.query(statement);
  }
  // These tables are additive and remain inaccessible while the finance API
  // flag is off. Keeping them present lets archive export preserve finance data
  // even if the feature flag is later disabled.
  for (const statement of FINANCE_SCHEMA_UPGRADES) {
    await client.query(statement);
  }
}
