/*
  # One subscription model, step U2: the invoice and payment functions

  Plan 3.F, step U2. U0 was the read-only report
  (`scripts/reports/subscription-conflicts.sql`), U1 the coverage table and the
  recompute (`20260919150000`), U3 removes the direct writes. U3 does not start
  here.

  ## What this is for

  U1 left `subscription_coverage` with no `invoice` rows at all, by rule: the
  owner had not given a grace period, so paying extended nothing and being
  overdue locked nothing. U1's self-check 9 pins that for its own release.

  He gave it on 18.09.2026, and this file is the three rules he gave:

  1. **Paying an invoice extends access.** The paid invoice records coverage for
     the period it is for, and the recompute derives the company's state from it.
  2. **Grace: two business days after the due date, then access closes.** Two
     *business* days, so a Friday due date does not close on a Sunday.
  3. **Cancelling an invoice withdraws the coverage it granted.** Cancelling
     stays allowed and the invoice row stays on record; what goes is the access
     it bought.

  ## The period an invoice covers, and the evidence for it

  `subscription_invoices` carries `invoice_month` (CHECK 1..12) and
  `invoice_year` (CHECK >= 2020), and `UNIQUE (company_id, invoice_month,
  invoice_year)` — one invoice per company per calendar month
  (`20260607125649:150-169`). There is no other period column: no
  `period_start`, no `period_end`, no `service_from`. So **an invoice covers the
  calendar month it names**, and this file maps it exactly as the U0 report
  already did (`scripts/reports/subscription-conflicts.sql:134-143`):

      period_start = make_date(invoice_year, invoice_month, 1)      Europe/Berlin
      period_end   = that day + 1 month                             Europe/Berlin

  Europe/Berlin because that is the product's own zone (`vitest.config.ts` pins
  it for the same reason) and because the U0 report, the only other place this
  mapping exists, uses it. A month boundary read in UTC would move every period
  by one or two hours and put a payment made late on the last day of a month in
  the wrong one.

  `company_subscriptions.starts_at` and `.ends_at` are **not** consulted. U0's
  class 08 finds an invoice whose month lies outside its own subscription row's
  term, and one such invoice exists on production. The rule here is the
  invoice's own month, so that invoice — if it is ever paid, cancelled or
  re-opened through one of the three RPCs below — grants exactly its own month
  and nothing is reconciled against the subscription row. That is deliberate:
  the invoice is what the customer was billed for and what the customer paid,
  the subscription row's term is a separate record that U0 already reports as
  inconsistent, and silently trusting the term would refuse a period the
  customer has paid for. It is named here rather than fixed because deciding
  which of the two records is wrong is the owner's, not this slice's.

  ## What "due" means

  `subscription_invoices.due_date` is `date NOT NULL` (`20260607125649:161`).
  There is no due *timestamp* and none is invented. `GenerateInvoicesModal.tsx:78`
  is what writes it — `new Date(year, month - 1, Math.min(sub.billing_day, 28))`
  — so the due date is a day **inside** the month being invoiced, never after
  it. `InvoiceDetailModal.tsx:41` and `SubscriptionBillingPage.tsx:196` both read
  it the same way, `status === 'open' && new Date(due_date) < new Date()`.

  A `date` has no time of day, so the grace end is midnight Europe/Berlin at the
  end of the counting, which gives the customer the whole of the due day and the
  whole of each business day counted after it.

  ## Why an open invoice grants, and what that costs

  Because the due date sits inside the invoiced month, "access closes two
  business days after the due date" can only be a statement about an invoice
  that is **not** paid — a paid one covers its whole month, which ends long
  after its own due date. And for access to *close* on that day it has to be
  open until then. So:

      status 'open' or 'overdue'   grants [period_start, due + 2 business days)
      status 'paid'                grants [period_start, max(period_end, due + 2 business days))
      status 'canceled'            the row is voided (rule 3)

  One row per invoice, keyed by U1's partial unique index on
  `(company_id, source, source_id)`, so re-applying an invoice moves its row
  instead of adding a second one.

  `greatest(...)` on the paid branch is not decoration: `billing_day` may be as
  late as the 28th, and 28 February plus two business days is in March. Without
  it, marking such an invoice paid would **shorten** the access its open state
  had already granted.

  ## What this changes for a company, and when

  **At the moment of deploy: nothing, for anybody.** This file writes no
  coverage row. It backfills nothing, it touches no invoice, and it recomputes
  no company. Every function below acts on one invoice at a time, and only when
  something calls it. The before/after access gate U1 had to build has no work
  to do here, and that is a property of this file rather than a claim about it:
  it contains no `UPDATE public.companies`, no `INSERT INTO
  public.subscription_coverage` outside a function body, and no loop over
  `public.companies`.

  **Afterwards, an invoice-sourced row can only ever add.** The recompute takes
  `max(period_end)` over a company's live granting rows (`20260919150000:385-409`),
  so a row an invoice writes can raise a company's expiry and can never lower
  it. The two ways access is taken away are both deliberate acts on one
  invoice: `platform_invoice_cancel` voids that invoice's row, and
  `platform_invoice_mark_unpaid` shrinks it from the month to the grace window.
  Neither can reach a row this release did not write, because no row for an
  older invoice exists.

  **So "a company loses access two business days after its invoice was due" is
  the steady state, not this release.** It becomes true for a company once the
  invoice rows are the furthest-reaching coverage it has — that is, once the
  `migration` row U1 carried it in on has expired and its invoices are what it
  runs on. Until then the U1 row outranks them, by the same `max`.

  **The one thing still to decide is the sweep.**
  `app_private.subscription_invoices_apply_all()` below applies the rule to
  every invoice already in the table. **Nothing calls it**, exactly as
  `app_private.recompute_all_company_subscriptions()` is callable and unwired
  since U1. Running it is an operational act, and its effect is monotone in the
  same way: it can grant, never withdraw, because it writes a row for every
  invoice that is not cancelled and voids a row only for one that is — and for
  a cancelled invoice no row exists to void. Wiring it (with the U1 sweep) into
  `deploy/otp-housekeeping.sh` is what makes rule 2 continuous for invoices
  nobody touches, and it is a step on the host, not a release. HANDOFF.md
  carries it.

  ## Where the grace number lives

  In one place: `app_private.subscription_grace_business_days()`, a `CONSTANT`
  in the one function that answers for it, which is the shape every other limit
  in this codebase already has — the OTP validity, the attempt count, the
  cooldown, `PASSWORD_PROOF_MAX_AGE_SECONDS`. No call site writes a 2.
  `app_private.invoice_grace_end(date)` is the only caller, and self-check 5
  fails a release where it stops asking.

  **It is deliberately not a `platform_settings` key yet**, although the
  `invoice` document added by `20260919120000` is where it will belong. That
  document's validator demands an exact key set
  (`20260919120000:296-298`), so adding a field means re-stating
  `app_private.platform_settings_problem_3_10`, raising the row's `version`, and
  editing four places in `tests/rls/settings.sql` that pin the key set and the
  version — for a knob with no screen to turn it, since the Einstellungen editor
  is plan 3.10's second half. Moving it there is a one-function change when that
  screen is built: replace this function's body with the read
  `app_private.signup_trial_days()` already demonstrates, and nothing else moves.
  HANDOFF.md carries that too.

  ## Business days are Monday to Friday, and nothing else

  No public holiday is subtracted. There is no holiday table in the database;
  the two that exist are TypeScript, they cover different sets, and they
  disagree with each other every year (CLAUDE.md, "Two holiday tables still
  disagree"). Choosing between them here would mean choosing a Bundesland for
  every company, which nothing records. A holiday therefore shortens the grace
  by one working day, in the customer's disfavour by at most a day or two, and
  that is written down rather than approximated.

  ## Money

  Integer cents in the coverage row, as rule 4 of U1 requires, and **the
  conversion happens in exactly one place**: `app_private.subscription_invoice_apply`,
  as `round(subscription_invoices.amount * 100)::bigint`. The invoice column is
  `numeric` euros, which is that column's unit and has been since
  `20260607125649:157`. `platform_invoice_mark_paid` converts the other way for
  the column it writes — `round(p_amount_cents::numeric / 100, 2)` into
  `cash_received_amount` — and that line is carried over untouched below.

  The coverage price is the invoice's `amount`, not `cash_received_amount`. The
  amount is what the period cost; what was handed over may be more or less, and
  a period that cost 49,00 € does not become a period that cost 50,00 €
  because the customer had no change.

  ## SCHEMA_EPOCH stays at 2

  Expansive. Three functions keep their signatures, their reasons, their answer
  shape and every column they write; five functions are added. A rollback
  re-activates the previous release's code against this database, and that code
  calls these three RPCs with the same arguments and reads `success`, `reason`
  and `error` out of the same answer. The extra keys in the audit payload are
  read by nothing. The coverage rows this release writes stay, and the previous
  release reads their effect through `companies.subscription_status` and
  `.subscription_expires_at` exactly as it reads every other period's.

  ## Rules followed

  Pinned `search_path` on every function, `SECURITY DEFINER` where it reaches
  `app_private`, `REVOKE ALL FROM PUBLIC, anon, authenticated` with a grant only
  to the role meant to call it, `ALTER FUNCTION … OWNER TO CURRENT_USER` for
  everything that reaches `app_private` (a `CREATE OR REPLACE` keeps the old
  owner, and on the real databases several of these belong to `postgres`, which
  holds no USAGE there — see tests/fixtures/owner-simulation.sql), one
  `app_private.audit_write` row per platform write, and a self-check that can
  fail.

  The self-check is a set of narrow tripwires and nothing more. Everything
  behavioural is in `tests/rls/subscriptions.sql`, section 5, and the header of
  that file records why the division is drawn there and what four rounds of
  false failures taught U1. `app_private.function_code()` and
  `app_private.companies_set_clauses()` are U1's and are reused rather than
  rewritten.
*/

-- ─── 1. The grace, in one named place ───────────────────────────────────────

/*
  Two business days, the owner's number of 18.09.2026.

  A function rather than a literal so that there is one name to grep, one place
  to change, and something the RLS kit can assert against without reading a
  function body as text. When plan 3.10's settings editor is built this body
  becomes a read of the `invoice` settings document, the way
  `app_private.signup_trial_days()` reads the `trial` one, and no caller changes.
*/
CREATE OR REPLACE FUNCTION app_private.subscription_grace_business_days()
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_grace_business_days CONSTANT integer := 2;
BEGIN
  RETURN c_grace_business_days;
END;
$$;

COMMENT ON FUNCTION app_private.subscription_grace_business_days() IS
  'Plan 3.F U2: the grace an unpaid invoice gets after its due date, in business '
  'days. The one place the number lives; no call site writes it.';

/*
  p_from plus p_days business days, Monday to Friday, no public holidays (see
  the header). Counting starts the day after p_from, so zero business days is
  p_from itself and the due day is never spent.

  The step cap is a guard against a loop that cannot terminate, not a business
  rule: 30 business days is at most 42 calendar days, so 400 can only be reached
  by a defect.
*/
CREATE OR REPLACE FUNCTION app_private.add_business_days(p_from date, p_days integer)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_steps CONSTANT integer := 400;
  v_date  date    := p_from;
  v_left  integer := p_days;
  v_steps integer := 0;
BEGIN
  IF p_from IS NULL OR p_days IS NULL OR p_days < 0 THEN
    RAISE EXCEPTION 'add_business_days: invalid arguments' USING ERRCODE = '22023';
  END IF;

  WHILE v_left > 0 LOOP
    v_date  := v_date + 1;
    v_steps := v_steps + 1;
    IF v_steps > c_max_steps THEN
      RAISE EXCEPTION 'add_business_days: runaway loop' USING ERRCODE = '22023';
    END IF;
    -- ISO day of week: 6 is Saturday and 7 is Sunday. Everything below is a
    -- working day.
    IF extract(isodow FROM v_date) < 6 THEN
      v_left := v_left - 1;
    END IF;
  END LOOP;

  RETURN v_date;
END;
$$;

/*
  The instant an unpaid invoice stops granting: midnight Europe/Berlin at the
  end of the grace. A due date of Friday answers Tuesday 00:00, so the customer
  holds Friday, Saturday, Sunday and Monday in full — which is the case the
  owner named.

  STABLE rather than IMMUTABLE: it reads no clock and no row, but a zone
  conversion is not something to promise immutability for.
*/
CREATE OR REPLACE FUNCTION app_private.invoice_grace_end(p_due_date date)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_due_date IS NULL THEN
    RAISE EXCEPTION 'invoice_grace_end: p_due_date is required' USING ERRCODE = '22023';
  END IF;
  RETURN app_private.add_business_days(p_due_date, app_private.subscription_grace_business_days())::timestamp
           AT TIME ZONE 'Europe/Berlin';
END;
$$;

-- ─── 2. The rule: one invoice, one coverage row ─────────────────────────────

/*
  Read one invoice's current state and make its coverage row say the same thing.
  The whole of U2's behaviour is here; the three RPCs below call it and add
  nothing of their own.

  Answers what it did — 'paid', 'grace', 'canceled' or 'not_found' — so a caller
  can put the outcome in its audit row without asking a second question.

  Idempotent, and it has to be: the sweep calls it over every invoice, and each
  of the three RPCs calls it after a change that may repeat. The first write of
  an invoice's row goes through U1's `app_private.subscription_coverage_record`,
  which is the one recorder; a later one updates that row in place, because
  `subscription_coverage_record` always inserts and the partial unique index on
  `(company_id, source, source_id)` is what keeps one row per invoice.

  Two writers cannot interleave on one invoice: the row is taken FOR NO KEY
  UPDATE first, which serialises every path into this function per invoice, and
  NO KEY UPDATE rather than FOR UPDATE for the reason salary_cash_receipts
  documents — a child row's foreign-key check holds a key share, and FOR UPDATE
  conflicts with it.

  `plan` is written when the row is created and never rewritten here.
  `platform_company_set_plan` owns that column on the coverage rows
  (20260919150000:1495-1502) and carries a tier onto every live granting period
  that has not ended; rewriting it on each apply would put the company's current
  tier onto a period that was bought at another one.
*/
CREATE OR REPLACE FUNCTION app_private.subscription_invoice_apply(p_invoice_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inv          public.subscription_invoices%ROWTYPE;
  v_existing     uuid;
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

  SELECT * INTO v_inv
    FROM public.subscription_invoices
   WHERE id = p_invoice_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  SELECT c.id INTO v_existing
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

COMMENT ON FUNCTION app_private.subscription_invoice_apply(uuid) IS
  'Plan 3.F U2: makes one invoice''s subscription_coverage row say what the '
  'invoice says — the calendar month when paid, the due date plus the grace '
  'while open, voided when cancelled — and recomputes the company.';

/*
  The sweep, for a job runner to call. **Nothing calls it**, and that is
  deliberate: this release changes nobody's access, and applying the rule to the
  invoices already in the table is a decision rather than a side effect of a
  deploy. `app_private.recompute_all_company_subscriptions()` has stood the same
  way since U1.

  Its effect is monotone: every invoice that is not cancelled gets a granting
  row, and a cancelled one has no row to void on the first run, so the sweep can
  raise a company's expiry and can never lower it.

  Wiring it, with U1's recompute, into deploy/otp-housekeeping.sh is the step
  that makes rule 2 continuous for an invoice nobody marks paid — that file is
  installed on the host by hand and a release does not replace it.
*/
CREATE OR REPLACE FUNCTION app_private.subscription_invoices_apply_all()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id    uuid;
  v_count integer := 0;
BEGIN
  FOR v_id IN SELECT i.id FROM public.subscription_invoices i ORDER BY i.id LOOP
    PERFORM app_private.subscription_invoice_apply(v_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ─── 3. Grants and ownership ────────────────────────────────────────────────

-- Nobody the API authenticates as reaches app_private, and the REVOKE is the
-- second wall: EXECUTE-to-PUBLIC on a new function is a built-in default that
-- cannot be revoked per schema.
REVOKE ALL ON FUNCTION app_private.subscription_grace_business_days()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.add_business_days(date, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.invoice_grace_end(date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.subscription_invoice_apply(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.subscription_invoices_apply_all()
  FROM PUBLIC, anon, authenticated, service_role;

-- Their callers are SECURITY DEFINER functions owned by the role running this
-- migration, which already holds USAGE on app_private; they reach these as
-- their own owner and need no grant of their own.
ALTER FUNCTION app_private.subscription_grace_business_days() OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.add_business_days(date, integer)   OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.invoice_grace_end(date)            OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.subscription_invoice_apply(uuid)   OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.subscription_invoices_apply_all()  OWNER TO CURRENT_USER;

-- ─── 4. The three invoice RPCs ──────────────────────────────────────────────

/*
  Each is `20260916130000`'s body with **one** addition and no other change:
  after the invoice row is written, `app_private.subscription_invoice_apply` is
  called, and what it answered goes into the one audit row the RPC already
  writes.

  Carried over, function by function, because this repository has lost a rule to
  a re-statement twice:

    all three   the capability is `billing.manage`, asked through
                app_private.platform_rpc_authorize before anything is read, with
                target type 'subscription_invoice' and a NULL company — a
                refusal is not attributed to a company whose invoice the caller
                may not even see;
                the invoice is taken with SELECT … FOR NO KEY UPDATE and a
                missing one answers 'not_found' with a NULL company;
                the status guard answers 'invalid_status' and names the status
                it found;
                exactly one app_private.audit_write row per call, through
                app_private.platform_rpc_finish, category 'write';
                the answer shape is app_private.platform_rpc_response's
                {success, reason, error};
                SECURITY DEFINER, VOLATILE, SET search_path = pg_catalog, public.

    mark_paid   p_invoice_id NULL, p_amount_cents NULL or <= 0 answers 'invalid'
                and records the amount it was given;
                'paid' and 'canceled' are both refused, which is what the screen
                offers;
                the amount arrives in integer cents and is stored as euros with
                two decimals, round(p_amount_cents::numeric / 100, 2);
                paid_at defaults to now(), paid_by and collected_by are the
                actor, receipt_note is the trimmed note or NULL;
                the payment trail row keeps its German wording and its action
                name 'marked_paid_cash', with the actor's full name, else the
                actor's address, else 'Admin';
                the audit `after` keeps status, amount_cents and paid_at.

    mark_unpaid only a 'paid' invoice may be re-opened;
                status goes to 'open' and paid_at, paid_by, collected_by and
                cash_received_amount are cleared — receipt_note is **not**,
                which is the shipped behaviour and is left alone;
                the trail row's action is 'marked_unpaid', its note 'Als
                unbezahlt markiert', its amount the invoice's own amount;
                the audit `before` keeps status, paid_at and
                cash_received_amount.

    cancel      an already cancelled invoice is refused;
                only `status` is written — paid_at, paid_by, collected_by and
                cash_received_amount stay, so a cancelled payment keeps its
                record (that is the half of rule 3 that does not change);
                the trail row's action is 'invoice_canceled' and it carries the
                invoice's amount and no note.

  Not carried over, because it never existed: none of the three has ever written
  `companies`, so none has ever assigned a column the recompute owns. Self-check
  4 pins that they still do not.
*/

-- 4a. platform_invoice_mark_paid
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
  -- writes the company's state back. Everything above this line is unchanged.
  v_applied := app_private.subscription_invoice_apply(p_invoice_id);
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

-- 4b. platform_invoice_mark_unpaid
CREATE OR REPLACE FUNCTION public.platform_invoice_mark_unpaid(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'invoice.mark_unpaid';
  v_invoice public.subscription_invoices%ROWTYPE;
  v_applied text;
  v_cov_end timestamptz;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            NULL, 'subscription_invoice', p_invoice_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_invoice FROM public.subscription_invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'subscription_invoice', p_invoice_id::text, NULL, NULL);
  END IF;
  IF v_invoice.status <> 'paid' THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid_status', v_invoice.company_id,
                                           'subscription_invoice', p_invoice_id::text, NULL,
                                           jsonb_build_object('status', v_invoice.status));
  END IF;

  UPDATE public.subscription_invoices
     SET status = 'open', paid_at = NULL, paid_by = NULL, collected_by = NULL, cash_received_amount = NULL
   WHERE id = p_invoice_id;

  INSERT INTO public.subscription_payment_audit
    (invoice_id, company_id, action, old_status, new_status, amount, changed_by, note)
  VALUES
    (p_invoice_id, v_invoice.company_id, 'marked_unpaid', v_invoice.status, 'open', v_invoice.amount, auth.uid(),
     'Als unbezahlt markiert');

  -- The period the payment bought shrinks back to the grace window. The row is
  -- not voided: the invoice still exists and is still due, so it still grants
  -- until two business days after its due date.
  v_applied := app_private.subscription_invoice_apply(p_invoice_id);
  SELECT c.period_end INTO v_cov_end
    FROM public.subscription_coverage c
   WHERE c.company_id = v_invoice.company_id AND c.source = 'invoice'
     AND c.source_id = p_invoice_id AND c.status = 'active';

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_invoice.company_id,
                                         'subscription_invoice', p_invoice_id::text,
                                         jsonb_build_object('status', v_invoice.status, 'paid_at', v_invoice.paid_at,
                                                            'cash_received_amount', v_invoice.cash_received_amount),
                                         jsonb_build_object('status', 'open',
                                                            'coverage', v_applied,
                                                            'coverage_period_end', v_cov_end));
END;
$$;

-- 4c. platform_invoice_cancel
CREATE OR REPLACE FUNCTION public.platform_invoice_cancel(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'invoice.cancel';
  v_invoice public.subscription_invoices%ROWTYPE;
  v_applied text;
  v_withdrawn timestamptz;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            NULL, 'subscription_invoice', p_invoice_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_invoice FROM public.subscription_invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'subscription_invoice', p_invoice_id::text, NULL, NULL);
  END IF;
  IF v_invoice.status = 'canceled' THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid_status', v_invoice.company_id,
                                           'subscription_invoice', p_invoice_id::text, NULL,
                                           jsonb_build_object('status', v_invoice.status));
  END IF;

  -- The end that is about to be withdrawn, read before it is, so the audit row
  -- records what the company lost rather than that it lost something.
  SELECT c.period_end INTO v_withdrawn
    FROM public.subscription_coverage c
   WHERE c.company_id = v_invoice.company_id AND c.source = 'invoice'
     AND c.source_id = p_invoice_id AND c.status = 'active';

  UPDATE public.subscription_invoices SET status = 'canceled' WHERE id = p_invoice_id;

  INSERT INTO public.subscription_payment_audit
    (invoice_id, company_id, action, old_status, new_status, amount, changed_by)
  VALUES
    (p_invoice_id, v_invoice.company_id, 'invoice_canceled', v_invoice.status, 'canceled', v_invoice.amount, auth.uid());

  -- Rule 3: the record stays, the access goes.
  v_applied := app_private.subscription_invoice_apply(p_invoice_id);

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_invoice.company_id,
                                         'subscription_invoice', p_invoice_id::text,
                                         jsonb_build_object('status', v_invoice.status,
                                                            'coverage_period_end', v_withdrawn),
                                         jsonb_build_object('status', 'canceled',
                                                            'coverage', v_applied,
                                                            'coverage_withdrawn', v_withdrawn IS NOT NULL));
END;
$$;

-- Each of the three reaches app_private, and on the real databases a function
-- that predates version control belongs to `postgres`, which holds no USAGE
-- there. A CREATE OR REPLACE keeps the old owner, so the owner is restated —
-- the failure tests/fixtures/owner-simulation.sql exists to reproduce.
ALTER FUNCTION public.platform_invoice_mark_paid(uuid, bigint, timestamptz, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_mark_unpaid(uuid)                          OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_cancel(uuid)                               OWNER TO CURRENT_USER;

-- ─── 5. Self-check ──────────────────────────────────────────────────────────

/*
  Tripwires, not proofs. Each one is here because a deploy must fail when it
  fires; the behaviour they stand in for is asserted in
  tests/rls/subscriptions.sql section 5, whose header records why the division
  is drawn there.

  Checks 4 and 5 read a function body through U1's app_private.function_code and
  app_private.companies_set_clauses. They are reused rather than rewritten, and
  the reason a check that forbids an assignment must read assignments — and not
  the body — is in that same header.
*/
DO $mig$
DECLARE
  c_grace  CONSTANT text := 'app_private.subscription_grace_business_days()';
  c_bdays  CONSTANT text := 'app_private.add_business_days(date,integer)';
  c_gend   CONSTANT text := 'app_private.invoice_grace_end(date)';
  c_apply  CONSTANT text := 'app_private.subscription_invoice_apply(uuid)';
  c_sweep  CONSTANT text := 'app_private.subscription_invoices_apply_all()';
  c_paid   CONSTANT text := 'public.platform_invoice_mark_paid(uuid,bigint,timestamptz,text)';
  c_unpaid CONSTANT text := 'public.platform_invoice_mark_unpaid(uuid)';
  c_cancel CONSTANT text := 'public.platform_invoice_cancel(uuid)';
  v_sig  text;
  v_role text;
  v_txt  text;
BEGIN
  -- 1. the five helpers exist and pin their search_path, and nobody the API
  --    authenticates as may call them
  FOREACH v_sig IN ARRAY ARRAY[c_grace, c_bdays, c_gend, c_apply, c_sweep] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '20260919170000 self-check: % is missing', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                    WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260919170000 self-check: % has no pinned search_path', v_sig;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_sig::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '20260919170000 self-check: % may call %', v_role, v_sig;
      END IF;
    END LOOP;
  END LOOP;

  -- 2. the two that write are SECURITY DEFINER
  FOREACH v_sig IN ARRAY ARRAY[c_apply, c_sweep] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION '20260919170000 self-check: % is not SECURITY DEFINER', v_sig;
    END IF;
  END LOOP;

  -- 3. every function that reaches app_private is owned by a role that can
  --    (see tests/fixtures/owner-simulation.sql, and PR #25)
  FOREACH v_sig IN ARRAY ARRAY[c_grace, c_bdays, c_gend, c_apply, c_sweep,
                               c_paid, c_unpaid, c_cancel]
  LOOP
    IF NOT EXISTS (SELECT 1
                     FROM pg_proc p
                     JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND (r.rolsuper
                           OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION '20260919170000 self-check: the owner of % can reach no app_private helper', v_sig;
    END IF;
  END LOOP;

  -- 4. each of the three RPCs applies the rule, and none of them assigns a
  --    column the recompute owns. They never did; a rewrite that starts is what
  --    this catches.
  FOREACH v_sig IN ARRAY ARRAY[c_paid, c_unpaid, c_cancel] LOOP
    IF app_private.function_code(v_sig) !~ 'subscription_invoice_apply' THEN
      RAISE EXCEPTION '20260919170000 self-check: % no longer applies the invoice rule', v_sig;
    END IF;
    v_txt := app_private.companies_set_clauses(v_sig);
    IF v_txt ~ '\msubscription_status\s*='
       OR v_txt ~ '\msubscription_expires_at\s*='
       OR v_txt ~ '\mplan\s*=' THEN
      RAISE EXCEPTION '20260919170000 self-check: % assigns a column the recompute owns: %',
        v_sig, regexp_replace(v_txt, '\s+', ' ', 'g');
    END IF;
  END LOOP;

  -- 5. the grace number is asked for, never written at the call site
  IF app_private.function_code(c_gend) !~ 'subscription_grace_business_days' THEN
    RAISE EXCEPTION '20260919170000 self-check: invoice_grace_end no longer asks for the grace, so the number has moved to a call site';
  END IF;
  IF app_private.subscription_grace_business_days() <> 2 THEN
    RAISE EXCEPTION '20260919170000 self-check: the grace is % business day(s), not the 2 the owner gave',
      app_private.subscription_grace_business_days();
  END IF;

  -- 6. the case the owner named: a Friday due date closes on the Tuesday, not
  --    on the Sunday. 02.01.2026 is a Friday and 05.01.2026 a Monday.
  IF app_private.add_business_days(DATE '2026-01-02', 2) <> DATE '2026-01-06'
     OR app_private.add_business_days(DATE '2026-01-05', 2) <> DATE '2026-01-07'
     OR app_private.add_business_days(DATE '2026-01-02', 0) <> DATE '2026-01-02' THEN
    RAISE EXCEPTION '20260919170000 self-check: business days are not counted Monday to Friday (Friday + 2 answered %)',
      app_private.add_business_days(DATE '2026-01-02', 2);
  END IF;

  -- 7. this release writes no coverage row of its own. The count is the whole
  --    of the "no company changes admission at deploy" claim, and it is the one
  --    thing about this file that a later edit could quietly break.
  IF EXISTS (SELECT 1 FROM public.subscription_coverage WHERE source = 'invoice') THEN
    RAISE EXCEPTION '20260919170000 self-check: % invoice coverage row(s) exist — this migration applies the rule to no invoice, it only installs it',
      (SELECT count(*) FROM public.subscription_coverage WHERE source = 'invoice');
  END IF;

  RAISE NOTICE '20260919170000 self-check: passed';
END $mig$;
