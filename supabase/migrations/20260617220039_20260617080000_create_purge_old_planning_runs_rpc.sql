-- Permanently deletes all replaced/archived planning runs for a company
-- (or scoped to a specific month/year when provided).
-- Safety invariants enforced:
--   1. Only deletes runs with status = 'replaced' OR 'archived'.
--   2. Never deletes a run that still has fahrtenbuch_trips referencing it.
--   3. Never deletes a run with a non-stale finalization (document still in use).
--   4. Deletes monthly_planning_manual_exceptions first (no ON DELETE CASCADE).
--   5. Deletes the run itself; planning_finalizations and planning_run_adjustments
--      cascade automatically via their FK ON DELETE CASCADE.
CREATE OR REPLACE FUNCTION public.purge_old_monthly_planning_runs(
  p_month int DEFAULT NULL,
  p_year  int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller      uuid := auth.uid();
  v_company     uuid;
  v_run         RECORD;
  v_trip_ref    int;
  v_has_active_fin boolean;
  v_deleted_ids uuid[] := '{}';
  v_skipped     jsonb[] := '{}';
  v_exc_deleted int;
  v_now         timestamptz := now();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'purge_old_monthly_planning_runs: unauthenticated';
  END IF;

  SELECT company_id INTO v_company FROM user_profiles WHERE user_id = v_caller;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'purge_old_monthly_planning_runs: caller has no company';
  END IF;

  FOR v_run IN
    SELECT id, status, month, year
    FROM company_planning_runs
    WHERE company_id = v_company
      AND status IN ('replaced', 'archived')
      AND (p_month IS NULL OR month = p_month)
      AND (p_year  IS NULL OR year  = p_year)
    ORDER BY applied_at ASC NULLS FIRST
  LOOP
    -- Safety check 1: no trip references
    SELECT COUNT(*) INTO v_trip_ref
    FROM fahrtenbuch_trips
    WHERE company_id = v_company
      AND assignment_planning_run_id = v_run.id;

    IF v_trip_ref > 0 THEN
      v_skipped := array_append(v_skipped, jsonb_build_object(
        'id', v_run.id,
        'reason', 'trip_references',
        'detail', v_trip_ref || ' Fahrten verweisen noch auf diese Planung'
      ));
      CONTINUE;
    END IF;

    -- Safety check 2: no non-stale finalization
    SELECT EXISTS (
      SELECT 1 FROM planning_finalizations
      WHERE planning_run_id = v_run.id AND is_stale = false
    ) INTO v_has_active_fin;

    IF v_has_active_fin THEN
      v_skipped := array_append(v_skipped, jsonb_build_object(
        'id', v_run.id,
        'reason', 'active_finalization',
        'detail', 'Planung hat eine gültige Finalisierung – als veraltet markieren oder neu finalisieren, bevor sie gelöscht werden kann'
      ));
      CONTINUE;
    END IF;

    -- Delete manual exceptions (no CASCADE)
    DELETE FROM monthly_planning_manual_exceptions
    WHERE planning_run_id = v_run.id;
    GET DIAGNOSTICS v_exc_deleted = ROW_COUNT;

    -- Delete the run (CASCADE: planning_finalizations, planning_run_adjustments)
    DELETE FROM company_planning_runs WHERE id = v_run.id;

    v_deleted_ids := array_append(v_deleted_ids, v_run.id);
  END LOOP;

  RETURN jsonb_build_object(
    'deleted_count',  array_length(v_deleted_ids, 1)::int,
    'skipped_count',  array_length(v_skipped, 1)::int,
    'deleted_ids',    to_jsonb(v_deleted_ids),
    'skipped',        to_jsonb(v_skipped)
  );
END;
$function$;
