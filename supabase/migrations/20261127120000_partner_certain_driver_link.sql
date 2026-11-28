-- ════════════════════════════════════════════════════════════════════════════
--  A partner driver is linked automatically when the match is certain
-- ════════════════════════════════════════════════════════════════════════════
--
--  Owner decision of 27.11.2026, for the drivers page: the update button
--  ("Fahrer aus Reidey aktualisieren") links the partner's drivers to ours by
--  name and adds the ones we do not have, so the tab of link proposals goes.
--  Only what is certain is decided by the database; every other case stays a
--  pending proposal that a person decides, exactly as before.
--
--  What this reverses, in the open:
--
--    * The rule of 06.10.2026, "the name is shown, never matched"
--      (20261008100000, partner_link_review). It had a reason: fuzzy name
--      matching once paid a month's salary to a driver nobody had chosen. That
--      reason is why the rule below is exact-name only, never similar-name,
--      and why every doubtful case is held back.
--    * The roster import of 14.10.2026 (20261015110000), which linked the
--      first unlinked namesake of ANY status and created a driver for any name
--      that found none, the partner's fallback name included.
--    * The nightly placement of 26.11.2026 (20261126110000), which linked a
--      same-named active driver who held no link. It is tightened too (owner
--      answer Q1, 27.11.2026): a night with two active namesakes, or an active
--      and an inactive one, holds back as it did before 26.11.
--
--  The rule, in one place (app_private.partner_driver_certain_match). The key
--  is lower(btrim(name)), the normalisation partner_place_earners always used.
--  An empty key or the partner's fallback name 'unbekannter fahrer' is
--  `name_missing`. Among the company's drivers with that key, in this order:
--
--    1. none, of any status: the driver is CREATED (active, or inactive when
--       the partner no longer lists them) and linked;
--    2. two or more active: `name_ambiguous`, held back;
--    3. any inactive one: `name_inactive`, held back (a new hire who shares a
--       former driver's name must not put his money on the old record);
--    4. exactly one active, and it already holds a link for this partner:
--       `name_taken`, held back;
--    5. otherwise exactly one active, unlinked: LINKED.
--
--  Nothing here compares names any other way. An existing driver is never
--  renamed, because drivers.name is joined by text in income, receipts and the
--  Abrechnung.
--
--  Why it is safe to automate: a link is written only when one active driver
--  carries the exact name and nothing else could be meant. A wrong automatic
--  link is also not silent: link_method records HOW the link came to be, and
--  linked_by who pressed the button (NULL for the nightly job), so the row tells
--  an automatic link from a confirmed one. Nothing in the product unlinks yet.
--
--  Every automatic link goes through app_private.partner_driver_link_apply, the
--  core of partner_driver_link_confirm: status, driver, linked_by, linked_at,
--  link_method, the decision reason cleared, and the waiting receipt and note
--  submissions claimed, all in one transaction. The confirm calls it with
--  'manual'. The claim is written out there for every caller, with or without
--  a session: partner_submission_claim_driver asks the SESSION's company and
--  role and so cannot run in the nightly job, and one copy of the two UPDATEs
--  is better than two. That function stays, for re-claiming after a correction.
--
--  What does not change: the human earnings resolve (partner_earners_resolve,
--  mode 'inactive' of partner_place_earners) keeps its matching exactly, because
--  an administrator reads its answer and it matches people in old earnings who
--  left long ago; it only records link_method. Gates, locks, grants and the
--  answers of the restated functions are those of the migrations they came from.
--
--  Two columns on partner_driver_links, both NULL on every row that exists:
--  link_method (manual, automatic_match, automatic_create; NULL on a link made
--  before this migration, which is not backfilled with a guess) and
--  decision_reason (why a pending link was left for a person; cleared when it
--  is linked or rejected).

-- ─── 1. the two columns ─────────────────────────────────────────────────────

ALTER TABLE public.partner_driver_links
  ADD COLUMN IF NOT EXISTS link_method text NULL,
  ADD COLUMN IF NOT EXISTS decision_reason text NULL;

ALTER TABLE public.partner_driver_links
  DROP CONSTRAINT IF EXISTS partner_driver_links_link_method_check;
ALTER TABLE public.partner_driver_links
  ADD CONSTRAINT partner_driver_links_link_method_check
  CHECK (link_method IS NULL OR link_method IN ('manual', 'automatic_match', 'automatic_create'));

ALTER TABLE public.partner_driver_links
  DROP CONSTRAINT IF EXISTS partner_driver_links_decision_reason_check;
ALTER TABLE public.partner_driver_links
  ADD CONSTRAINT partner_driver_links_decision_reason_check
  CHECK (decision_reason IS NULL
         OR decision_reason IN ('name_missing', 'name_ambiguous', 'name_inactive', 'name_taken'));

ALTER TABLE public.partner_driver_links
  DROP CONSTRAINT IF EXISTS partner_driver_links_decision_reason_pending;
ALTER TABLE public.partner_driver_links
  ADD CONSTRAINT partner_driver_links_decision_reason_pending
  CHECK (decision_reason IS NULL OR status = 'pending');

COMMENT ON COLUMN public.partner_driver_links.link_method IS
  'How the link was made: manual (a person confirmed it), automatic_match (the roster import or the nightly pull found exactly one active driver of that exact name) or automatic_create (they created the driver). NULL on a link made before 27.11.2026. 20261127120000.';
COMMENT ON COLUMN public.partner_driver_links.decision_reason IS
  'Why a pending link was left for a person by the roster import: name_missing, name_ambiguous, name_inactive or name_taken. NULL when linked or rejected, and on a link nothing has examined. 20261127120000.';

-- ─── 2. the rule, once ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.partner_driver_certain_match(
  p_company uuid,
  p_partner text,
  p_name    text,
  OUT o_action    text,
  OUT o_driver_id uuid,
  OUT o_reason    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_partner  text := lower(btrim(coalesce(p_partner, '')));
  v_key      text := lower(btrim(coalesce(p_name, '')));
  v_active   integer;
  v_inactive integer;
  v_one      uuid;
BEGIN
  IF p_company IS NULL OR v_partner = '' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  IF v_key = '' OR v_key = 'unbekannter fahrer' THEN
    o_action := 'refuse';
    o_reason := 'name_missing';
    RETURN;
  END IF;

  SELECT count(*) FILTER (WHERE coalesce(d.status, 'active') = 'active'),
         count(*) FILTER (WHERE coalesce(d.status, 'active') <> 'active'),
         (array_agg(d.id ORDER BY d.created_at, d.id)
            FILTER (WHERE coalesce(d.status, 'active') = 'active'))[1]
    INTO v_active, v_inactive, v_one
    FROM public.drivers d
   WHERE d.company_id = p_company AND lower(btrim(d.name)) = v_key;

  IF v_active = 0 AND v_inactive = 0 THEN
    o_action := 'create';
  ELSIF v_active >= 2 THEN
    o_action := 'refuse';
    o_reason := 'name_ambiguous';
  ELSIF v_inactive > 0 THEN
    o_action := 'refuse';
    o_reason := 'name_inactive';
  ELSIF EXISTS (SELECT 1 FROM public.partner_driver_links x
                 WHERE x.company_id = p_company AND x.partner = v_partner
                   AND x.driver_id = v_one) THEN
    o_action := 'refuse';
    o_reason := 'name_taken';
  ELSE
    o_action := 'match';
    o_driver_id := v_one;
  END IF;
END;
$$;

COMMENT ON FUNCTION app_private.partner_driver_certain_match(uuid, text, text) IS
  'The one rule of 27.11.2026 for linking a partner driver by name: exact lower(btrim(name)), and only when certain. Answers create (no namesake of any status), match (one active unlinked namesake and no inactive one) or refuse with name_missing, name_ambiguous, name_inactive or name_taken. Reads, writes nothing. The caller has done the authorization and holds the company lock. 20261127120000.';

ALTER FUNCTION app_private.partner_driver_certain_match(uuid, text, text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.partner_driver_certain_match(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. linking, once ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.partner_driver_link_apply(
  p_link_id   uuid,
  p_driver_id uuid,
  p_caller    uuid,
  p_method    text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_link public.partner_driver_links;
  v_r    integer := 0;
  v_n    integer := 0;
BEGIN
  IF p_link_id IS NULL OR p_driver_id IS NULL
     OR p_method IS NULL OR p_method NOT IN ('manual', 'automatic_match', 'automatic_create') THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  BEGIN
    UPDATE public.partner_driver_links
       SET status = 'linked', driver_id = p_driver_id,
           linked_by = p_caller, linked_at = now(),
           link_method = p_method, decision_reason = NULL, updated_at = now()
     WHERE id = p_link_id AND status = 'pending'
    RETURNING * INTO v_link;
  EXCEPTION WHEN unique_violation THEN
    -- partner_driver_links_driver_key. Named, because a constraint name on a
    -- screen is how an operator reads `duplicate key value violates ...`.
    RAISE EXCEPTION 'Dieser Fahrer ist bereits mit diesem Partner verknüpft.'
      USING ERRCODE = 'P0001', HINT = 'driver_already_linked';
  END;

  IF v_link.id IS NULL THEN
    RAISE EXCEPTION 'Der Vorschlag wurde bereits entschieden.'
      USING ERRCODE = 'P0001', HINT = 'already_decided';
  END IF;

  -- The claim of partner_submission_claim_driver, written out so that a caller
  -- with no session (the nightly job) can make it too: only what still waits,
  -- bounded by the link's own company, partner and external id.
  UPDATE public.partner_receipt_submissions
     SET driver_id = v_link.driver_id, updated_at = now()
   WHERE company_id = v_link.company_id AND partner = v_link.partner
     AND external_driver_id = v_link.external_driver_id
     AND driver_id IS NULL AND status = 'pending';
  GET DIAGNOSTICS v_r = ROW_COUNT;

  UPDATE public.partner_note_submissions
     SET driver_id = v_link.driver_id, updated_at = now()
   WHERE company_id = v_link.company_id AND partner = v_link.partner
     AND external_driver_id = v_link.external_driver_id
     AND driver_id IS NULL AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'receipts', v_r, 'notes', v_n);
END;
$$;

COMMENT ON FUNCTION app_private.partner_driver_link_apply(uuid, uuid, uuid, text) IS
  'Links a pending partner driver to one of ours and claims the receipt and note submissions that waited for it, in the caller''s transaction. The core of partner_driver_link_confirm (manual) and of every automatic link (automatic_match, automatic_create); linked_by is the person who pressed the button, NULL for the nightly job. The caller has done the authorization and checked the driver belongs to the link''s company. 20261127120000.';

ALTER FUNCTION app_private.partner_driver_link_apply(uuid, uuid, uuid, text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.partner_driver_link_apply(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 4. confirm and reject, restated ────────────────────────────────────────
-- Gate, lock, hints and answer are those of 20261008100000. The only change is
-- that the confirm's UPDATE and claim are app_private.partner_driver_link_apply,
-- and the reject clears decision_reason.

CREATE OR REPLACE FUNCTION public.partner_driver_link_confirm(
  p_link_id   uuid,
  p_driver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid := public.get_active_company_id();
  v_caller  uuid := auth.uid();
  v_link    public.partner_driver_links;
  v_claimed jsonb;
BEGIN
  IF v_caller IS NULL OR v_company IS NULL
     OR NOT public.current_role_permits('drivers', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_link_id IS NULL OR p_driver_id IS NULL THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  SELECT * INTO v_link FROM public.partner_driver_links
   WHERE id = p_link_id AND company_id = v_company
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vorschlag nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'link_not_found';
  END IF;

  IF v_link.status <> 'pending' THEN
    RAISE EXCEPTION 'Der Vorschlag wurde bereits entschieden.'
      USING ERRCODE = 'P0001', HINT = 'already_decided';
  END IF;

  -- The driver is looked up in the caller's own company. A driver of another
  -- company is the same refusal as a driver that does not exist, so a caller
  -- learns nothing about other companies' drivers.
  IF NOT EXISTS (
    SELECT 1 FROM public.drivers d
     WHERE d.id = p_driver_id AND d.company_id = v_company
  ) THEN
    RAISE EXCEPTION 'Fahrer nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'driver_not_found';
  END IF;

  -- One transaction with the claim: the apply names a driver that already holds
  -- a link as driver_already_linked, and claims the waiting submissions.
  v_claimed := app_private.partner_driver_link_apply(v_link.id, p_driver_id, v_caller, 'manual');

  RETURN jsonb_build_object(
    'ok', true,
    'driver_id', p_driver_id,
    'receipts', v_claimed -> 'receipts',
    'notes', v_claimed -> 'notes'
  );
END;
$$;

COMMENT ON FUNCTION public.partner_driver_link_confirm(uuid, uuid) IS
  'Confirms that a partner''s driver is one of ours, chosen by a person from a '
  'list (link_method manual). It claims the submissions that arrived before '
  'the link in the SAME transaction, because the claim is driven by a button '
  'and nothing would retry a lost second call. The automatic links of '
  '27.11.2026 go through the same core, app_private.partner_driver_link_apply.';

CREATE OR REPLACE FUNCTION public.partner_driver_link_reject(p_link_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company   uuid := public.get_active_company_id();
  v_caller    uuid := auth.uid();
  v_link      public.partner_driver_links;
  v_stranded  int;
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
    RAISE EXCEPTION 'Vorschlag nicht gefunden.'
      USING ERRCODE = 'P0002', HINT = 'link_not_found';
  END IF;

  IF v_link.status <> 'pending' THEN
    RAISE EXCEPTION 'Der Vorschlag wurde bereits entschieden.'
      USING ERRCODE = 'P0001', HINT = 'already_decided';
  END IF;

  -- decision_reason is only ever set on a pending link (a CHECK), so the
  -- person's decision clears it in the same statement.
  UPDATE public.partner_driver_links
     SET status = 'rejected', decision_reason = NULL, updated_at = now()
   WHERE id = v_link.id;

  -- Counted, not rejected: see 20261008100000. The number is what the screen
  -- tells the operator, so the consequence of the decision is visible at the
  -- moment it is taken rather than discovered in the inbox later.
  SELECT count(*) INTO v_stranded
    FROM (
      SELECT 1 FROM public.partner_note_submissions s
       WHERE s.company_id = v_company AND s.partner = v_link.partner
         AND s.external_driver_id = v_link.external_driver_id
         AND s.driver_id IS NULL AND s.status = 'pending'
      UNION ALL
      SELECT 1 FROM public.partner_receipt_submissions s
       WHERE s.company_id = v_company AND s.partner = v_link.partner
         AND s.external_driver_id = v_link.external_driver_id
         AND s.driver_id IS NULL AND s.status = 'pending'
    ) AS waiting;

  RETURN jsonb_build_object('ok', true, 'stranded', v_stranded);
END;
$$;

COMMENT ON FUNCTION public.partner_driver_link_reject(uuid) IS
  'Rejects a proposal: this partner driver is not one of ours. It counts the '
  'submissions left unresolvable and returns the number rather than rejecting '
  'them, because rejected_reason is shown to the driver and an automatic one '
  'would be a sentence no person wrote. Clears decision_reason.';

ALTER FUNCTION public.partner_driver_link_confirm(uuid, uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.partner_driver_link_confirm(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_driver_link_confirm(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.partner_driver_link_reject(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_driver_link_reject(uuid) TO authenticated;

-- ─── 5. the roster import, restated on the rule ─────────────────────────────
-- Gate, platform refusal, lock and the keys of the answer are those of
-- 20261015110000; `pending` is new (the company's pending links for the partner
-- after the run). `created` and `linked` mean what they meant: drivers created
-- and linked, and existing drivers linked.

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

    SELECT m.o_action, m.o_driver_id, m.o_reason INTO v_action, v_driver, v_reason
      FROM app_private.partner_driver_certain_match(v_company, v_partner, v_link.proposed_name) m;

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
  'The update button of the drivers page. Walks the partner''s pending drivers and, by the one rule of app_private.partner_driver_certain_match, links an exact-name active driver who holds no link, creates the driver when no namesake exists, and leaves every other case pending with its decision_reason. Answers created, linked, pending (the company''s pending links for the partner after the run) and the skipped ones with their reason. Administrator only; refuses a platform session. Rewritten 27.11.2026 (20261127120000).';

ALTER FUNCTION public.partner_drivers_import(text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.partner_drivers_import(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_drivers_import(text) TO authenticated;

-- ─── 6. the placement of earners, restated on the rule ──────────────────────
-- Signature, argument checks, lock and the answer are those of 20261126110000.
-- Mode 'active' (the nightly pull) asks the certain rule; mode 'inactive' (the
-- human earnings resolve) keeps its matching. Both write the link through
-- partner_driver_link_apply and so record link_method.

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

      PERFORM app_private.partner_driver_link_apply(v_link_id, v_driver, v_caller, v_method);
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
  'Gives each earner with no confirmed link a named home. Mode active (the nightly pull) uses app_private.partner_driver_certain_match: links only a certain exact-name match, creates the driver when no namesake of any status exists, refuses the rest with name_missing, name_ambiguous, name_inactive or name_taken. Mode inactive (the human partner_earners_resolve) links any same-named driver with no link, otherwise creates an inactive one. Never renames a driver. Links are written through partner_driver_link_apply. The caller has done the authorization. 20261127120000.';

ALTER FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.partner_place_earners(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 7. self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_match   oid := 'app_private.partner_driver_certain_match(uuid,text,text)'::regprocedure;
  v_apply   oid := 'app_private.partner_driver_link_apply(uuid,uuid,uuid,text)'::regprocedure;
  v_place   oid := 'app_private.partner_place_earners(uuid,text,jsonb,text)'::regprocedure;
  v_import  oid := 'public.partner_drivers_import(text)'::regprocedure;
  v_confirm oid := 'public.partner_driver_link_confirm(uuid,uuid)'::regprocedure;
  v_reject  oid := 'public.partner_driver_link_reject(uuid)'::regprocedure;
  v_oid     oid;
  v_src     text;
  v_n       integer;
BEGIN
  -- 1. the columns and the three CHECKs, and nothing was backfilled.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'partner_driver_links'
     AND column_name IN ('link_method', 'decision_reason') AND is_nullable = 'YES'
     AND data_type = 'text';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'certain link self-check 1: link_method or decision_reason is missing or not a nullable text';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.partner_driver_links'::regclass
     AND conname IN ('partner_driver_links_link_method_check',
                     'partner_driver_links_decision_reason_check',
                     'partner_driver_links_decision_reason_pending');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'certain link self-check 1: % of 3 constraints exist', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_driver_links
              WHERE link_method IS NOT NULL OR decision_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'certain link self-check 1: a row already carries a method or a reason; nothing is backfilled';
  END IF;

  -- 2. every new or restated function is a definer with a pinned search_path.
  FOREACH v_oid IN ARRAY ARRAY[v_match, v_apply, v_place, v_import, v_confirm, v_reject] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid)
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION 'certain link self-check 2: % is not SECURITY DEFINER with a pinned search_path', v_oid::regprocedure;
    END IF;
  END LOOP;

  -- 3. nobody the API authenticates as reaches an app_private function.
  FOREACH v_oid IN ARRAY ARRAY[v_match, v_apply, v_place] LOOP
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_oid AND a.grantee = 0) THEN
      RAISE EXCEPTION 'certain link self-check 3: % is reachable by an API role or PUBLIC', v_oid::regprocedure;
    END IF;
  END LOOP;

  -- 4. the three restated public functions keep their grants.
  FOREACH v_oid IN ARRAY ARRAY[v_import, v_confirm, v_reject] LOOP
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_oid AND a.grantee = 0) THEN
      RAISE EXCEPTION 'certain link self-check 4: % lost its grants', v_oid::regprocedure;
    END IF;
  END LOOP;

  -- 5. every path that links goes through the one apply, and none writes the
  --    link's status or driver itself.
  FOREACH v_oid IN ARRAY ARRAY[v_import, v_confirm, v_place] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
    IF v_src NOT LIKE '%app_private.partner_driver_link_apply(%'
       OR v_src ~* 'SET\s+status\s*=\s*''linked''' THEN
      RAISE EXCEPTION 'certain link self-check 5: % does not link through partner_driver_link_apply alone', v_oid::regprocedure;
    END IF;
  END LOOP;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_confirm;
  IF v_src NOT LIKE '%''manual''%' THEN
    RAISE EXCEPTION 'certain link self-check 5: the confirm no longer records manual';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_apply;
  IF v_src NOT LIKE '%driver_already_linked%' OR v_src NOT LIKE '%already_decided%'
     OR v_src NOT LIKE '%decision_reason = NULL%' OR v_src NOT LIKE '%link_method = p_method%'
     OR v_src NOT LIKE '%UPDATE public.partner_receipt_submissions%'
     OR v_src NOT LIKE '%UPDATE public.partner_note_submissions%' THEN
    RAISE EXCEPTION 'certain link self-check 5: the apply lost a hint, the method, the reason reset or the claim';
  END IF;

  -- 6. the rule lives in the decision function and nowhere else for the roster:
  --    the import compares no name, and the placement spells the fallback name
  --    once, in the human branch whose matching is unchanged.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_import;
  IF v_src LIKE '%unbekannter fahrer%' OR v_src LIKE '%btrim(d.name)%'
     OR v_src NOT LIKE '%partner_driver_certain_match(%' THEN
    RAISE EXCEPTION 'certain link self-check 6: the import matches names itself or does not ask the decision function';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_place;
  IF v_src NOT LIKE '%partner_driver_certain_match(%'
     OR (length(v_src) - length(replace(v_src, 'unbekannter fahrer', '')))
        / length('unbekannter fahrer') <> 1 THEN
    RAISE EXCEPTION 'certain link self-check 6: the placement does not ask the decision function, or spells the fallback name outside the human branch';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_match;
  IF v_src NOT LIKE '%lower(btrim(d.name)) = v_key%' OR v_src NOT LIKE '%unbekannter fahrer%'
     OR v_src NOT LIKE '%name_missing%' OR v_src NOT LIKE '%name_ambiguous%'
     OR v_src NOT LIKE '%name_inactive%' OR v_src NOT LIKE '%name_taken%'
     OR v_src ~* '(similarity|levenshtein|soundex|metaphone|ILIKE)' THEN
    RAISE EXCEPTION 'certain link self-check 6: the decision function lost a reason or compares a name loosely';
  END IF;

  -- 7. the load-bearing fragments of the bodies this migration restated.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_import;
  IF v_src NOT LIKE '%get_active_company_id()%' OR v_src NOT LIKE '%is_company_admin()%'
     OR v_src NOT LIKE '%platform_session_not_allowed%' OR v_src NOT LIKE '%not_authorized%'
     OR v_src NOT LIKE '%invalid_request%'
     OR v_src NOT LIKE '%pg_advisory_xact_lock(hashtextextended(''partner_fleet_import:'' || v_company::text, 0))%'
     OR v_src NOT LIKE '%Fahrerlimit%' OR v_src NOT LIKE '%limit_reached%'
     OR v_src NOT LIKE '%partner_normalise_phone(v_link.proposed_phone)%'
     OR v_src NOT LIKE '%partner_removed_at IS NULL THEN ''active'' ELSE ''inactive''%'
     OR v_src NOT LIKE '%''pending'', v_pending%' THEN
    RAISE EXCEPTION 'certain link self-check 7: partner_drivers_import lost its gate, lock, limit, phone, departed rule or answer key';
  END IF;
  IF v_src ~* 'personalnummer|preferred_language|employment_type|salary_ratio' THEN
    RAISE EXCEPTION 'certain link self-check 7: partner_drivers_import sets a column the drivers defaults own';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_confirm;
  IF v_src NOT LIKE '%current_role_permits(''drivers'', true)%' OR v_src NOT LIKE '%get_active_company_id()%'
     OR v_src NOT LIKE '%FOR UPDATE%' OR v_src NOT LIKE '%link_not_found%'
     OR v_src NOT LIKE '%already_decided%' OR v_src NOT LIKE '%driver_not_found%'
     OR v_src NOT LIKE '%not_authorized%' OR v_src NOT LIKE '%invalid_request%'
     OR v_src ~* 'proposed_name|similarity\(|levenshtein\(|ILIKE' THEN
    RAISE EXCEPTION 'certain link self-check 7: partner_driver_link_confirm lost a gate, a hint or compares a name';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_reject;
  IF v_src NOT LIKE '%current_role_permits(''drivers'', true)%' OR v_src NOT LIKE '%get_active_company_id()%'
     OR v_src NOT LIKE '%stranded%' OR v_src NOT LIKE '%decision_reason = NULL%'
     OR v_src NOT LIKE '%already_decided%' OR v_src NOT LIKE '%link_not_found%'
     OR v_src LIKE '%UPDATE public.partner_note_submissions%'
     OR v_src LIKE '%UPDATE public.partner_receipt_submissions%' THEN
    RAISE EXCEPTION 'certain link self-check 7: partner_driver_link_reject lost a gate, the reset, or now writes a submission';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_place;
  IF v_src NOT LIKE '%pg_advisory_xact_lock(hashtextextended(''partner_fleet_import:'' || p_company::text, 0))%'
     OR v_src NOT LIKE '%limit_reached%' OR v_src NOT LIKE '%rejected%'
     OR v_src NOT LIKE '%name_taken%' OR v_src NOT LIKE '%name_missing%'
     OR v_src NOT LIKE '%an earner is malformed%' OR v_src NOT LIKE '%jsonb_array_length(p_earners) > 200%'
     OR v_src ~* 'UPDATE\s+(public\.)?drivers' OR v_src ~* 'DELETE\s+FROM'
     OR v_src ~* '(public\.)?income' OR v_src ~* 'cash_movements'
     OR v_src ~* 'personalnummer' THEN
    RAISE EXCEPTION 'certain link self-check 7: partner_place_earners lost the lock, a refusal, its argument checks, or rewrites a driver or touches money';
  END IF;

  RAISE NOTICE 'partner certain driver link: self-checks passed';
END
$check$;
