-- ════════════════════════════════════════════════════════════════════════════
--  Earnings import: partner_earners_resolve (20261016110000)
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner decision 16.10.2026: an earner in Uber's history who is not in the
--  partner's current roster must not block the import for good - the money gets
--  a named home. The care is the one the fleet import has: `drivers.name` is
--  text with no foreign key and money joins on it, so
--
--    * an earner whose normalised name exists is LINKED, never created again;
--    * a name already held by a driver linked to ANOTHER partner driver is
--      reported (name_taken), not duplicated;
--    * a created driver is INACTIVE and carries the partner's name trimmed;
--    * the income written afterwards carries exactly the stored driver name.
--
--  Every refusal is read as `ERR <sqlstate> <hint>`. Runs inside BEGIN ...
--  ROLLBACK. Platform contexts are opened LAST. Ids start with `2f`.
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
  -- A probe that read nothing is a mismatch to print, not a constraint error.
  p_actual := coalesce(p_actual, '<null>');
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

/* One resolve call, as a string: created/linked/already/skipped counts. */
CREATE OR REPLACE FUNCTION _fi_resolve(p_earners jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT format($q$SELECT (x->'created')::text || '/' || (x->'linked')::text || '/' || (x->>'already') || '/' || (x->'skipped')::text
                     FROM (SELECT partner_earners_resolve('reidey', %L::jsonb) AS x) s$q$, p_earners::text)
$$;

CREATE OR REPLACE FUNCTION _fi_earner(p_ext text, p_name text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('external_driver_id', p_ext, 'name', p_name) $$;

-- ─── fixtures (as the owner, so RLS does not apply) ─────────────────────────

DO $$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
BEGIN
  UPDATE companies SET subscription_car_limit = 1000 WHERE id = co_a;

  -- Maria exists, active and unlinked: an earner of her name must LINK to her.
  -- Held is linked to ANOTHER partner driver (3010): a second row of that name
  -- would merge two people's money in every join on drivers.name.
  INSERT INTO drivers (id, company_id, name, status) VALUES
    ('2f000000-0000-4000-8000-0000000000d1', co_a, 'Maria  Existing', 'active'),
    ('2f000000-0000-4000-8000-0000000000d2', co_a, 'Held Name', 'active'),
    ('2f000000-0000-4000-8000-0000000000d3', co_b, 'Tatiana Capota', 'inactive');

  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, driver_id, proposed_name, status)
  VALUES (co_a, 'reidey', '3010', '2f000000-0000-4000-8000-0000000000d2', 'Held Name', 'linked');
  INSERT INTO partner_driver_links (company_id, partner, external_driver_id, proposed_name, status)
  VALUES (co_a, 'reidey', '3005', 'Rita Rejected', 'rejected'),
         (co_a, 'reidey', '3006', 'Pia Pending', 'pending');

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('2f000000-0000-4000-8000-0000000000e3', 'er-suspended@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('2f000000-0000-4000-8000-0000000000e3', 'er-suspended@test.invalid', 'ER Suspended', 'admin',
          (SELECT id FROM roles WHERE name = 'admin' AND company_id IS NULL LIMIT 1), co_a, 'suspended');

  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES ('2f000000-0000-4000-8000-0000000000e1', 'er-staff@test.invalid', now());
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES ('2f000000-0000-4000-8000-0000000000e1', 'er-staff@test.invalid', 'ER Staff', 'viewer',
          (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL LIMIT 1), NULL, 'active');
  INSERT INTO app_private.platform_staff (user_id, role, note)
  VALUES ('2f000000-0000-4000-8000-0000000000e1', 'owner', 'er');
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
  v_call    text := _fi_resolve(jsonb_build_array(_fi_earner('3002', 'Tatiana Capota')));
BEGIN
  PERFORM _fi_rec(1, 'a viewer is refused by the administrator gate',
    _fi_call(viewer_a, v_call), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(2, 'so is an editor: creating drivers is an administrator''s act',
    _fi_call(editor_a, v_call), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(3, 'a suspended account is refused by the company state',
    _fi_call(susp_a, v_call), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(4, 'anon cannot execute it',
    _fi_call(NULL, v_call), 'ERR 42501 (no hint)');
  PERFORM _fi_rec(5, 'a platform account with no context has no company: refused',
    _fi_call(nocomp, v_call), 'ERR 42501 not_authorized');
  PERFORM _fi_rec(6, 'none of that created a driver',
    (SELECT count(*)::text FROM drivers), v_drivers::text);
  PERFORM _fi_rec(7, 'the grants: authenticated yes, anon no, PUBLIC no',
    (has_function_privilege('authenticated', 'public.partner_earners_resolve(text,jsonb)', 'EXECUTE')::text || '/' ||
     has_function_privilege('anon', 'public.partner_earners_resolve(text,jsonb)', 'EXECUTE')::text || '/' ||
     EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.partner_earners_resolve(text,jsonb)'::regprocedure AND a.grantee = 0)::text),
    'true/false/false');
END $$;

-- ─── 2. malformed input is a refusal ────────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _fi_rec(8, 'an id that is not digits is refused',
    _fi_call(admin_a, _fi_resolve(jsonb_build_array(_fi_earner('abc', 'X')))), 'ERR 22023 invalid_request');
  PERFORM _fi_rec(9, 'a name that is not a string is refused',
    _fi_call(admin_a, _fi_resolve(jsonb_build_array(jsonb_build_object('external_driver_id', '1', 'name', 5)))),
    'ERR 22023 invalid_request');
  PERFORM _fi_rec(10, 'a payload that is not an array is refused',
    _fi_call(admin_a, _fi_resolve(jsonb_build_object('a', 1))), 'ERR 22023 invalid_request');
END $$;

-- ─── 3. the resolution ──────────────────────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_b_before integer := (SELECT count(*) FROM drivers WHERE company_id = co_b);
BEGIN
  PERFORM _fi_rec(11, 'Maria links to her existing row, Tatiana and Pia are created, six are named in the answer',
    _fi_call(admin_a, _fi_resolve(jsonb_build_array(
      _fi_earner('3001', ' MARIA  existing '),
      _fi_earner('3002', 'Tatiana Capota'),
      _fi_earner('3003', 'Unbekannter Fahrer'),
      _fi_earner('3004', 'held name'),
      _fi_earner('3005', 'Rita Rejected'),
      _fi_earner('3006', 'Pia Pending'),
      _fi_earner('3010', 'Held Name')))),
    '[{"name": "Tatiana Capota", "external_driver_id": "3002"}, {"name": "Pia Pending", "external_driver_id": "3006"}]'
    || '/[{"name": "Maria  Existing", "external_driver_id": "3001"}]/1/'
    || '[{"name": "Unbekannter Fahrer", "reason": "name_missing", "external_driver_id": "3003"}, '
    || '{"name": "held name", "reason": "name_taken", "external_driver_id": "3004"}, '
    || '{"name": "Rita Rejected", "reason": "rejected", "external_driver_id": "3005"}]');

  PERFORM _fi_rec(12, 'Maria was linked, not duplicated, and her stored name is byte-identical',
    (SELECT count(*)::text || ' ' || min(name) FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'maria  existing'),
    '1 Maria  Existing');
  PERFORM _fi_rec(13, '...and her link names her',
    (SELECT status || ' ' || (driver_id = '2f000000-0000-4000-8000-0000000000d1')::text
       FROM partner_driver_links WHERE company_id = co_a AND external_driver_id = '3001'),
    'linked true');
  PERFORM _fi_rec(14, 'a created driver is INACTIVE and has the partner''s name, trimmed',
    (SELECT status || ' | ' || name FROM drivers WHERE company_id = co_a AND lower(name) = 'tatiana capota'),
    'inactive | Tatiana Capota');
  PERFORM _fi_rec(15, 'the other company''s Tatiana was neither matched nor touched, and gained nothing',
    (SELECT count(*)::text FROM drivers WHERE company_id = co_b), v_b_before::text);
  PERFORM _fi_rec(16, 'her link is confirmed and points at the created row',
    (SELECT l.status || ' ' || (l.driver_id = d.id)::text || ' ' || l.linked_by::text
       FROM partner_driver_links l JOIN drivers d ON d.company_id = co_a AND d.name = 'Tatiana Capota'
      WHERE l.company_id = co_a AND l.external_driver_id = '3002'),
    'linked true ' || admin_a::text);
  PERFORM _fi_rec(17, 'a pending proposal was confirmed in place: one link row for 3006, not two',
    (SELECT count(*)::text || ' ' || min(status) FROM partner_driver_links WHERE company_id = co_a AND external_driver_id = '3006'),
    '1 linked');
  PERFORM _fi_rec(18, 'the rejected link is untouched and nobody was created for it',
    (SELECT status || ' ' || coalesce(driver_id::text, 'null') FROM partner_driver_links
      WHERE company_id = co_a AND external_driver_id = '3005')
    || ' ' || (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND name = 'Rita Rejected'),
    'rejected null 0');
  PERFORM _fi_rec(19, 'the name held by a linked driver was not duplicated',
    (SELECT count(*)::text FROM drivers WHERE company_id = co_a AND lower(btrim(name)) = 'held name'), '1');
  PERFORM _fi_rec(20, 'the driver limit was not raised',
    (SELECT subscription_car_limit::text FROM companies WHERE id = co_a), '1000');
END $$;

-- ─── 4. a second call changes nothing ───────────────────────────────────────

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_drivers integer := (SELECT count(*) FROM drivers);
  v_links   integer := (SELECT count(*) FROM partner_driver_links);
BEGIN
  PERFORM _fi_rec(21, 'the same earners again: nothing created, the linked ones are already done',
    _fi_call(admin_a, _fi_resolve(jsonb_build_array(
      _fi_earner('3001', 'Maria Existing'), _fi_earner('3002', 'Tatiana Capota'), _fi_earner('3006', 'Pia Pending')))),
    '[]/[]/3/[]');
  PERFORM _fi_rec(22, 'no driver and no link row was added',
    (SELECT count(*)::text FROM drivers) || '/' || (SELECT count(*)::text FROM partner_driver_links),
    v_drivers || '/' || v_links);
END $$;

-- ─── 5. THE ATTRIBUTION: the money lands on the created, named driver ───────
--
--  income_import_uber takes the driver's name from the linked drivers row. The
--  income's driver_name must be byte-equal to the created driver's stored name,
--  or the money is attributed to nobody in every read that joins on the name.

DO $$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_rows jsonb := jsonb_build_array(
    jsonb_build_object('external_driver_id', '3002', 'type', 'umsatz', 'amount', '120.50', 'date', '2026-06-01',
      'week', 1, 'description', 'Woche 1 - Uber', 'trip_count', 7, 'period_start', '2026-06-01', 'period_end', '2026-06-01'),
    jsonb_build_object('external_driver_id', '3001', 'type', 'trinkgeld', 'amount', '5.00', 'date', '2026-06-01',
      'week', 1, 'description', 'Woche 1 - Uber', 'trip_count', NULL, 'period_start', '2026-06-01', 'period_end', '2026-06-01'));
BEGIN
  PERFORM _fi_rec(23, 'the import writes both rows once their drivers are linked',
    _fi_call(admin_a, format('SELECT (income_import_uber(%L::jsonb)->>''inserted'')', v_rows::text)), '2');
  PERFORM _fi_rec(24, 'the created driver''s income carries exactly the stored driver name',
    (SELECT count(*)::text || ' ' || sum(i.amount)::text
       FROM income i JOIN drivers d ON d.company_id = i.company_id AND d.name = i.driver_name
      WHERE i.company_id = co_a AND i.source = 'uber' AND i.source_driver_key = '3002'
        AND i.driver_name = 'Tatiana Capota'  -- the earner's own spelling, which is what anyone searches for
        AND d.id = (SELECT driver_id FROM partner_driver_links WHERE company_id = co_a AND external_driver_id = '3002')),
    '1 120.50');
  PERFORM _fi_rec(25, 'no income row of this company names a driver that does not exist',
    (SELECT count(*)::text FROM income i
      WHERE i.company_id = co_a AND i.source = 'uber'
        AND NOT EXISTS (SELECT 1 FROM drivers d WHERE d.company_id = i.company_id AND d.name = i.driver_name)),
    '0');
  PERFORM _fi_rec(26, 'the existing driver''s income carries her unchanged name',
    (SELECT driver_name FROM income WHERE company_id = co_a AND source_driver_key = '3001'), 'Maria  Existing');
  PERFORM _fi_rec(27, 'importing the same day again is still refused: the duplicate judges are unchanged',
    _fi_call(admin_a, format('SELECT income_import_uber(%L::jsonb)::text', v_rows::text)),
    'ERR 23505 already_imported');
END $$;

-- ─── 6. platform sessions ───────────────────────────────────────────────────

DO $$
DECLARE
  staff   constant uuid := '2f000000-0000-4000-8000-0000000000e1';
  staff_s constant uuid := '2f000000-0000-4000-8000-0000000000e2';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_drivers integer := (SELECT count(*) FROM drivers);
  v_call text := _fi_resolve(jsonb_build_array(_fi_earner('3099', 'Session Person')));
BEGIN
  PERFORM _fi_call(staff, format($q$SELECT platform_context_open(%L, 'support', 'earner resolve probe, long enough')::text$q$, co_a), staff_s);
  PERFORM _fi_rec(28, 'a platform account in a SUPPORT session creates no drivers',
    _fi_call(staff, v_call, staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _fi_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
  PERFORM _fi_call(staff, format($q$SELECT platform_context_open(%L, 'view')::text$q$, co_a), staff_s);
  PERFORM _fi_rec(29, 'and a VIEW session is refused the same way',
    _fi_call(staff, v_call, staff_s), 'ERR 42501 platform_session_not_allowed');
  PERFORM _fi_call(staff, 'SELECT platform_context_close(NULL)::text', staff_s);
  PERFORM _fi_rec(30, 'the platform sessions created nothing',
    (SELECT count(*)::text FROM drivers), v_drivers::text);
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _fi_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner earners resolve: % of % probe(s) did not match - read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '-- partner earners resolve: all % probes matched --', v_all;
END $$;

ROLLBACK;
