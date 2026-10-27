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
];

export async function applyArchiveSchemaUpgrades(client: UpgradeClient): Promise<void> {
  for (const statement of ARCHIVE_SCHEMA_UPGRADES) {
    await client.query(statement);
  }
}
