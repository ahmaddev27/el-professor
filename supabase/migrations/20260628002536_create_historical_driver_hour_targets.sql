
-- Table: historical_driver_hour_targets
-- Stores reusable monthly payroll-hour targets imported from JSON or entered manually.
-- Used to prefill the "Mit Arbeitsstunden" historical reconciliation wizard.

CREATE TABLE IF NOT EXISTS historical_driver_hour_targets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  driver_id           uuid REFERENCES drivers(id) ON DELETE SET NULL,
  driver_name         text NOT NULL,
  month               text NOT NULL,
  year                integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  base_hours          numeric(8,4) NOT NULL DEFAULT 0,
  night_25_hours      numeric(8,4) NOT NULL DEFAULT 0,
  night_0_4_40_hours  numeric(8,4) NOT NULL DEFAULT 0,
  sunday_50_hours     numeric(8,4) NOT NULL DEFAULT 0,
  holiday_hours       numeric(8,4) NOT NULL DEFAULT 0,
  source_import_id    uuid,
  updated_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Uniqueness: one record per driver (by driver_id) per company/month/year
CREATE UNIQUE INDEX IF NOT EXISTS hdht_unique_driver_id
  ON historical_driver_hour_targets (company_id, driver_id, month, year)
  WHERE driver_id IS NOT NULL;

-- Fallback uniqueness when driver_id is null: by normalized driver_name
CREATE UNIQUE INDEX IF NOT EXISTS hdht_unique_driver_name
  ON historical_driver_hour_targets (company_id, lower(trim(driver_name)), month, year)
  WHERE driver_id IS NULL;

-- Index for efficient month/year lookups
CREATE INDEX IF NOT EXISTS hdht_company_month_year
  ON historical_driver_hour_targets (company_id, year, month);

-- Enable RLS
ALTER TABLE historical_driver_hour_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hdht_select" ON historical_driver_hour_targets
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "hdht_insert" ON historical_driver_hour_targets
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "hdht_update" ON historical_driver_hour_targets
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

CREATE POLICY "hdht_delete" ON historical_driver_hour_targets
  FOR DELETE TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );
