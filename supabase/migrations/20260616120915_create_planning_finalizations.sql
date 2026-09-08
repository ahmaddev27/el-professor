/*
  # Planning Finalizations
  Stores a finalization record per planning run.
  When a run is finalized, Fahrtenbuch + Stundennachweise are generated
  from the same data snapshot. The record tracks stale state so that
  any subsequent transfer applied after finalization marks it stale.
*/

CREATE TABLE IF NOT EXISTS planning_finalizations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id         uuid NOT NULL REFERENCES company_planning_runs(id) ON DELETE CASCADE,
  company_id              uuid NOT NULL,
  finalized_at            timestamptz NOT NULL DEFAULT now(),
  finalized_by            uuid REFERENCES auth.users(id),
  trip_count              integer NOT NULL DEFAULT 0,
  driver_count            integer NOT NULL DEFAULT 0,
  driver_summary_json     jsonb,
  is_stale                boolean NOT NULL DEFAULT false,
  stale_reason            text,
  stale_at                timestamptz,
  document_status         text NOT NULL DEFAULT 'ready',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE planning_finalizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_select_finalizations"
  ON planning_finalizations FOR SELECT TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE POLICY "company_insert_finalizations"
  ON planning_finalizations FOR INSERT TO authenticated
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "company_update_finalizations"
  ON planning_finalizations FOR UPDATE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin())
  WITH CHECK (company_id = get_user_company_id());

CREATE POLICY "company_delete_finalizations"
  ON planning_finalizations FOR DELETE TO authenticated
  USING (company_id = get_user_company_id() OR is_user_super_admin());

CREATE INDEX IF NOT EXISTS idx_planning_finalizations_run_id
  ON planning_finalizations(planning_run_id);

CREATE INDEX IF NOT EXISTS idx_planning_finalizations_company_id
  ON planning_finalizations(company_id);
