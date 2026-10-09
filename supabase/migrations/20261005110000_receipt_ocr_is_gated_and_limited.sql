/*
  # Reading a receipt with an AI agent is gated, and it is counted

  `supabase/functions/extract-receipt` has been deployed and unreachable since it
  was written: nothing in `src/` calls it, and the deploy deliberately withholds
  `ANTHROPIC_API_KEY` from it. `deploy/docker-compose.yml` says why — it
  "performs no auth check while spending ANTHROPIC_API_KEY, so it is left
  without an API key rather than merely unrouted."

  The Reidey driver flow turns it on: the driver photographs a Beleg, an agent
  reads it, and the driver confirms the reading. That makes the gap live, so it
  is closed first. Measured against the function as it stands, there were five
  separate problems and only one of them was the missing session:

  1. **No authorization at all.** `main/index.ts` keeps it out of
     `PUBLIC_FUNCTIONS`, so the router requires a token this stack signed — but
     the anon key is such a token and it ships in the browser bundle. Every
     signed-in customer, and anyone who reads the bundle, could spend the key.
  2. `Access-Control-Allow-Origin: "*"`.
  3. `await req.json()` on an image body, with no cap of any kind.
  4. The catch returned `err.message` verbatim to the caller.
  5. No rate limit — and Kong applies none to `/functions/v1` either, so a
     per-caller budget has to live here, the way `otp_issue`'s does.

  This migration is parts 1 and 5: the identity the function asks about, and the
  budget it counts against. The function itself carries 2, 3 and 4.

  ## The budget

  `RECEIPT_OCR_PER_HOUR = 60` per account. A person photographing Belege works
  in bursts — a day's receipts at the end of a shift — so the window is an hour
  rather than a minute, and 60 is far above any real burst while bounding a
  runaway loop to a known cost. The number is a CONSTANT in the one function
  that enforces it, which is how every other limit in this codebase is written.

  Events are kept for the count and for seeing what was spent; `outcome` records
  refusals too, so a caller being refused is visible rather than silent.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The event log the budget is counted from
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_private.receipt_ocr_events (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- No FK to auth.users: an event must outlive a deleted account until a purge
  -- removes it, or deleting an account would reset its budget.
  user_id     uuid        NULL,
  company_id  uuid        NULL,
  outcome     text        NOT NULL CHECK (outcome IN
                ('allowed','rate_limited','not_authorized','no_company'))
);

CREATE INDEX IF NOT EXISTS receipt_ocr_events_user_time
  ON app_private.receipt_ocr_events (user_id, created_at DESC);

COMMENT ON TABLE app_private.receipt_ocr_events IS
  'One row per call to the receipt OCR endpoint, allowed or refused. The hourly '
  'budget in public.receipt_ocr_allow() is counted from it.';

REVOKE ALL ON app_private.receipt_ocr_events FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The gate: may this caller have a receipt read, and record that it asked
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.receipt_ocr_allow()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  RECEIPT_OCR_PER_HOUR CONSTANT int := 60;
  v_uid     uuid;
  v_company uuid;
  v_recent  int;
BEGIN
  v_uid := auth.uid();

  -- The anon key carries no subject. This is the check the function never had.
  IF v_uid IS NULL THEN
    INSERT INTO app_private.receipt_ocr_events (user_id, company_id, outcome)
    VALUES (NULL, NULL, 'not_authorized');
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- The same two questions the receipts table itself asks of a writer: a
  -- company whose state admits business data, and the role gate for that page.
  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    INSERT INTO app_private.receipt_ocr_events (user_id, company_id, outcome)
    VALUES (v_uid, NULL, 'no_company');
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  IF NOT public.current_role_permits('receipts', true) THEN
    INSERT INTO app_private.receipt_ocr_events (user_id, company_id, outcome)
    VALUES (v_uid, v_company, 'not_authorized');
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- Counted over allowed calls only: a refusal costs nothing, and counting
  -- refusals would let a refused caller lock out their own real work.
  SELECT count(*) INTO v_recent
    FROM app_private.receipt_ocr_events
   WHERE user_id = v_uid
     AND outcome = 'allowed'
     AND created_at > now() - interval '1 hour';

  IF v_recent >= RECEIPT_OCR_PER_HOUR THEN
    INSERT INTO app_private.receipt_ocr_events (user_id, company_id, outcome)
    VALUES (v_uid, v_company, 'rate_limited');
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  INSERT INTO app_private.receipt_ocr_events (user_id, company_id, outcome)
  VALUES (v_uid, v_company, 'allowed');

  RETURN jsonb_build_object('ok', true, 'company_id', v_company);
END;
$$;

COMMENT ON FUNCTION public.receipt_ocr_allow() IS
  'Whether the caller may have a receipt read by the AI agent: a real session, '
  'a company get_active_company_id() admits, the receipts role gate, and an '
  'hourly per-account budget. Records every call, refused or not. Returns a '
  'value and never raises, so a refusal still leaves its row.';

REVOKE ALL ON FUNCTION public.receipt_ocr_allow() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_ocr_allow() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Self-check
-- ─────────────────────────────────────────────────────────────────────────────

DO $check$
DECLARE
  r record;
BEGIN
  -- 1. no API role may reach the table (the app_private rule)
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role LOOP
    IF has_table_privilege(r.role, 'app_private.receipt_ocr_events', 'SELECT')
    OR has_table_privilege(r.role, 'app_private.receipt_ocr_events', 'INSERT') THEN
      RAISE EXCEPTION 'self-check 1: % can reach app_private.receipt_ocr_events', r.role;
    END IF;
  END LOOP;

  -- 2. anon cannot ask the gate; authenticated can
  IF has_function_privilege('anon', 'public.receipt_ocr_allow()', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 2: anon may execute receipt_ocr_allow';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.receipt_ocr_allow()', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 2: authenticated may not execute receipt_ocr_allow';
  END IF;

  -- 3. the gate still asks all three questions. A rewrite that drops one would
  --    reopen exactly what this migration closed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'receipt_ocr_allow'
       AND p.prosrc LIKE '%auth.uid()%'
       AND p.prosrc LIKE '%get_active_company_id()%'
       AND p.prosrc LIKE '%current_role_permits%'
  ) THEN
    RAISE EXCEPTION 'self-check 3: receipt_ocr_allow no longer asks session, company and role';
  END IF;

  -- 4. pinned search_path
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'receipt_ocr_allow'
       AND p.proconfig IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'self-check 4: receipt_ocr_allow has no pinned search_path';
  END IF;

  RAISE NOTICE 'receipt_ocr_allow: self-checks passed';
END
$check$;
