-- ════════════════════════════════════════════════════════════════════════════
--  Earnings import: an earner with no link gets a named home
-- ════════════════════════════════════════════════════════════════════════════
--
--  The earnings backfill refused for good when an earner in Uber's history was
--  not in the partner's CURRENT roster: the roster import never fetches a
--  departed driver, so no link could ever be made and the instruction "link
--  them and click again" could not be followed.
--
--  Owner decision of 16.10.2026: the company that connected the fleet owns it,
--  and the earnings must be pulled. The standing rule (an unlinked driver stops
--  the import and is named) was written so money never lands on nobody; this
--  honours that reason by giving the money a named record instead of refusing:
--
--    1. an earner whose normalised name (lower(btrim)) matches a driver of the
--       company that holds no partner link yet is LINKED to that driver and
--       never created again;
--    2. otherwise a driver is created from the partner's name, INACTIVE: they
--       are not in the current roster, and an active driver would appear in
--       planning and salary screens as if they still drove;
--    3. the answer names every driver created and every driver linked, so the
--       operator sees what the import invented.
--
--  What it deliberately does not resolve, and reports with a reason: a name
--  that is empty or the partner's fallback name, a name already held by a
--  driver that is linked to ANOTHER partner driver (two rows of one name would
--  merge their money in every join on drivers.name), and a link a person
--  rejected. Those stop the import and are named, as before.
--
--  It writes the driver and the link and nothing else. The money rows are
--  written by income_import_uber, which takes the driver's name from the linked
--  drivers row, so the name the money carries is the stored name by
--  construction.
--
--  Administrator only and refused in a platform session, as the fleet import
--  is: bulk-creating a customer's drivers is not an agent's act.

CREATE OR REPLACE FUNCTION public.partner_earners_resolve(
  p_partner text,
  p_earners jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid := public.get_active_company_id();
  v_caller  uuid := auth.uid();
  v_member  uuid;
  v_partner text := lower(btrim(coalesce(p_partner, '')));
  v_earner  record;
  v_link    public.partner_driver_links;
  v_key     text;
  v_name    text;
  v_driver  uuid;
  v_dname   text;
  v_reason  text;
  v_link_id uuid;
  v_already integer := 0;
  v_created jsonb := '[]'::jsonb;
  v_linked  jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL THEN
    RAISE EXCEPTION 'Keine Berechtigung.' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  -- A company and no membership is an open platform context.
  SELECT up.company_id INTO v_member FROM public.user_profiles up WHERE up.user_id = v_caller;
  IF v_member IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'a platform session imports nothing'
      USING ERRCODE = '42501', HINT = 'platform_session_not_allowed';
  END IF;

  IF NOT public.is_company_admin() THEN
    RAISE EXCEPTION 'Keine Berechtigung.' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF v_partner = '' OR p_earners IS NULL OR jsonb_typeof(p_earners) <> 'array'
     OR jsonb_array_length(p_earners) > 200 THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_earners) e
     WHERE NOT (jsonb_typeof(e) = 'object'
                AND e->>'external_driver_id' ~ '^[0-9]{1,18}$'
                AND jsonb_typeof(e->'name') = 'string')
  ) THEN
    RAISE EXCEPTION 'an earner is malformed' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- The same lock as the fleet import: a double click is one resolve.
  PERFORM pg_advisory_xact_lock(hashtextextended('partner_fleet_import:' || v_company::text, 0));

  FOR v_earner IN
    SELECT DISTINCT ON (e->>'external_driver_id')
           e->>'external_driver_id' AS external_id, e->>'name' AS name
      FROM jsonb_array_elements(p_earners) e
     ORDER BY e->>'external_driver_id'
  LOOP
    v_name := btrim(v_earner.name);
    v_key := lower(v_name);
    v_driver := NULL;
    v_reason := NULL;

    SELECT * INTO v_link FROM public.partner_driver_links l
     WHERE l.company_id = v_company AND l.partner = v_partner
       AND l.external_driver_id = v_earner.external_id;

    IF FOUND AND v_link.status = 'linked' THEN
      v_already := v_already + 1;
      CONTINUE;
    END IF;

    IF FOUND AND v_link.status = 'rejected' THEN
      v_reason := 'rejected';
    ELSIF v_key = '' OR v_key = 'unbekannter fahrer' THEN
      v_reason := 'name_missing';
    ELSE
      SELECT d.id, d.name INTO v_driver, v_dname FROM public.drivers d
       WHERE d.company_id = v_company AND lower(btrim(d.name)) = v_key
         AND NOT EXISTS (SELECT 1 FROM public.partner_driver_links x
                          WHERE x.company_id = v_company AND x.partner = v_partner
                            AND x.driver_id = d.id)
       ORDER BY d.created_at, d.id LIMIT 1;

      IF v_driver IS NOT NULL THEN
        v_linked := v_linked || jsonb_build_object(
          'external_driver_id', v_earner.external_id, 'name', v_dname);
      ELSIF EXISTS (SELECT 1 FROM public.drivers d
                     WHERE d.company_id = v_company AND lower(btrim(d.name)) = v_key) THEN
        v_reason := 'name_taken';
      ELSE
        BEGIN
          INSERT INTO public.drivers (name, company_id, status)
          VALUES (v_name, v_company, 'inactive')
          RETURNING id, name INTO v_driver, v_dname;
          v_created := v_created || jsonb_build_object(
            'external_driver_id', v_earner.external_id, 'name', v_dname);
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          IF SQLERRM LIKE 'Fahrerlimit%' THEN
            v_reason := 'limit_reached';
            v_driver := NULL;
          ELSE
            RAISE;
          END IF;
        END;
      END IF;
    END IF;

    IF v_reason IS NULL THEN
      INSERT INTO public.partner_driver_links AS l
             (company_id, partner, external_driver_id, driver_id, proposed_name,
              status, linked_by, linked_at)
      VALUES (v_company, v_partner, v_earner.external_id, v_driver, v_name,
              'linked', v_caller, now())
      ON CONFLICT (company_id, partner, external_driver_id) DO UPDATE
         SET status = 'linked', driver_id = excluded.driver_id,
             linked_by = excluded.linked_by, linked_at = excluded.linked_at,
             updated_at = now()
       WHERE l.status = 'pending'
      RETURNING l.id INTO v_link_id;
      PERFORM public.partner_submission_claim_driver(v_link_id);
    ELSE
      v_skipped := v_skipped || jsonb_build_object(
        'external_driver_id', v_earner.external_id, 'name', v_name, 'reason', v_reason);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked,
                            'already', v_already, 'skipped', v_skipped);
END;
$$;

COMMENT ON FUNCTION public.partner_earners_resolve(text, jsonb) IS
  'Gives each earner of an earnings import that has no confirmed link a named '
  'home: links a driver of the company with the same normalised name that holds '
  'no link, otherwise creates an INACTIVE driver from the partner''s name, and '
  'links it. Reports every driver created or linked, and every earner it could '
  'not resolve with a reason. Administrator only; refuses a platform session.';

REVOKE ALL ON FUNCTION public.partner_earners_resolve(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_earners_resolve(text, jsonb) TO authenticated;

-- ─── self-check: a release that loses any of this fails ────────────────────
--  Asserts the engine's shape. It reads no stored data.

DO $check$
DECLARE
  v_fn  oid := 'public.partner_earners_resolve(text,jsonb)'::regprocedure;
  v_src text;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn)
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn
                     AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'earners resolve self-check 1: lost SECURITY DEFINER or its pinned search_path';
  END IF;

  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'earners resolve self-check 2: the grants are wrong';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
  IF v_src NOT LIKE '%get_active_company_id()%' OR v_src NOT LIKE '%is_company_admin()%'
     OR v_src NOT LIKE '%platform_session_not_allowed%' THEN
    RAISE EXCEPTION 'earners resolve self-check 3: lost its company, administrator or platform gate';
  END IF;

  -- It creates inactive drivers only, never rewrites an existing one, and never
  -- touches the money: income is written by income_import_uber alone.
  IF v_src !~ 'VALUES \(v_name, v_company, ''inactive''\)'
     OR v_src ~* 'UPDATE\s+(public\.)?drivers' OR v_src ~* 'DELETE\s+FROM'
     OR v_src ~* '(public\.)?income' OR v_src ~* 'cash_movements' THEN
    RAISE EXCEPTION 'earners resolve self-check 4: it creates an active driver, rewrites one or touches money';
  END IF;

  -- A name already held is matched, never duplicated; a held name is reported.
  IF v_src NOT LIKE '%lower(btrim(d.name)) = v_key%' OR v_src NOT LIKE '%name_taken%' THEN
    RAISE EXCEPTION 'earners resolve self-check 5: the name match or its refusal is gone';
  END IF;

  RAISE NOTICE 'partner earners resolve: self-checks passed';
END
$check$;
