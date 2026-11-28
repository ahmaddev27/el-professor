-- 20261128120000 — a person may take a Reidey driver link apart (owner, 28.11.2026)
--
--  The owner's answer to the third question of PR #394: a person may UNLINK a
--  Reidey driver link, an automatic one included. Until now nothing in the
--  product did; a wrong automatic link (two different people who share an exact
--  name, the one case the certain rule of 20261127120000 cannot see) could only
--  be undone in the database.
--
--  What unlinking is, in four rules:
--
--  1. WHO. The right that confirms or rejects a link today and nothing new:
--     get_active_company_id(), auth.uid(), current_role_permits('drivers', true),
--     exactly the gate of partner_driver_link_confirm / _reject. So a support
--     session may unlink as the company's administrator would (the platform
--     branch of current_role_permits) and a view context is refused, the same
--     two cells those two read in tests/rls/matrix.sql.
--
--  2. WHAT. The row goes back to `pending` with no driver, and the person who
--     did it and the time are stored on the row (unlinked_by, unlinked_at),
--     with decision_reason 'unlinked' so the decision dialog says why it waits.
--     link_method, linked_by and linked_at are cleared with the driver: they
--     describe a link that no longer exists, and every one of them is NULL on a
--     pending row everywhere else in the table. A row a person has unlinked is
--     never linked AUTOMATICALLY again, by any path:
--       - the nightly placement (uber_pull_place_unlinked → partner_place_earners,
--         mode 'active'), which is what the brief names;
--       - the update button (partner_drivers_import) and the human earnings
--         resolve (partner_earners_resolve → partner_place_earners, mode
--         'inactive'), which the brief does not name. Both are automatic links
--         too, and both would otherwise re-make the very link the person just
--         took apart: the import by the certain rule (the driver is active, of
--         that name and now unlinked), the resolve by its looser match. The
--         answer of each names the row as skipped with reason 'unlinked'.
--     A person links it again by hand through the existing flow: the row is
--     pending, so it is in the notice's list and partner_driver_link_confirm
--     takes it (link_method 'manual'). That is the only way back.
--
--  3. WHAT IT NEVER DOES. It deletes, moves and re-dates nothing that the link
--     claimed: Belege, driver notes, income rows and the submissions themselves
--     stay with the driver they were given to. They are that driver's records,
--     and a Beleg already numbered (BEL-…) or an income row already in an
--     Abrechnung is not a thing to move silently. The function names none of
--     those tables; self-check 7 fails a release where it does. A submission
--     claimed but still waiting (a Beleg with no date) keeps its driver too,
--     because the claim of partner_driver_link_apply only takes rows whose
--     driver_id IS NULL. A submission that arrives after the unlink waits with
--     no driver, as it would for any pending link, and is claimed by whoever
--     the link is confirmed to next.
--
--  4. THE WALL. Three CHECKs make rule 2 a property of the table and not of the
--     callers that happen to exist today (the lesson of
--     derive-a-property-into-a-constraint: a rule enforced in one function is
--     lost silently by the next writer):
--       - partner_driver_links_unlinked_pair: unlinked_by and unlinked_at are
--         both set or both NULL;
--       - partner_driver_links_unlinked_stays_manual: a row with unlinked_at may
--         be `linked` only with link_method 'manual' — an automatic link of it
--         is refused by the table whatever function writes it;
--       - partner_driver_links_unlinked_reason_recorded: decision_reason
--         'unlinked' only on a row that carries the record.
--     Every expression is written so it can never be NULL (a CHECK passes on
--     NULL, 20261127200000's lesson); self-check 3 evaluates the stored
--     expressions against the rows they must refuse. The callers skip such a
--     row BEFORE the wall, so the wall is never what a person sees.
--     And app_private.partner_link_guard_unlink_record, a BEFORE INSERT OR
--     UPDATE trigger, refuses a change of unlinked_by or unlinked_at made
--     directly by an API role: partner_driver_links_update lets the drivers
--     page PATCH a row through PostgREST, and a PATCH that cleared unlinked_at
--     would let the next night link it again with no person deciding. The one
--     writer is the SECURITY DEFINER function below, which runs as its owner.
--
--  The stable reasons of the new function: not_authorized (42501),
--  invalid_request (22023), link_not_found (P0002), not_linked (P0001: the row
--  is pending or rejected, so there is nothing to take apart).
--  The guard's: unlink_record_protected (42501).
--
--  Restated, from their LIVE bodies in 20261127120000 (no later migration
--  defines either): public.partner_drivers_import and
--  app_private.partner_place_earners. Each gains one branch, which skips an
--  unlinked row with reason 'unlinked'; nothing else in either body moves, and
--  self-checks 5 and 6 re-assert the fragments 20261127120000's self-check and
--  tests/rls/partner-certain-link.sql read. Gates, locks, grants and answers are
--  unchanged, so a release before this one calls them the same way.
--
--  Not changed, and said so: partner_driver_links_update still lets the drivers
--  page PATCH status and driver_id directly, as it has since 20261005120000
--  (the table was designed to be "resolved by an UPDATE" before the confirm and
--  reject RPCs existed). Closing that is a change to the table's policies and
--  to matrix cells that are not this slice's; what this slice needs from it —
--  that a direct write cannot erase or forge the unlink record — the trigger
--  above closes.

-- ─── 1. the record ──────────────────────────────────────────────────────────

ALTER TABLE public.partner_driver_links
  ADD COLUMN IF NOT EXISTS unlinked_by uuid NULL,
  ADD COLUMN IF NOT EXISTS unlinked_at timestamptz NULL;

COMMENT ON COLUMN public.partner_driver_links.unlinked_by IS
  'The person who last took this link apart (partner_driver_link_unlink). Set together with unlinked_at. A row that carries it is never linked automatically again; only partner_driver_link_confirm (link_method manual) links it. 20261128120000.';
COMMENT ON COLUMN public.partner_driver_links.unlinked_at IS
  'When a person last took this link apart. NULL on every row nobody has unlinked. 20261128120000.';

-- decision_reason gains 'unlinked'; the four of 20261127120000 are carried
-- over character for character.
ALTER TABLE public.partner_driver_links
  DROP CONSTRAINT IF EXISTS partner_driver_links_decision_reason_check;
ALTER TABLE public.partner_driver_links
  ADD CONSTRAINT partner_driver_links_decision_reason_check
  CHECK (decision_reason IS NULL
         OR decision_reason IN ('name_missing', 'name_ambiguous', 'name_inactive', 'name_taken', 'unlinked'));

COMMENT ON COLUMN public.partner_driver_links.decision_reason IS
  'Why a pending link was left for a person: name_missing, name_ambiguous, name_inactive or name_taken (the roster import, 20261127120000), or unlinked (a person took the link apart, 20261128120000). NULL when linked or rejected, and on a link nothing has examined.';

ALTER TABLE public.partner_driver_links
  DROP CONSTRAINT IF EXISTS partner_driver_links_unlinked_pair;
ALTER TABLE public.partner_driver_links
  ADD CONSTRAINT partner_driver_links_unlinked_pair
  CHECK ((unlinked_by IS NULL) = (unlinked_at IS NULL));

ALTER TABLE public.partner_driver_links
  DROP CONSTRAINT IF EXISTS partner_driver_links_unlinked_stays_manual;
ALTER TABLE public.partner_driver_links
  ADD CONSTRAINT partner_driver_links_unlinked_stays_manual
  CHECK (unlinked_at IS NULL OR status <> 'linked' OR link_method IS NOT DISTINCT FROM 'manual');

ALTER TABLE public.partner_driver_links
  DROP CONSTRAINT IF EXISTS partner_driver_links_unlinked_reason_recorded;
ALTER TABLE public.partner_driver_links
  ADD CONSTRAINT partner_driver_links_unlinked_reason_recorded
  CHECK (decision_reason IS DISTINCT FROM 'unlinked' OR unlinked_at IS NOT NULL);

-- ─── 2. the direct-write guard ──────────────────────────────────────────────
-- SECURITY INVOKER on purpose: as a definer, current_user would always be its
-- owner and it would refuse nobody (the rule of
-- app_private.refuse_direct_subscription_write, whose shape this copies). Its
-- body names nothing in app_private and calls no function, because it runs
-- in the caller's name on every write the drivers page makes.

CREATE OR REPLACE FUNCTION app_private.partner_link_guard_unlink_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The roles PostgREST serves a request as. A SECURITY DEFINER function runs
  -- as its owner, which is never one of them.
  c_api_roles CONSTANT text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  IF NOT (current_user::text = ANY (c_api_roles)) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.unlinked_by IS NULL AND NEW.unlinked_at IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.unlinked_by IS NOT DISTINCT FROM OLD.unlinked_by
        AND NEW.unlinked_at IS NOT DISTINCT FROM OLD.unlinked_at THEN
    -- A change, not a mention: a statement carrying the current values passes.
    RETURN NEW;
  END IF;

  -- The record is written by partner_driver_link_unlink and kept by
  -- partner_driver_link_confirm; nothing else may set, change or clear it.
  RAISE EXCEPTION 'partner_driver_links: unlinked_by and unlinked_at may not be written directly'
    USING ERRCODE = '42501', HINT = 'unlink_record_protected';
END;
$$;

COMMENT ON FUNCTION app_private.partner_link_guard_unlink_record() IS
  'BEFORE INSERT OR UPDATE on partner_driver_links: refuses (42501) a change of unlinked_by or unlinked_at made as anon, authenticated or service_role, so the record that a person took a link apart can neither be erased by a PATCH (which would let the nightly placement link it again) nor forged. The one writer is public.partner_driver_link_unlink, a SECURITY DEFINER function that runs as its owner. Must stay SECURITY INVOKER. 20261128120000.';

ALTER FUNCTION app_private.partner_link_guard_unlink_record() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.partner_link_guard_unlink_record() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS partner_link_unlink_record_guard ON public.partner_driver_links;
CREATE TRIGGER partner_link_unlink_record_guard
  BEFORE INSERT OR UPDATE ON public.partner_driver_links
  FOR EACH ROW EXECUTE FUNCTION app_private.partner_link_guard_unlink_record();

-- ─── 3. the unlink ──────────────────────────────────────────────────────────
-- The shape of partner_driver_link_reject: the same gate, the same lock, the
-- same hints for the same refusals, one UPDATE.

CREATE OR REPLACE FUNCTION public.partner_driver_link_unlink(p_link_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid := public.get_active_company_id();
  v_caller  uuid := auth.uid();
  v_link    public.partner_driver_links;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL
     OR NOT public.current_role_permits('drivers', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_link_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT * INTO v_link FROM public.partner_driver_links
   WHERE id = p_link_id AND company_id = v_company
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verknüpfung nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'link_not_found';
  END IF;

  IF v_link.status <> 'linked' THEN
    RAISE EXCEPTION 'Diese Verknüpfung besteht nicht mehr.'
      USING ERRCODE = 'P0001', HINT = 'not_linked';
  END IF;

  -- The link only. What it claimed stays with the driver: see the header, rule 3.
  UPDATE public.partner_driver_links
     SET status = 'pending', driver_id = NULL,
         link_method = NULL, linked_by = NULL, linked_at = NULL,
         decision_reason = 'unlinked',
         unlinked_by = v_caller, unlinked_at = now(),
         updated_at = now()
   WHERE id = v_link.id;

  RETURN jsonb_build_object('ok', true, 'driver_id', v_link.driver_id);
END;
$$;

COMMENT ON FUNCTION public.partner_driver_link_unlink(uuid) IS
  'Takes a partner driver link apart, an automatic one included (owner, 28.11.2026): the row goes back to pending with no driver, decision_reason unlinked, and unlinked_by / unlinked_at record the person and the time. No automatic path links such a row again (the CHECK partner_driver_links_unlinked_stays_manual); a person links it through partner_driver_link_confirm. Never touches the Belege, notes, income rows or submissions the link claimed. The gate of partner_driver_link_confirm / _reject. Reasons: not_authorized, invalid_request, link_not_found, not_linked. 20261128120000.';

ALTER FUNCTION public.partner_driver_link_unlink(uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.partner_driver_link_unlink(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_driver_link_unlink(uuid) TO authenticated;

-- ─── 4. the roster import, restated: an unlinked row is skipped ─────────────
-- 20261127120000's body, copied, with one branch added around the rule: a row
-- a person unlinked is not offered to the rule at all, and is reported as
-- skipped with reason 'unlinked'. Its decision_reason is already 'unlinked',
-- so the existing skip UPDATE (which writes only a reason that differs) leaves
-- it as it is.

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
  v_action  text;
  v_method  text;
  v_driver  uuid;
  v_email   text;
  v_created int := 0;
  v_linked  int := 0;
  v_pending int;
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
    v_driver := NULL;
    v_method := NULL;

    IF v_link.unlinked_at IS NOT NULL THEN
      -- 20261128120000: a person took this link apart. Only a person links it
      -- again (partner_driver_link_confirm); the rule is not asked, because it
      -- would find the same driver it found before.
      v_action := NULL;
      v_reason := 'unlinked';
    ELSE
      SELECT m.o_action, m.o_driver_id, m.o_reason INTO v_action, v_driver, v_reason
        FROM app_private.partner_driver_certain_match(v_company, v_partner, v_link.proposed_name) m;
    END IF;

    IF v_action = 'match' THEN
      v_method := 'automatic_match';
    ELSIF v_action = 'create' THEN
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
        v_method := 'automatic_create';
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM LIKE 'Fahrerlimit%' THEN
          v_reason := 'limit_reached';
          v_driver := NULL;
        ELSE
          RAISE;
        END IF;
      END;
    END IF;

    IF v_reason IS NULL THEN
      PERFORM app_private.partner_driver_link_apply(v_link.id, v_driver, v_caller, v_method);
      IF v_method = 'automatic_create' THEN
        v_created := v_created + 1;
      ELSE
        v_linked := v_linked + 1;
      END IF;
    ELSE
      -- Left for a person, and the screen says why. limit_reached is a plan
      -- limit and not a decision about a name, so it is reported and not stored.
      UPDATE public.partner_driver_links
         SET decision_reason = CASE WHEN v_reason = 'limit_reached' THEN NULL ELSE v_reason END,
             updated_at = now()
       WHERE id = v_link.id
         AND decision_reason IS DISTINCT FROM
             CASE WHEN v_reason = 'limit_reached' THEN NULL ELSE v_reason END;
      v_skipped := v_skipped || jsonb_build_object(
        'link_id', v_link.id, 'name', v_link.proposed_name, 'reason', v_reason);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_pending FROM public.partner_driver_links l
   WHERE l.company_id = v_company AND l.partner = v_partner AND l.status = 'pending';

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked,
                            'pending', v_pending,
                            'skipped_count', jsonb_array_length(v_skipped), 'skipped', v_skipped);
END;
$$;

COMMENT ON FUNCTION public.partner_drivers_import(text) IS
  'The update button of the drivers page. Walks the partner''s pending drivers and, by the one rule of app_private.partner_driver_certain_match, links an exact-name active driver who holds no link, creates the driver when no namesake exists, and leaves every other case pending with its decision_reason. A row a person unlinked (unlinked_at set) is not offered to the rule and is reported as skipped with reason unlinked. Answers created, linked, pending (the company''s pending links for the partner after the run) and the skipped ones with their reason. Administrator only; refuses a platform session. Rewritten 27.11.2026 (20261127120000), the unlinked skip 28.11.2026 (20261128120000).';

ALTER FUNCTION public.partner_drivers_import(text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.partner_drivers_import(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_drivers_import(text) TO authenticated;

-- ─── 5. the placement of earners, restated: an unlinked row is skipped ──────
-- 20261127120000's body, copied, with one branch added after the rejected one.
-- It holds for both modes: the nightly pull (active) and the human earnings
-- resolve (inactive), whose looser match would otherwise find the very driver
-- the person just unlinked, because that driver now holds no link.

CREATE OR REPLACE FUNCTION app_private.partner_place_earners(
  p_company    uuid,
  p_partner    text,
  p_earners    jsonb,
  p_new_status text,
  p_caller     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_partner text := lower(btrim(coalesce(p_partner, '')));
  v_earner  record;
  v_link    public.partner_driver_links;
  v_key     text;
  v_name    text;
  v_driver  uuid;
  v_dname   text;
  v_reason  text;
  v_action  text;
  v_method  text;
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
    v_action := NULL;
    v_method := NULL;

    SELECT * INTO v_link FROM public.partner_driver_links l
     WHERE l.company_id = p_company AND l.partner = v_partner
       AND l.external_driver_id = v_earner.external_id;

    IF FOUND AND v_link.status = 'linked' THEN
      v_already := v_already + 1;
      CONTINUE;
    END IF;

    IF FOUND AND v_link.status = 'rejected' THEN
      v_reason := 'rejected';
    ELSIF FOUND AND v_link.unlinked_at IS NOT NULL THEN
      -- 20261128120000: a person took this link apart. In either mode only a
      -- person links it again (partner_driver_link_confirm).
      v_reason := 'unlinked';
    ELSIF p_new_status = 'active' THEN
      -- With nobody watching (the nightly call) only a certain match is made:
      -- see the header. The rule is not written a second time here.
      SELECT m.o_action, m.o_driver_id, m.o_reason INTO v_action, v_driver, v_reason
        FROM app_private.partner_driver_certain_match(p_company, v_partner, v_name) m;
    ELSIF v_key = '' OR v_key = 'unbekannter fahrer' THEN
      v_reason := 'name_missing';
    ELSE
      -- The human earnings resolve, unchanged: a name finds a driver with no
      -- link, of any status, because an administrator reads the answer and the
      -- earners include people who left long ago.
      SELECT d.id INTO v_driver FROM public.drivers d
       WHERE d.company_id = p_company AND lower(btrim(d.name)) = v_key
         AND NOT EXISTS (SELECT 1 FROM public.partner_driver_links x
                          WHERE x.company_id = p_company AND x.partner = v_partner
                            AND x.driver_id = d.id)
       ORDER BY d.created_at, d.id LIMIT 1;

      IF v_driver IS NOT NULL THEN
        v_action := 'match';
      ELSIF EXISTS (SELECT 1 FROM public.drivers d
                     WHERE d.company_id = p_company AND lower(btrim(d.name)) = v_key) THEN
        v_reason := 'name_taken';
      ELSE
        v_action := 'create';
      END IF;
    END IF;

    IF v_action = 'match' THEN
      SELECT d.name INTO v_dname FROM public.drivers d WHERE d.id = v_driver;
      v_method := 'automatic_match';
      v_linked := v_linked || jsonb_build_object(
        'external_driver_id', v_earner.external_id, 'name', v_dname);
    ELSIF v_action = 'create' THEN
      BEGIN
        INSERT INTO public.drivers (name, company_id, status)
        VALUES (v_name, p_company, p_new_status)
        RETURNING id, name INTO v_driver, v_dname;
        v_method := 'automatic_create';
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

    IF v_reason IS NULL THEN
      -- A proposal row first (or the pending one that exists), then the one
      -- way a link is made.
      INSERT INTO public.partner_driver_links AS l
             (company_id, partner, external_driver_id, proposed_name, status)
      VALUES (p_company, v_partner, v_earner.external_id, v_name, 'pending')
      ON CONFLICT (company_id, partner, external_driver_id) DO UPDATE
         SET updated_at = now()
       WHERE l.status = 'pending'
      RETURNING l.id INTO v_link_id;

      PERFORM app_private.partner_driver_link_apply(v_link_id, v_driver, p_caller, v_method);
    ELSE
      v_skipped := v_skipped || jsonb_build_object(
        'external_driver_id', v_earner.external_id, 'name', v_name, 'reason', v_reason);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked,
                            'already', v_already, 'skipped', v_skipped);
END;
$$;

COMMENT ON FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text, uuid) IS
  'Gives each earner with no confirmed link a named home. Mode active (the nightly pull) uses app_private.partner_driver_certain_match: links only a certain exact-name match, creates the driver when no namesake of any status exists, refuses the rest with name_missing, name_ambiguous, name_inactive or name_taken. Mode inactive (the human partner_earners_resolve) links any same-named driver with no link, otherwise creates an inactive one. In both modes a rejected row is refused with rejected and a row a person unlinked with unlinked (20261128120000). Never renames a driver. Links are written through partner_driver_link_apply with p_caller as linked_by; reads no session. The caller has done the authorization. 20261127120000.';

ALTER FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text, uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 6. self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  v_unlink  oid := 'public.partner_driver_link_unlink(uuid)'::regprocedure;
  v_guard   oid := 'app_private.partner_link_guard_unlink_record()'::regprocedure;
  v_import  oid := 'public.partner_drivers_import(text)'::regprocedure;
  v_place   oid := 'app_private.partner_place_earners(uuid,text,jsonb,text,uuid)'::regprocedure;
  v_tbl     oid := 'public.partner_driver_links'::regclass;
  v_src     text;
  v_expr    text;
  v_ok      boolean;
  v_row     record;
BEGIN
  -- 1. The unlink: a definer with a pinned search_path, reachable by a
  --    signed-in caller and by nobody else.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_unlink) THEN
    RAISE EXCEPTION 'self-check 1: partner_driver_link_unlink is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = v_unlink AND 'search_path=pg_catalog, public' = ANY (p.proconfig)) THEN
    RAISE EXCEPTION 'self-check 1: partner_driver_link_unlink has no pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_unlink, 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 1: anon may execute partner_driver_link_unlink';
  END IF;
  IF NOT has_function_privilege('authenticated', v_unlink, 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 1: authenticated may not execute partner_driver_link_unlink';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = v_unlink AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 1: PUBLIC may execute partner_driver_link_unlink';
  END IF;

  -- 2. The guard: SECURITY INVOKER (as a definer it refuses nobody), on the
  --    table, enabled, for INSERT and UPDATE, and nothing in it reaches a
  --    schema the caller cannot use.
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_guard) THEN
    RAISE EXCEPTION 'self-check 2: partner_link_guard_unlink_record is SECURITY DEFINER and would refuse nobody';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = v_tbl AND t.tgfoid = v_guard AND NOT t.tgisinternal
                    AND t.tgenabled <> 'D'
                    AND (t.tgtype & 2) <> 0      -- BEFORE
                    AND (t.tgtype & 4) <> 0      -- INSERT
                    AND (t.tgtype & 16) <> 0) THEN -- UPDATE
    RAISE EXCEPTION 'self-check 2: the unlink-record guard is not a BEFORE INSERT OR UPDATE trigger on partner_driver_links';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_guard;
  IF v_src LIKE '%app\_private.%' THEN
    RAISE EXCEPTION 'self-check 2: the guard names app_private, which the caller it runs as cannot use';
  END IF;

  -- 3. The three CHECKs, read back from the catalogue and evaluated against the
  --    rows they must refuse and admit. FALSE is a refusal; NULL would be a
  --    pass, so a NULL answer fails here too.
  SELECT regexp_replace(pg_get_constraintdef(c.oid), '^CHECK \((.*)\)$', '\1') INTO v_expr
    FROM pg_constraint c WHERE c.conrelid = v_tbl AND c.conname = 'partner_driver_links_unlinked_stays_manual';
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'self-check 3: partner_driver_links_unlinked_stays_manual is missing';
  END IF;
  FOR v_row IN
    SELECT * FROM (VALUES
      (now(),               'linked',  'automatic_match',  false),
      (now(),               'linked',  'automatic_create', false),
      (now(),               'linked',  NULL,               false),
      (now(),               'linked',  'manual',           true),
      (now(),               'pending', NULL,               true),
      (NULL::timestamptz,   'linked',  'automatic_match',  true),
      (NULL::timestamptz,   'linked',  NULL,               true)
    ) AS t(unlinked_at, status, link_method, expected)
  LOOP
    EXECUTE format('SELECT %s FROM (SELECT $1::timestamptz AS unlinked_at, $2::text AS status, $3::text AS link_method) t', v_expr)
      INTO v_ok USING v_row.unlinked_at, v_row.status, v_row.link_method;
    IF v_ok IS DISTINCT FROM v_row.expected THEN
      RAISE EXCEPTION 'self-check 3: unlinked_stays_manual answers % for (%, %, %), expected %',
        coalesce(v_ok::text, 'NULL'), v_row.unlinked_at IS NOT NULL, v_row.status, coalesce(v_row.link_method, 'NULL'), v_row.expected;
    END IF;
  END LOOP;

  SELECT regexp_replace(pg_get_constraintdef(c.oid), '^CHECK \((.*)\)$', '\1') INTO v_expr
    FROM pg_constraint c WHERE c.conrelid = v_tbl AND c.conname = 'partner_driver_links_unlinked_reason_recorded';
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'self-check 3: partner_driver_links_unlinked_reason_recorded is missing';
  END IF;
  FOR v_row IN
    SELECT * FROM (VALUES
      ('unlinked',   NULL::timestamptz, false),
      ('unlinked',   now(),             true),
      (NULL,         NULL::timestamptz, true),
      ('name_taken', NULL::timestamptz, true)
    ) AS t(decision_reason, unlinked_at, expected)
  LOOP
    EXECUTE format('SELECT %s FROM (SELECT $1::text AS decision_reason, $2::timestamptz AS unlinked_at) t', v_expr)
      INTO v_ok USING v_row.decision_reason, v_row.unlinked_at;
    IF v_ok IS DISTINCT FROM v_row.expected THEN
      RAISE EXCEPTION 'self-check 3: unlinked_reason_recorded answers % for (%, %), expected %',
        coalesce(v_ok::text, 'NULL'), coalesce(v_row.decision_reason, 'NULL'), v_row.unlinked_at IS NOT NULL, v_row.expected;
    END IF;
  END LOOP;

  SELECT regexp_replace(pg_get_constraintdef(c.oid), '^CHECK \((.*)\)$', '\1') INTO v_expr
    FROM pg_constraint c WHERE c.conrelid = v_tbl AND c.conname = 'partner_driver_links_unlinked_pair';
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'self-check 3: partner_driver_links_unlinked_pair is missing';
  END IF;
  FOR v_row IN
    SELECT * FROM (VALUES
      (gen_random_uuid(), NULL::timestamptz, false),
      (NULL::uuid,        now(),             false),
      (gen_random_uuid(), now(),             true),
      (NULL::uuid,        NULL::timestamptz, true)
    ) AS t(unlinked_by, unlinked_at, expected)
  LOOP
    EXECUTE format('SELECT %s FROM (SELECT $1::uuid AS unlinked_by, $2::timestamptz AS unlinked_at) t', v_expr)
      INTO v_ok USING v_row.unlinked_by, v_row.unlinked_at;
    IF v_ok IS DISTINCT FROM v_row.expected THEN
      RAISE EXCEPTION 'self-check 3: unlinked_pair answers % for (%, %), expected %',
        coalesce(v_ok::text, 'NULL'), v_row.unlinked_by IS NOT NULL, v_row.unlinked_at IS NOT NULL, v_row.expected;
    END IF;
  END LOOP;

  -- 4. decision_reason admits 'unlinked' and still refuses an invented reason.
  SELECT regexp_replace(pg_get_constraintdef(c.oid), '^CHECK \((.*)\)$', '\1') INTO v_expr
    FROM pg_constraint c WHERE c.conrelid = v_tbl AND c.conname = 'partner_driver_links_decision_reason_check';
  FOR v_row IN
    SELECT * FROM (VALUES ('unlinked', true), ('name_taken', true), ('name_missing', true),
                          ('name_ambiguous', true), ('name_inactive', true), ('guess', false)) AS t(r, expected)
  LOOP
    EXECUTE format('SELECT %s FROM (SELECT $1::text AS decision_reason) t', v_expr) INTO v_ok USING v_row.r;
    IF v_ok IS DISTINCT FROM v_row.expected THEN
      RAISE EXCEPTION 'self-check 4: decision_reason_check answers % for %, expected %', coalesce(v_ok::text, 'NULL'), v_row.r, v_row.expected;
    END IF;
  END LOOP;

  -- 5. The import still links through the one core, asks the rule, and skips an
  --    unlinked row before the rule; grants unchanged.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_import;
  IF v_src NOT LIKE '%IF v_link.unlinked_at IS NOT NULL THEN%'
     OR v_src NOT LIKE '%v_reason := ''unlinked'';%'
     OR v_src NOT LIKE '%app_private.partner_driver_certain_match(v_company, v_partner, v_link.proposed_name)%'
     OR v_src NOT LIKE '%app_private.partner_driver_link_apply(v_link.id, v_driver, v_caller, v_method)%'
     OR v_src NOT LIKE '%HINT = ''platform_session_not_allowed''%'
     OR v_src NOT LIKE '%public.is_company_admin()%'
     OR v_src NOT LIKE '%pg_advisory_xact_lock(hashtextextended(''partner_fleet_import:''%' THEN
    RAISE EXCEPTION 'self-check 5: partner_drivers_import lost a fragment of 20261127120000 or the unlinked skip';
  END IF;
  IF has_function_privilege('anon', v_import, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_import, 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 5: partner_drivers_import''s grants moved';
  END IF;

  -- 6. The placement: the skip sits after the rejected branch and before both
  --    modes; the fragments 20261127120000 and the kit read are unchanged; no
  --    API role may call it.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_place;
  IF v_src NOT LIKE '%ELSIF FOUND AND v_link.unlinked_at IS NOT NULL THEN%v_reason := ''unlinked'';%ELSIF p_new_status = ''active'' THEN%'
     OR v_src NOT LIKE '%IF FOUND AND v_link.status = ''rejected'' THEN%ELSIF FOUND AND v_link.unlinked_at IS NOT NULL THEN%'
     OR v_src NOT LIKE '%partner_driver_link_apply(v_link_id, v_driver, p_caller, v_method)%'
     OR v_src NOT LIKE '%app_private.partner_driver_certain_match(p_company, v_partner, v_name)%'
     OR v_src LIKE '%auth.uid()%' THEN
    RAISE EXCEPTION 'self-check 6: partner_place_earners lost a fragment of 20261127120000 or the unlinked skip';
  END IF;
  IF has_function_privilege('anon', v_place, 'EXECUTE')
     OR has_function_privilege('authenticated', v_place, 'EXECUTE')
     OR has_function_privilege('service_role', v_place, 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 6: an API role may call partner_place_earners';
  END IF;

  -- 7. Rule 3 by construction: the unlink names none of the tables whose rows
  --    the link claimed, and writes nothing but the link row.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_unlink;
  IF v_src ~* '(partner_receipt_submissions|partner_note_submissions|\mreceipts\M|driver_notes|\mincome\M|partner_receipt_apply|partner_note_apply|DELETE)' THEN
    RAISE EXCEPTION 'self-check 7: partner_driver_link_unlink names a table or call that touches what the link claimed';
  END IF;
  IF v_src NOT LIKE '%HINT = ''not_linked''%'
     OR v_src NOT LIKE '%HINT = ''link_not_found''%'
     OR v_src NOT LIKE '%public.current_role_permits(''drivers'', true)%'
     OR v_src NOT LIKE '%public.get_active_company_id()%'
     OR v_src NOT LIKE '%FOR UPDATE%'
     OR v_src NOT LIKE '%unlinked_by = v_caller, unlinked_at = now()%' THEN
    RAISE EXCEPTION 'self-check 7: partner_driver_link_unlink lost its gate, its lock, a reason or its record';
  END IF;
END
$selfcheck$;
