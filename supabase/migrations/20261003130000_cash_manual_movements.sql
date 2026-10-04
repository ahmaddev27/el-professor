/*
  # Manual cash entries: add cash, add a cash payment (Bargeldbestand)

  ## What this is

  The Bargeldbestand screen gets two buttons. "Bargeld hinzufügen" books cash
  that came into the till and is not a driver's Bargeld (an owner's top-up, an
  opening balance, a correction). "Barzahlung hinzufügen" books cash that left
  the till and is neither a Beleg nor a Gehaltsquittung (a purchase paid from
  the till, a withdrawal, a correction).

  Both are rows of `public.cash_movements`, the ledger the screen already
  reads, with two new source types: `manual_in` (direction in) and `manual_out`
  (direction out). The reading side already counts every movement by its
  direction, so the balance is Bargeld - Belege - (Gehaltsquittungen - Stornos)
  + manual in - manual out, and nothing touches `salary_payments`: "Bar zurueck"
  stays out of the till.

  ## Why an RPC and not a policy

  `authenticated` holds SELECT and nothing else on `cash_movements`, and that
  does not change: a client write policy would let any browser write the till.
  The one writer of the two new kinds is `public.record_cash_movement`, a
  SECURITY DEFINER function with its own gate, shaped like
  `confirm_salary_cash_payment`:

    - the caller's active company (`get_active_company_id()`), so a suspended
      or unsubscribed company writes nothing;
    - `current_role_permits('cash-balance', true)`: the page of this screen;
    - a platform account inside a context, in either mode, is refused with
      HINT `platform_session_not_allowed` - cash documents are never issued
      from a support session (owner decision 18.09.2026), and a till entry is
      the same kind of attestation;
    - idempotent on the client's request id: `source_id` is the request id and
      `UNIQUE (source_type, source_id)` makes a retry the same row.

  ## Compatibility

  Additive: a wider CHECK and a new function. The previous release reads an
  unknown source type as `other` and still counts its direction. No
  SCHEMA_EPOCH bump.
*/

ALTER TABLE public.cash_movements
  DROP CONSTRAINT IF EXISTS cash_movements_source_type_check;

ALTER TABLE public.cash_movements
  ADD CONSTRAINT cash_movements_source_type_check
  CHECK (source_type IN ('gehaltsquittung', 'gehaltsquittung_storno', 'manual_in', 'manual_out'));

CREATE FUNCTION public.record_cash_movement(
  p_request_id    uuid,
  p_direction     text,
  p_amount        numeric,
  p_movement_date date,
  p_description   text
)
RETURNS public.cash_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_company uuid := get_active_company_id();
  v_today   date := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_source  text;
  v_desc    text := btrim(COALESCE(p_description, ''));
  v_row     public.cash_movements%ROWTYPE;
BEGIN
  -- A platform account inside a context: a company and no membership.
  IF v_company IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_profiles up
                      WHERE up.user_id = v_caller AND up.company_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Kassenbuchungen werden nur im eigenen Unternehmen erfasst, nie aus einer Plattform-Sitzung heraus.'
      USING ERRCODE = '42501', HINT = 'platform_session_not_allowed';
  END IF;

  IF v_caller IS NULL OR v_company IS NULL OR NOT current_role_permits('cash-balance', true) THEN
    RAISE EXCEPTION 'Keine Berechtigung, den Bargeldbestand zu buchen.'
      USING ERRCODE = '42501', HINT = 'not_authorized';
  END IF;

  IF p_request_id IS NULL OR p_direction IS NULL OR p_direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'Die Anfrage ist unvollständig.'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount >= 10000000 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Der Betrag muss größer als 0 sein und darf höchstens zwei Nachkommastellen haben.'
      USING ERRCODE = '22023', HINT = 'invalid_amount';
  END IF;
  IF p_movement_date IS NULL OR p_movement_date > v_today OR p_movement_date < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'Das Datum fehlt oder liegt in der Zukunft.'
      USING ERRCODE = '22023', HINT = 'invalid_date';
  END IF;
  IF v_desc = '' OR length(v_desc) > 200 THEN
    RAISE EXCEPTION 'Bitte einen Verwendungszweck mit höchstens 200 Zeichen angeben.'
      USING ERRCODE = '22023', HINT = 'invalid_description';
  END IF;

  v_source := CASE p_direction WHEN 'in' THEN 'manual_in' ELSE 'manual_out' END;

  INSERT INTO public.cash_movements (
    company_id, direction, amount, movement_date, source_type, source_id, description, created_by
  ) VALUES (
    v_company, p_direction, p_amount, p_movement_date, v_source, p_request_id, v_desc, v_caller
  )
  ON CONFLICT (source_type, source_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- A retry of the same request must be the same entry in every field; the
  -- request id is globally unique, so a hit in another company is a conflict
  -- too and reveals nothing but that the id is taken.
  SELECT * INTO v_row FROM public.cash_movements
   WHERE source_type = v_source AND source_id = p_request_id;
  IF v_row.company_id IS DISTINCT FROM v_company
     OR v_row.amount IS DISTINCT FROM p_amount
     OR v_row.movement_date IS DISTINCT FROM p_movement_date
     OR v_row.description IS DISTINCT FROM v_desc THEN
    RAISE EXCEPTION 'Diese Anfrage wurde bereits für eine andere Buchung verwendet.'
      USING ERRCODE = 'P0001', HINT = 'request_id_conflict';
  END IF;
  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.record_cash_movement(uuid, text, numeric, date, text) IS
  'Books a manual cash entry (manual_in / manual_out) into cash_movements. The only writer of those two kinds; refuses a platform context; idempotent on p_request_id.';

REVOKE ALL ON FUNCTION public.record_cash_movement(uuid, text, numeric, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cash_movement(uuid, text, numeric, date, text) TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────
DO $check$
DECLARE
  v_oid oid := to_regprocedure('public.record_cash_movement(uuid, text, numeric, date, text)');
  v_def text;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'cash manual: function missing'; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'cash manual: record_cash_movement must be SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'cash manual: anon can execute record_cash_movement';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'cash manual: authenticated cannot execute record_cash_movement';
  END IF;
  IF has_table_privilege('authenticated', 'public.cash_movements', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cash_movements', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.cash_movements', 'DELETE')
     OR has_table_privilege('anon', 'public.cash_movements', 'INSERT') THEN
    RAISE EXCEPTION 'cash manual: a client role can write cash_movements directly';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cash_movements'
              AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'cash manual: cash_movements has a write policy';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF v_def !~ 'get_active_company_id' OR v_def !~ 'platform_session_not_allowed'
     OR v_def !~ 'current_role_permits' THEN
    RAISE EXCEPTION 'cash manual: a gate is missing from record_cash_movement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND proconfig IS NOT NULL) THEN
    RAISE EXCEPTION 'cash manual: search_path is not pinned';
  END IF;
END
$check$;
