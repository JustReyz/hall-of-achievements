interface UpgradeClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

// CREATE TABLE IF NOT EXISTS never adds columns to a database created by an
// earlier release. Every upgrade here must be safe to run on both fresh and
// existing schemas, and the migration entry point must surface any failure.
const ARCHIVE_SCHEMA_UPGRADES = [
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

export async function applyArchiveSchemaUpgrades(client: UpgradeClient): Promise<void> {
  for (const statement of ARCHIVE_SCHEMA_UPGRADES) {
    await client.query(statement);
  }
}
