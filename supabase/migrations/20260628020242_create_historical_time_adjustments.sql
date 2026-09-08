
-- Table: historical_time_adjustments
-- Stores approved manual time corrections for the Mit-Arbeitsstunden historical reconciliation.
-- Only start/end time are adjusted; all other trip fields remain unchanged.
-- Original ride data is NEVER mutated. These are correction proposals that require
-- explicit user approval before being used in export or calculation.

CREATE TABLE IF NOT EXISTS historical_time_adjustments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reconciliation_id    uuid REFERENCES historical_reconciliations(id) ON DELETE CASCADE,
  source_row_index     integer,
  fahrt_id             uuid,
  original_start_time  text NOT NULL,   -- HH:MM
  original_end_time    text NOT NULL,   -- HH:MM
  adjusted_start_time  text NOT NULL,   -- HH:MM
  adjusted_end_time    text NOT NULL,   -- HH:MM
  duration_minutes     integer NOT NULL,
  reason               text,
  status               text NOT NULL DEFAULT 'approved'
                        CHECK (status IN ('proposal', 'approved', 'rejected', 'invalid')),
  approved_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hta_company_recon
  ON historical_time_adjustments (company_id, reconciliation_id);

ALTER TABLE historical_time_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hta_select" ON historical_time_adjustments
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "hta_insert" ON historical_time_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "hta_update" ON historical_time_adjustments
  FOR UPDATE TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "hta_delete" ON historical_time_adjustments
  FOR DELETE TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );
