/*
  # The Belegnummer is drawn on the server, and our own shape is unique

  Prerequisite for the Reidey driver-receipt integration, and worth doing on its
  own. Today `generateUniqueReceiptNumber()` in `src/components/ReceiptModal.tsx`
  builds `BEL-<Date.now()>-<4 random digits>` **in the browser** and checks it for
  collisions against the `existingReceipts` array that tab happens to hold. There
  is no uniqueness in the database at all. With one writer that is merely
  optimistic; with a second writer — a partner API submitting a driver's receipt —
  a collision is a matter of time, and nothing would refuse it.

  ## What production actually holds, measured 05.10.2026

  1006 receipts, 4 companies, no NULL number, no NULL company.

  - **912** carry our generated shape `BEL-<digits>-<digits>`.
  - **94** do not: they carry the number printed on the merchant's own receipt
    (`7475/007/00001`, `128/5026/4314`, `11341`), one piece of OCR noise
    (`/hW7RIVAGIS`), and six rows where a German label from the paper was typed
    into the field instead of a number — `MWST` four times, `Kundennr.` twice.

  The field is an ordinary editable `Input` with only a non-empty check, so this
  is people typing, not a defect. The owner decided on 05.10.2026 to **leave it
  editable**: a merchant's number is useful, and two different merchants may
  legitimately issue the same one. So a unique constraint over the whole column
  would be wrong — it would refuse real work.

  ## Hence a PARTIAL unique index, over our own shape only

  `(company_id, receipt_number) WHERE receipt_number ~ '^BEL-[0-9]+-[0-9]+$'`.
  It protects the numbers this system issues and says nothing about the 94 a
  human typed.

  ## The two exemptions, and why they are named rather than cleaned

  Two pairs inside our own shape collide, and both are a double submit, not two
  receipts:

    BEL-1770624209411-6879  driver A  28.01.2026  44,96 EUR  Tanken
    BEL-1771166119677-4654  driver B  14.01.2026  30,00 EUR  Straffe

  (The two drivers are real people at one company and are not named here; this
  repository is public. The Belegnummern below are what the index and the
  self-check key on, and they are the only identifiers this migration needs.)

  Every field of each pair is identical and the two rows were created **118 ms
  and 41 ms apart**. Both are `payment_method = 'bar'`, so both sit in
  `abrechnung_weekly`, which filters exactly that — each driver's `bar_zuruck`
  for that week reads 44,96 and 30,00 EUR lower than it should, in the driver's
  favour, and the first also skews that driver's Tankenquote.

  **The owner decided on 05.10.2026 to leave those rows as they are.** The weeks
  are January 2026 and were long since settled with the drivers on the figure as
  it stood; correcting the books now would not recover money already handed over,
  and would make a past Abrechnung disagree with what both sides acted on.

  So the index names them. This is the repository's existing idiom for a known
  historical case — `tests/rls/assertions.sql` carries a recorded exemption
  keyed tightly enough that it cannot absorb a different defect, and fails when
  it stops matching anything. The same holds here: the exemption names two exact
  strings. A third collision is refused, and if these two rows are ever cleaned
  up the exemption becomes dead weight that self-check 3 will report.

  ## What else this changes

  `public.receipt_number_next(p_company_id uuid)` draws the number server-side,
  in the same shape, retrying against the index until it wins. `ReceiptModal`
  calls it instead of generating locally. The partner intake path will call the
  same function, so both writers draw from one place.

  Nothing is backfilled and no existing row is read, rewritten or deleted.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The partial unique index
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS receipts_company_generated_number_key
  ON public.receipts (company_id, receipt_number)
  WHERE receipt_number ~ '^BEL-[0-9]+-[0-9]+$'
    -- The two historical double submits of January 2026. Named exactly, so a
    -- third collision is still refused. See the header for why they stay.
    AND receipt_number <> 'BEL-1770624209411-6879'
    AND receipt_number <> 'BEL-1771166119677-4654';

COMMENT ON INDEX public.receipts_company_generated_number_key IS
  'Uniqueness for Belegnummern this system issues (BEL-<digits>-<digits>), per '
  'company. Numbers typed from a merchant receipt are deliberately outside it: '
  'two merchants may issue the same number. Two January 2026 double submits are '
  'named exemptions; see migration 20261005100000.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The generator
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.receipt_number_next(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid;
  v_number  text;
  v_taken   boolean;
BEGIN
  -- Running past RLS means running past the role gate too, so ask both here.
  v_company := public.get_active_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'caller has no company'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;
  IF NOT public.current_role_permits('receipts', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  -- The argument is a cross-check, not the authority: a caller may only draw a
  -- number for the company the session already resolves to.
  IF p_company_id IS NOT NULL AND p_company_id <> v_company THEN
    RAISE EXCEPTION 'company mismatch'
      USING ERRCODE = '42501', HINT = 'company_mismatch';
  END IF;

  -- The shape ReceiptModal has always produced, so nothing downstream has to
  -- learn a second one: BEL-<epoch millis>-<four digits>. The loop is what the
  -- browser's check only approximated -- it asks the database, under the index.
  FOR i IN 1..20 LOOP
    v_number := 'BEL-'
      || (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
      || '-'
      || lpad((floor(random() * 10000))::int::text, 4, '0');

    SELECT EXISTS (
      SELECT 1 FROM public.receipts
       WHERE company_id = v_company AND receipt_number = v_number
    ) INTO v_taken;

    IF NOT v_taken THEN
      RETURN v_number;
    END IF;
  END LOOP;

  -- Twenty collisions in a row is not luck; it is a defect somewhere else.
  RAISE EXCEPTION 'could not draw a free Belegnummer'
    USING ERRCODE = 'P0001', HINT = 'number_exhausted';
END;
$$;

COMMENT ON FUNCTION public.receipt_number_next(uuid) IS
  'Draws the next Belegnummer for the caller''s own company, in the shape '
  'BEL-<epoch millis>-<four digits>, checked against the partial unique index. '
  'Asks get_active_company_id() and current_role_permits(''receipts'') itself, '
  'because SECURITY DEFINER runs past both.';

REVOKE ALL ON FUNCTION public.receipt_number_next(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_number_next(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Self-check -- fails the release rather than shipping a half-applied slice
-- ─────────────────────────────────────────────────────────────────────────────

DO $check$
DECLARE
  v_def  text;
  v_dups int;
BEGIN
  -- 1. the index exists, is unique, and is partial on our own shape
  SELECT indexdef INTO v_def
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'receipts_company_generated_number_key';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'self-check 1: receipts_company_generated_number_key is missing';
  END IF;
  IF v_def NOT LIKE 'CREATE UNIQUE INDEX%' THEN
    RAISE EXCEPTION 'self-check 1: the index is not UNIQUE';
  END IF;
  IF position('BEL-[0-9]+-[0-9]+' IN v_def) = 0 THEN
    RAISE EXCEPTION 'self-check 1: the index is no longer partial on the generated shape';
  END IF;

  -- 2. anon cannot draw a number, authenticated can
  IF has_function_privilege('anon', 'public.receipt_number_next(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 2: anon may execute receipt_number_next';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.receipt_number_next(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check 2: authenticated may not execute receipt_number_next';
  END IF;

  -- 3. the exemption still matches something. If both rows are ever cleaned up
  --    this stops being a tolerated case and becomes dead text in an index
  --    predicate -- report it rather than let it rot.
  SELECT count(*) INTO v_dups
    FROM public.receipts
   WHERE receipt_number IN ('BEL-1770624209411-6879', 'BEL-1771166119677-4654');
  IF v_dups = 0 THEN
    RAISE WARNING 'self-check 3: the two named exemptions match no row any more; '
                  'drop them from receipts_company_generated_number_key';
  END IF;

  -- 4. the function pins its search_path (the app_private rule, applied here too)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'receipt_number_next'
       AND p.proconfig IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'self-check 4: receipt_number_next has no pinned search_path';
  END IF;

  RAISE NOTICE 'receipt_number_next: self-checks passed';
END
$check$;
