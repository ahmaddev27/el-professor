-- Historical payroll targets for Steuerberater reconciliation
-- Stores per-driver, per-month target values for each Lohnart (wage type)
CREATE TABLE IF NOT EXISTS historical_payroll_targets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL,
  month                integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                 integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  driver_id            uuid NOT NULL,
  wage_type_code       text NOT NULL,
  wage_type_label      text NOT NULL,
  target_hours_decimal numeric(10, 4) NOT NULL DEFAULT 0,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_historical_payroll_target
    UNIQUE (company_id, month, year, driver_id, wage_type_code)
);

CREATE INDEX IF NOT EXISTS idx_hist_payroll_company_period
  ON historical_payroll_targets (company_id, year, month);

ALTER TABLE historical_payroll_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_hist_payroll" ON historical_payroll_targets
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "insert_own_hist_payroll" ON historical_payroll_targets
  FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "update_own_hist_payroll" ON historical_payroll_targets
  FOR UPDATE TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "delete_own_hist_payroll" ON historical_payroll_targets
  FOR DELETE TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));
