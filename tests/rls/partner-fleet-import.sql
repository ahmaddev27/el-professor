-- ════════════════════════════════════════════════════════════════════════════
--  Fleet import: partner_drivers_import, partner_vehicles_import,
--  partner_vehicle_roster_apply and partner_vehicle_links (20261015100000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  The owner's rule, 14.10.2026: a new company pulls its data in and the
--  administrator edits it afterwards. The one care: `drivers.name` is text with
--  no foreign key, and money joins on it, so an import must never create a
--  second row for a person who exists and never write an existing name.
--
--    §1  who may call: viewer, editor, a suspended administrator, anon, a
--        platform account with no context - all refused BEFORE anything is
--        created, each with the reason that gate raises (not_authorized, and
--        for anon a privilege error, which has no hint).
--    §2  drivers, the happy path: an existing driver is LINKED and not
--        duplicated (probe 12 reads the count of that name), its name is
--        byte-identical afterwards (13), created ones carry the partner's name
--        trimmed, a clean e-mail and an E.164 phone (15), a refused e-mail and
--        phone become NULL and do not fail the row (16), a departed driver is
--        created inactive (17), nothing the owner ruled out arrives (18), a
--        rejected link and another company's link are untouched (19, 20).
--    §3  the fallback name and a name already taken are reported, not created
--        twice (21, 22), and a second run creates nothing (23).
--    §4  the driver limit: what fits is created, the rest reported, and the
--        limit itself is not raised (24-26).
--    §5  vehicles: the apply function is idempotent (27), a plate we already
--        have is linked (29), a missing plate and a plate held by ANOTHER
--        company are reported and the other company is not named (31-33), the
--        car limit is honoured and not raised (35, 36).
--    §6  who may call, again, and the table: a platform account inside a
--        support or a view session is refused with its own reason (37-40);
--        partner_vehicle_links has no client write (41), the grants (42).
--
--  Every refusal is read as `ERR <sqlstate> <hint>`. Runs inside BEGIN ...
--  ROLLBACK. Platform contexts are opened LAST: afterwards the transaction-local
--  write flag is still set and a plain owner INSERT would be refused.
--  Ids start with `2f` so a failure names a row.

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

CREATE OR REPLACE FUNCTION _fi_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A privilege error is raised at parse time; the plan the owner warmed would
  -- hide it from every principal after.
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

CREATE OR REPLACE FUNCTION _fi_call(p_user uuid, p_sql text, p_session uuid DEFAULT NULL,
                                    p_owner boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text; v_hint text; v_state text;
BEGIN
  IF NOT p_owner THEN PERFORM _fi_as(p_user, p_session); END IF;
  EXECUTE p_sql INTO v_out;
  RESET ROLE;
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RESET ROLE;
  RETURN 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END $$;

CREATE TEMP TABLE _fi_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _fi_rec(p_n integer, p_label text, p_actual text, p_expected text,
                                   p_like boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := CASE WHEN p_like THEN p_actual LIKE p_expected ELSE p_actual = p_expected END;
  INSERT INTO _fi_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END $$;

/* created/linked/skipped of one driver import, as a string. */
CREATE OR REPLACE FUNCTION _fi_drivers() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT $q$SELECT (x->>'created') || '/' || (x->>'linked') || '/' || (x->>'skipped_count')
              FROM (SELECT partner_drivers_import() AS x) s$q$
$$;

/* the skipped reasons of one driver import, in link-id order. */
CREATE OR REPLACE FUNCTION _fi_driver_reasons() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT $q$SELECT coalesce(string_agg(e->>'reason', ',' ORDER BY e->>'link_id'), 'none')
              FROM jsonb_array_elements(partner_drivers_import()->'skipped') e$q$
$$;

CREATE OR REPLACE FUNCTION _fi_vehicles() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT $q$SELECT (x->>'created') || '/' || (x->>'linked') || '/' || (x->>'skipped_count')
              FROM (SELECT partner_vehicles_import() AS x) s$q$
$$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  -- Exists already, with a double space inside the name: a function that
  -- re-spelled it, trimmed it or wrote the partner's text over it reads
  -- differently afterwards.
  -- The subscription default is three cars, so six drivers: more than the seed
  -- plus this file's fixtures leave room for. Section 4 sets its own.
  UPDATE companies SET subscription_car_limit = 1000 WHERE id = co_a;

  INSERT INTO drivers (id, company_id, name)
  VALUES ('2f000000-0000-4000-8000-0000000000d1', co_a, 'Anna  Existing'),
         ('2f000000-0000-4000-8000-0000000000d2', co_b, 'Carla Neu');

  -- The partner's list as it would arrive, in link-id order. Ids are fixed so
  -- the order the import walks is the order read here.
  INSERT INTO partner_driver_links
    (id, company_id, partner, external_driver_id, proposed_name, proposed_email, proposed_phone, partner_removed_at, status)
  VALUES
    ('2f000000-0000-4000-8000-000000001001', co_a, 'reidey', '1001', 'ANNA  EXISTING ', NULL, NULL, NULL, 'pending'),
    ('2f000000-0000-4000-8000-000000001002', co_a, 'reidey', '1002', ' Bernd Neu', 'bernd@example.com', '0176 1234567', NULL, 'pending'),
    ('2f000000-0000-4000-8000-000000001003', co_a, 'reidey', '1003', 'Carla Neu', 'not-an-email', 'abc', NULL, 'pending'),
    ('2f000000-0000-4000-8000-000000001004', co_a, 'reidey', '1004', 'Unbekannter Fahrer', NULL, NULL, NULL, 'pending'),
    ('2f000000-0000-4000-8000-000000001005', co_a, 'reidey', '1005', 'Unbekannter Fahrer', NULL, NULL, NULL, 'pending'),
    ('2f000000-0000-4000-8000-000000001006', co_a, 'reidey', '1006', 'Dora Weg', NULL, NULL, now(), 'pending'),
    ('2f000000-0000-4000-8000-000000001007', co_a, 'reidey', '1007', NULL, NULL, NULL, NULL, 'pending'),
    ('2f000000-0000-4000-8000-000000001008', co_a, 'reidey', '1008', 'bernd neu', NULL, NULL, NULL, 'pending'),
    ('2f000000-0000-4000-8000-000000002001', co_b, 'reidey', '2001', 'Zed Other', NULL, NULL, NULL, 'pending');
  -- A person rejected this link: not ours. Nobody creates it.
  INSERT INTO partner_driver_links
    (id, company_id, partner, external_driver_id, proposed_name, status)
  VALUES ('2f000000-0000-4000-8000-000000001009', co_a, 'reidey', '1009', 'Rita Rejected', 'rejected');

  -- An administrator whose account is suspended: the state gate.
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('2f000000-0000-4000-8000-0000000000e3', 'fi-suspended@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('2f000000-0000-4000-8000-0000000000e3', 'fi-suspended@test.invalid', 'FI Suspended', 'admin',
          (SELECT id FROM roles WHERE name = 'admin' AND company_id IS NULL LIMIT 1), co_a, 'suspended');

  -- Cars: ours, and another company's plate.
  INSERT INTO cars (id, company_id, kennzeichen, created_by)
  VALUES ('2f000000-0000-4000-8000-0000000000c1', co_a, 'M-AB 123', admin_a),
         ('2f000000-0000-4000-8000-0000000000c2', co_b, 'B-CD 456', 'b0000000-0000-4000-8000-000000000001');

  -- A platform account with a session, for the context probes (section 6).
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('2f000000-0000-4000-8000-0000000000e1', 'fi-staff@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('2f000000-0000-4000-8000-0000000000e1', 'fi-staff@test.invalid', 'FI Staff', 'viewer',
          (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL LIMIT 1), NULL, 'active');
  INSERT INTO app_private.platform_staff (user_id, role, note)
  VALUES ('2f000000-0000-4000-8000-0000000000e1', 'owner', 'fi');
  INSERT INTO auth.sessions (id, user_id)
  VALUES ('2f000000-0000-4000-8000-0000000000e2', '2f000000-0000-4000-8000-0000000000e1');
END $$;

-- ─── 1. who may call it, refused before anything is created ─────────────────

DO $$
DECLARE
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  editor_a constant uuid := 'a0000000-0000-4000-8000-000000000002';
  susp_a   constant uuid := '2f000000-0000-4000-8000-0000000000e3';
  nocomp   constant uuid := '50000000-0000-4000-8000-000000000001';
  v_drivers integer := (SELECT count(*) FROM drivers);
BEGIN
  PERFORM _fi_rec(1, 'a viewer is refused by the administrator gate',
    _fi_call(viewer_a, _fi_drivers()), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(2, 'so is an editor: bulk-creating drivers is an administrator''s act',
    _fi_call(editor_a, _fi_drivers()), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(3, 'a suspended account refuses before the role is asked (company state)',
    _fi_call(susp_a, _fi_drivers()), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(4, 'anon cannot execute it',
    _fi_call(NULL, _fi_drivers()), 'ERR 42501 (no hint)');
  PERFORM _fi_rec(5, 'a platform account with no context has no company: refused',
    _fi_call(nocomp, _fi_drivers()), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(6, 'the vehicle import refuses a viewer the same way',
    _fi_call(viewer_a, _fi_vehicles()), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(7, 'and an editor',
    _fi_call(editor_a, _fi_vehicles()), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(8, 'and anon',
    _fi_call(NULL, _fi_vehicles()), 'ERR 42501 (no hint)');
  PERFORM _fi_rec(9, 'none of that created a driver',
    (SELECT count(*)::text FROM drivers), v_drivers::text);
  PERFORM _fi_rec(10, 'the grants: authenticated yes, anon no, PUBLIC no',
    (has_function_privilege('authenticated', 'public.partner_drivers_import(text)', 'EXECUTE')::text || '/' ||
     has_function_privilege('anon', 'public.partner_drivers_import(text)', 'EXECUTE')::text || '/' ||
     EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.partner_drivers_import(text)'::regprocedure AND a.grantee = 0)::text),
    'true/false/false');
  PERFORM _fi_rec(11, 'the vehicle apply is the service role''s alone',
    (has_function_privilege('service_role', 'public.partner_vehicle_roster_apply(uuid,text,jsonb)', 'EXECUTE')::text || '/' ||
     has_function_privilege('authenticated', 'public.partner_vehicle_roster_apply(uuid,text,jsonb)', 'EXECUTE')::text || '/' ||
     has_function_privilege('anon', 'public.partner_vehicle_roster_apply(uuid,text,jsonb)', 'EXECUTE')::text),
    'true/false/false');
END $$;

-- ─── 2. drivers: link the known, create the rest ────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_b_before integer := (SELECT count(*) FROM drivers WHERE company_id = co_b);
BEGIN
  -- 1001 links (Anna), 1002 Bernd, 1003 Carla, 1004 the fallback name and 1006
  -- Dora (departed) are created; 1005 and 1007 have no usable name and 1008 is
  -- Bernd again. 1009 was rejected by a person and is not looked at.
  PERFORM _fi_rec(12, 'one linked, four created, three reported - and the existing name is not created again',
    _fi_call(admin_a, _fi_drivers()) || ' / ' ||
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'anna  existing'),
    '4/1/3 / 1');

  PERFORM _fi_rec(13, 'the existing driver''s name is byte-identical: the partner never writes it',
    (SELECT name FROM drivers WHERE id = '2f000000-0000-4000-8000-0000000000d1'), 'Anna  Existing');
  PERFORM _fi_rec(14, '...and her link names her',
    (SELECT status || ' ' || (driver_id = '2f000000-0000-4000-8000-0000000000d1')::text
       FROM partner_driver_links WHERE id = '2f000000-0000-4000-8000-000000001001'),
    'linked true');

  PERFORM _fi_rec(15, 'a created driver: the partner''s name trimmed, a clean e-mail, the phone as E.164',
    (SELECT name || ' | ' || email || ' | ' || phone FROM drivers WHERE company_id = co_a AND name = 'Bernd Neu'),
    'Bernd Neu | bernd@example.com | +491761234567');
  PERFORM _fi_rec(16, 'an e-mail the CHECK would refuse and a phone nobody can dial become NULL, the row stands',
    (SELECT coalesce(email, 'null') || ' | ' || coalesce(phone, 'null') FROM drivers WHERE company_id = co_a AND name = 'Carla Neu'),
    'null | null');
  PERFORM _fi_rec(17, 'a driver the partner reports as departed is created inactive, not dropped',
    (SELECT status FROM drivers WHERE company_id = co_a AND name = 'Dora Weg'), 'inactive');
  PERFORM _fi_rec(18, 'nothing about pay or employment arrives: the created drivers carry the columns'' own defaults',
    (SELECT string_agg(DISTINCT employment_type || ' ' || salary_ratio::text || ' ' || coalesce(personalnummer, 'null'), ',')
       FROM drivers WHERE company_id = co_a AND name IN ('Bernd Neu', 'Carla Neu', 'Dora Weg', 'Unbekannter Fahrer')),
    'employee 0.5000 null');

  PERFORM _fi_rec(19, 'a link a person rejected creates nothing',
    (SELECT count(*)::text FROM drivers WHERE name = 'Rita Rejected'), '0');
  PERFORM _fi_rec(20, 'another company''s pending link and driver are untouched',
    (SELECT status FROM partner_driver_links WHERE id = '2f000000-0000-4000-8000-000000002001') || ' ' ||
    (SELECT count(*)::text FROM drivers WHERE company_id = co_b)::text || ' ' ||
    (SELECT count(*)::text FROM drivers WHERE name = 'Zed Other')::text,
    'pending ' || v_b_before || ' 0');
END $$;

-- ─── 3. the fallback name, a taken name, and a second run ───────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _fi_rec(21, 'the first "Unbekannter Fahrer" was created, and only one',
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND name = 'Unbekannter Fahrer'), '1');
  -- 1005 and 1007: no usable name. 1008: Bernd again, whose name is taken by 1002.
  PERFORM _fi_rec(22, 'the rest are reported with their own reasons, not created',
    _fi_call(admin_a, _fi_driver_reasons()), 'name_missing,name_missing,name_taken');
  PERFORM _fi_rec(23, 'a second run creates nothing new',
    _fi_call(admin_a, _fi_drivers()), '0/0/3');
END $$;

-- ─── 4. the driver limit: what fits is created, the limit is not raised ────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_active integer;
  v_limit integer;
BEGIN
  SELECT count(*) INTO v_active FROM drivers WHERE company_id = co_a AND status IS DISTINCT FROM 'inactive';
  -- The limit is twice the car limit, so make room for exactly one more.
  IF v_active % 2 = 0 THEN
    INSERT INTO drivers (company_id, name) VALUES (co_a, 'Filler Driver');
    v_active := v_active + 1;
  END IF;
  v_limit := v_active + 1;
  UPDATE companies SET subscription_car_limit = v_limit / 2 WHERE id = co_a;

  INSERT INTO partner_driver_links (id, company_id, partner, external_driver_id, proposed_name, partner_removed_at)
  VALUES ('2f000000-0000-4000-8000-000000003001', co_a, 'reidey', '3001', 'Lena Limit', NULL),
         ('2f000000-0000-4000-8000-000000003002', co_a, 'reidey', '3002', 'Lars Limit', NULL),
         ('2f000000-0000-4000-8000-000000003003', co_a, 'reidey', '3003', 'Gone Limit', now());

  PERFORM _fi_rec(24, 'one slot left: the first fits, the second is reported as limit_reached, the departed one is inactive and fits',
    _fi_call(admin_a, $q$SELECT (x->>'created') || '/' ||
        (SELECT count(*) FROM jsonb_array_elements(x->'skipped') e WHERE e->>'reason' = 'limit_reached')
        FROM (SELECT partner_drivers_import() AS x) s$q$),
    '2/1');
  PERFORM _fi_rec(25, 'the company''s limit was not raised',
    (SELECT subscription_car_limit::text FROM companies WHERE id = co_a), (v_limit / 2)::text);
  PERFORM _fi_rec(26, 'and the one that did not fit was not created',
    (SELECT count(*)::text FROM drivers WHERE name = 'Lars Limit'), '0');
END $$;

-- ─── 5. vehicles ────────────────────────────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_page jsonb := jsonb_build_array(
    jsonb_build_object('id', 4001, 'license_plate', 'm ab123'),
    jsonb_build_object('id', 4002, 'license_plate', 'k-xy  789'),
    jsonb_build_object('id', 4003, 'license_plate', NULL),
    jsonb_build_object('id', 4004, 'license_plate', 'b-cd 456'),
    jsonb_build_object('id', 4005, 'license_plate', 'M-AB-123'),
    jsonb_build_object('license_plate', 'X-NO 1'));
  v_out text;
  v_limit_before integer;
BEGIN
  PERFORM _fi_rec(27, 'the apply stores five proposals, skips the one with no id, and is idempotent',
    (partner_vehicle_roster_apply(co_a, 'reidey', v_page)::text) || ' / ' ||
    (partner_vehicle_roster_apply(co_a, 'reidey', v_page)::text),
    '{"ok": true, "new": 5, "seen": 5} / {"ok": true, "new": 0, "seen": 5}');
  -- Ids carry the order the import walks.
  UPDATE partner_vehicle_links SET id = ('2f000000-0000-4000-8000-00000000' || lpad(external_vehicle_id, 4, '0'))::uuid
   WHERE company_id = co_a;
  PERFORM _fi_rec(28, 'a client cannot call the apply',
    _fi_call(admin_a, format($q$SELECT partner_vehicle_roster_apply(%L, 'reidey', '[]'::jsonb)::text$q$, co_a)),
    'ERR 42501 (no hint)');

  UPDATE companies SET subscription_car_limit = 1000 WHERE id = co_a;
  v_out := _fi_call(admin_a, $q$SELECT partner_vehicles_import()::text$q$);

  PERFORM _fi_rec(29, 'a plate we already have is linked, one is created, three are reported',
    (v_out::jsonb ->> 'created') || '/' || (v_out::jsonb ->> 'linked') || '/' || (v_out::jsonb ->> 'skipped_count'),
    '1/1/3');
  PERFORM _fi_rec(30, 'the existing car is the one linked, and its plate is untouched',
    (SELECT l.status || ' ' || c.kennzeichen FROM partner_vehicle_links l JOIN cars c ON c.id = l.car_id
      WHERE l.external_vehicle_id = '4001'),
    'linked M-AB 123');
  PERFORM _fi_rec(31, 'the created car is stored upper-case with the spacing collapsed',
    (SELECT kennzeichen FROM cars WHERE company_id = co_a AND id <> '2f000000-0000-4000-8000-0000000000c1'),
    'K-XY 789');
  PERFORM _fi_rec(32, 'no plate, a plate held by another company and a second spelling of a linked plate are each reported',
    (SELECT string_agg(e->>'reason', ',' ORDER BY e->>'link_id') FROM jsonb_array_elements(v_out::jsonb -> 'skipped') e),
    'plate_missing,plate_unavailable,plate_duplicate');
  PERFORM _fi_rec(33, 'the answer never names the other company, and its car is untouched',
    (v_out LIKE '%' || co_b::text || '%')::text || ' ' ||
    (SELECT count(*)::text FROM cars WHERE company_id = co_b AND kennzeichen = 'B-CD 456'),
    'false 1');
  PERFORM _fi_rec(34, 'no car was created for the plate that is not ours',
    (SELECT count(*)::text FROM cars WHERE company_id = co_a), '2');

  -- The limit: the company is exactly full, a new plate does not fit.
  INSERT INTO partner_vehicle_links (id, company_id, partner, external_vehicle_id, proposed_plate)
  VALUES ('2f000000-0000-4000-8000-000000004006', co_a, 'reidey', '4006', 'Z-LI 1');
  UPDATE companies SET subscription_car_limit = (SELECT count(*) FROM cars WHERE company_id = co_a) WHERE id = co_a;
  SELECT subscription_car_limit INTO v_limit_before FROM companies WHERE id = co_a;
  v_out := _fi_call(admin_a, $q$SELECT partner_vehicles_import()::text$q$);
  -- Two, not one: the limit trigger is a BEFORE trigger, so it speaks before
  -- the unique index does. A plate held by another company reads as
  -- limit_reached once the company is full, which is true and not a leak.
  PERFORM _fi_rec(35, 'at the car limit every plate that would be created is reported as limit_reached, none is created',
    (v_out::jsonb ->> 'created') || ' ' ||
    (SELECT count(*)::text FROM jsonb_array_elements(v_out::jsonb -> 'skipped') e WHERE e->>'reason' = 'limit_reached'),
    '0 2');
  PERFORM _fi_rec(36, 'the limit was not raised',
    (SELECT subscription_car_limit::text FROM companies WHERE id = co_a), v_limit_before::text);
END $$;

-- ─── 6. platform sessions, and the table ────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  staff   constant uuid := '2f000000-0000-4000-8000-0000000000e1';
  staff_s constant uuid := '2f000000-0000-4000-8000-0000000000e2';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_drivers integer := (SELECT count(*) FROM drivers);
  v_cars    integer := (SELECT count(*) FROM cars);
BEGIN
  PERFORM _fi_call(staff, format($q$SELECT platform_context_open(%L, 'support', 'fleet import probe, long enough')::text$q$, co_a), staff_s);
  PERFORM _fi_rec(37, 'inside a SUPPORT session the company is the opened one, so only the membership comparison refuses',
    _fi_call(staff, 'SELECT get_active_company_id()::text', staff_s), co_a::text);
  PERFORM _fi_rec(38, 'a platform account in a support session creates no drivers',
    _fi_call(staff, _fi_drivers(), staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _fi_rec(39, '...and no cars',
    _fi_call(staff, _fi_vehicles(), staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _fi_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
  PERFORM _fi_call(staff, format($q$SELECT platform_context_open(%L, 'view')::text$q$, co_a), staff_s);
  PERFORM _fi_rec(40, 'and a VIEW session is refused the same way',
    _fi_call(staff, _fi_drivers(), staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _fi_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);

  PERFORM _fi_rec(41, 'partner_vehicle_links has no client write: an administrator''s INSERT is refused',
    _fi_call(admin_a, format($q$INSERT INTO partner_vehicle_links (company_id, partner, external_vehicle_id)
                                VALUES (%L, 'reidey', 'client')$q$, co_a)),
    'ERR 42501 (no hint)');
  PERFORM _fi_rec(42, 'and its rows are readable by the owning company only',
    _fi_call(admin_a, $q$SELECT count(*)::text FROM partner_vehicle_links WHERE company_id <> get_active_company_id()$q$), '0');
  PERFORM _fi_rec(43, 'the platform sessions created nothing',
    (SELECT count(*)::text FROM drivers) || '/' || (SELECT count(*)::text FROM cars),
    v_drivers || '/' || v_cars);
  PERFORM _fi_rec(44, 'both context triggers are on the new table',
    (SELECT count(*)::text FROM pg_trigger g
      WHERE g.tgrelid = 'public.partner_vehicle_links'::regclass AND NOT g.tgisinternal
        AND g.tgname IN ('refuse_read_only_context_write', 'record_support_write')),
    '2');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _fi_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner fleet import: % of % probe(s) did not match - read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '-- partner fleet import: all % probes matched --', v_all;
END $$;

ROLLBACK;
