ALTER TABLE saved_stundennachweise
  ADD COLUMN IF NOT EXISTS generation_source  text    NULL,
  ADD COLUMN IF NOT EXISTS source_import_id   uuid    NULL,
  ADD COLUMN IF NOT EXISTS source_run_id      uuid    NULL,
  ADD COLUMN IF NOT EXISTS generated_at       timestamptz NULL,
  ADD COLUMN IF NOT EXISTS warnings_json      jsonb   NULL;
