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
];

export async function applyArchiveSchemaUpgrades(client: UpgradeClient): Promise<void> {
  for (const statement of ARCHIVE_SCHEMA_UPGRADES) {
    await client.query(statement);
  }
  if (process.env.FINANCE_EXPERIMENTAL === 'true') {
    for (const statement of FINANCE_SCHEMA_UPGRADES) {
      await client.query(statement);
    }
  }
}
