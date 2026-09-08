
-- Planning run header
CREATE TABLE IF NOT EXISTS company_planning_runs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month              int         NOT NULL,
  year               int         NOT NULL,
  import_id          uuid        NULL REFERENCES fahrtenbuch_imports(id) ON DELETE SET NULL,
  status             text        NOT NULL DEFAULT 'draft',
  max_shift_minutes  int         NOT NULL DEFAULT 480,
  summary_json       jsonb       NOT NULL DEFAULT '{}',
  settings_json      jsonb       NULL,
  created_by         uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Planning run blocks (each proposed working block)
CREATE TABLE IF NOT EXISTS company_planning_run_blocks (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid        NOT NULL,
  run_id               uuid        NOT NULL REFERENCES company_planning_runs(id) ON DELETE CASCADE,
  driver_id            uuid        NULL,
  driver_name          text,
  driver_usage_type    text,
  block_date           date        NOT NULL,
  start_time           text,
  end_time             text,
  duration_minutes     int,
  source               text,
  status               text,
  reason               text,
  trip_ids             text[]      NULL,
  original_driver_id   uuid        NULL,
  original_driver_name text        NULL,
  proposed_driver_id   uuid        NULL,
  proposed_driver_name text        NULL,
  metadata_json        jsonb       NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_planning_runs_company ON company_planning_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_planning_blocks_run   ON company_planning_run_blocks(run_id);

-- RLS
ALTER TABLE company_planning_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_planning_run_blocks ENABLE ROW LEVEL SECURITY;

-- Policies for company_planning_runs
CREATE POLICY "select_own_planning_runs" ON company_planning_runs
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "insert_own_planning_runs" ON company_planning_runs
  FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "update_own_planning_runs" ON company_planning_runs
  FOR UPDATE TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "delete_own_planning_runs" ON company_planning_runs
  FOR DELETE TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

-- Policies for company_planning_run_blocks
CREATE POLICY "select_own_planning_blocks" ON company_planning_run_blocks
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "insert_own_planning_blocks" ON company_planning_run_blocks
  FOR INSERT TO authenticated
  WITH CHECK (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "update_own_planning_blocks" ON company_planning_run_blocks
  FOR UPDATE TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));

CREATE POLICY "delete_own_planning_blocks" ON company_planning_run_blocks
  FOR DELETE TO authenticated
  USING (company_id IN (SELECT company_id FROM user_profiles WHERE user_id = auth.uid()));
