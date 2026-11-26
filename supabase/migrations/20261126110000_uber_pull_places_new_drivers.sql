-- ════════════════════════════════════════════════════════════════════════════
--  The daily Uber pull places a few new drivers itself
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner decision of 26.11.2026. The scheduled pull stopped the WHOLE day
--  (outcome blocked_unlinked) when one earner with money had no confirmed
--  link, and the daily job never refreshes the roster, so a newly hired driver
--  cost the company a day until an administrator pressed the full import.
--
--  What changes: before it gives up on a day, the job hands the earners with no
--  link to uber_pull_place_unlinked. They are linked to a company driver of the
--  same normalised name that holds no link, or created ACTIVE (they earned money
--  yesterday, so they drive now), and the day is then written as usual.
--
--  What does not change, and why:
--
--    * The resolution rules are partner_earners_resolve's, moved unchanged into
--      app_private.partner_place_earners, so there is one definition: a
--      normalised-name match to a driver with no link; an existing driver is
--      never renamed (drivers.name is joined by text in income, receipts and
--      the Abrechnung); an empty or fallback name, a rejected link and a name
--      held by a driver linked to ANOTHER partner driver are refused, with a
--      reason. The human function calls it with 'inactive' (people in old
--      earnings who are long gone), the nightly one with 'active'.
--    * One rule differs, and only for 'active': the name match finds a driver
--      who is still working. A same-named driver who has left, with no link,
--      is refused (`name_inactive`), never linked: with nobody watching, a
--      new hire who shares a former driver's name would otherwise put his
--      money on the old record. The 'inactive' call matches as before.
--    * More than five earners in one call are refused (`too_many`). Twenty-two
--      unlinked at once means the connection was reset or the fleet was never
--      imported, and that is the full import's job, not something to do
--      silently overnight.
--    * A new driver gets the partner's name and status active, and nothing
--      else: the staff number comes from the drivers trigger of
--      20261126100000 and the language from the column default (German).
--      Nothing about pay or employment crosses from the partner.
--    * The service role has no auth.uid(), so linked_by and created_by stay
--      NULL, and the context triggers on drivers return early without a
--      subject: a platform session is not involved.
--
--  The pending receipt and note submissions that waited for a link are claimed
--  for the driver. partner_submission_claim_driver asks the SESSION's company
--  and role and so cannot run in the job; the two UPDATEs it makes are written
--  out in the helper for the caller with no session, bounded the same way.
--
--  Every refusal is a return value. A broken argument contract raises 22023.

-- ─── 1. what was placed, on the run ─────────────────────────────────────────

ALTER TABLE public.uber_pull_runs
  ADD COLUMN IF NOT EXISTS placed_drivers jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.uber_pull_runs
  DROP CONSTRAINT IF EXISTS uber_pull_runs_placed_drivers_check;
ALTER TABLE public.uber_pull_runs
  ADD CONSTRAINT uber_pull_runs_placed_drivers_check
  CHECK (jsonb_typeof(placed_drivers) = 'array' AND jsonb_array_length(placed_drivers) <= 50);

COMMENT ON COLUMN public.uber_pull_runs.placed_drivers IS
  'The drivers the pull created or linked before writing the day: [{"name": text, "action": "created" | "linked"}], at most 50. Names are the company''s own drivers'' names. 20261126110000.';

-- ─── 2. the resolution loop, once ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.partner_place_earners(
  p_company    uuid,
  p_partner    text,
  p_earners    jsonb,
  p_new_status text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller  uuid := auth.uid();
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
  IF p_company IS NULL OR p_new_status IS NULL OR p_new_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
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
  PERFORM pg_advisory_xact_lock(hashtextextended('partner_fleet_import:' || p_company::text, 0));

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
     WHERE l.company_id = p_company AND l.partner = v_partner
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
       WHERE d.company_id = p_company AND lower(btrim(d.name)) = v_key
         AND NOT EXISTS (SELECT 1 FROM public.partner_driver_links x
                          WHERE x.company_id = p_company AND x.partner = v_partner
                            AND x.driver_id = d.id)
         -- With nobody watching (the nightly call, status active), a name may
         -- only find a driver who is still working: a departed one of the same
         -- name is more likely someone else, and the money would follow him.
         AND (p_new_status = 'inactive' OR coalesce(d.status, 'active') = 'active')
       ORDER BY d.created_at, d.id LIMIT 1;

      IF v_driver IS NOT NULL THEN
        v_linked := v_linked || jsonb_build_object(
          'external_driver_id', v_earner.external_id, 'name', v_dname);
      ELSIF p_new_status = 'active' AND EXISTS (
              SELECT 1 FROM public.drivers d
               WHERE d.company_id = p_company AND lower(btrim(d.name)) = v_key
                 AND coalesce(d.status, 'active') <> 'active'
                 AND NOT EXISTS (SELECT 1 FROM public.partner_driver_links x
                                  WHERE x.company_id = p_company AND x.partner = v_partner
                                    AND x.driver_id = d.id)) THEN
        v_reason := 'name_inactive';
      ELSIF EXISTS (SELECT 1 FROM public.drivers d
                     WHERE d.company_id = p_company AND lower(btrim(d.name)) = v_key) THEN
        v_reason := 'name_taken';
      ELSE
        BEGIN
          INSERT INTO public.drivers (name, company_id, status)
          VALUES (v_name, p_company, p_new_status)
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
      VALUES (p_company, v_partner, v_earner.external_id, v_driver, v_name,
              'linked', v_caller, now())
      ON CONFLICT (company_id, partner, external_driver_id) DO UPDATE
         SET status = 'linked', driver_id = excluded.driver_id,
             linked_by = excluded.linked_by, linked_at = excluded.linked_at,
             updated_at = now()
       WHERE l.status = 'pending'
      RETURNING l.id INTO v_link_id;

      IF v_caller IS NOT NULL THEN
        PERFORM public.partner_submission_claim_driver(v_link_id);
      ELSE
        -- The job has no session for that function's company and role gate:
        -- the same two statements, bounded by the same company, partner,
        -- external id, "no driver yet" and "still pending".
        UPDATE public.partner_receipt_submissions
           SET driver_id = v_driver, updated_at = now()
         WHERE company_id = p_company AND partner = v_partner
           AND external_driver_id = v_earner.external_id
           AND driver_id IS NULL AND status = 'pending';
        UPDATE public.partner_note_submissions
           SET driver_id = v_driver, updated_at = now()
         WHERE company_id = p_company AND partner = v_partner
           AND external_driver_id = v_earner.external_id
           AND driver_id IS NULL AND status = 'pending';
      END IF;
    ELSE
      v_skipped := v_skipped || jsonb_build_object(
        'external_driver_id', v_earner.external_id, 'name', v_name, 'reason', v_reason);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked,
                            'already', v_already, 'skipped', v_skipped);
END;
$$;

COMMENT ON FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text) IS
  'Gives each earner with no confirmed link a named home: links a same-named driver of the company that holds no link, otherwise creates a driver in the given status, and links it. Never renames a driver. The caller has done the authorization; this is the one resolution loop of partner_earners_resolve (inactive) and uber_pull_place_unlinked (active). 20261126110000.';

ALTER FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. partner_earners_resolve, restated on the helper ─────────────────────
-- Signature, grants, gates and answer are those of 20261016110000.

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

  RETURN app_private.partner_place_earners(v_company, p_partner, p_earners, 'inactive');
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

-- ─── 4. the job's door ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.uber_pull_place_unlinked(p_run_id uuid, p_earners jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_partner CONSTANT text := 'reidey';
  c_max     CONSTANT integer := 5;
  v_run     public.uber_pull_runs%ROWTYPE;
  v_answer  jsonb;
  v_placed  jsonb;
BEGIN
  IF p_run_id IS NULL OR p_earners IS NULL OR jsonb_typeof(p_earners) <> 'array' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT * INTO v_run FROM public.uber_pull_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.settled_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_not_open');
  END IF;

  -- The writer's own rule for a company that may be written to without a person.
  IF NOT EXISTS (
    SELECT 1 FROM public.companies c
     WHERE c.id = v_run.company_id
       AND c.approval_status = 'approved'
       AND c.status IN ('active', 'trial')
       AND (
             (c.subscription_status = 'active'
              AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
             OR (c.status = 'trial' AND c.trial_end IS NOT NULL AND c.trial_end > now())
           )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'company_blocked');
  END IF;

  IF (SELECT count(DISTINCT e->>'external_driver_id') FROM jsonb_array_elements(p_earners) e) > c_max THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many');
  END IF;

  v_answer := app_private.partner_place_earners(v_run.company_id, c_partner, p_earners, 'active');

  SELECT coalesce(jsonb_agg(x.item), '[]'::jsonb) INTO v_placed FROM (
    SELECT jsonb_build_object('name', c->>'name', 'action', 'created') AS item
      FROM jsonb_array_elements(v_answer->'created') c
    UNION ALL
    SELECT jsonb_build_object('name', l->>'name', 'action', 'linked')
      FROM jsonb_array_elements(v_answer->'linked') l
  ) x;

  UPDATE public.uber_pull_runs
     SET placed_drivers = v_placed
   WHERE id = v_run.id;

  RETURN jsonb_build_object(
    'ok', true,
    'created', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', c->>'name')), '[]'::jsonb)
                  FROM jsonb_array_elements(v_answer->'created') c),
    'linked',  (SELECT coalesce(jsonb_agg(jsonb_build_object('name', l->>'name')), '[]'::jsonb)
                  FROM jsonb_array_elements(v_answer->'linked') l),
    'refused', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', s->>'name', 'reason', s->>'reason')), '[]'::jsonb)
                  FROM jsonb_array_elements(v_answer->'skipped') s));
END;
$$;

COMMENT ON FUNCTION public.uber_pull_place_unlinked(uuid, jsonb) IS
  'The scheduled pull''s placement of earners with no link: at most five per call, only on an open run of a company that may be written to, then partner_place_earners with status active. Records what it created or linked on the run (placed_drivers). A refusal is a returned reason: run_not_open, company_blocked, too_many. service_role only. 20261126110000.';

ALTER FUNCTION public.uber_pull_place_unlinked(uuid, jsonb) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.uber_pull_place_unlinked(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.uber_pull_place_unlinked(uuid, jsonb) TO service_role;

-- ─── 5. self-check ───────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_res   oid := 'public.partner_earners_resolve(text,jsonb)'::regprocedure;
  v_help  oid := 'app_private.partner_place_earners(uuid,text,jsonb,text)'::regprocedure;
  v_door  oid := 'public.uber_pull_place_unlinked(uuid,jsonb)'::regprocedure;
  v_src   text;
  v_hsrc  text;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_res)
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_res
                     AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'place earners self-check 1: partner_earners_resolve lost SECURITY DEFINER or its pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_res, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_res AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_res, 'EXECUTE') THEN
    RAISE EXCEPTION 'place earners self-check 2: partner_earners_resolve grants are wrong';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_res;
  IF v_src NOT LIKE '%get_active_company_id()%' OR v_src NOT LIKE '%is_company_admin()%'
     OR v_src NOT LIKE '%platform_session_not_allowed%'
     OR v_src NOT LIKE '%partner_place_earners(v_company, p_partner, p_earners, ''inactive'')%' THEN
    RAISE EXCEPTION 'place earners self-check 3: partner_earners_resolve lost a gate or no longer calls the helper with inactive';
  END IF;

  -- The helper keeps every rule of the loop it came from.
  SELECT prosrc INTO v_hsrc FROM pg_proc WHERE oid = v_help;
  IF v_hsrc !~ 'VALUES \(v_name, p_company, p_new_status\)'
     OR v_hsrc ~* 'UPDATE\s+(public\.)?drivers' OR v_hsrc ~* 'DELETE\s+FROM'
     OR v_hsrc ~* '(public\.)?income' OR v_hsrc ~* 'cash_movements'
     OR v_hsrc ~* 'personalnummer' THEN
    RAISE EXCEPTION 'place earners self-check 4: the helper rewrites a driver, touches money or names the staff number';
  END IF;
  IF v_hsrc NOT LIKE '%lower(btrim(d.name)) = v_key%' OR v_hsrc NOT LIKE '%name_taken%'
     OR v_hsrc NOT LIKE '%name_missing%' OR v_hsrc NOT LIKE '%rejected%'
     OR v_hsrc NOT LIKE '%limit_reached%'
     OR v_hsrc NOT LIKE '%name_inactive%'
     OR v_hsrc NOT LIKE '%p_new_status = ''inactive'' OR coalesce(d.status, ''active'') = ''active''%' THEN
    RAISE EXCEPTION 'place earners self-check 5: the name match or one of its refusals is gone';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_help)
     OR has_function_privilege('anon', v_help, 'EXECUTE')
     OR has_function_privilege('authenticated', v_help, 'EXECUTE')
     OR has_function_privilege('service_role', v_help, 'EXECUTE') THEN
    RAISE EXCEPTION 'place earners self-check 6: the helper is reachable or lost SECURITY DEFINER';
  END IF;

  -- The door: service_role alone.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_door)
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_door
                     AND p.proconfig @> ARRAY['search_path=pg_catalog, public'])
     OR has_function_privilege('anon', v_door, 'EXECUTE')
     OR has_function_privilege('authenticated', v_door, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_door, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_door AND a.grantee = 0) THEN
    RAISE EXCEPTION 'place earners self-check 7: uber_pull_place_unlinked is not service_role only';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.uber_pull_runs'::regclass
                    AND conname = 'uber_pull_runs_placed_drivers_check') THEN
    RAISE EXCEPTION 'place earners self-check 8: the placed_drivers CHECK is missing';
  END IF;

  RAISE NOTICE 'uber pull places new drivers: self-checks passed';
END
$check$;
