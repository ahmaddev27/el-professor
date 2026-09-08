-- Ausgleichsstunden adjustments per planning run + driver.
-- These are Stundennachweis-only payroll adjustments (never touch Fahrtenbuch).
CREATE TABLE IF NOT EXISTS planning_run_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id uuid NOT NULL REFERENCES company_planning_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  driver_id text NOT NULL,
  driver_name text NOT NULL,
  adjustment_type text NOT NULL DEFAULT 'gehaltsausgleich',
  hours numeric(10,2) NOT NULL CHECK (hours > 0),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  hourly_rate numeric(10,2) NOT NULL CHECK (hourly_rate > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planning_run_adjustments_run ON planning_run_adjustments(planning_run_id);
CREATE INDEX IF NOT EXISTS idx_planning_run_adjustments_company ON planning_run_adjustments(company_id);

ALTER TABLE planning_run_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_adjustments" ON planning_run_adjustments FOR SELECT
  TO authenticated USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "insert_own_adjustments" ON planning_run_adjustments FOR INSERT
  TO authenticated WITH CHECK (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "update_own_adjustments" ON planning_run_adjustments FOR UPDATE
  TO authenticated USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "delete_own_adjustments" ON planning_run_adjustments FOR DELETE
  TO authenticated USING (company_id = get_user_company_id() OR is_user_super_admin());
