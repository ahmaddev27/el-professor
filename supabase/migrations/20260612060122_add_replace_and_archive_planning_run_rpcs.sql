-- Replace an existing applied monthly planning run with a new one.
-- 1) Verify caller owns the old run.
-- 2) Mark old run status='replaced'.
-- 3) Detach trips currently pointing at the old run (so the idempotency check passes
--    and so the new run can attach them).
-- 4) Reuse the same apply logic the original apply RPC uses.
CREATE OR REPLACE FUNCTION public.replace_monthly_planning_run(p_payload jsonb, p_old_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_company       uuid;
  v_import_id     uuid := (p_payload->>'import_id')::uuid;
  v_month         int  := (p_payload->>'month')::int;
  v_year          int  := (p_payload->>'year')::int;
  v_old           RECORD;
  v_run_id        uuid;
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
  v_detached_trips int := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'replace_monthly_planning_run: unauthenticated';
  END IF;

  SELECT company_id INTO v_company FROM user_profiles WHERE user_id = v_caller;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'replace_monthly_planning_run: caller has no company';
  END IF;

  IF v_import_id IS NULL THEN
    RAISE EXCEPTION 'replace_monthly_planning_run: import_id required';
  END IF;

  -- Verify old run belongs to caller's company and is in the same period.
  SELECT id, company_id, import_id, month, year, status, applied_at
  INTO v_old
  FROM company_planning_runs
  WHERE id = p_old_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'replace_monthly_planning_run: old run not found';
  END IF;
  IF v_old.company_id <> v_company THEN
    RAISE EXCEPTION 'replace_monthly_planning_run: old run does not belong to caller company';
  END IF;
  IF v_old.import_id <> v_import_id OR v_old.month <> v_month OR v_old.year <> v_year THEN
    RAISE EXCEPTION 'replace_monthly_planning_run: old run mismatch (import/month/year)';
  END IF;

  -- Mark old run as replaced and clear its applied_at so the idempotency guard
  -- in the apply path does not trigger.
  UPDATE company_planning_runs
  SET status = 'replaced',
      applied_at = NULL,
      updated_at = v_now
  WHERE id = p_old_run_id;

  -- Detach trips currently pointing at the old run. Counts only.
  UPDATE fahrtenbuch_trips
  SET assignment_planning_run_id = NULL,
      updated_at = v_now
  WHERE company_id = v_company
    AND import_id = v_import_id
    AND assignment_planning_run_id = p_old_run_id;
  GET DIAGNOSTICS v_detached_trips = ROW_COUNT;

  -- Now create the new run and apply, mirroring apply_monthly_planning_run.
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
      'tageslimit_exceptions_count', (p_payload->>'tageslimit_exceptions_count')::int,
      'replaced_run_id', p_old_run_id
    ),
    jsonb_build_object(
      'block_separator_minutes', (p_payload->>'block_separator_minutes')::int,
      'replaced_run_id', p_old_run_id
    ),
    v_caller, v_now, v_caller, NULL
  )
  RETURNING id INTO v_run_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_payload->'change_rows') LOOP
    v_trip_id   := (v_row->>'trip_id')::uuid;
    v_driver_id := NULLIF(v_row->>'driver_id','')::uuid;
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

  FOR v_exc IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'manual_exceptions', '[]'::jsonb)) LOOP
    INSERT INTO monthly_planning_manual_exceptions (
      planning_run_id, company_id, import_id, month, year,
      block_id, vehicle_identifier, service_date,
      block_start_datetime, block_end_datetime,
      assigned_driver_id, assigned_driver_name,
      dienstzeit_exception, tageslimit_exception,
      reason, confirmed_by, confirmed_at
    ) VALUES (
      v_run_id, v_company, v_import_id, v_month, v_year,
      v_exc->>'block_id', v_exc->>'vehicle_identifier',
      (v_exc->>'service_date')::date,
      (v_exc->>'block_start_datetime')::timestamptz,
      (v_exc->>'block_end_datetime')::timestamptz,
      NULLIF(v_exc->>'driver_id','')::uuid,
      v_exc->>'driver_name',
      COALESCE((v_exc->>'dienstzeit')::bool, false),
      COALESCE((v_exc->>'tageslimit')::bool, false),
      v_exc->>'reason', v_caller, v_now
    );
    v_exception_count := v_exception_count + 1;
  END LOOP;

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

  UPDATE company_planning_runs
  SET apply_summary_json = jsonb_build_object(
        'updated_trips', v_updated_count,
        'skipped_canceled', v_skipped_canceled,
        'manual_exceptions_saved', v_exception_count,
        'verify_assigned_in_import', v_verify_assigned,
        'verify_canceled_in_import', v_verify_canceled,
        'verify_rows_with_run', v_verify_with_run,
        'verify_exceptions_in_run', v_verify_exceptions,
        'replaced_run_id', p_old_run_id,
        'detached_trips_from_old_run', v_detached_trips
      ),
      updated_at = v_now
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'success', true,
    'planning_run_id', v_run_id,
    'replaced_run_id', p_old_run_id,
    'detached_trips_from_old_run', v_detached_trips,
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
$function$;

-- Delete or archive a saved planning run.
-- - If any fahrtenbuch_trips still reference this run AND status='applied', archive.
-- - Otherwise hard delete (including manual exceptions).
CREATE OR REPLACE FUNCTION public.delete_or_archive_monthly_planning_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_company  uuid;
  v_run      RECORD;
  v_ref_cnt  int;
  v_exc_cnt  int;
  v_now      timestamptz := now();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: unauthenticated';
  END IF;
  SELECT company_id INTO v_company FROM user_profiles WHERE user_id = v_caller;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: caller has no company';
  END IF;

  SELECT id, company_id, status INTO v_run FROM company_planning_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: run not found';
  END IF;
  IF v_run.company_id <> v_company THEN
    RAISE EXCEPTION 'delete_or_archive_monthly_planning_run: run does not belong to caller company';
  END IF;

  SELECT COUNT(*) INTO v_ref_cnt
  FROM fahrtenbuch_trips
  WHERE company_id = v_company AND assignment_planning_run_id = p_run_id;

  IF v_ref_cnt > 0 THEN
    UPDATE company_planning_runs
    SET status = 'archived', updated_at = v_now
    WHERE id = p_run_id;
    RETURN jsonb_build_object('action', 'archived', 'referenced_trips', v_ref_cnt);
  END IF;

  SELECT COUNT(*) INTO v_exc_cnt
  FROM monthly_planning_manual_exceptions
  WHERE planning_run_id = p_run_id;

  DELETE FROM monthly_planning_manual_exceptions WHERE planning_run_id = p_run_id;
  DELETE FROM company_planning_runs WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'action', 'deleted',
    'referenced_trips', 0,
    'deleted_exceptions', v_exc_cnt
  );
END;
$function$;