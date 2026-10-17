-- ════════════════════════════════════════════════════════════════════════════
--  Undo the Uber import: uber_import_undo (20261016120000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  The function deletes money, drivers and cars. Every probe below is one way
--  it could destroy real work, and each is written so that the ONE term that
--  prevents it is the only thing that can make the probe fail:
--
--    §3  the preview: what goes, what stays and why, counted by the same plan
--        that deletes. Nothing is written.
--    §5  the delete, then the physical checks, each its own probe:
--          P-HAND     hand-typed income (source NULL) is exactly as it was
--          P-SALARY   a driver with a salary (id reference, ON DELETE CASCADE)
--                     and the salary are still there
--          P-NAME     a driver named by hand-typed income or a receipt (no
--                     foreign key anywhere) is still there; nothing names a
--                     driver that no longer exists
--          P-CAR      a car with a Werkstatt check, and the check, are still there
--          P-OLD      a driver the import only LINKED (it existed before) is
--                     still there, with its link; only its Uber income went
--          P-OTHER    company B's rows are byte-for-byte what they were
--          P-CONN     the partner connection and the unconfirmed links stand
--          P-AGREE    the preview's counts, the answer's counts and the physical
--                     difference are the same three numbers
--
--  Every refusal is read as `ERR <sqlstate> <hint>`. Runs inside BEGIN ...
--  ROLLBACK. Platform contexts are opened LAST. Ids start with `3f`.
--
--  ONE THING TO KNOW ABOUT THE FIXTURE: "created by the import" is derived from
--  a row being created in the same TRANSACTION as its link, and this whole file
--  is one transaction. Rows meant to be "found, not created" are therefore
--  inserted with an explicit older created_at; the import functions create the
--  rest, as they do in production.
BEGIN;

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();
CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _un_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DISCARD PLANS;
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _un_call(p_user uuid, p_sql text, p_session uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_hint text; v_state text;
BEGIN
  PERFORM _un_as(p_user, p_session);
  EXECUTE p_sql INTO v_out;
  RESET ROLE;
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RESET ROLE;
  RETURN 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END $$;

CREATE TEMP TABLE _un_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _un_rec(p_n integer, p_label text, p_actual text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  p_actual := coalesce(p_actual, '<null>');
  v_ok := p_actual = p_expected;
  INSERT INTO _un_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END $$;

/* The undo as one call, as text. */
CREATE OR REPLACE FUNCTION _un_undo(p_dry boolean, p_name text DEFAULT NULL, p_expect jsonb DEFAULT NULL) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format('SELECT uber_import_undo(%L::boolean, %L, %L::jsonb)::text', p_dry, p_name, p_expect::text)
$$;

/* Everything the probes compare, for one company, as one string. */
CREATE OR REPLACE FUNCTION _un_world(p_co uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT concat_ws(' ',
    'uber=' || (SELECT count(*) FROM income WHERE company_id = p_co AND source = 'uber'),
    'hand=' || (SELECT count(*) FROM income WHERE company_id = p_co AND source IS NULL),
    'drivers=' || (SELECT count(*) FROM drivers WHERE company_id = p_co),
    'cars=' || (SELECT count(*) FROM cars WHERE company_id = p_co),
    'dlinks=' || (SELECT count(*) FROM partner_driver_links WHERE company_id = p_co),
    'vlinks=' || (SELECT count(*) FROM partner_vehicle_links WHERE company_id = p_co),
    'salaries=' || (SELECT count(*) FROM salaries WHERE company_id = p_co),
    'receipts=' || (SELECT count(*) FROM receipts WHERE company_id = p_co),
    'checks=' || (SELECT count(*) FROM werkstatt_checks WHERE company_id = p_co),
    'conns=' || (SELECT count(*) FROM partner_connections WHERE company_id = p_co))
$$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  admin_b constant uuid := 'b0000000-0000-4000-8000-000000000001';
BEGIN
  UPDATE companies SET subscription_car_limit = 1000 WHERE id IN (co_a, co_b);

  -- Found, not created: older than this transaction, so the import links them.
  INSERT INTO drivers (id, company_id, name, status, created_at)
  VALUES ('3f000000-0000-4000-8000-0000000000d0', co_a, 'Old Hand', 'active', now() - interval '30 days');
  INSERT INTO cars (id, company_id, kennzeichen, created_by, created_at)
  VALUES ('3f000000-0000-4000-8000-0000000000c0', co_a, 'AB-OLD 1', admin_a, now() - interval '30 days');

  -- What the partner proposed. Six drivers (one of them is Old Hand under a
  -- different spelling), three vehicles, and one driver somebody rejected.
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, proposed_name, status) VALUES
    (co_a, 'reidey', '9101', 'Ann Import', 'pending'),
    (co_a, 'reidey', '9102', 'Bob Import', 'pending'),
    (co_a, 'reidey', '9103', 'Cy Import',  'pending'),
    (co_a, 'reidey', '9104', 'Dee Import', 'pending'),
    (co_a, 'reidey', '9105', 'Eve Import', 'pending'),
    (co_a, 'reidey', '9106', ' old HAND ', 'pending'),
    (co_a, 'reidey', '9199', 'Rita Rejected', 'rejected');
  INSERT INTO partner_vehicle_links (company_id, partner, external_vehicle_id, proposed_plate, status) VALUES
    (co_a, 'reidey', '801', 'AB-IM 1',  'pending'),
    (co_a, 'reidey', '802', 'AB-IM 2',  'pending'),
    (co_a, 'reidey', '803', 'AB OLD 1', 'pending');

  INSERT INTO partner_connections (company_id, partner) VALUES (co_a, 'reidey'), (co_b, 'reidey');

  -- Staff for the platform-session probes.
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('3f000000-0000-4000-8000-0000000000e1', 'un-staff@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('3f000000-0000-4000-8000-0000000000e1', 'un-staff@test.invalid', 'UN Staff', 'viewer',
          (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL LIMIT 1), NULL, 'active');
  INSERT INTO app_private.platform_staff (user_id, role, note)
  VALUES ('3f000000-0000-4000-8000-0000000000e1', 'owner', 'un');
  INSERT INTO auth.sessions (id, user_id)
  VALUES ('3f000000-0000-4000-8000-0000000000e2', '3f000000-0000-4000-8000-0000000000e1');

  -- Company B: a driver of the SAME name as company A's Ann, created by its own
  -- import (row and link in this transaction), with Uber income, and a receipt
  -- that names her. Company A's undo must neither touch any of it nor be
  -- blocked by the receipt; company B's own undo is blocked by it.
  INSERT INTO drivers (id, company_id, name, status)
  VALUES ('3f000000-0000-4000-8000-0000000000b1', co_b, 'Ann Import', 'inactive');
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, proposed_name, status, linked_at)
  VALUES (co_b, 'reidey', '9101', '3f000000-0000-4000-8000-0000000000b1', 'Ann Import', 'linked', now());
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  VALUES ('B uber', 77, 'umsatz', 'Ann Import', '2026-09-02', co_b, 'uber', '2026-08-31', '2026-09-06', '9101');
  INSERT INTO receipts (receipt_number, date, description, driver_name, company_id)
  VALUES ('BEL-UN-B', current_date, 'un', 'Ann Import', co_b);
  INSERT INTO income (description, amount, type, driver_name, date, company_id)
  VALUES ('B typed', 11, 'umsatz', 'Somebody', '2026-09-03', co_b);
END $$;

-- The import itself, as company A's administrator, through the real functions.
DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _un_rec(1, 'the driver import creates five drivers and links the one that existed',
    _un_call(admin_a, $q$SELECT (x -> 'created')::text || '/' || (x -> 'linked')::text
                           FROM (SELECT partner_drivers_import() AS x) s$q$),
    '5/1');
  PERFORM _un_rec(2, 'the vehicle import creates two cars and links the one that existed',
    _un_call(admin_a, $q$SELECT (x -> 'created')::text || '/' || (x -> 'linked')::text
                           FROM (SELECT partner_vehicles_import() AS x) s$q$),
    '2/1');
END $$;

-- Data that hangs off the imported rows (owner, so RLS is out of the way).
DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_bob uuid := (SELECT id FROM drivers WHERE company_id = co_a AND name = 'Bob Import');
  v_car2 uuid := (SELECT id FROM cars WHERE company_id = co_a AND kennzeichen = 'AB-IM 2');
BEGIN
  -- The import's own income: one row per partner driver, six in all.
  INSERT INTO income (description, amount, type, driver_name, date, company_id,
                      source, source_period_start, source_period_end, source_driver_key)
  SELECT 'A uber ' || l.external_driver_id, 100, 'umsatz', d.name, '2026-09-02', co_a,
         'uber', '2026-08-31', '2026-09-06', l.external_driver_id
    FROM partner_driver_links l JOIN drivers d ON d.id = l.driver_id
   WHERE l.company_id = co_a AND l.status = 'linked';

  -- Somebody typed these. One names an import driver (Cy), one names nobody.
  INSERT INTO income (description, amount, type, driver_name, date, company_id) VALUES
    ('A typed Cy', 21, 'umsatz', 'Cy Import', '2026-09-04', co_a),
    ('A typed nobody', 22, 'umsatz', 'Nobody Typed', '2026-09-05', co_a);

  -- Bob has a salary: an id reference with ON DELETE CASCADE.
  INSERT INTO salaries (driver_id, period_start, period_end, created_by, company_id)
  VALUES (v_bob, '2026-09-01', '2026-09-30', admin_a, co_a);
  -- Dee is named by a receipt and by nothing else: no foreign key anywhere.
  INSERT INTO receipts (receipt_number, date, description, driver_name, company_id)
  VALUES ('BEL-UN-A', current_date, 'un', 'Dee Import', co_a);
  -- The second imported car has a Werkstatt check (ON DELETE CASCADE).
  INSERT INTO werkstatt_checks (car_id, week_number, year, created_by, company_id)
  VALUES (v_car2, 36, 2026, admin_a, co_a);
END $$;

CREATE TEMP TABLE _un_before AS
  SELECT _un_world('c0000000-0000-4000-8000-00000000000a') AS a,
         (SELECT count(*) FROM drivers WHERE company_id = 'c0000000-0000-4000-8000-00000000000a') AS a_drivers,
         (SELECT count(*) FROM cars WHERE company_id = 'c0000000-0000-4000-8000-00000000000a') AS a_cars,
         _un_world('c0000000-0000-4000-8000-00000000000b') AS b,
         (SELECT string_agg(id::text, ',' ORDER BY id) FROM income
           WHERE company_id = 'c0000000-0000-4000-8000-00000000000a' AND source IS NULL) AS a_hand_ids,
         (SELECT string_agg(id::text, ',' ORDER BY id) FROM income
           WHERE company_id = 'c0000000-0000-4000-8000-00000000000b') AS b_income_ids;

-- ─── 1. who may call it ─────────────────────────────────────────────────────

DO $$
DECLARE
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  nocomp   constant uuid := '50000000-0000-4000-8000-000000000001';
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_world  text := _un_world('c0000000-0000-4000-8000-00000000000a');
BEGIN
  PERFORM _un_rec(3, 'a viewer is refused: undoing an import is an administrator''s act',
    _un_call(viewer_a, _un_undo(true)), 'ERR 42501 not_authorized');
  PERFORM _un_rec(4, 'so is an editor, who may import earnings but not undo them',
    _un_call(editor_a, _un_undo(true)), 'ERR 42501 not_authorized');
  PERFORM _un_rec(5, 'anon cannot execute it', _un_call(NULL, _un_undo(true)), 'ERR 42501 (no hint)');
  PERFORM _un_rec(6, 'a platform account with no context has no company: refused',
    _un_call(nocomp, _un_undo(true)), 'ERR 42501 not_authorized');
  PERFORM _un_rec(7, 'a null dry-run flag is a refusal, not a default',
    _un_call(admin_a, 'SELECT uber_import_undo(NULL::boolean)::text'), 'ERR 22023 invalid_request');
  PERFORM _un_rec(8, 'the grants: authenticated yes, anon no, PUBLIC no',
    (has_function_privilege('authenticated', 'public.uber_import_undo(boolean,text,jsonb)', 'EXECUTE')::text || '/' ||
     has_function_privilege('anon', 'public.uber_import_undo(boolean,text,jsonb)', 'EXECUTE')::text || '/' ||
     EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.uber_import_undo(boolean,text,jsonb)'::regprocedure AND a.grantee = 0)::text),
    'true/false/false');
  PERFORM _un_rec(9, 'none of that changed anything', _un_world('c0000000-0000-4000-8000-00000000000a'), v_world);
END $$;

-- ─── 2. the marker: created, or only found ──────────────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _un_rec(10, 'the five created drivers are marked, the one that was found is not',
    (SELECT string_agg(d.name || '=' || l.created_by_import::text, ', ' ORDER BY d.name)
       FROM partner_driver_links l JOIN drivers d ON d.id = l.driver_id WHERE l.company_id = co_a),
    'Ann Import=true, Bob Import=true, Cy Import=true, Dee Import=true, Eve Import=true, Old Hand=false');
  PERFORM _un_rec(11, 'the two created cars are marked, the one that was found is not',
    (SELECT string_agg(c.kennzeichen || '=' || l.created_by_import::text, ', ' ORDER BY c.kennzeichen)
       FROM partner_vehicle_links l JOIN cars c ON c.id = l.car_id WHERE l.company_id = co_a),
    'AB-IM 1=true, AB-IM 2=true, AB-OLD 1=false');
  PERFORM _un_rec(12, 'an unconfirmed proposal is marked nothing',
    (SELECT coalesce(bool_or(created_by_import), false)::text FROM partner_driver_links WHERE company_id = co_a AND status <> 'linked'),
    'false');

  -- The drivers page may UPDATE a link. It must not be able to claim a row.
  PERFORM _un_rec(13, 'the administrator''s UPDATE of a link reaches the row',
    _un_call(admin_a, $q$WITH u AS (UPDATE partner_driver_links SET created_by_import = true
                                     WHERE company_id = 'c0000000-0000-4000-8000-00000000000a'
                                       AND external_driver_id = '9106' RETURNING 1)
                         SELECT count(*)::text FROM u$q$), '1');
  PERFORM _un_rec(14, '...and the flag it sent was overwritten: a found driver is still not "created"',
    (SELECT created_by_import::text FROM partner_driver_links WHERE company_id = co_a AND external_driver_id = '9106'),
    'false');
END $$;

-- ─── 3. the preview: what goes, what stays, and why ─────────────────────────

CREATE TEMP TABLE _un_preview AS
  SELECT _un_call('a0000000-0000-4000-8000-000000000001', _un_undo(true))::jsonb AS doc;

DO $$
DECLARE
  j jsonb := (SELECT doc FROM _un_preview);
BEGIN
  PERFORM _un_rec(15, 'it is a dry run and says whose company it is',
    (j->>'ok') || ' ' || (j->>'dry_run') || ' ' || (j->>'company_name'), 'true true Test A');
  PERFORM _un_rec(16, 'the income: six Uber rows over the one week, and the two typed rows are named as untouched',
    (j#>>'{income,rows}') || ' ' || (j#>>'{income,from}') || ' ' || (j#>>'{income,to}') || ' ' || (j->>'hand_typed_rows'),
    '6 2026-08-31 2026-09-06 2');
  PERFORM _un_rec(17, 'two drivers go: the two that carry nothing else',
    (SELECT string_agg(x->>'name', ', ' ORDER BY x->>'name') FROM jsonb_array_elements(j#>'{drivers,delete}') x),
    'Ann Import, Eve Import');
  PERFORM _un_rec(18, 'three stay, each with the table and the number that keeps it',
    (SELECT string_agg((x->>'name') || ' ' || (x->>'blockers'), ' | ' ORDER BY x->>'name') FROM jsonb_array_elements(j#>'{drivers,keep}') x),
    'Bob Import {"salaries.driver_id": 1} | Cy Import {"income.driver_name": 1} | Dee Import {"receipts.driver_name": 1}');
  PERFORM _un_rec(19, 'the driver that was only linked is counted as untouched, not as a candidate',
    j#>>'{drivers,untouched}', '1');
  PERFORM _un_rec(20, 'one car goes, one stays with its Werkstatt check, one was only linked',
    (SELECT string_agg(x->>'plate', ',') FROM jsonb_array_elements(j#>'{cars,delete}') x) || ' / ' ||
    (SELECT string_agg((x->>'plate') || ' ' || (x->>'blockers'), ',') FROM jsonb_array_elements(j#>'{cars,keep}') x) || ' / ' ||
    (j#>>'{cars,untouched}'),
    'AB-IM 1 / AB-IM 2 {"werkstatt_checks.car_id": 1} / 1');
  PERFORM _un_rec(21, 'Bob''s September salary is computed from Uber income that is about to go, and says so',
    j->>'salaries_affected', '1');
  PERFORM _un_rec(22, 'the counts to send back with the real run',
    (j->'expect')::text, '{"cars": 1, "income": 6, "drivers": 2}');
  PERFORM _un_rec(23, 'company B''s receipt for an "Ann Import" did not keep company A''s Ann: scoped by company',
    (SELECT count(*)::text FROM jsonb_array_elements(j#>'{drivers,delete}') x WHERE x->>'name' = 'Ann Import'), '1');
  PERFORM _un_rec(24, 'the preview wrote nothing',
    _un_world('c0000000-0000-4000-8000-00000000000a') || ' | ' || _un_world('c0000000-0000-4000-8000-00000000000b'),
    (SELECT a || ' | ' || b FROM _un_before));
END $$;

-- ─── 4. the real run needs the typed name and the counts the preview showed ──

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_expect jsonb := (SELECT doc->'expect' FROM _un_preview);
  v_world text := _un_world('c0000000-0000-4000-8000-00000000000a');
BEGIN
  PERFORM _un_rec(25, 'no typed name: refused',
    _un_call(admin_a, _un_undo(false, NULL, v_expect)), 'ERR 22023 confirmation_mismatch');
  PERFORM _un_rec(26, 'another company''s name: refused',
    _un_call(admin_a, _un_undo(false, 'Test B', v_expect)), 'ERR 22023 confirmation_mismatch');
  PERFORM _un_rec(27, 'the name in another case: refused, the comparison is exact',
    _un_call(admin_a, _un_undo(false, 'test a', v_expect)), 'ERR 22023 confirmation_mismatch');
  PERFORM _un_rec(28, 'no counts: refused',
    _un_call(admin_a, _un_undo(false, 'Test A', NULL)), 'ERR 22023 invalid_request');
  PERFORM _un_rec(29, 'counts that are not numbers: refused',
    _un_call(admin_a, _un_undo(false, 'Test A', '{"income":"6","drivers":2,"cars":1}'::jsonb)), 'ERR 22023 invalid_request');
  PERFORM _un_rec(30, 'counts the data no longer matches: refused as plan_changed',
    _un_call(admin_a, _un_undo(false, 'Test A', '{"income":5,"drivers":2,"cars":1}'::jsonb)), 'ERR 22023 plan_changed');
  PERFORM _un_rec(31, 'surrounding blanks on the typed name are forgiven (the name check passes; the stale counts are what refuse)',
    _un_call(admin_a, _un_undo(false, '  Test A  ', '{"income":9,"drivers":9,"cars":9}'::jsonb)), 'ERR 22023 plan_changed');
  PERFORM _un_rec(32, 'every refusal above left everything where it was',
    _un_world('c0000000-0000-4000-8000-00000000000a'), v_world);
END $$;

-- ─── 5. the run ─────────────────────────────────────────────────────────────

CREATE TEMP TABLE _un_run AS
  SELECT _un_call('a0000000-0000-4000-8000-000000000001',
                  _un_undo(false, 'Test A', (SELECT doc->'expect' FROM _un_preview)))::jsonb AS doc;

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  j jsonb := (SELECT doc FROM _un_run);
  v_pre jsonb := (SELECT doc FROM _un_preview);
  b record;
BEGIN
  SELECT * INTO b FROM _un_before;

  PERFORM _un_rec(33, 'it ran and says what it deleted and what it kept',
    (j->>'ok') || ' ' || (j->'deleted')::text || ' ' || (j->'kept')::text,
    'true {"cars": 1, "income": 6, "drivers": 2} {"cars": 1, "drivers": 3}');

  -- P-AGREE: three independent numbers that must be one.
  PERFORM _un_rec(34, 'P-AGREE: the preview, the answer and the physical difference are the same three numbers',
    (v_pre->'expect')::text || ' = ' || (j->'deleted')::text || ' = ' ||
    jsonb_build_object('income', 6 - (SELECT count(*) FROM income WHERE company_id = co_a AND source = 'uber'),
                       'drivers', b.a_drivers - (SELECT count(*) FROM drivers WHERE company_id = co_a),
                       'cars', b.a_cars - (SELECT count(*) FROM cars WHERE company_id = co_a))::text,
    '{"cars": 1, "income": 6, "drivers": 2} = {"cars": 1, "income": 6, "drivers": 2} = {"cars": 1, "income": 6, "drivers": 2}');

  PERFORM _un_rec(35, 'the two drivers and the one car that carried nothing are gone',
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND name IN ('Ann Import', 'Eve Import'))
      || '/' || (SELECT count(*)::text FROM cars WHERE company_id = co_a AND kennzeichen = 'AB-IM 1'), '0/0');

  -- P-HAND
  PERFORM _un_rec(36, 'P-HAND: the hand-typed income rows are exactly the rows they were',
    (SELECT string_agg(id::text, ',' ORDER BY id) FROM income WHERE company_id = co_a AND source IS NULL),
    b.a_hand_ids);
  PERFORM _un_rec(37, 'P-HAND: ...and their amounts',
    (SELECT sum(amount)::text FROM income WHERE company_id = co_a AND source IS NULL AND description LIKE 'A typed%'), '43');

  -- P-SALARY
  PERFORM _un_rec(38, 'P-SALARY: the driver with a salary and the salary are both still there',
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND name = 'Bob Import')
      || '/' || (SELECT count(*)::text FROM salaries s JOIN drivers d ON d.id = s.driver_id
                   WHERE s.company_id = co_a AND d.name = 'Bob Import'), '1/1');

  -- P-NAME
  PERFORM _un_rec(39, 'P-NAME: the drivers named by typed income and by a receipt are still there',
    (SELECT string_agg(name, ',' ORDER BY name) FROM drivers WHERE company_id = co_a AND name IN ('Cy Import', 'Dee Import')),
    'Cy Import,Dee Import');
  PERFORM _un_rec(40, 'P-NAME: no income or receipt row names an import driver that no longer exists',
    (SELECT count(*)::text FROM (
        SELECT driver_name FROM income WHERE company_id = co_a
        UNION ALL SELECT driver_name FROM receipts WHERE company_id = co_a) n
      WHERE n.driver_name IN ('Ann Import', 'Bob Import', 'Cy Import', 'Dee Import', 'Eve Import', 'Old Hand')
        AND NOT EXISTS (SELECT 1 FROM drivers d WHERE d.company_id = co_a AND d.name = n.driver_name)),
    '0');
  PERFORM _un_rec(41, 'P-NAME: Dee''s receipt is still there',
    (SELECT count(*)::text FROM receipts WHERE company_id = co_a AND driver_name = 'Dee Import'), '1');

  -- P-CAR
  PERFORM _un_rec(42, 'P-CAR: the car with a Werkstatt check and the check are both still there',
    (SELECT count(*)::text FROM cars WHERE company_id = co_a AND kennzeichen = 'AB-IM 2')
      || '/' || (SELECT count(*)::text FROM werkstatt_checks WHERE company_id = co_a), '1/1');

  -- P-OLD
  PERFORM _un_rec(43, 'P-OLD: the driver and the car that existed before the import stand, with their links',
    (SELECT count(*)::text FROM drivers WHERE id = '3f000000-0000-4000-8000-0000000000d0')
      || '/' || (SELECT count(*)::text FROM cars WHERE id = '3f000000-0000-4000-8000-0000000000c0')
      || '/' || (SELECT count(*)::text FROM partner_driver_links WHERE driver_id = '3f000000-0000-4000-8000-0000000000d0')
      || '/' || (SELECT count(*)::text FROM partner_vehicle_links WHERE car_id = '3f000000-0000-4000-8000-0000000000c0'),
    '1/1/1/1');
  PERFORM _un_rec(44, 'the import''s income is gone: all of it, including the old driver''s',
    (SELECT count(*)::text FROM income WHERE company_id = co_a AND source = 'uber'), '0');

  -- P-OTHER
  PERFORM _un_rec(45, 'P-OTHER: company B''s world is what it was',
    _un_world(co_b), b.b);
  PERFORM _un_rec(46, 'P-OTHER: ...down to its income rows',
    (SELECT string_agg(id::text, ',' ORDER BY id) FROM income WHERE company_id = co_b), b.b_income_ids);

  -- P-CONN
  PERFORM _un_rec(47, 'P-CONN: the partner connection and the rejected proposal stand',
    (SELECT count(*)::text FROM partner_connections WHERE company_id = co_a)
      || '/' || (SELECT count(*)::text FROM partner_driver_links WHERE company_id = co_a AND status = 'rejected'),
    '1/1');
  PERFORM _un_rec(48, 'the links of the deleted rows went with them, the links of the kept rows stayed',
    (SELECT count(*)::text FROM partner_driver_links WHERE company_id = co_a AND status = 'linked')
      || '/' || (SELECT count(*)::text FROM partner_vehicle_links WHERE company_id = co_a AND status = 'linked'),
    '4/2');
END $$;

-- ─── 6. it can be run again, and company B's administrator has his own plan ──

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  admin_b constant uuid := 'b0000000-0000-4000-8000-000000000001';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  j jsonb;
  v_a_world constant text := _un_world('c0000000-0000-4000-8000-00000000000a');
BEGIN
  j := _un_call(admin_a, _un_undo(true))::jsonb;
  PERFORM _un_rec(49, 'a second preview finds nothing to delete and still names what it kept',
    (j->'expect')::text || ' ' || jsonb_array_length(j#>'{drivers,keep}') || ' ' || jsonb_array_length(j#>'{cars,keep}'),
    '{"cars": 0, "income": 0, "drivers": 0} 3 1');

  j := _un_call(admin_b, _un_undo(true))::jsonb;
  PERFORM _un_rec(50, 'company B''s preview is about company B: one Uber row, and its Ann is kept by B''s own receipt',
    (j#>>'{income,rows}') || ' ' || (j->>'hand_typed_rows') || ' ' || (j->'expect')::text || ' '
      || (SELECT x->>'blockers' FROM jsonb_array_elements(j#>'{drivers,keep}') x LIMIT 1),
    '1 1 {"cars": 0, "income": 1, "drivers": 0} {"receipts.driver_name": 1}');

  PERFORM _un_rec(51, 'company B''s run deletes company B''s one Uber row and nothing else',
    _un_call(admin_b, _un_undo(false, 'Test B', j->'expect')),
    '{"ok": true, "kept": {"cars": 0, "drivers": 1}, "deleted": {"cars": 0, "income": 1, "drivers": 0}, "dry_run": false, "hand_typed_rows": 1}');
  PERFORM _un_rec(52, 'company B''s driver, its typed income and its receipt are still there',
    (SELECT count(*)::text FROM drivers WHERE company_id = co_b) || '/'
      || (SELECT count(*)::text FROM income WHERE company_id = co_b AND source IS NULL) || '/'
      || (SELECT count(*)::text FROM receipts WHERE company_id = co_b), '2/1/1');
  PERFORM _un_rec(53, 'company A was not touched by company B''s run',
    _un_world('c0000000-0000-4000-8000-00000000000a'), v_a_world);
END $$;

-- ─── 7. what the scan reads comes from the catalogue ────────────────────────

DO $$
BEGIN
  PERFORM _un_rec(54, 'the scan reaches the four references that matter most',
    (SELECT string_agg(kind || ':' || tbl || '.' || col, ',' ORDER BY kind, tbl)
       FROM app_private.uber_undo_reference_columns()
      WHERE (kind, tbl, col) IN (('driver_id', 'salaries', 'driver_id'),
                                 ('driver_name', 'income', 'driver_name'),
                                 ('driver_name', 'receipts', 'driver_name'),
                                 ('car_id', 'werkstatt_checks', 'car_id'))),
    'car_id:werkstatt_checks.car_id,driver_id:salaries.driver_id,driver_name:income.driver_name,driver_name:receipts.driver_name');
  PERFORM _un_rec(55, 'it reads the trips by the name of the driver, which has no foreign key to the name',
    (SELECT count(*)::text FROM app_private.uber_undo_reference_columns()
      WHERE tbl = 'fahrtenbuch_trips' AND col IN ('assigned_driver_name', 'original_driver_name')), '2');
  PERFORM _un_rec(56, 'and it never reads the partner''s own driver key as one of ours',
    (SELECT count(*)::text FROM app_private.uber_undo_reference_columns() WHERE col ~ 'external|source_driver_key'), '0');
  PERFORM _un_rec(57, 'every foreign key to a driver or a car (outside the two link tables) is covered',
    (SELECT count(*)::text FROM pg_constraint k
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.confrelid IN ('public.drivers'::regclass, 'public.cars'::regclass)
        AND k.conrelid::regclass::text NOT IN ('partner_driver_links', 'partner_vehicle_links')
        AND NOT EXISTS (SELECT 1 FROM app_private.uber_undo_reference_columns() s
                         WHERE s.tbl::text = k.conrelid::regclass::text AND s.col = a.attname)),
    '0');
END $$;

-- ─── 8. platform sessions, last ─────────────────────────────────────────────

DO $$
DECLARE
  staff   constant uuid := '3f000000-0000-4000-8000-0000000000e1';
  staff_s constant uuid := '3f000000-0000-4000-8000-0000000000e2';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_world text := _un_world(co_a);
BEGIN
  PERFORM _un_call(staff, format($q$SELECT platform_context_open(%L, 'support', 'undo import probe, long enough')::text$q$, co_a), staff_s);
  PERFORM _un_rec(58, 'a platform account in a SUPPORT session may not even preview',
    _un_call(staff, _un_undo(true), staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _un_rec(59, 'nor run it',
    _un_call(staff, _un_undo(false, 'Test A', '{"income":0,"drivers":0,"cars":0}'::jsonb), staff_s),
    'ERR 42501 platform_session_not_allowed');
  PERFORM _un_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
  PERFORM _un_call(staff, format($q$SELECT platform_context_open(%L, 'view')::text$q$, co_a), staff_s);
  PERFORM _un_rec(60, 'and a VIEW session is refused the same way',
    _un_call(staff, _un_undo(true), staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _un_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
  PERFORM _un_rec(61, 'the platform sessions changed nothing', _un_world(co_a), v_world);
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _un_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'uber import undo: % of % probe(s) did not match - read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '-- uber import undo: all % probes matched --', v_all;
END $$;

ROLLBACK;
