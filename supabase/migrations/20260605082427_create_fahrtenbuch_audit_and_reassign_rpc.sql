-- ============================================================
-- Phase 1 — Step 3: fahrtenbuch_assignment_audit + reassign RPC
-- ============================================================

-- ── Audit log ────────────────────────────────────────────────────────────────
-- Append-only. No UPDATE or DELETE policy — rows are permanent proof
-- that original_driver was never changed and only assigned_driver changed.

CREATE TABLE IF NOT EXISTS fahrtenbuch_assignment_audit (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id                 uuid NOT NULL REFERENCES fahrtenbuch_trips(id) ON DELETE CASCADE,

  -- Snapshot values at moment of change (proof)
  trip_date               date NOT NULL,
  start_time              time NOT NULL,
  end_time                time NOT NULL,
  price_amount            numeric(10,2) NOT NULL,
  original_driver_id      uuid,
  original_driver_name    text NOT NULL,

  -- What changed
  old_assigned_driver_id   uuid,
  old_assigned_driver_name text,
  new_assigned_driver_id   uuid,
  new_assigned_driver_name text NOT NULL,

  -- Why / who / when
  reason                  text,
  changed_by              uuid NOT NULL REFERENCES user_profiles(user_id) ON DELETE RESTRICT,
  changed_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fahrtenbuch_audit_company ON fahrtenbuch_assignment_audit (company_id);
CREATE INDEX idx_fahrtenbuch_audit_trip    ON fahrtenbuch_assignment_audit (trip_id);

ALTER TABLE fahrtenbuch_assignment_audit ENABLE ROW LEVEL SECURITY;

-- SELECT: own company
CREATE POLICY "fahrtenbuch_audit_select"
  ON fahrtenbuch_assignment_audit FOR SELECT
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

-- INSERT: allowed (the RPC inserts here)
-- We also allow authenticated users to insert so the SECURITY DEFINER
-- function can write on their behalf within the same transaction.
CREATE POLICY "fahrtenbuch_audit_insert"
  ON fahrtenbuch_assignment_audit FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
    AND changed_by = auth.uid()
  );

-- No UPDATE policy — audit rows are immutable.
-- No DELETE policy — audit rows are permanent.


-- ============================================================
-- reassign_fahrtenbuch_trip RPC
--
-- This is the ONLY permitted path to change assigned_driver.
-- It runs SECURITY DEFINER so it can bypass the missing UPDATE
-- RLS policy on fahrtenbuch_trips while still enforcing every
-- business rule inside the function body.
--
-- Parameters:
--   p_trip_id              uuid
--   p_new_driver_id        uuid    (new assigned_driver_id)
--   p_new_driver_name      text    (new assigned_driver_name)
--   p_plausibility_status  text    (ok / uncovered / overlap / pending)
--   p_reason               text    (human-readable reason)
--   p_note                 text    (optional note)
--
-- Returns: jsonb with success flag and audit row id
-- ============================================================

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
  -- ── 1. Identify caller ───────────────────────────────────────────────────
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

  -- ── 2. Load trip and verify tenant ownership ─────────────────────────────
  SELECT * INTO v_trip
  FROM fahrtenbuch_trips
  WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: trip % not found', p_trip_id;
  END IF;

  IF v_trip.company_id <> v_caller_company THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: cross-company access denied';
  END IF;

  -- ── 3. Validate plausibility_status value ────────────────────────────────
  IF p_plausibility_status NOT IN ('pending','ok','uncovered','overlap') THEN
    RAISE EXCEPTION 'reassign_fahrtenbuch_trip: invalid plausibility_status "%"',
      p_plausibility_status;
  END IF;

  -- ── 4. Validate new driver belongs to same company ───────────────────────
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

  -- ── 5. Update ONLY the permitted mutable columns on the trip ────────────
  --       The immutability trigger will fire here and raise if any
  --       immutable field were somehow different — it won't be, but this
  --       is an extra safety net.
  UPDATE fahrtenbuch_trips
  SET
    assigned_driver_id    = p_new_driver_id,
    assigned_driver_name  = p_new_driver_name,
    plausibility_status   = p_plausibility_status,
    assignment_reason     = p_reason,
    assignment_note       = p_note,
    confirmed_by          = v_caller_id,
    confirmed_at          = now()
    -- updated_at is set automatically by the trigger
  WHERE id = p_trip_id;

  -- ── 6. Write audit row ───────────────────────────────────────────────────
  --       Snapshots time/price/original_driver to prove they did not change.
  INSERT INTO fahrtenbuch_assignment_audit (
    company_id,
    trip_id,
    trip_date,
    start_time,
    end_time,
    price_amount,
    original_driver_id,
    original_driver_name,
    old_assigned_driver_id,
    old_assigned_driver_name,
    new_assigned_driver_id,
    new_assigned_driver_name,
    reason,
    changed_by
  )
  VALUES (
    v_caller_company,
    p_trip_id,
    v_trip.trip_date,          -- snapshot (immutable proof)
    v_trip.start_time,         -- snapshot (immutable proof)
    v_trip.end_time,           -- snapshot (immutable proof)
    v_trip.price_amount,       -- snapshot (immutable proof)
    v_trip.original_driver_id,
    v_trip.original_driver_name,
    v_trip.assigned_driver_id,
    v_trip.assigned_driver_name,
    p_new_driver_id,
    p_new_driver_name,
    p_reason,
    v_caller_id
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

-- Grant execute to authenticated users only
GRANT EXECUTE ON FUNCTION reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)
  TO authenticated;

-- Revoke from public / anon
REVOKE EXECUTE ON FUNCTION reassign_fahrtenbuch_trip(uuid, uuid, text, text, text, text)
  FROM PUBLIC;
