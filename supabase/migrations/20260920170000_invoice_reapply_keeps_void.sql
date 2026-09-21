/*
  # Re-applying an invoice keeps a period something else replaced

  Plan 3.F, a fix to U2 (20260919170000). Live on production since U2 was
  promoted on 19.09.2026, and harmless there only because nothing calls the
  invoice sweep yet. The owner has decided to install it; this is what blocked
  that.

  ## The defect

  `app_private.subscription_invoice_apply` looks up the invoice's coverage row
  with no condition on its status (20260919170000:358-362) and, for any invoice
  that is not cancelled, sets that row back to `status = 'active'`,
  `void_reason = NULL` (:413-421). Two things void such a row, and the function
  undid both:

    invoice_canceled   the invoice's own cancellation — this same function,
                       when the invoice reads `canceled` (:367-377)
    replaced           a manual edit. update_company_subscription_manual voids
                       every live row of the company, the invoice's included,
                       through subscription_coverage_record's p_replace
                       (20260919150000:514-520) or directly when it records no
                       date (:1393-1398)

  So: a paid invoice for the current month, then an administrator sets the
  company to `expired` in the Abo-Status modal — the invoice's period is voided
  as `replaced` and the company is refused. The nightly sweep,
  `app_private.subscription_invoices_apply_all()`, re-applies that invoice,
  finds the row, makes it active again, and the recompute admits the company.
  Every night. `tests/rls/subscriptions.sql` section 10a reproduces it against
  the old body: the sweep's first run leaves the company admitted.

  ## The rule

  A voided invoice period comes back in exactly two cases:

    1. its own invoice voided it (`void_reason = 'invoice_canceled'`) and that
       invoice is no longer cancelled. U2 decided "one invoice, one period", and
       re-paying an invoice revives its row rather than writing a second. Any
       caller may do this, the sweep included, because the void was the
       invoice's own and the invoice has changed back.
    2. it was voided as `replaced` and the caller is an **explicit payment of
       that invoice** — `platform_invoice_mark_paid`, the only caller that
       passes `p_reinstate => true`. The money arrived after the replacement,
       and paying an invoice extends access (U2, rule 1).

  Every other voided period is left exactly as it is — status, reason, dates,
  price and note — and the function answers `superseded` without writing
  anything or recomputing. That covers the sweep, a direct re-apply,
  `platform_invoice_mark_unpaid` (an act on the invoice that withdraws access
  must never grant it) and `platform_invoice_cancel` (whose branch is unchanged
  and already leaves a void row void). A void reason this file does not name —
  none exists today — is never revived: a new reason has to be admitted here on
  purpose.

  A void's cause is recorded in `subscription_coverage.void_reason`, which U1
  added with `CHECK ((status = 'void') = (void_reason IS NOT NULL))`
  (20260919150000:250, :264-265), and the two writers above already fill it
  with the two values. Nothing had to be added to the table.

  **The company is locked before the coverage row is read.** Every writer of
  `replaced` holds the company row FOR NO KEY UPDATE first
  (update_company_subscription_manual takes it at 20260919150000:1341, before
  it voids anything). Without the same lock here, a sweep racing a manual edit
  could read the row while it was still active and write it active after the
  edit committed — the defect again, by timing. Taking it first also puts the
  invoice RPCs and the manual edit in one lock order (company, then coverage),
  where before this function took a coverage row lock and then, through the
  recompute, the company's: the other order, and a deadlock the database would
  have had to break. The recompute takes the same lock again and already holds
  it.

  ## How the explicit payment is told apart

  By an argument, `p_reinstate boolean DEFAULT false`. The signature changes
  from (uuid) to (uuid, boolean), so the old function is dropped and the new
  one created: `CREATE OR REPLACE` with another argument list would add a
  second overload, and a one-argument call would then be ambiguous. The
  default is what every caller but one gets — the sweep, mark_unpaid and cancel
  call it with one argument and are not restated. `platform_invoice_mark_paid`
  is restated to pass `true`, with its body otherwise character for character
  20260919170000:554-637. The self-check fails a release where any other
  function passes a second argument.

  ## What it does not do

  - **HOLE[revival] stays open** (section 9b). That row was never voided — it
    had ended — and a period revived either way keeps the tier it was recorded
    at, exactly as before. Giving a revived period the company's current tier
    changes U2's "tier written at creation" rule and is the owner's decision
    (HANDOFF.md). This file changes which periods may come back, not what tier
    they carry.
  - **An invoice with no coverage row yet is applied as before.** An invoice
    paid before U2 went live, or generated and never touched since, has no row;
    the sweep's first run creates one, granting, whatever a manual edit said in
    the meantime. That is not a revival, and nothing records which came first.
    HANDOFF.md's dry run lists every company the sweep would admit; read it for
    exactly this before the cron line goes in.
  - The table's own UPDATE policy still lets a holder of billing.manage take an
    invoice out of `canceled` directly (20260917130000:776-779). That is how
    rule 1 above is reached without an RPC, and it is unchanged.

  ## What this changes, and when

  **At deploy: nothing, for anybody.** The file replaces two function bodies and
  writes no row, recomputes no company and applies no invoice. The only
  execution in it is the self-check's call with an invoice that does not exist,
  which answers `not_found` before it reads or locks anything.

  **Afterwards**, for a company whose invoice period a manual edit voided, a
  re-apply of that invoice — the sweep once it is wired — no longer admits it.
  An explicit payment of that invoice still does, as it did before. Nothing
  else moves: for a live row, a row with no coverage yet and a row its own
  cancellation voided, the new body does what the old one did.

  ## The wall and the catalogue (U3, 20260920120000)

  Neither function writes `companies`: the lock is a `PERFORM … FOR NO KEY
  UPDATE`, which assigns nothing and which `app_private.subscription_column_writes()`
  does not read as a write (the recompute has had the same statement since U1).
  So the set of writers of the five subscription columns is unchanged, and
  `tests/rls/subscriptions.sql` section 8 needs no change. The self-check asks
  the reader to confirm it for both functions.

  ## SCHEMA_EPOCH stays at 2

  The dropped signature is an `app_private` helper that no release's code
  calls: PostgREST cannot reach the schema, no edge function or screen names
  it, and the host has no cron line for the sweep yet. Its three callers in the
  database (the sweep, mark_unpaid, cancel) resolve to the new function through
  the default, and the fourth is restated here. A rollback re-activates the
  previous release's code, which reaches all of this only through the three
  invoice RPCs, whose signatures, grants and answers are unchanged — only the
  `coverage` value inside mark_unpaid's audit row can now read `superseded`.

  ## Rules followed

  Restated from the current bodies (20260919170000:327-427 and :554-637); the
  PR lists every behaviour of the old apply and where it is in the new one.
  Pinned `search_path`, SECURITY DEFINER, `REVOKE ALL FROM PUBLIC, anon,
  authenticated, service_role` on the helper and the RPC's own grant restated
  (EXECUTE for authenticated alone, 20260916130000:1407-1408), `ALTER FUNCTION …
  OWNER TO CURRENT_USER` on both (a CREATE OR REPLACE keeps the old owner, see
  tests/fixtures/owner-simulation.sql), and a self-check that can fail.
  Behaviour is asserted in `tests/rls/subscriptions.sql` section 10.
*/

-- ─── 1. The rule ────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS app_private.subscription_invoice_apply(uuid);

/*
  Read one invoice's current state and make its coverage row say the same thing,
  unless that row was voided by something other than the invoice's own
  lifecycle (see the header of this file).

  Answers what it did: 'paid', 'grace', 'canceled', 'not_found', or
  'superseded' for a voided row it is not allowed to bring back.

  Idempotent: the sweep calls it over every invoice. The first write of an
  invoice's row goes through U1's app_private.subscription_coverage_record; a
  later one updates that row in place, because the partial unique index on
  (company_id, source, source_id) keeps one row per invoice.

  Locks, in order: the invoice, then the company, then (by writing it) the
  coverage row. NO KEY UPDATE rather than FOR UPDATE for the reason
  salary_cash_receipts documents — a child row's foreign-key check holds a key
  share, and FOR UPDATE conflicts with it.

  `plan` is written when the row is created and never rewritten here;
  platform_company_set_plan owns that column on the coverage rows.
*/
CREATE FUNCTION app_private.subscription_invoice_apply(
  p_invoice_id uuid,
  p_reinstate  boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inv          public.subscription_invoices%ROWTYPE;
  v_existing     uuid;
  v_row_status   text;
  v_void_reason  text;
  v_revivable    boolean;
  v_first_day    date;
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_grace_end    timestamptz;
  v_end          timestamptz;
  v_cents        bigint;
  v_note         text;
  v_plan         text;
BEGIN
  IF p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'subscription_invoice_apply: p_invoice_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_reinstate IS NULL THEN
    RAISE EXCEPTION 'subscription_invoice_apply: p_reinstate must be true or false' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inv
    FROM public.subscription_invoices
   WHERE id = p_invoice_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- The company before its coverage row: every writer that voids a row as
  -- replaced holds this lock while it does, so the row read below is never one
  -- a concurrent manual edit is about to void, or has voided unseen.
  PERFORM 1 FROM public.companies WHERE id = v_inv.company_id FOR NO KEY UPDATE;

  SELECT c.id, c.status, c.void_reason
    INTO v_existing, v_row_status, v_void_reason
    FROM public.subscription_coverage c
   WHERE c.company_id = v_inv.company_id
     AND c.source     = 'invoice'
     AND c.source_id  = v_inv.id;

  -- Rule 3. The invoice row stays exactly as it is; the access it bought does
  -- not. A void keeps the period it withdrew, dates and all, because voiding is
  -- a correction and a correction does not rewrite history (U1, section 1).
  IF v_inv.status = 'canceled' THEN
    IF v_existing IS NOT NULL THEN
      UPDATE public.subscription_coverage
         SET status      = 'void',
             void_reason = 'invoice_canceled'
       WHERE id = v_existing
         AND status <> 'void';
      PERFORM app_private.recompute_company_subscription(v_inv.company_id);
    END IF;
    RETURN 'canceled';
  END IF;

  -- A voided row comes back only when its own invoice voided it, or when an
  -- explicit payment of that invoice brings back a replaced one. Anything else
  -- was somebody's decision about the company, and it stands: nothing is
  -- written and nothing is recomputed. NULL-safe on purpose, so an unexpected
  -- value can only keep a row void.
  v_revivable := v_void_reason IS NOT DISTINCT FROM 'invoice_canceled'
                 OR (p_reinstate AND v_void_reason IS NOT DISTINCT FROM 'replaced');
  IF v_row_status IS NOT DISTINCT FROM 'void' AND NOT v_revivable THEN
    RETURN 'superseded';
  END IF;

  -- The calendar month the invoice names, in the product's own zone. The same
  -- expression as scripts/reports/subscription-conflicts.sql:137-140.
  v_first_day    := make_date(v_inv.invoice_year, v_inv.invoice_month, 1);
  v_period_start := v_first_day::timestamp AT TIME ZONE 'Europe/Berlin';
  v_period_end   := (v_first_day + interval '1 month') AT TIME ZONE 'Europe/Berlin';
  v_grace_end    := app_private.invoice_grace_end(v_inv.due_date);

  IF v_inv.status = 'paid' THEN
    -- greatest(): a due date on the 28th plus two business days can land after
    -- the month ends, and paying must never shorten what being open granted.
    v_end  := greatest(v_period_end, v_grace_end);
    v_note := 'Rechnung ' || v_inv.invoice_number || ': bezahlt, Zeitraum abgedeckt';
  ELSE
    -- greatest(): a due date before the month it invoices is a data error, and
    -- the period must still run forwards for the table's CHECK. Such a row ends
    -- where it starts and grants nothing.
    v_end  := greatest(v_grace_end, v_period_start);
    v_note := 'Rechnung ' || v_inv.invoice_number || ': offen, Zugang bis zum Ende der Zahlungsfrist';
  END IF;

  -- The one conversion. `amount` is numeric euros, the column's unit.
  v_cents := round(v_inv.amount * 100)::bigint;

  IF v_existing IS NULL THEN
    SELECT CASE WHEN co.plan IN ('basic', 'advanced', 'premium') THEN co.plan END
      INTO v_plan
      FROM public.companies co
     WHERE co.id = v_inv.company_id;

    -- U1's recorder, which recomputes the company itself.
    PERFORM app_private.subscription_coverage_record(
      v_inv.company_id, 'invoice', v_inv.id,
      v_period_start, v_end, true, v_plan, v_cents, v_note, false);
  ELSE
    UPDATE public.subscription_coverage
       SET period_start  = v_period_start,
           period_end    = v_end,
           grants_access = true,
           price_cents   = v_cents,
           status        = 'active',
           void_reason   = NULL,
           note          = v_note
     WHERE id = v_existing;
    PERFORM app_private.recompute_company_subscription(v_inv.company_id);
  END IF;

  RETURN CASE WHEN v_inv.status = 'paid' THEN 'paid' ELSE 'grace' END;
END;
$$;

COMMENT ON FUNCTION app_private.subscription_invoice_apply(uuid, boolean) IS
  'Plan 3.F U2: makes one invoice''s subscription_coverage row say what the '
  'invoice says — the calendar month when paid, the due date plus the grace '
  'while open, voided when cancelled — and recomputes the company. A row voided '
  'as replaced comes back only with p_reinstate (an explicit payment); any other '
  'void but the invoice''s own cancellation is never revived (20260920170000).';

-- Nobody the API authenticates as reaches app_private, and the REVOKE is the
-- second wall: a new function is executable by PUBLIC by default, and this one
-- is new.
REVOKE ALL ON FUNCTION app_private.subscription_invoice_apply(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION app_private.subscription_invoice_apply(uuid, boolean) OWNER TO CURRENT_USER;

-- ─── 2. The explicit payment ────────────────────────────────────────────────

/*
  20260919170000:554-637, character for character, but for one argument: the
  call to the rule passes p_reinstate => true, because a payment entered for
  this invoice is the one act that may bring back a period a manual edit
  replaced. Everything its U2 header lists is carried over: billing.manage
  through platform_rpc_authorize with a NULL company before anything is read;
  FOR NO KEY UPDATE and 'not_found'; the 'invalid' branch for a NULL id or an
  amount at or below zero; 'paid' and 'canceled' refused as 'invalid_status';
  cents to euros once, round(p_amount_cents::numeric / 100, 2); paid_at
  defaulting to now(), paid_by and collected_by the actor, the trimmed note;
  the trail row 'marked_paid_cash' with its German wording; one audit row
  through platform_rpc_finish with the same before and after keys.
*/
CREATE OR REPLACE FUNCTION public.platform_invoice_mark_paid(
  p_invoice_id   uuid,
  p_amount_cents bigint,
  p_paid_at      timestamptz DEFAULT NULL,
  p_note         text        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'invoice.mark_paid';
  v_actor   uuid := auth.uid();
  v_invoice public.subscription_invoices%ROWTYPE;
  v_amount  numeric;
  v_paid_at timestamptz := coalesce(p_paid_at, now());
  v_name    text;
  v_email   text;
  v_applied text;
  v_cov_end timestamptz;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            NULL, 'subscription_invoice', p_invoice_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_invoice_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', NULL, 'subscription_invoice', p_invoice_id::text,
                                           NULL, jsonb_build_object('amount_cents', p_amount_cents));
  END IF;

  SELECT * INTO v_invoice FROM public.subscription_invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'subscription_invoice', p_invoice_id::text, NULL, NULL);
  END IF;
  -- The screen offers the action only for an invoice that is neither paid nor canceled.
  IF v_invoice.status IN ('paid', 'canceled') THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid_status', v_invoice.company_id,
                                           'subscription_invoice', p_invoice_id::text, NULL,
                                           jsonb_build_object('status', v_invoice.status));
  END IF;

  v_amount := round(p_amount_cents::numeric / 100, 2);

  SELECT up.full_name, up.email INTO v_name, v_email
    FROM public.user_profiles up
   WHERE up.user_id = v_actor
   LIMIT 1;

  UPDATE public.subscription_invoices
     SET status               = 'paid',
         paid_at              = v_paid_at,
         paid_by              = v_actor,
         collected_by         = v_actor,
         cash_received_amount = v_amount,
         receipt_note         = nullif(trim(p_note), '')
   WHERE id = p_invoice_id;

  INSERT INTO public.subscription_payment_audit
    (invoice_id, company_id, action, old_status, new_status, amount, changed_by, note)
  VALUES
    (p_invoice_id, v_invoice.company_id, 'marked_paid_cash', v_invoice.status, 'paid', v_amount, v_actor,
     coalesce(nullif(trim(p_note), ''),
              format('Barzahlung von %s erfasst', coalesce(nullif(v_name, ''), nullif(v_email, ''), 'Admin'))));

  -- Plan 3.F U2, rule 1: the paid period becomes coverage and the recompute
  -- writes the company's state back. `true`: a payment entered for this
  -- invoice may bring back its period even where a manual edit replaced it
  -- (20260920170000). Everything above this line is unchanged.
  v_applied := app_private.subscription_invoice_apply(p_invoice_id, true);
  SELECT c.period_end INTO v_cov_end
    FROM public.subscription_coverage c
   WHERE c.company_id = v_invoice.company_id AND c.source = 'invoice'
     AND c.source_id = p_invoice_id AND c.status = 'active';

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_invoice.company_id,
                                         'subscription_invoice', p_invoice_id::text,
                                         jsonb_build_object('status', v_invoice.status),
                                         jsonb_build_object('status', 'paid', 'amount_cents', p_amount_cents,
                                                            'paid_at', v_paid_at,
                                                            'coverage', v_applied,
                                                            'coverage_period_end', v_cov_end));
END;
$$;

-- CREATE OR REPLACE keeps both the grants and the owner; they are restated so
-- this file does not lean on an earlier one. The platform screens call it
-- signed in and nothing else does (20260916130000:1407-1408).
REVOKE ALL ON FUNCTION public.platform_invoice_mark_paid(uuid, bigint, timestamptz, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_invoice_mark_paid(uuid, bigint, timestamptz, text) TO authenticated;
ALTER FUNCTION public.platform_invoice_mark_paid(uuid, bigint, timestamptz, text) OWNER TO CURRENT_USER;

-- ─── 3. Self-check ──────────────────────────────────────────────────────────

-- Tripwires, as U1's, U2's and U3's are. What the rule does is asserted in
-- tests/rls/subscriptions.sql section 10.
DO $mig$
DECLARE
  c_apply  CONSTANT text := 'app_private.subscription_invoice_apply(uuid,boolean)';
  c_old    CONSTANT text := 'app_private.subscription_invoice_apply(uuid)';
  c_paid   CONSTANT text := 'public.platform_invoice_mark_paid(uuid,bigint,timestamptz,text)';
  c_reader CONSTANT text := 'app_private.subscription_column_writes()';
  v_sig    text;
  v_role   text;
  v_txt    text;
  v_answer text;
  v_lock   integer;
  v_read   integer;
BEGIN
  -- 1. the rule has one signature. A surviving one-argument overload would make
  --    every one-argument call ambiguous, and would keep the old rule callable.
  IF to_regprocedure(c_apply) IS NULL THEN
    RAISE EXCEPTION '20260920170000 self-check: % is missing', c_apply;
  END IF;
  IF to_regprocedure(c_old) IS NOT NULL THEN
    RAISE EXCEPTION '20260920170000 self-check: % still exists beside %', c_old, c_apply;
  END IF;

  -- 2. both functions are SECURITY DEFINER, pin their search_path, and are
  --    owned by a role that reaches app_private and is not one the U3 wall
  --    refuses (see tests/fixtures/owner-simulation.sql, and PR #25)
  FOREACH v_sig IN ARRAY ARRAY[c_apply, c_paid] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION '20260920170000 self-check: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260920170000 self-check: % has no pinned search_path', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1
                     FROM pg_proc p
                     JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND (r.rolsuper
                           OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))
                      AND r.rolname::text <> ALL (ARRAY['anon', 'authenticated', 'service_role'])) THEN
      RAISE EXCEPTION '20260920170000 self-check: the owner of % can reach no app_private helper, or is an API role', v_sig;
    END IF;
  END LOOP;

  -- 3. the grants: nobody the API authenticates as calls the rule, and the RPC
  --    keeps exactly the grants it had
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, c_apply::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '20260920170000 self-check: % may call %', v_role, c_apply;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', c_paid::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', c_paid::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', c_paid::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '20260920170000 self-check: % no longer has exactly the grant authenticated holds', c_paid;
  END IF;

  -- 4. the explicit payment is the one caller that brings a replaced period
  --    back
  IF app_private.function_code(c_paid) !~ 'subscription_invoice_apply\(\s*p_invoice_id\s*,\s*true\s*\)' THEN
    RAISE EXCEPTION '20260920170000 self-check: % no longer passes p_reinstate => true', c_paid;
  END IF;
  --    …and no other function passes a second argument: the sweep, re-opening
  --    and cancelling must never revive what a manual edit replaced. The
  --    candidates are fixed first, MATERIALIZED, because a planner free to
  --    order the predicates would hand function_code an extension's C function
  --    from another schema, whose signature does not resolve here.
  WITH candidates AS MATERIALIZED (
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language  l ON l.oid = p.prolang
     WHERE n.nspname IN ('public', 'app_private')
       AND l.lanname IN ('plpgsql', 'sql')
       AND p.prokind IN ('f', 'p')
       AND p.oid <> to_regprocedure(c_paid)
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  )
  SELECT string_agg(c.sig, ', ' ORDER BY c.sig)
    INTO v_txt
    FROM candidates c
   WHERE app_private.function_code(c.sig) ~ 'subscription_invoice_apply\s*\([^)]*,';
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '20260920170000 self-check: only platform_invoice_mark_paid may pass p_reinstate, and these call the rule with two arguments: %', v_txt;
  END IF;

  -- 5. the company is locked before the coverage row is read, or a sweep
  --    racing a manual edit revives the row the edit is voiding
  v_txt  := app_private.function_code(c_apply);
  v_lock := strpos(v_txt, 'FROM public.companies WHERE id = v_inv.company_id FOR NO KEY UPDATE');
  v_read := strpos(v_txt, 'FROM public.subscription_coverage c');
  IF v_lock = 0 OR v_read = 0 OR v_lock > v_read THEN
    RAISE EXCEPTION '20260920170000 self-check: % no longer locks the company before it reads the coverage row', c_apply;
  END IF;

  -- 6. a one-argument call still resolves — the form the sweep, mark_unpaid and
  --    cancel use — and answers for an invoice that does not exist without
  --    reading or locking anything else. This is the only call in this file.
  v_answer := app_private.subscription_invoice_apply('00000000-0000-0000-0000-000000000000'::uuid);
  IF v_answer IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION '20260920170000 self-check: a one-argument call answered % for an invoice that does not exist', v_answer;
  END IF;

  -- 7. neither function writes a subscription column of companies, as U3's
  --    reader sees them, so its list of sanctioned writers still holds
  IF to_regprocedure(c_reader) IS NULL THEN
    RAISE EXCEPTION '20260920170000 self-check: % is missing — this file needs U3 (20260920120000) applied first', c_reader;
  END IF;
  SELECT string_agg(w.routine::text || ' writes ' || w.column_name, ', ')
    INTO v_txt
    FROM app_private.subscription_column_writes() w
   WHERE w.routine::oid IN (to_regprocedure(c_apply)::oid, to_regprocedure(c_paid)::oid);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '20260920170000 self-check: %; the U3 list of sanctioned writers would no longer hold', v_txt;
  END IF;

  RAISE NOTICE '20260920170000 self-check: passed';
END $mig$;
