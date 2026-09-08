CREATE TABLE IF NOT EXISTS historical_block_adjustments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reconciliation_id         uuid REFERENCES historical_reconciliations(id) ON DELETE CASCADE,
  block_id                  text NOT NULL,
  fahrt_ids                 jsonb NOT NULL DEFAULT '[]',
  source_row_indices        jsonb NOT NULL DEFAULT '[]',
  vehicle                   text NOT NULL DEFAULT '',
  original_date             text NOT NULL DEFAULT '',
  original_block_start      text NOT NULL DEFAULT '00:00',
  original_block_end        text NOT NULL DEFAULT '00:00',
  adjusted_block_start      text,
  adjusted_block_end        text,
  adjusted_date             text,
  offset_seconds            integer,
  proposed_driver_id        text,
  proposed_driver_name      text,
  original_driver_name      text,
  status                    text NOT NULL DEFAULT 'proposal'
                              CHECK (status IN ('pending','proposal','approved','rejected','no_slot','invalid')),
  reason                    text,
  fail_reason               text,
  conflicts                 jsonb NOT NULL DEFAULT '[]',
  impact                    text,
  approved_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hba_company_recon
  ON historical_block_adjustments (company_id, reconciliation_id);

ALTER TABLE historical_block_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hba_select_own" ON historical_block_adjustments
  FOR SELECT TO authenticated
  USING (company_id IN (
    SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "hba_insert_own" ON historical_block_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (company_id IN (
    SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "hba_update_own" ON historical_block_adjustments
  FOR UPDATE TO authenticated
  USING (company_id IN (
    SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
  ))
  WITH CHECK (company_id IN (
    SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "hba_delete_own" ON historical_block_adjustments
  FOR DELETE TO authenticated
  USING (company_id IN (
    SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
  ));
