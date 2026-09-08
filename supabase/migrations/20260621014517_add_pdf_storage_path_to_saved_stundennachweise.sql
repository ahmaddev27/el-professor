-- Add stored PDF path and snapshot hash to saved_stundennachweise
-- This enables single-source-of-truth PDF storage: the exact blob generated
-- at save time is stored and served unchanged, eliminating regeneration mismatch.
ALTER TABLE saved_stundennachweise
  ADD COLUMN IF NOT EXISTS pdf_storage_path text,
  ADD COLUMN IF NOT EXISTS snapshot_hash    text;

COMMENT ON COLUMN saved_stundennachweise.pdf_storage_path IS
  'Storage path in stundennachweise-pdfs bucket. When set, Documents page serves this file directly instead of regenerating.';
COMMENT ON COLUMN saved_stundennachweise.snapshot_hash IS
  'Lightweight hash: driver_id|run_id|grundlohn|nachtarbeit|month|year. Used to detect if stored PDF may be stale.';
