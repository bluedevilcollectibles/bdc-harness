-- Migration 046: defensively repair live tm_health schemas that drifted from
-- migration 041's provider-only primary key. This is normally a no-op.
DO $$
DECLARE
  primary_key_name text;
  primary_key_columns text[];
BEGIN
  -- Serialize inspection and repair with writers so no new duplicate can race
  -- the deduplication or primary-key installation in this atomic DO block.
  LOCK TABLE tm_health IN ACCESS EXCLUSIVE MODE;

  SELECT c.conname, array_agg(a.attname ORDER BY key_column.ordinality)
  INTO primary_key_name, primary_key_columns
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum
  WHERE t.relname = 'tm_health'
    AND n.nspname = current_schema()
    AND c.contype = 'p'
  GROUP BY c.conname;

  IF primary_key_name IS NULL OR primary_key_columns <> ARRAY['provider']::text[] THEN
    DELETE FROM tm_health older
    USING tm_health newer
    WHERE older.provider = newer.provider
      AND (older.sampled_at, older.ctid) < (newer.sampled_at, newer.ctid);

    IF primary_key_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE tm_health DROP CONSTRAINT %I', primary_key_name);
    END IF;
    ALTER TABLE tm_health ADD PRIMARY KEY (provider);
  END IF;
END $$;
