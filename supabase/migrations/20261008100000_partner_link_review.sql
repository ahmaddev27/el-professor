-- ════════════════════════════════════════════════════════════════════════════
--  M2 — a person confirms which of our drivers a partner's driver is
-- ════════════════════════════════════════════════════════════════════════════
--
--  `partner_driver_resolve` creates the proposal; this adds the two decisions a
--  human makes about it. The tables and the claim already existed and are
--  unchanged.
--
--  ── 1. Confirming and claiming are ONE transaction ──────────────────────────
--
--  `partner_driver_link_confirm` calls `partner_submission_claim_driver` itself
--  rather than leaving the screen to make a second call. Two calls leave a
--  window where the link is confirmed and the notes that arrived before it are
--  still unattached, and **nothing retries**: the claim is driven by a person
--  pressing a button, so a lost second call means those submissions sit in the
--  inbox marked "driver not linked" for ever, next to a link that says it is.
--  The separate RPC stays — it is how a re-claim is run after a correction —
--  and calling it is also what keeps one copy of the two UPDATEs.
--
--  ── 2. Why the name is never matched automatically ─────────────────────────
--
--  The owner's decision of 06.10.2026, and this codebase has the scar: fuzzy
--  name matching once gave a month's salary to a driver nobody had chosen. So
--  `proposed_name` is shown to a person and the driver is chosen from a list.
--  Nothing here compares names, and nothing should be added that does.
--
--  ── 3. A rejected link does NOT reject the submissions waiting on it ───────
--
--  It would be the tidier database and the wrong product. `rejected_reason` is
--  shown to the driver in their app, and "your company rejected the link" is a
--  different statement from "your note was rejected" — an automatic one would
--  be a sentence no person wrote, sent to a person. So the reject reports how
--  many submissions are now unresolvable (`stranded`) and the screen says so,
--  leaving the reviewer to reject them with their own words.
--
--  What that costs, stated: those rows stay `pending` and can never be
--  accepted, because `partner_note_accept` refuses a submission whose driver is
--  NULL. They are visible — the inbox badges them "Fahrer nicht verknüpft" —
--  and a reviewer clears them by rejecting them. If that pile ever becomes a
--  real nuisance the answer is a bulk reject with a reason the operator types,
--  not a sentence generated here.
--
--  ── 4. One driver, one link per partner ────────────────────────────────────
--
--  `partner_driver_links_driver_key` is unique on `(company_id, partner,
--  driver_id)` where the driver is set, so pointing a second proposal at a
--  driver who already has one raises 23505. That is caught and named
--  `driver_already_linked`, because a constraint name reaching a screen is how
--  an operator ends up reading `duplicate key value violates unique
--  constraint`.

-- ─── 1. confirm ─────────────────────────────────────────────────────────────

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

  BEGIN
    UPDATE public.partner_driver_links
       SET status = 'linked', driver_id = p_driver_id,
           linked_by = v_caller, linked_at = now(), updated_at = now()
     WHERE id = v_link.id;
  EXCEPTION WHEN unique_violation THEN
    -- partner_driver_links_driver_key. Named, because a constraint name on a
    -- screen is how an operator reads `duplicate key value violates ...`.
    RAISE EXCEPTION 'Dieser Fahrer ist bereits mit diesem Partner verknüpft.'
      USING ERRCODE = 'P0001', HINT = 'driver_already_linked';
  END;

  -- One transaction with the confirm: see the header. The claim re-reads the
  -- link and sees the row this statement just wrote.
  v_claimed := public.partner_submission_claim_driver(v_link.id);

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
  'list — never matched by name. It claims the submissions that arrived before '
  'the link in the SAME transaction, because the claim is driven by a button '
  'and nothing would retry a lost second call.';

-- ─── 2. reject ──────────────────────────────────────────────────────────────

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

  UPDATE public.partner_driver_links
     SET status = 'rejected', updated_at = now()
   WHERE id = v_link.id;

  -- Counted, not rejected: see the header. The number is what the screen tells
  -- the operator, so the consequence of the decision is visible at the moment
  -- it is taken rather than discovered in the inbox later.
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
  'would be a sentence no person wrote.';

REVOKE ALL ON FUNCTION public.partner_driver_link_confirm(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_driver_link_confirm(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.partner_driver_link_reject(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_driver_link_reject(uuid) TO authenticated;

-- ─── 3. Self-check ──────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_n int;
BEGIN
  -- 1. anon reaches neither, and Supabase grants EXECUTE on every new public
  --    function to anon, so this is the check that the REVOKEs above ran.
  IF has_function_privilege('anon', 'public.partner_driver_link_confirm(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.partner_driver_link_reject(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'link review self-check 1: anon can execute one of the two functions';
  END IF;

  -- 2. both are SECURITY DEFINER with a pinned search_path. As invokers the
  --    confirm would die 42501 the moment it called the claim, which is owned
  --    elsewhere — PR #117's defect, and the reason the rule is written down.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_driver_link_confirm', 'partner_driver_link_reject')
     AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'link review self-check 2: % of 2 are SECURITY DEFINER with a pinned search_path', v_n;
  END IF;

  -- 3. both ask the company and the drivers page themselves. Running past RLS
  --    means running past the role gate.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_driver_link_confirm', 'partner_driver_link_reject')
     AND p.prosrc LIKE '%current_role_permits(''drivers'', true)%'
     AND p.prosrc LIKE '%get_active_company_id()%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'link review self-check 3: one of the two lost its company or page gate';
  END IF;

  -- 4. the confirm claims in its own body. Split into a second client call, a
  --    lost response leaves submissions stranded beside a confirmed link and
  --    nothing retries.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_driver_link_confirm'
     AND p.prosrc LIKE '%partner_submission_claim_driver(v_link.id)%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'link review self-check 4: the confirm no longer claims the waiting submissions itself';
  END IF;

  -- 5. nothing here compares a name. The owner's decision of 06.10.2026, and
  --    this codebase has the scar: fuzzy matching once paid a month's salary to
  --    a driver nobody chose.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_driver_link_confirm', 'partner_driver_link_reject')
     AND (p.prosrc LIKE '%proposed_name%' OR p.prosrc LIKE '%similarity(%'
          OR p.prosrc LIKE '%levenshtein(%' OR p.prosrc LIKE '%ILIKE%');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'link review self-check 5: a link decision reads or compares a name';
  END IF;

  -- 6. the reject counts and does not write a submission. An automatic
  --    rejected_reason is a sentence no person wrote, shown to a person.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_driver_link_reject'
     AND (p.prosrc LIKE '%UPDATE public.partner_note_submissions%'
          OR p.prosrc LIKE '%UPDATE public.partner_receipt_submissions%');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'link review self-check 6: the reject now writes a submission';
  END IF;

  -- 7. the links table still has no INSERT policy: the writer is the partner
  --    door through a definer, and a client-insertable proposal would let a
  --    company invent a partner driver.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_driver_links'
     AND cmd IN ('INSERT', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'link review self-check 7: partner_driver_links gained an INSERT or DELETE policy';
  END IF;

  RAISE NOTICE 'partner link review: self-checks passed — a person decides, the claim is atomic, and no name is compared';
END
$check$;
