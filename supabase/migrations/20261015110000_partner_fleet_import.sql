-- ════════════════════════════════════════════════════════════════════════════
--  Fleet import: a new company pulls its drivers and plates from the partner
-- ════════════════════════════════════════════════════════════════════════════
--
--  The owner's framing of 14.10.2026: a new company has no data yet, so it is
--  imported from the partner and the administrator edits it afterwards. No
--  queue, no confirmation dialog. What is NOT negotiable is one rule, because
--  `drivers.name` is text with no foreign key and income, receipts and the whole
--  Abrechnung join on it:
--
--    * a partner driver whose normalised name already exists in the company is
--      LINKED to that driver and never created again;
--    * an existing driver's name is never written by an import;
--    * everything else is created.
--
--  Owner decisions of 15.10.2026, which narrow it: import exactly what the
--  product needs and no more. A driver carries name, e-mail and phone (E.164
--  or NULL); a vehicle carries its plate. Nothing about pay, employment type,
--  personnel numbers or planning crosses the boundary, and the import is silent
--  about pay: those columns keep their own defaults.
--
--  Two seed functions (administrator, authenticated), one apply function for
--  vehicle proposals (service role), and one table. A support session is
--  refused, as the Gehaltsquittung RPCs do: bulk-creating a customer's drivers
--  is not an agent's act.
--
--  Limits are honoured, never raised: a refused insert is reported per row.
--  A plate held by another company is reported as "plate unavailable" and the
--  other company is never named.

-- ─── 1. helpers (app_private: reachable only from the definers below) ───────

CREATE OR REPLACE FUNCTION app_private.partner_normalise_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v text := regexp_replace(coalesce(p_phone, ''), '[\s\-\(\)\./]', '', 'g');
BEGIN
  IF v ~ '^00' THEN
    v := '+' || substr(v, 3);
  ELSIF v ~ '^0[1-9]' THEN
    v := '+49' || substr(v, 2);
  END IF;
  IF v ~ '^\+[1-9][0-9]{6,14}$' THEN RETURN v; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.partner_plate_key(p_plate text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9ÄÖÜäöü]', '', 'g'));
$$;

REVOKE ALL ON FUNCTION app_private.partner_normalise_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.partner_plate_key(text) FROM PUBLIC, anon, authenticated;

-- ─── 2. the vehicle links ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.partner_vehicle_links (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  partner             text        NOT NULL CHECK (partner = lower(btrim(partner)) AND partner <> ''),
  external_vehicle_id text        NOT NULL CHECK (btrim(external_vehicle_id) <> ''),
  -- Deleting the car removes its link: the next pull proposes it afresh. SET NULL
  -- would violate the check below and make the car undeletable.
  car_id              uuid        NULL REFERENCES public.cars(id) ON DELETE CASCADE,
  proposed_plate      text        NULL,
  status              text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','linked','rejected')),
  linked_by           uuid        NULL,
  linked_at           timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_vehicle_links_linked_has_car
    CHECK ((status = 'linked') = (car_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_vehicle_links_external_key
  ON public.partner_vehicle_links (company_id, partner, external_vehicle_id);
CREATE UNIQUE INDEX IF NOT EXISTS partner_vehicle_links_car_key
  ON public.partner_vehicle_links (company_id, partner, car_id) WHERE car_id IS NOT NULL;

COMMENT ON TABLE public.partner_vehicle_links IS
  'Which car of ours a partner vehicle is. Written only by SECURITY DEFINER '
  'functions: the roster apply proposes, the import links or creates.';

ALTER TABLE public.partner_vehicle_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_vehicle_links_select ON public.partner_vehicle_links;
CREATE POLICY partner_vehicle_links_select ON public.partner_vehicle_links
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_active_company_id())
         OR (SELECT public.platform_reads_company_data()));

-- No INSERT, UPDATE or DELETE policy: nothing in the product writes a link
-- from a browser.

DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.partner_vehicle_links;
CREATE TRIGGER refuse_read_only_context_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.partner_vehicle_links
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write();

DROP TRIGGER IF EXISTS record_support_write ON public.partner_vehicle_links;
CREATE TRIGGER record_support_write
  AFTER INSERT OR UPDATE OR DELETE ON public.partner_vehicle_links
  FOR EACH ROW
  WHEN (current_setting('app_private.support_write_context', true) <> '')
  EXECUTE FUNCTION app_private.record_support_write();

-- ─── 3. one page of vehicle proposals (service role) ────────────────────────

CREATE OR REPLACE FUNCTION public.partner_vehicle_roster_apply(
  p_company_id uuid,
  p_partner    text,
  p_vehicles   jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_partner  text := lower(btrim(coalesce(p_partner, '')));
  v_seen     int := 0;
  v_new      int := 0;
  v_row      jsonb;
  v_external text;
  v_existed  boolean;
BEGIN
  IF p_company_id IS NULL OR v_partner = '' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF p_vehicles IS NULL OR jsonb_typeof(p_vehicles) <> 'array' THEN
    RAISE EXCEPTION 'the vehicle page is not an array' USING ERRCODE = '22023', HINT = 'invalid_roster';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_vehicles) LOOP
    v_external := btrim(coalesce(v_row ->> 'id', ''));
    CONTINUE WHEN v_external = '';

    SELECT true INTO v_existed FROM public.partner_vehicle_links l
     WHERE l.company_id = p_company_id AND l.partner = v_partner
       AND l.external_vehicle_id = v_external;

    INSERT INTO public.partner_vehicle_links AS l
           (company_id, partner, external_vehicle_id, proposed_plate)
    VALUES (p_company_id, v_partner, v_external,
            nullif(btrim(coalesce(v_row ->> 'license_plate', '')), ''))
    ON CONFLICT (company_id, partner, external_vehicle_id) DO UPDATE
       SET proposed_plate = excluded.proposed_plate,
           updated_at     = now();

    v_seen := v_seen + 1;
    IF NOT coalesce(v_existed, false) THEN v_new := v_new + 1; END IF;
    v_existed := NULL;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'seen', v_seen, 'new', v_new);
END;
$$;

REVOKE ALL ON FUNCTION public.partner_vehicle_roster_apply(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_vehicle_roster_apply(uuid, text, jsonb) TO service_role;

-- ─── 4. drivers: link the known, create the rest ────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_drivers_import(p_partner text DEFAULT 'reidey')
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
  v_link    record;
  v_key     text;
  v_driver  uuid;
  v_email   text;
  v_created int := 0;
  v_linked  int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_reason  text;
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

  IF v_partner = '' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- A double click is the same import twice, not two imports.
  PERFORM pg_advisory_xact_lock(hashtextextended('partner_fleet_import:' || v_company::text, 0));

  FOR v_link IN
    SELECT * FROM public.partner_driver_links l
     WHERE l.company_id = v_company AND l.partner = v_partner AND l.status = 'pending'
     ORDER BY l.created_at, l.id
  LOOP
    v_key := lower(btrim(coalesce(v_link.proposed_name, '')));
    v_driver := NULL;
    v_reason := NULL;

    IF v_key = '' THEN
      v_reason := 'name_missing';
    ELSE
      SELECT d.id INTO v_driver FROM public.drivers d
       WHERE d.company_id = v_company AND lower(btrim(d.name)) = v_key
         AND NOT EXISTS (SELECT 1 FROM public.partner_driver_links x
                          WHERE x.company_id = v_company AND x.partner = v_partner
                            AND x.driver_id = d.id)
       ORDER BY d.created_at, d.id LIMIT 1;

      IF v_driver IS NULL AND EXISTS (
        SELECT 1 FROM public.drivers d
         WHERE d.company_id = v_company AND lower(btrim(d.name)) = v_key
      ) THEN
        -- The name exists and is already taken by another partner driver. The
        -- partner's fallback name lands here for every driver after the first.
        v_reason := CASE WHEN v_key = 'unbekannter fahrer' THEN 'name_missing' ELSE 'name_taken' END;
      END IF;
    END IF;

    IF v_reason IS NULL AND v_driver IS NULL THEN
      v_email := nullif(lower(btrim(coalesce(v_link.proposed_email, ''))), '');
      IF v_email IS NOT NULL AND v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
        v_email := NULL;
      END IF;
      BEGIN
        INSERT INTO public.drivers (name, company_id, status, email, phone)
        VALUES (btrim(v_link.proposed_name), v_company,
                CASE WHEN v_link.partner_removed_at IS NULL THEN 'active' ELSE 'inactive' END,
                v_email, app_private.partner_normalise_phone(v_link.proposed_phone))
        RETURNING id INTO v_driver;
        v_created := v_created + 1;
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM LIKE 'Fahrerlimit%' THEN
          v_reason := 'limit_reached';
          v_driver := NULL;
        ELSE
          RAISE;
        END IF;
      END;
    ELSIF v_reason IS NULL THEN
      v_linked := v_linked + 1;
    END IF;

    IF v_reason IS NULL THEN
      UPDATE public.partner_driver_links
         SET status = 'linked', driver_id = v_driver,
             linked_by = v_caller, linked_at = now(), updated_at = now()
       WHERE id = v_link.id;
      PERFORM public.partner_submission_claim_driver(v_link.id);
    ELSE
      v_skipped := v_skipped || jsonb_build_object(
        'link_id', v_link.id, 'name', v_link.proposed_name, 'reason', v_reason);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked,
                            'skipped_count', jsonb_array_length(v_skipped), 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.partner_drivers_import(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_drivers_import(text) TO authenticated;

-- ─── 5. vehicles: link the known plate, create the rest ─────────────────────

CREATE OR REPLACE FUNCTION public.partner_vehicles_import(p_partner text DEFAULT 'reidey')
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
  v_link    record;
  v_key     text;
  v_plate   text;
  v_car     uuid;
  v_created int := 0;
  v_linked  int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_reason  text;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL THEN
    RAISE EXCEPTION 'Keine Berechtigung.' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  SELECT up.company_id INTO v_member FROM public.user_profiles up WHERE up.user_id = v_caller;
  IF v_member IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'a platform session imports nothing'
      USING ERRCODE = '42501', HINT = 'platform_session_not_allowed';
  END IF;

  IF NOT public.is_company_admin() THEN
    RAISE EXCEPTION 'Keine Berechtigung.' USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF v_partner = '' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('partner_fleet_import:' || v_company::text, 0));

  FOR v_link IN
    SELECT * FROM public.partner_vehicle_links l
     WHERE l.company_id = v_company AND l.partner = v_partner AND l.status = 'pending'
     ORDER BY l.created_at, l.id
  LOOP
    v_key := app_private.partner_plate_key(v_link.proposed_plate);
    v_car := NULL;
    v_reason := NULL;

    IF v_key = '' THEN
      v_reason := 'plate_missing';
    ELSE
      SELECT c.id INTO v_car FROM public.cars c
       WHERE c.company_id = v_company AND app_private.partner_plate_key(c.kennzeichen) = v_key
         AND NOT EXISTS (SELECT 1 FROM public.partner_vehicle_links x
                          WHERE x.company_id = v_company AND x.partner = v_partner
                            AND x.car_id = c.id)
       ORDER BY c.created_at, c.id LIMIT 1;

      IF v_car IS NULL AND EXISTS (
        SELECT 1 FROM public.cars c
         WHERE c.company_id = v_company AND app_private.partner_plate_key(c.kennzeichen) = v_key
      ) THEN
        v_reason := 'plate_duplicate';
      END IF;
    END IF;

    IF v_reason IS NULL AND v_car IS NULL THEN
      v_plate := upper(regexp_replace(btrim(v_link.proposed_plate), '\s+', ' ', 'g'));
      BEGIN
        INSERT INTO public.cars (kennzeichen, created_by, company_id)
        VALUES (v_plate, v_caller, v_company)
        RETURNING id INTO v_car;
        v_created := v_created + 1;
      EXCEPTION
        WHEN unique_violation THEN
          -- The column is unique across all companies. Which company holds it
          -- is not ours to say.
          v_reason := 'plate_unavailable';
          v_car := NULL;
        WHEN SQLSTATE 'P0001' THEN
          IF SQLERRM LIKE 'Fahrzeuglimit%' THEN
            v_reason := 'limit_reached';
            v_car := NULL;
          ELSE
            RAISE;
          END IF;
      END;
    ELSIF v_reason IS NULL THEN
      v_linked := v_linked + 1;
    END IF;

    IF v_reason IS NULL THEN
      UPDATE public.partner_vehicle_links
         SET status = 'linked', car_id = v_car,
             linked_by = v_caller, linked_at = now(), updated_at = now()
       WHERE id = v_link.id;
    ELSE
      v_skipped := v_skipped || jsonb_build_object(
        'link_id', v_link.id, 'plate', v_link.proposed_plate, 'reason', v_reason);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked,
                            'skipped_count', jsonb_array_length(v_skipped), 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.partner_vehicles_import(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_vehicles_import(text) TO authenticated;

-- ─── 6. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
  v_src text;
  r record;
BEGIN
  -- 1. the apply is service role's alone; the seeds are not anon's.
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated']) AS role LOOP
    IF has_function_privilege(r.role, 'public.partner_vehicle_roster_apply(uuid,text,jsonb)', 'EXECUTE') THEN
      RAISE EXCEPTION 'fleet import self-check 1: % may execute the vehicle apply', r.role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.partner_drivers_import(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.partner_vehicles_import(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fleet import self-check 1: anon may execute a seed';
  END IF;

  -- 2. all three are SECURITY DEFINER with a pinned search_path.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_vehicle_roster_apply', 'partner_drivers_import', 'partner_vehicles_import')
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'fleet import self-check 2: % of 3 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 3. both seeds ask the company, the administrator and the membership.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('partner_drivers_import', 'partner_vehicles_import')
     AND p.prosrc LIKE '%get_active_company_id()%'
     AND p.prosrc LIKE '%is_company_admin()%'
     AND p.prosrc LIKE '%platform_session_not_allowed%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'fleet import self-check 3: a seed lost its company, administrator or platform gate';
  END IF;

  -- 4. the driver import never assigns a driver's name, and never names a
  --    column the owner ruled out (pay, employment type, personnel number).
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.partner_drivers_import(text)'::regprocedure;
  IF v_src ~* 'UPDATE\s+(public\.)?drivers' OR v_src ~* '(employment_type|salary_ratio|personalnummer)' THEN
    RAISE EXCEPTION 'fleet import self-check 4: the driver import writes an existing driver or a ruled-out column';
  END IF;

  -- 5. the vehicle import never rewrites a car, never touches a limit, and
  --    never reads an exception detail (which could name another company).
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.partner_vehicles_import(text)'::regprocedure;
  IF v_src ~* 'UPDATE\s+(public\.)?cars' OR v_src ~* 'subscription_car_limit'
     OR v_src ~* 'PG_EXCEPTION_DETAIL' THEN
    RAISE EXCEPTION 'fleet import self-check 5: the vehicle import rewrites a car, a limit or reads an exception detail';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.partner_drivers_import(text)'::regprocedure;
  IF v_src ~* 'subscription_car_limit' THEN
    RAISE EXCEPTION 'fleet import self-check 5: the driver import touches a limit';
  END IF;

  -- 6. the vehicle links: RLS on, no write policy, both context triggers.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.partner_vehicle_links'::regclass) THEN
    RAISE EXCEPTION 'fleet import self-check 6: RLS is off on partner_vehicle_links';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_vehicle_links' AND cmd <> 'SELECT';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'fleet import self-check 6: partner_vehicle_links gained a write policy';
  END IF;
  FOR r IN SELECT unnest(ARRAY['refuse_read_only_context_write', 'record_support_write']) AS t LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = 'public.partner_vehicle_links'::regclass
                      AND g.tgname = r.t AND NOT g.tgisinternal) THEN
      RAISE EXCEPTION 'fleet import self-check 6: partner_vehicle_links is missing trigger %', r.t;
    END IF;
  END LOOP;

  -- 7. the helpers are unreachable from a browser.
  IF has_function_privilege('authenticated', 'app_private.partner_normalise_phone(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'app_private.partner_plate_key(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fleet import self-check 7: a helper is executable by an API role';
  END IF;

  -- 8. the phone normaliser produces E.164 or nothing.
  IF app_private.partner_normalise_phone('0176 1234567') IS DISTINCT FROM '+491761234567'
     OR app_private.partner_normalise_phone('0049 176 1234567') IS DISTINCT FROM '+491761234567'
     OR app_private.partner_normalise_phone('+49 (176) 123-4567') IS DISTINCT FROM '+491761234567'
     OR app_private.partner_normalise_phone('abc') IS NOT NULL
     OR app_private.partner_normalise_phone('123') IS NOT NULL
     OR app_private.partner_normalise_phone(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'fleet import self-check 8: the phone normaliser is wrong';
  END IF;

  RAISE NOTICE 'partner fleet import: self-checks passed';
END
$check$;
