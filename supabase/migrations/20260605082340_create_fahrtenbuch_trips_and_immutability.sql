-- ============================================================
-- Phase 1 — Step 2: fahrtenbuch_trips + immutability trigger
-- One row per trip in a Fahrtenbuch import.
--
-- IMMUTABLE fields (protected by trigger below):
--   trip_date, start_time, end_time, duration_minutes,
--   car_id, car_identifier,
--   route_start, route_end, description,
--   price_amount, cash_amount, online_amount, tip_amount, action_amount,
--   raw_data_json, original_driver_id, original_driver_name
--
-- MUTABLE (reassignment only, via RPC):
--   assigned_driver_id, assigned_driver_name,
--   plausibility_status, assignment_reason, assignment_note,
--   confirmed_by, confirmed_at, updated_at
-- ============================================================

CREATE TABLE IF NOT EXISTS fahrtenbuch_trips (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  import_id             uuid NOT NULL REFERENCES fahrtenbuch_imports(id) ON DELETE CASCADE,

  -- ── IMMUTABLE: time fields ──────────────────────────────────────────────────
  trip_date             date NOT NULL,
  start_time            time NOT NULL,
  end_time              time NOT NULL,
  duration_minutes      int  NOT NULL CHECK (duration_minutes >= 0),

  -- ── IMMUTABLE: original driver (from imported file) ─────────────────────────
  original_driver_id    uuid REFERENCES drivers(id) ON DELETE SET NULL,
  original_driver_name  text NOT NULL,

  -- ── MUTABLE: assigned driver (for Stundennachweis alignment) ────────────────
  assigned_driver_id    uuid REFERENCES drivers(id) ON DELETE SET NULL,
  assigned_driver_name  text NOT NULL,

  -- ── IMMUTABLE: vehicle ──────────────────────────────────────────────────────
  car_id                uuid REFERENCES cars(id) ON DELETE SET NULL,
  car_identifier        text,

  -- ── IMMUTABLE: route / description ─────────────────────────────────────────
  route_start           text,
  route_end             text,
  description           text,

  -- ── IMMUTABLE: financial ────────────────────────────────────────────────────
  price_amount          numeric(10,2) NOT NULL DEFAULT 0,
  cash_amount           numeric(10,2) NOT NULL DEFAULT 0,
  online_amount         numeric(10,2) NOT NULL DEFAULT 0,
  tip_amount            numeric(10,2) NOT NULL DEFAULT 0,
  action_amount         numeric(10,2) NOT NULL DEFAULT 0,

  -- ── IMMUTABLE: raw source data ──────────────────────────────────────────────
  raw_data_json         jsonb NOT NULL DEFAULT '{}',

  -- ── MUTABLE: plausibility & assignment metadata ─────────────────────────────
  plausibility_status   text NOT NULL DEFAULT 'pending'
                          CHECK (plausibility_status IN ('pending','ok','uncovered','overlap')),
  assignment_reason     text,
  assignment_note       text,
  confirmed_by          uuid REFERENCES user_profiles(user_id) ON DELETE SET NULL,
  confirmed_at          timestamptz,

  -- ── Timestamps ──────────────────────────────────────────────────────────────
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fahrtenbuch_trips_company    ON fahrtenbuch_trips (company_id);
CREATE INDEX idx_fahrtenbuch_trips_import     ON fahrtenbuch_trips (import_id);
CREATE INDEX idx_fahrtenbuch_trips_date       ON fahrtenbuch_trips (company_id, trip_date);
CREATE INDEX idx_fahrtenbuch_trips_orig_drv   ON fahrtenbuch_trips (company_id, original_driver_id);
CREATE INDEX idx_fahrtenbuch_trips_asgn_drv   ON fahrtenbuch_trips (company_id, assigned_driver_id);

-- ============================================================
-- IMMUTABILITY TRIGGER
-- Raises an exception if any immutable field is changed in any
-- UPDATE statement, regardless of how it was issued (client,
-- RPC, or any other path).
-- ============================================================

CREATE OR REPLACE FUNCTION protect_fahrtenbuch_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.trip_date            IS DISTINCT FROM NEW.trip_date            OR
    OLD.start_time           IS DISTINCT FROM NEW.start_time           OR
    OLD.end_time             IS DISTINCT FROM NEW.end_time             OR
    OLD.duration_minutes     IS DISTINCT FROM NEW.duration_minutes     OR
    OLD.car_id               IS DISTINCT FROM NEW.car_id               OR
    OLD.car_identifier       IS DISTINCT FROM NEW.car_identifier       OR
    OLD.route_start          IS DISTINCT FROM NEW.route_start          OR
    OLD.route_end            IS DISTINCT FROM NEW.route_end            OR
    OLD.description          IS DISTINCT FROM NEW.description          OR
    OLD.price_amount         IS DISTINCT FROM NEW.price_amount         OR
    OLD.cash_amount          IS DISTINCT FROM NEW.cash_amount          OR
    OLD.online_amount        IS DISTINCT FROM NEW.online_amount        OR
    OLD.tip_amount           IS DISTINCT FROM NEW.tip_amount           OR
    OLD.action_amount        IS DISTINCT FROM NEW.action_amount        OR
    OLD.raw_data_json        IS DISTINCT FROM NEW.raw_data_json        OR
    OLD.original_driver_id   IS DISTINCT FROM NEW.original_driver_id   OR
    OLD.original_driver_name IS DISTINCT FROM NEW.original_driver_name OR
    OLD.import_id            IS DISTINCT FROM NEW.import_id            OR
    OLD.company_id           IS DISTINCT FROM NEW.company_id
  ) THEN
    RAISE EXCEPTION
      'fahrtenbuch_trips: immutable fields cannot be modified after insert. '
      'Attempted to change one or more of: trip_date, start_time, end_time, '
      'duration_minutes, financial fields, original_driver, car, route, '
      'raw_data_json, import_id, or company_id.';
  END IF;

  -- Always keep updated_at current on any permitted update
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_protect_fahrtenbuch_immutable
  BEFORE UPDATE ON fahrtenbuch_trips
  FOR EACH ROW
  EXECUTE FUNCTION protect_fahrtenbuch_immutable_fields();

-- ============================================================
-- RLS for fahrtenbuch_trips
-- Direct UPDATE from client is restricted to only the mutable
-- columns, but because the trigger enforces field-level
-- immutability at the DB level, the RLS layer adds the
-- company isolation and role check.
--
-- The reassign_fahrtenbuch_trip RPC (Step 3) uses
-- SECURITY DEFINER so it bypasses the UPDATE RLS — it is the
-- only sanctioned mutation path.
-- ============================================================

ALTER TABLE fahrtenbuch_trips ENABLE ROW LEVEL SECURITY;

-- SELECT: own company
CREATE POLICY "fahrtenbuch_trips_select"
  ON fahrtenbuch_trips FOR SELECT
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

-- INSERT: own company (import process inserts rows)
CREATE POLICY "fahrtenbuch_trips_insert"
  ON fahrtenbuch_trips FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles WHERE user_id = auth.uid()
    )
  );

-- UPDATE: blocked for regular clients.
-- The RPC uses SECURITY DEFINER and bypasses RLS.
-- This policy is intentionally absent — no direct UPDATE is allowed.
-- (Absence of an UPDATE policy means no UPDATE is permitted under RLS.)

-- DELETE: admin only (e.g., deleting an import batch)
CREATE POLICY "fahrtenbuch_trips_delete"
  ON fahrtenbuch_trips FOR DELETE
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
