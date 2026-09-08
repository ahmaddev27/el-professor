-- Phase 5: Apply tracking + manual exceptions audit
-- Extends fahrtenbuch_trips with assignment metadata, creates a manual-exception
-- audit table, and adds an atomic apply RPC for the monthly planning result.

-- 1. Add assignment metadata columns to fahrtenbuch_trips
ALTER TABLE fahrtenbuch_trips
  ADD COLUMN IF NOT EXISTS assignment_source         text,
  ADD COLUMN IF NOT EXISTS assignment_block_id       text,
  ADD COLUMN IF NOT EXISTS assignment_planning_run_id uuid REFERENCES company_planning_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignment_applied_at     timestamptz,
  ADD COLUMN IF NOT EXISTS assignment_applied_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fahrtenbuch_trips_planning_run
  ON fahrtenbuch_trips(assignment_planning_run_id);

-- 2. Manual exception audit table
CREATE TABLE IF NOT EXISTS monthly_planning_manual_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id uuid NOT NULL REFERENCES company_planning_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  import_id uuid REFERENCES fahrtenbuch_imports(id) ON DELETE SET NULL,
  month integer,
  year integer,
  block_id text NOT NULL,
  vehicle_identifier text,
  service_date date,
  block_start_datetime timestamptz,
  block_end_datetime timestamptz,
  assigned_driver_id uuid REFERENCES drivers(id) ON DELETE SET NULL,
  assigned_driver_name text,
  dienstzeit_exception boolean NOT NULL DEFAULT false,
  tageslimit_exception boolean NOT NULL DEFAULT false,
  reason text,
  confirmed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE monthly_planning_manual_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_company_exceptions" ON monthly_planning_manual_exceptions
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "insert_own_company_exceptions" ON monthly_planning_manual_exceptions
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "update_own_company_exceptions" ON monthly_planning_manual_exceptions
  FOR UPDATE TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "delete_own_company_exceptions" ON monthly_planning_manual_exceptions
  FOR DELETE TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

-- 3. Atomic Apply RPC
-- Payload:
-- {
--   "import_id":      uuid,
--   "month":          int,
--   "year":           int,
--   "source_file_name": text,
--   "block_separator_minutes": int,
--   "vehicle_blocks_count":   int,
--   "assigned_blocks_count":  int,
--   "manual_exceptions_count": int,
--   "dienstzeit_exceptions_count": int,
--   "tageslimit_exceptions_count": int,
--   "change_rows": [
--     { "trip_id": uuid, "driver_id": uuid, "driver_name": text,
--       "assignment_source": text, "block_id": text,
--       "is_canceled": bool,
--       "dienstzeit_exception": bool, "tageslimit_exception": bool,
--       "exception_reason": text },
--     ...
--   ],
--   "manual_exceptions": [
--     { "block_id": text, "vehicle_identifier": text,
--       "service_date": date, "block_start_datetime": timestamptz,
--       "block_end_datetime": timestamptz,
--       "driver_id": uuid, "driver_name": text,
--       "dienstzeit": bool, "tageslimit": bool, "reason": text },
--     ...
--   ]
-- }

CREATE OR REPLACE FUNCTION apply_monthly_planning_run(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_company       uuid;
  v_import_id     uuid := (p_payload->>'import_id')::uuid;
  v_month         int  := (p_payload->>'month')::int;
  v_year          int  := (p_payload->>'year')::int;
  v_run_id        uuid;
  v_existing      RECORD;
  v_updated_count int := 0;
  v_skipped_canceled int := 0;
  v_exception_count int := 0;
  v_row jsonb;
  v_exc jsonb;
  v_trip_id uuid;
  v_driver_id uuid;
  v_now timestamptz := now();
  v_verify_assigned int;
  v_verify_canceled int;
  v_verify_with_run int;
  v_verify_exceptions int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'apply_monthly_planning_run: unauthenticated';
  END IF;

  SELECT company_id INTO v_company
  FROM user_profiles
  WHERE user_id = v_caller;

  IF v_company IS NULL THEN
    RAISE EXCEPTION 'apply_monthly_planning_run: caller has no company';
  END IF;

  IF v_import_id IS NULL THEN
    RAISE EXCEPTION 'apply_monthly_planning_run: import_id required';
  END IF;

  -- Idempotency: block if an applied run already exists for same import/month/year
  SELECT id, applied_at, applied_by
    INTO v_existing
  FROM company_planning_runs
  WHERE company_id = v_company
    AND import_id  = v_import_id
    AND month      = v_month
    AND year       = v_year
    AND applied_at IS NOT NULL
  ORDER BY applied_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'already_applied', true,
      'planning_run_id', v_existing.id,
      'applied_at', v_existing.applied_at,
      'applied_by', v_existing.applied_by,
      'message', 'Für diesen Monat wurde bereits eine Planung angewendet.'
    );
  END IF;

  -- Create planning run
  INSERT INTO company_planning_runs (
    company_id, month, year, import_id, status,
    max_shift_minutes, summary_json, settings_json,
    created_by, applied_at, applied_by, apply_summary_json
  ) VALUES (
    v_company, v_month, v_year, v_import_id, 'applied',
    270,
    jsonb_build_object(
      'source_file_name', p_payload->>'source_file_name',
      'block_separator_minutes', (p_payload->>'block_separator_minutes')::int,
      'vehicle_blocks_count', (p_payload->>'vehicle_blocks_count')::int,
      'assigned_blocks_count', (p_payload->>'assigned_blocks_count')::int,
      'manual_exceptions_count', (p_payload->>'manual_exceptions_count')::int,
      'dienstzeit_exceptions_count', (p_payload->>'dienstzeit_exceptions_count')::int,
      'tageslimit_exceptions_count', (p_payload->>'tageslimit_exceptions_count')::int
    ),
    jsonb_build_object(
      'block_separator_minutes', (p_payload->>'block_separator_minutes')::int
    ),
    v_caller,
    v_now,
    v_caller,
    NULL
  )
  RETURNING id INTO v_run_id;

  -- Apply trip updates
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_payload->'change_rows')
  LOOP
    v_trip_id   := (v_row->>'trip_id')::uuid;
    v_driver_id := NULLIF(v_row->>'driver_id','')::uuid;

    -- Skip canceled trips defensively
    IF COALESCE((v_row->>'is_canceled')::bool, false) THEN
      v_skipped_canceled := v_skipped_canceled + 1;
      CONTINUE;
    END IF;

    UPDATE fahrtenbuch_trips ft
    SET
      assigned_driver_id        = v_driver_id,
      assigned_driver_name      = v_row->>'driver_name',
      assignment_source         = v_row->>'assignment_source',
      assignment_block_id       = v_row->>'block_id',
      assignment_planning_run_id = v_run_id,
      assignment_applied_at     = v_now,
      assignment_applied_by     = v_caller,
      assignment_reason         = COALESCE(v_row->>'exception_reason', ft.assignment_reason),
      plausibility_status       = CASE WHEN ft.plausibility_status = 'canceled'
                                       THEN ft.plausibility_status
                                       ELSE 'planned_reassignment' END,
      confirmed_by              = v_caller,
      confirmed_at              = v_now,
      updated_at                = v_now
    WHERE id          = v_trip_id
      AND company_id  = v_company
      AND is_canceled = false;

    IF FOUND THEN
      v_updated_count := v_updated_count + 1;
    END IF;
  END LOOP;

  -- Insert manual exceptions
  FOR v_exc IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'manual_exceptions', '[]'::jsonb))
  LOOP
    INSERT INTO monthly_planning_manual_exceptions (
      planning_run_id, company_id, import_id, month, year,
      block_id, vehicle_identifier,
      service_date, block_start_datetime, block_end_datetime,
      assigned_driver_id, assigned_driver_name,
      dienstzeit_exception, tageslimit_exception,
      reason, confirmed_by, confirmed_at
    ) VALUES (
      v_run_id, v_company, v_import_id, v_month, v_year,
      v_exc->>'block_id',
      v_exc->>'vehicle_identifier',
      (v_exc->>'service_date')::date,
      (v_exc->>'block_start_datetime')::timestamptz,
      (v_exc->>'block_end_datetime')::timestamptz,
      NULLIF(v_exc->>'driver_id','')::uuid,
      v_exc->>'driver_name',
      COALESCE((v_exc->>'dienstzeit')::bool, false),
      COALESCE((v_exc->>'tageslimit')::bool, false),
      v_exc->>'reason',
      v_caller,
      v_now
    );
    v_exception_count := v_exception_count + 1;
  END LOOP;

  -- Verification
  SELECT
    COUNT(*) FILTER (WHERE assigned_driver_id IS NOT NULL AND is_canceled = false),
    COUNT(*) FILTER (WHERE is_canceled = true),
    COUNT(*) FILTER (WHERE assignment_planning_run_id = v_run_id)
  INTO v_verify_assigned, v_verify_canceled, v_verify_with_run
  FROM fahrtenbuch_trips
  WHERE company_id = v_company AND import_id = v_import_id;

  SELECT COUNT(*) INTO v_verify_exceptions
  FROM monthly_planning_manual_exceptions
  WHERE planning_run_id = v_run_id;

  -- Persist apply summary
  UPDATE company_planning_runs
  SET apply_summary_json = jsonb_build_object(
        'updated_trips', v_updated_count,
        'skipped_canceled', v_skipped_canceled,
        'manual_exceptions_saved', v_exception_count,
        'verify_assigned_in_import', v_verify_assigned,
        'verify_canceled_in_import', v_verify_canceled,
        'verify_rows_with_run', v_verify_with_run,
        'verify_exceptions_in_run', v_verify_exceptions
      ),
      updated_at = v_now
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'success', true,
    'planning_run_id', v_run_id,
    'updated_trips', v_updated_count,
    'skipped_canceled', v_skipped_canceled,
    'manual_exceptions_saved', v_exception_count,
    'applied_at', v_now,
    'applied_by', v_caller,
    'verify_assigned_in_import', v_verify_assigned,
    'verify_canceled_in_import', v_verify_canceled,
    'verify_rows_with_run', v_verify_with_run,
    'verify_exceptions_in_run', v_verify_exceptions
  );
END;
$$;

GRANT EXECUTE ON FUNCTION apply_monthly_planning_run(jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION apply_monthly_planning_run(jsonb) FROM PUBLIC;
