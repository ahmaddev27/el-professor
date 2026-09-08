-- Add reconciliation_mode to historical_reconciliations
ALTER TABLE public.historical_reconciliations
  ADD COLUMN IF NOT EXISTS reconciliation_mode TEXT NOT NULL DEFAULT 'brutto_salary'
    CHECK (reconciliation_mode IN ('brutto_salary', 'working_hours'));

-- Working-hours target/result table (separate from brutto driver table to avoid cluttering it)
CREATE TABLE IF NOT EXISTS public.historical_reconciliation_wh_drivers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id       UUID NOT NULL REFERENCES public.historical_reconciliations(id) ON DELETE CASCADE,
  driver_id               UUID NOT NULL,
  driver_name             TEXT NOT NULL,
  personalnummer          TEXT,
  hourly_rate_cents       INTEGER NOT NULL DEFAULT 0,
  is_owner                BOOLEAN NOT NULL DEFAULT false,
  is_included             BOOLEAN NOT NULL DEFAULT true,
  hinweis                 TEXT,
  -- target hours from Lohnabrechnung
  target_base_hours       NUMERIC(10,4) NOT NULL DEFAULT 0,
  target_night_25_hours   NUMERIC(10,4) NOT NULL DEFAULT 0,
  target_night_40_hours   NUMERIC(10,4) NOT NULL DEFAULT 0,
  target_sunday_50_hours  NUMERIC(10,4) NOT NULL DEFAULT 0,
  target_holiday_hours    NUMERIC(10,4) NOT NULL DEFAULT 0,
  -- reconstructed actuals from Fahrtenbuch
  actual_base_hours       NUMERIC(10,4),
  actual_night_25_hours   NUMERIC(10,4),
  actual_night_40_hours   NUMERIC(10,4),
  actual_sunday_50_hours  NUMERIC(10,4),
  actual_holiday_hours    NUMERIC(10,4),
  -- computed total
  total_amount_cents      INTEGER,
  -- export state
  export_blocked          BOOLEAN NOT NULL DEFAULT false,
  export_block_reason     TEXT,
  -- timestamps
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_id, driver_id)
);

ALTER TABLE public.historical_reconciliation_wh_drivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_wh_drivers" ON public.historical_reconciliation_wh_drivers
  FOR SELECT TO authenticated
  USING (
    reconciliation_id IN (
      SELECT id FROM public.historical_reconciliations WHERE company_id = get_user_company_id()
    )
  );

CREATE POLICY "insert_own_wh_drivers" ON public.historical_reconciliation_wh_drivers
  FOR INSERT TO authenticated
  WITH CHECK (
    reconciliation_id IN (
      SELECT id FROM public.historical_reconciliations WHERE company_id = get_user_company_id()
    )
  );

CREATE POLICY "update_own_wh_drivers" ON public.historical_reconciliation_wh_drivers
  FOR UPDATE TO authenticated
  USING (
    reconciliation_id IN (
      SELECT id FROM public.historical_reconciliations WHERE company_id = get_user_company_id()
    )
  )
  WITH CHECK (
    reconciliation_id IN (
      SELECT id FROM public.historical_reconciliations WHERE company_id = get_user_company_id()
    )
  );

CREATE POLICY "delete_own_wh_drivers" ON public.historical_reconciliation_wh_drivers
  FOR DELETE TO authenticated
  USING (
    reconciliation_id IN (
      SELECT id FROM public.historical_reconciliations WHERE company_id = get_user_company_id()
    )
  );

CREATE INDEX IF NOT EXISTS idx_hist_recon_wh_drivers_recon
  ON public.historical_reconciliation_wh_drivers (reconciliation_id);
