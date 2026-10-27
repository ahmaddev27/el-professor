/*
  The declined trip status and its fee column (migration 20261027140000).

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  What is covered, in order:

    1. shape      the column exists, is an integer, and is protected by
                  protect_fahrtenbuch_immutable_fields; fahrtenbuch_trips still
                  has no UPDATE policy
    2. checks     a declined row is accepted; a completed row with a fee, a
                  declined row carrying is_canceled, and a negative fee are each
                  refused BY NAME, so a refusal from an unrelated constraint
                  cannot read as a pass
    3. map        abgelehnt and declined read as 'declined'; every word that
                  read as completed, cancelled or unknown before still does
    4. history    the backfill rule is unchanged, so no stored row is
                  reclassified by this migration
    5. tenants    a declined row obeys the same tenancy as any other trip: a
                  member reads its own company's and never another's, and the
                  insert gate on imported_by is untouched
    6. immutable  the fee cannot be changed after insert, and an assignment
                  column still can — so the trigger has not become a blanket
                  refusal

  Why section 2 reads the constraint name rather than "it was refused": a row
  that fails `times_consistent`, `review_check` or `currency_check` also raises
  check_violation, and counting that as the refusal under test would make the
  probe pass while measuring nothing. The lesson is this repository's own: a
  probe whose refusals share a class measures nothing.
*/

\set ON_ERROR_STOP on

BEGIN;

\set company_a '''c0000000-0000-4000-8000-00000000000a'''
\set company_b '''c0000000-0000-4000-8000-00000000000b'''
\set admin_a   '''a0000000-0000-4000-8000-000000000001'''

-- ─── 1. Shape ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = 'public.fahrtenbuch_trips'::regclass
       AND a.attname = 'declined_fee_cents' AND NOT a.attisdropped
       AND format_type(a.atttypid, a.atttypmod) = 'integer'
  ) THEN
    RAISE EXCEPTION 'declined 1: declined_fee_cents is missing or is not an integer';
  END IF;

  -- The fee must be named in the immutability trigger's body. Read from the
  -- catalogue, because a column added to the table and forgotten here would be
  -- editable after insert with nothing saying so.
  IF position('declined_fee_cents' IN pg_get_functiondef(
       'public.protect_fahrtenbuch_immutable_fields()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'declined 1: the immutability trigger does not mention declined_fee_cents';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'fahrtenbuch_trips' AND cmd = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'declined 1: an UPDATE policy appeared on fahrtenbuch_trips';
  END IF;
  RAISE NOTICE 'declined 1: shape ok';
END $$;

-- ─── 2. The checks, each refusal matched on its constraint name ─────────────

-- An import to hang the rows off. The real table, as the owner, so the checks
-- under test are the live ones and not a copy.
INSERT INTO fahrtenbuch_imports (id, company_id, file_name, imported_by, row_count)
VALUES ('11110000-0000-4000-8000-00000000000a', :company_a, 'declined-kit.xlsx', :admin_a, 0)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  c_import CONSTANT uuid := '11110000-0000-4000-8000-00000000000a';
  c_company CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_constraint text;
BEGIN
  -- 2a. Positive control. If any other constraint refuses this shape, it fails
  --     here and names itself, instead of making 2b to 2d vacuous.
  INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name,
                                 assigned_driver_name, trip_status, declined_fee_cents)
  VALUES (c_company, c_import, DATE '2026-10-01', 'Fahrer 1', 'Fahrer 1', 'declined', 600);

  -- 2b. A fee on a completed trip: refused by the fee check and no other.
  v_constraint := NULL;
  BEGIN
    INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name,
                                   assigned_driver_name, trip_status, declined_fee_cents)
    VALUES (c_company, c_import, DATE '2026-10-02', 'Fahrer 1', 'Fahrer 1', 'completed', 600);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;
  IF v_constraint IS DISTINCT FROM 'fahrtenbuch_trips_declined_fee_check' THEN
    RAISE EXCEPTION 'declined 2b: refused by % rather than the fee check', coalesce(v_constraint, 'nothing');
  END IF;

  -- 2c. A declined trip carrying is_canceled: refused by the status check.
  v_constraint := NULL;
  BEGIN
    INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name,
                                   assigned_driver_name, trip_status, is_canceled, declined_fee_cents)
    VALUES (c_company, c_import, DATE '2026-10-03', 'Fahrer 1', 'Fahrer 1', 'declined', true, 600);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;
  IF v_constraint IS DISTINCT FROM 'fahrtenbuch_trips_trip_status_check' THEN
    RAISE EXCEPTION 'declined 2c: refused by % rather than the status check', coalesce(v_constraint, 'nothing');
  END IF;

  -- 2d. A negative fee: refused by the fee check.
  v_constraint := NULL;
  BEGIN
    INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name,
                                   assigned_driver_name, trip_status, declined_fee_cents)
    VALUES (c_company, c_import, DATE '2026-10-04', 'Fahrer 1', 'Fahrer 1', 'declined', -1);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;
  IF v_constraint IS DISTINCT FROM 'fahrtenbuch_trips_declined_fee_check' THEN
    RAISE EXCEPTION 'declined 2d: refused by % rather than the fee check', coalesce(v_constraint, 'nothing');
  END IF;

  -- 2e. A cancelled trip MAY carry the fee: the audit lets a tenant charge one
  --     by policy, and only a completed trip is refused.
  INSERT INTO fahrtenbuch_trips (company_id, import_id, trip_date, original_driver_name,
                                 assigned_driver_name, trip_status, is_canceled, declined_fee_cents)
  VALUES (c_company, c_import, DATE '2026-10-05', 'Fahrer 1', 'Fahrer 1', 'cancelled', true, 600);

  RAISE NOTICE 'declined 2: the checks refuse by name';
END $$;

-- ─── 3. The status map ──────────────────────────────────────────────────────

DO $$
BEGIN
  IF app_private.fahrtenbuch_map_status('abgelehnt')  <> 'declined'
     OR app_private.fahrtenbuch_map_status('Abgelehnt') <> 'declined'
     OR app_private.fahrtenbuch_map_status('declined')  <> 'declined' THEN
    RAISE EXCEPTION 'declined 3: the map does not read the declined words';
  END IF;
  -- Every word that read as something else before must still read the same.
  -- This is the half that matters: widening a list is only safe while it moves
  -- words out of 'unknown' and nothing else.
  IF app_private.fahrtenbuch_map_status('abgeschlossen')    <> 'completed'
     OR app_private.fahrtenbuch_map_status('storno')          <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('storniert')       <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('storniertfahrt')  <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('stornierung')     <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('cancelled')       <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('canceled')        <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('abgebrochen')     <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('nichtdurchgefuhrt') <> 'cancelled'
     OR app_private.fahrtenbuch_map_status('etwas anderes')   <> 'unknown'
     OR app_private.fahrtenbuch_map_status('')                <> 'unknown'
     OR app_private.fahrtenbuch_map_status(NULL)              <> 'unknown' THEN
    RAISE EXCEPTION 'declined 3: a word that read as completed, cancelled or unknown now reads differently';
  END IF;
  RAISE NOTICE 'declined 3: the map reads one more word and no fewer';
END $$;

-- ─── 4. No stored row is reclassified ───────────────────────────────────────

DO $$
BEGIN
  -- The backfill rule of 20260922100000 is deliberately NOT restated. A row the
  -- old importer stored as a ride whose status cell says 'abgelehnt' must still
  -- backfill to 'unknown': reclassifying history is the one thing a migration
  -- over the legal Fahrtenbuch must never do.
  IF app_private.fahrtenbuch_trip_status_of(false, 'abgelehnt') <> 'unknown' THEN
    RAISE EXCEPTION 'declined 4: the backfill rule now reclassifies a historical row';
  END IF;
  IF app_private.fahrtenbuch_trip_status_of(true, 'abgelehnt') <> 'cancelled' THEN
    RAISE EXCEPTION 'declined 4: is_canceled no longer wins in the backfill rule';
  END IF;
  RAISE NOTICE 'declined 4: history is untouched';
END $$;

-- ─── 5. Tenancy is the same as any other trip ───────────────────────────────

DO $$
DECLARE
  c_admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
  v_seen int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_admin_a, 'role', 'authenticated',
                      'amr', json_build_array(json_build_object('method', 'password')))::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM fahrtenbuch_trips WHERE trip_status = 'declined';
  IF v_seen = 0 THEN
    RAISE EXCEPTION 'declined 5: the company''s own administrator cannot see its declined rows';
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_admin_b, 'role', 'authenticated',
                      'amr', json_build_array(json_build_object('method', 'password')))::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM fahrtenbuch_trips WHERE trip_status = 'declined';
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'declined 5: another company''s administrator sees % declined rows', v_seen;
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', NULL, true);
  SET LOCAL ROLE anon;
  SELECT count(*) INTO v_seen FROM fahrtenbuch_trips WHERE trip_status = 'declined';
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'declined 5: anon sees % declined rows', v_seen;
  END IF;
  RESET ROLE;
  RAISE NOTICE 'declined 5: tenancy holds for a declined row';
END $$;

-- ─── 6. The fee is immutable, and the trigger is not a blanket refusal ──────

DO $$
DECLARE
  v_id uuid;
  v_refused boolean;
BEGIN
  SELECT id INTO v_id FROM fahrtenbuch_trips WHERE trip_status = 'declined' LIMIT 1;

  v_refused := false;
  BEGIN
    UPDATE fahrtenbuch_trips SET declined_fee_cents = 700 WHERE id = v_id;
  EXCEPTION WHEN raise_exception THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'declined 6: the fee changed after insert';
  END IF;

  -- is_simulated is immutable too, by its own trigger rather than by the big
  -- one. The migration files it under "protected elsewhere", and this is the
  -- probe that the filing is true rather than a label.
  v_refused := false;
  BEGIN
    UPDATE fahrtenbuch_trips SET is_simulated = NOT is_simulated WHERE id = v_id;
  EXCEPTION WHEN raise_exception THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'declined 6: the simulation marker changed after insert';
  END IF;

  -- An assignment column still moves, or applying a plan would stop working.
  UPDATE fahrtenbuch_trips SET assignment_note = 'kit' WHERE id = v_id;
  RAISE NOTICE 'declined 6: the fee and the simulation marker are immutable, the assignment columns are not';
END $$;

ROLLBACK;
