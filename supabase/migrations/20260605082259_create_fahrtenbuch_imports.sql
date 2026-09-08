-- ============================================================
-- Phase 1 — Step 1: fahrtenbuch_imports
-- One row per file-upload event.
-- ============================================================

CREATE TABLE IF NOT EXISTS fahrtenbuch_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month         smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  year          smallint NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  file_name     text NOT NULL,
  imported_by   uuid NOT NULL REFERENCES user_profiles(user_id) ON DELETE RESTRICT,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'archived')),
  row_count     int NOT NULL DEFAULT 0,
  notes         text
);

CREATE INDEX idx_fahrtenbuch_imports_company   ON fahrtenbuch_imports (company_id);
CREATE INDEX idx_fahrtenbuch_imports_monthyear ON fahrtenbuch_imports (company_id, year, month);

ALTER TABLE fahrtenbuch_imports ENABLE ROW LEVEL SECURITY;

-- SELECT: own company
CREATE POLICY "fahrtenbuch_imports_select"
  ON fahrtenbuch_imports FOR SELECT
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

-- INSERT: own company, caller must be importer
CREATE POLICY "fahrtenbuch_imports_insert"
  ON fahrtenbuch_imports FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
    AND imported_by = auth.uid()
  );

-- UPDATE: status/notes — own company only
CREATE POLICY "fahrtenbuch_imports_update"
  ON fahrtenbuch_imports FOR UPDATE
  TO authenticated
  USING   (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

-- DELETE: admin only
CREATE POLICY "fahrtenbuch_imports_delete"
  ON fahrtenbuch_imports FOR DELETE
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
