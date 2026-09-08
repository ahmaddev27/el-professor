-- 1. Add 'planned_reassignment' to plausibility_status CHECK
ALTER TABLE fahrtenbuch_trips
  DROP CONSTRAINT IF EXISTS fahrtenbuch_trips_plausibility_status_check;

ALTER TABLE fahrtenbuch_trips
  ADD CONSTRAINT fahrtenbuch_trips_plausibility_status_check
  CHECK (plausibility_status IN ('pending','ok','uncovered','overlap','canceled','planned_reassignment'));

-- 2. Update RPC to accept 'planned_reassignment'
CREATE OR REPLACE FUNCTION reassign_fahrtenbuch_trip(
  p_trip_id             uuid,
  p_new_driver_id       uuid,
  p_new_driver_name     text,
  p_plausibility_status text DEFAULT 'pending',
  p_reason              text DEFAULT NULL,
  p_note                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id       uuid;
  v_caller_company  uuid;
  v_trip            fahrtenbuch_trips%ROWTYPE;
  v_audit_id        uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: unauthenticated call';
  END IF;

  SELECT company_id INTO v_caller_company
  FROM user_profiles
  WHERE user_id = v_caller_id;

  IF v_caller_company IS NULL THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: caller has no company';
  END IF;

  SELECT * INTO v_trip
  FROM fahrtenbuch_trips
  WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: trip % not found', p_trip_id;
  END IF;

  IF v_trip.company_id <> v_caller_company THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: cross-company access denied';
  END IF;

  IF p_plausibility_status NOT IN ('pending','ok','uncovered','overlap','planned_reassignment') THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: invalid plausibility_status "%"',
      p_plausibility_status;
  END IF;

  IF p_new_driver_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM drivers
      WHERE id = p_new_driver_id AND company_id = v_caller_company
    ) THEN
      RAISE EXCEPTION
        'reassign_fahrtenbuch_trip: driver % does not belong to company %',
        p_new_driver_id, v_caller_company;
    END IF;
  END IF;

  UPDATE fahrtenbuch_trips
  SET
    assigned_driver_id    = p_new_driver_id,
    assigned_driver_name  = p_new_driver_name,
    plausibility_status   = p_plausibility_status,
    assignment_reason     = p_reason,
    assignment_note       = p_note,
    confirmed_by          = v_caller_id,
    confirmed_at          = now()
  WHERE id = p_trip_id;

  INSERT INTO fahrtenbuch_assignment_audit (
    company_id, trip_id, trip_date, start_time, end_time, price_amount,
    original_driver_id, original_driver_name,
    old_assigned_driver_id, old_assigned_driver_name,
    new_assigned_driver_id, new_assigned_driver_name,
    reason, changed_by
  )
  VALUES (
    v_caller_company, p_trip_id,
    v_trip.trip_date, v_trip.start_time, v_trip.end_time, v_trip.price_amount,
    v_trip.original_driver_id, v_trip.original_driver_name,
    v_trip.assigned_driver_id, v_trip.assigned_driver_name,
    p_new_driver_id, p_new_driver_name,
    p_reason, v_caller_id
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'success',   true,
    'trip_id',   p_trip_id,
    'audit_id',  v_audit_id,
    'changed_by', v_caller_id
  );

EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)
  TO authenticated;
REVOKE EXECUTE ON FUNCTION reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)
  FROM PUBLIC;

-- 3. Add apply tracking columns to company_planning_runs
ALTER TABLE company_planning_runs
  ADD COLUMN IF NOT EXISTS applied_at          timestamptz,
  ADD COLUMN IF NOT EXISTS applied_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS apply_summary_json  jsonb;
