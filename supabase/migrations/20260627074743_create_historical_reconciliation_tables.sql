-- Historical reconciliation: one record per company/month combination
CREATE TABLE IF NOT EXISTS historical_reconciliations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month             integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  year              integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  import_id         uuid REFERENCES fahrtenbuch_imports(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finalized_at      timestamptz,
  notes             text,
  UNIQUE (company_id, month, year)
);

ALTER TABLE historical_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_reconciliations" ON historical_reconciliations FOR SELECT
  TO authenticated USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "insert_own_reconciliations" ON historical_reconciliations FOR INSERT
  TO authenticated WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "update_own_reconciliations" ON historical_reconciliations FOR UPDATE
  TO authenticated USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  ) WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

CREATE POLICY "delete_own_reconciliations" ON historical_reconciliations FOR DELETE
  TO authenticated USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid() AND company_id IS NOT NULL
    )
  );

-- Per-driver target values and computed results for a reconciliation
CREATE TABLE IF NOT EXISTS historical_reconciliation_drivers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id         uuid NOT NULL REFERENCES historical_reconciliations(id) ON DELETE CASCADE,
  driver_id                 uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  driver_name               text NOT NULL,
  personalnummer            text,
  hourly_rate_cents         integer NOT NULL DEFAULT 0, -- euro-cents per hour
  -- Steuerberater target: gross brutto in euro-cents
  target_gross_cents        integer NOT NULL DEFAULT 0,
  -- Computed from rides
  gross_from_rides_cents    integer,
  -- Ausgleichsstunden in decimal hours (stored as integer thousandths for precision)
  ausgleich_stunden_milli   integer, -- e.g. 1500 = 1.5h
  -- Final gross (should equal target_gross_cents when finalized)
  final_gross_cents         integer,
  -- Whether this driver is blocked from export (over target, missing data, etc.)
  export_blocked            boolean NOT NULL DEFAULT false,
  export_block_reason       text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, driver_id)
);

ALTER TABLE historical_reconciliation_drivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_recon_drivers" ON historical_reconciliation_drivers FOR SELECT
  TO authenticated USING (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );

CREATE POLICY "insert_own_recon_drivers" ON historical_reconciliation_drivers FOR INSERT
  TO authenticated WITH CHECK (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );

CREATE POLICY "update_own_recon_drivers" ON historical_reconciliation_drivers FOR UPDATE
  TO authenticated USING (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  ) WITH CHECK (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );

CREATE POLICY "delete_own_recon_drivers" ON historical_reconciliation_drivers FOR DELETE
  TO authenticated USING (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );

-- Snapshot of final PDF row data per driver (for regeneration without re-calculating)
CREATE TABLE IF NOT EXISTS historical_reconciliation_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id uuid NOT NULL REFERENCES historical_reconciliations(id) ON DELETE CASCADE,
  driver_id         uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  rows_json         jsonb NOT NULL DEFAULT '[]',  -- PdfDayRow[]
  totals_json       jsonb NOT NULL DEFAULT '{}',  -- PdfTotals
  corrections_json  jsonb NOT NULL DEFAULT '[]',  -- HistoricalPdfCorrectionEntry[]
  generated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, driver_id)
);

ALTER TABLE historical_reconciliation_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_recon_results" ON historical_reconciliation_results FOR SELECT
  TO authenticated USING (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );

CREATE POLICY "insert_own_recon_results" ON historical_reconciliation_results FOR INSERT
  TO authenticated WITH CHECK (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );

CREATE POLICY "update_own_recon_results" ON historical_reconciliation_results FOR UPDATE
  TO authenticated USING (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  ) WITH CHECK (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );

CREATE POLICY "delete_own_recon_results" ON historical_reconciliation_results FOR DELETE
  TO authenticated USING (
    reconciliation_id IN (
      SELECT hr.id FROM historical_reconciliations hr
      JOIN user_profiles up ON up.company_id = hr.company_id
      WHERE up.user_id = auth.uid()
    )
  );
