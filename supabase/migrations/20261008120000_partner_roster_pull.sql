-- ════════════════════════════════════════════════════════════════════════════
--  M1.5 — the roster pull, and the departed driver the owner chose to badge
-- ════════════════════════════════════════════════════════════════════════════
--
--  Everything before this records a connection; nothing reads the partner's
--  roster, so `partner_driver_links` has no rows and M2's proposals tab is
--  empty. This is the function the pull writes through, and one column.
--
--  ── The owner's decision of 08.10.2026: badge, never unlink ────────────────
--
--  Reidey carries `roster_removed_at` on a driver. When a pull sees it the link
--  keeps its `linked` status and the screen marks it; the operator decides.
--  Automatic unlinking was the alternative and was refused, and the reasoning
--  is worth keeping because it is not obvious: unlinking silently detaches the
--  driver from the submissions and notes already attributed to them, and "this
--  person left the other product" is a different fact from "this person is not
--  our driver". Only the second is a reason to break a link.
--
--  So `partner_driver_links.partner_removed_at` records what the partner last
--  reported and **changes no state**. It is nullable, and a driver who returns
--  to their fleet clears it on the next pull — the same occurrence logic
--  `notification_deliveries` uses, where the fact is the occurrence and not the
--  day a job happened to run.
--
--  ── Why the pull is one function and not one call per driver ───────────────
--
--  `partner_driver_resolve` already upserts one proposal. A roster of 80
--  drivers through it is 80 round trips from an edge function, each with its
--  own transaction, and a failure halfway leaves a half-read roster with no
--  record of where it stopped. `partner_roster_apply` takes the page as JSON
--  and writes it in ONE transaction, so a pull either records a page or
--  records nothing, and the connection's own `last_pull_at` says when.
--
--  It is deliberately NOT idempotent-by-request-id: re-reading a roster is
--  meant to be repeatable, and the upsert is keyed on the partner's own driver
--  id. Running it twice is the same as running it once.
--
--  ── What the partner may and may not change ────────────────────────────────
--
--  The proposed name, address and phone are refreshed every pull, so a driver
--  who corrected their details there is shown correctly here. `driver_id` and
--  `status` are never touched — the same rule `partner_driver_resolve` already
--  states: a confirmed link is a person's decision and the partner does not get
--  to revise it. Self-check 4 reads the body for that.

-- ─── 1. what the partner last reported ──────────────────────────────────────

ALTER TABLE public.partner_driver_links
  ADD COLUMN IF NOT EXISTS partner_removed_at timestamptz NULL;

COMMENT ON COLUMN public.partner_driver_links.partner_removed_at IS
  'When the partner last reported this driver as off their roster, or NULL. '
  'Recorded by a pull and changes NO state: the owner decided on 08.10.2026 '
  'that a departed driver is badged and the operator decides, because '
  'unlinking silently detaches them from submissions already attributed to '
  'them. Cleared again if the driver returns.';

-- ─── 2. one page of a roster, in one transaction ────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_roster_apply(
  p_company_id uuid,
  p_partner    text,
  p_drivers    jsonb
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
  v_departed int := 0;
  v_returned int := 0;
  v_row      jsonb;
  v_external text;
  v_removed  timestamptz;
  v_before   timestamptz;
  v_existed  boolean;
BEGIN
  IF p_company_id IS NULL OR v_partner = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF p_drivers IS NULL OR jsonb_typeof(p_drivers) <> 'array' THEN
    RAISE EXCEPTION 'the roster page is not an array'
      USING ERRCODE = '22023', HINT = 'invalid_roster';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_drivers) LOOP
    v_external := btrim(coalesce(v_row ->> 'id', ''));
    -- A driver the partner cannot identify is skipped rather than stored under
    -- a blank key, which would collide with every other such row.
    CONTINUE WHEN v_external = '';

    BEGIN
      v_removed := nullif(btrim(coalesce(v_row ->> 'roster_removed_at', '')), '')::timestamptz;
    EXCEPTION WHEN others THEN
      -- An unreadable timestamp is not a reason to lose the driver. The link is
      -- recorded and the departure is simply not claimed.
      v_removed := NULL;
    END;

    SELECT true, l.partner_removed_at INTO v_existed, v_before
      FROM public.partner_driver_links l
     WHERE l.company_id = p_company_id AND l.partner = v_partner
       AND l.external_driver_id = v_external;

    INSERT INTO public.partner_driver_links AS l
           (company_id, partner, external_driver_id,
            proposed_name, proposed_email, proposed_phone, partner_removed_at)
    VALUES (p_company_id, v_partner, v_external,
            nullif(btrim(coalesce(v_row ->> 'name', '')), ''),
            nullif(lower(btrim(coalesce(v_row ->> 'email', ''))), ''),
            nullif(btrim(coalesce(v_row ->> 'phone', '')), ''),
            v_removed)
    ON CONFLICT (company_id, partner, external_driver_id) DO UPDATE
       SET proposed_name      = excluded.proposed_name,
           proposed_email     = excluded.proposed_email,
           proposed_phone     = excluded.proposed_phone,
           -- Recorded, never acted on: `status` and `driver_id` are untouched,
           -- which is what makes this a badge and not an unlink.
           partner_removed_at = excluded.partner_removed_at,
           updated_at         = now();

    v_seen := v_seen + 1;
    IF NOT coalesce(v_existed, false) THEN
      v_new := v_new + 1;
    END IF;
    IF v_removed IS NOT NULL AND v_before IS NULL THEN
      v_departed := v_departed + 1;
    ELSIF v_removed IS NULL AND v_before IS NOT NULL THEN
      v_returned := v_returned + 1;
    END IF;
    v_existed := NULL;
    v_before := NULL;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'seen', v_seen,
    'new', v_new,
    'departed', v_departed,
    'returned', v_returned
  );
END;
$$;

COMMENT ON FUNCTION public.partner_roster_apply(uuid, text, jsonb) IS
  'Records one page of a partner roster in one transaction: the proposals are '
  'created or refreshed, and a departure the partner reports is stored without '
  'changing a link''s status. Repeatable by design — the key is the partner''s '
  'own driver id, so running it twice is running it once. Service role only.';

REVOKE ALL ON FUNCTION public.partner_roster_apply(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_roster_apply(uuid, text, jsonb) TO service_role;

-- ─── 3. when a pull happened, and whether it worked ─────────────────────────

CREATE OR REPLACE FUNCTION public.partner_pull_record(
  p_company_id uuid,
  p_partner    text,
  p_error      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_partner text := lower(btrim(coalesce(p_partner, '')));
  v_error   text := nullif(btrim(coalesce(p_error, '')), '');
BEGIN
  IF p_company_id IS NULL OR v_partner = '' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- `last_pull_at` moves on every attempt and `last_success_at` only on a
  -- success, so "it ran and failed" is distinguishable from "it never ran" —
  -- which is the whole reason a failed pull needs a record at all.
  UPDATE public.partner_connections
     SET last_pull_at    = now(),
         last_success_at = CASE WHEN v_error IS NULL THEN now() ELSE last_success_at END,
         last_error      = v_error,
         status          = CASE WHEN v_error IS NULL THEN 'active' ELSE 'failed' END,
         updated_at      = now()
   WHERE company_id = p_company_id AND partner = v_partner AND status <> 'revoked';

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.partner_pull_record(uuid, text, text) IS
  'Stamps a pull on the connection: last_pull_at always, last_success_at only '
  'on success, and the error text otherwise. A revoked connection is never '
  'revived by a pull. Service role only.';

REVOKE ALL ON FUNCTION public.partner_pull_record(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_pull_record(uuid, text, text) TO service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
  r   record;
BEGIN
  -- 1. both are service_role's alone.
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated']) AS role LOOP
    IF has_function_privilege(r.role, 'public.partner_roster_apply(uuid,text,jsonb)', 'EXECUTE')
       OR has_function_privilege(r.role, 'public.partner_pull_record(uuid,text,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'roster pull self-check 1: % may execute a pull function', r.role;
    END IF;
  END LOOP;

  -- 2. SECURITY DEFINER with a pinned search_path, both.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_roster_apply', 'partner_pull_record')
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'roster pull self-check 2: % of 2 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 3. the badge column exists and is nullable. NOT NULL would force a value
  --    for every driver who is still on the roster, which is the opposite fact.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'partner_driver_links'
       AND column_name = 'partner_removed_at' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'roster pull self-check 3: partner_removed_at is missing or NOT NULL';
  END IF;

  -- 4. the pull changes no link's status and no link's driver. This is the
  --    owner's decision read out of the body rather than trusted to a comment:
  --    an UPDATE naming either column would turn the badge into an unlink.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_roster_apply'
     AND (p.prosrc ~ 'SET[^;]*\mstatus\M\s*=' OR p.prosrc ~ 'SET[^;]*\mdriver_id\M\s*=');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'roster pull self-check 4: the pull now assigns a link''s status or driver — that is an unlink, not a badge';
  END IF;

  -- 5. a pull never revives a revoked connection.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_pull_record'
     AND p.prosrc LIKE '%status <> ''revoked''%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'roster pull self-check 5: a pull can now revive a revoked connection';
  END IF;

  -- 6. the links table still has no INSERT policy: the writer is this definer,
  --    and a client-insertable proposal would let a company invent a partner
  --    driver and then confirm it.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_driver_links'
     AND cmd IN ('INSERT', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'roster pull self-check 6: partner_driver_links gained an INSERT or DELETE policy';
  END IF;

  RAISE NOTICE 'partner roster pull: self-checks passed — a departure is recorded and nothing is unlinked';
END
$check$;
