-- Add source metadata for exact-format export reconstruction.
-- source_columns_json: original column names in order from the uploaded Excel
-- source_sheet_name:   original sheet name from the uploaded Excel
-- source_row_index:    original row position in the uploaded Excel (1-based)

ALTER TABLE fahrtenbuch_imports
  ADD COLUMN IF NOT EXISTS source_columns_json jsonb,
  ADD COLUMN IF NOT EXISTS source_sheet_name   text;

ALTER TABLE fahrtenbuch_trips
  ADD COLUMN IF NOT EXISTS source_row_index integer;

CREATE INDEX IF NOT EXISTS idx_fahrtenbuch_trips_source_row
  ON fahrtenbuch_trips (import_id, source_row_index);
