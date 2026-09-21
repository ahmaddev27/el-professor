/*
  # Every write a support session makes to a company's data leaves an audit row
    (plan 3.B, slice 3.4c)

  ## What was missing

  3.4a (20260917140000) let a company-less platform account write a tenant's
  rows while it holds a *support* context on that company, and refuses the write
  in a *view* context with a statement trigger on 39 tables. Opening and closing
  the context are audited (`platform_context.open` / `.close`, category
  `support`), but the writes in between were not: an owner or a support agent
  could change a driver, a salary or a month's planning under a reason given
  once, and the log said nothing about what was changed. Plan 3.B names this row
  itself: "كتابات جلسة الدعم على بيانات الشركات (triggers)".

  ## What this adds

    app_private.record_support_write()            AFTER … FOR EACH ROW, on the
                                                  same tables as the refusal
                                                  trigger, one audit row per
                                                  written row
    app_private.refuse_read_only_context_write()  restated: it also *arms* the
                                                  audit for the statement when
                                                  the caller is in a support
                                                  session (section 3)
    app_private.guard_company_hard_delete()       BEFORE DELETE on companies: no
                                                  hard delete while a context is
                                                  open (section 3b)
    app_private.support_write_redaction_pattern() the one place that says which
                                                  columns are never copied
    app_private.support_write_values()            the size cap on what is copied

  Each row: category `support`, action `support_write.<table>.<insert|update|
  delete>`, the row's own company (the context's, for the five child tables that
  reach their company through a parent, and for role_permissions), target_type
  the table and target_id the row's `id`, the actor, its role and the sign-in
  session the context is bound to, and

    before_value  {"values": {…}}                       NULL on INSERT
    after_value   {"context_id": …, "reason": …,
                   "values": {…}}                       values null on DELETE

  ## Decision 1 — row level, gated so that a company member pays nothing per row

  Row level, because the log has to say *which* row changed and from what. A
  statement-level trigger sees neither without transition tables, and those
  would make every member's write — a Fahrtenbuch import of thousands of trips
  included — copy each of its rows into a tuplestore for a trigger that then
  returns without looking at them. That cost would land on the path this
  trigger has nothing to do with.

  What keeps row level cheap for the company member, who makes the
  overwhelming majority of writes, is the gate:

    WHEN (current_setting('app_private.support_write_context', true) <> '')

  The condition is a built-in GUC read, evaluated per row *before* anything is
  queued. For a member it is false, so the audit function is never called, no
  after-trigger event is queued, and no JSON is built. The flag is set in
  exactly one place: the statement-level trigger 3.4a already runs before every
  INSERT, UPDATE and DELETE on these tables, which already asks whether the
  caller is a platform account inside a support session. So a member's
  statement costs one `current_setting` and one primary-key lookup on
  `platform_staff` — cheaper than the session-gated check it replaces — and a
  member's row costs one GUC comparison.

  **The flag names an account, and for a company-less platform account it is
  never empty.** It holds `<context id>:<account>` while that account writes in
  a support session, and `none:<account>` when a company-less platform account
  writes with no support session open. A company member, the service role,
  GoTrue and a migration leave it empty, so for them the gate stays closed. The
  statement trigger clears a flag that names another account — by comparing the
  account, not by looking anything up — so a flag left armed earlier in a
  transaction never reaches another caller's rows, and a session that
  disappears in the middle of a statement never closes the gate for its own
  account.

  So every row a company-less platform account writes in these tables reaches
  the audit function, and that function has exactly three answers: record it
  against the account's own support session; let it through unrecorded because
  it is part of a company hard delete made with no context open (the D13
  residual, marked by the `companies` trigger of section 3b); or refuse it.
  There is no fourth outcome in which such a write is neither recorded nor
  refused. The function looks the session up again and requires it to be the
  caller's own, in support mode, so a forged flag can neither record a write in
  another account's name nor drop one. The API has no way to set the flag —
  PostgREST sets only its own `request.` settings, and no function a client can
  call runs set_config.

  The first version of this file did have that fourth outcome, and the kit
  found it. It cleared the flag whenever the session it named no longer
  existed, and armed it only while the session was valid. A company's hard
  delete removes the session through `platform_company_contexts.company_id ON
  DELETE CASCADE`, and PostgreSQL runs the delete's foreign-key cascades in an
  order set by the constraint triggers' names, so every audited cascade that
  ran after the session's own cleared the flag and wrote its rows unrecorded.
  The kit's run refused the delete only because one audited cascade happened to
  run first and queue an audit event while the flag was still armed. In a
  database where the order differed, nothing would have been refused.

  **The planning path, explicitly.** `apply_monthly_planning_run` and
  `replace_monthly_planning_run` write each trip in its own single-row UPDATE
  inside a loop, so for them statement level and row level are the same number
  of trigger calls: 3.4a's statement trigger already runs once per trip. What
  this slice adds per trip is one audit row. A support session's apply of a
  month with T open trips and E manual exceptions writes

    apply     1 run insert + T trip updates + E exception inserts
              + 1 run update (the apply summary)              = T + E + 2 rows
    replace   1 old-run update + D detached trips (one bulk UPDATE,
              recorded row by row) + 1 run insert + T trip updates
              + E exception inserts + 1 run update            = D + T + E + 3

  A canceled trip is not written, so it is not recorded.

  The added cost is per trip and only inside a support session: the context
  looked up by primary key, the row diffed as JSON (for a trip the diff is the
  assignment columns only, see decision 2), and one INSERT into the log with its
  three indexes. Reasoned, not measured — this branch had no database to measure
  against — at the order of 0.1 ms per trip, against a trip UPDATE that already
  maintains ten indexes on fahrtenbuch_trips and runs 3.4a's context check once
  per statement. For a month in the thousands of trips that is a fraction of a
  second to a few seconds added to a call a company member makes without any of
  it. **It must be timed on staging with a real month before a support agent
  applies a large month**; if it proves too slow, the fix is to record the
  planning RPCs per call instead of per trip, which means changing those two
  payroll functions and is deliberately not done blind here.

  ## Decision 2 — fahrtenbuch_trips and protect_fahrtenbuch_immutable_fields

  They do not meet. `tg_protect_fahrtenbuch_immutable` is a BEFORE UPDATE row
  trigger; `record_support_write` is AFTER. For every UPDATE of a trip the order
  is fixed by timing, not by name:

    1. refuse_read_only_context_write   BEFORE, per statement: refuses a view
                                        context, arms the audit for a support one
    2. tg_protect_fahrtenbuch_immutable BEFORE, per row: raises on any change to
                                        an immutable column, sets updated_at
    3. the row is written; the WHEN gate is evaluated
    4. record_support_write             AFTER, per row, at the end of the
                                        statement

  So a change to an immutable column is refused at step 2 and the statement
  aborts before any audit row exists; and every UPDATE that does reach step 4
  has, by construction, changed none of the immutable columns. Because the log
  records changed columns only, a trip's row carries exactly the assignment
  columns the planning RPCs and `reassign_fahrtenbuch_trip` write — never
  `raw_data_json`, never an amount. There is still no UPDATE policy on the table
  and this file adds none. An INSERT or a DELETE of a trip (an import, or an
  import deleted with its trips) is recorded with the whole row, under the
  rules of decision 3.

  ## Decision 3 — what the log may copy

  The log is append-only and has no retention yet: D4 is open, and it may not
  ship before slice 3.12, whose team page is folded from this log. Whatever is
  copied here is kept indefinitely and cannot be erased for one person. The
  platform read models already decided the same question for reading (no
  salary, bank or personal identifier beyond the name, 20260916140000), and the
  same reasoning holds more strongly for a copy that cannot be deleted.

  So the rule is the smallest that still says what was done:

  - **UPDATE: changed columns only.** Unchanged columns identify nothing the
    table and id do not already identify. A write that changes nothing is still
    a write and is still recorded, with two empty objects.
  - **INSERT and DELETE: the whole row**, under the two rules below — a
    created or destroyed row is only accountable if the log says what it was.
  - **Never copied, whatever the operation:** pay and money owed or paid to a
    person, identifiers beyond the name (Personalnummer, tax and social
    security numbers, IBAN and BIC, date of birth), gender, and the free text
    that describes a person's pay or absence (a driver note, a salary note).
    The column is still named, with `{"redacted": true}` in place of both
    values, so the log says *that* it changed and not *to what*. The rule is
    one function, `support_write_redaction_pattern()`: a name rule for every
    table, so a pay or identifier column added later is covered without anyone
    remembering this file, and an explicit list for the amounts on the pay
    tables whose names do not say so (amount_due, amount, …). Keys (`…_id`)
    are never redacted: they identify a row, not a person's circumstances.
  - **JSON documents are recorded by size, never copied**, and neither is any
    value over 1 KiB: `{"omitted": true, "bytes": n}`. A document's content
    cannot be screened by column name — `totals_json`, `driver_summary_json`,
    `driver_configs_json` and `rows_json` carry per-driver pay and time
    records — and they are the bulk of the volume. Arrays of plain values
    (weekdays, a short list of ids) are copied.
  - Names, statuses, dates, plates, fares and assignments are copied: they are
    what a support write changes, and the read models return names too.

  Nothing derived from a redacted or omitted value is kept — no hash: a salary
  has few enough plausible values that a hash of one is the value.

  ## Where the trigger sits, and where it deliberately does not

  Exactly on the tables that carry 3.4a's refusal trigger — derived from that
  trigger, not from a list, and compared both ways by the self-check. Those are
  the 36 tenant tables of 20260917130000 plus roles, role_permissions and
  activation_code_attempts: the writes whose company comes from the context,
  which is what "a support session's write" means. None of the 39 is excluded.

  Not here, each for a stated reason:

  - `company_settings` and `user_profiles`. Their platform writes take no
    company from the context at all — `companies.lifecycle` and
    `company_users.manage` name no company, so they reach any tenant with or
    without a context (matrix.sql tags both residual, 3.4c/3.13). Recording them
    as support writes only when a context happens to be open would record half
    of them under a category that is not theirs. What they need is a company
    term in the policy and an audit of capability writes, both 3.13's.
  - The subscription and billing tables. A context widens only what may be
    *read* there; their writes are the audited 3.5 RPCs.
  - `storage.objects`. A file has no row history a table trigger could diff —
    an upload or a delete is a storage-API call whose object carries a path and
    metadata, not the content — and the bucket policies are being rewritten
    onto the context by another slice. Files are audited where they are
    reached, in `platform-file-url` (plan 3.C), not here.

  A tenant table a later migration adds must carry both triggers;
  tests/rls/support-write-audit.sql section 1 fails the kit when it carries the
  refusal trigger without this one.

  ## A company is not hard-deleted while a context is open — decided up front

  A company's hard delete (`companies.hard_delete`, CompaniesPage's direct
  DELETE, D13) cascades into every audited table — most foreign keys to
  `companies` are ON DELETE CASCADE, `activation_code_attempts.company_id` is
  ON DELETE SET NULL — and into `platform_company_contexts`, so it deletes the
  very session a support write would be recorded against. PostgreSQL runs
  those cascades in the order of their constraint triggers' names, which is
  not an order this file can rely on (see "The flag names an account" above).

  So the question is answered before any cascade runs, by a BEFORE DELETE
  trigger on `companies` (section 3b): **a company-less platform account that
  holds an open context, in either mode, or that has written in a support
  session earlier in the same transaction, hard-deletes no company.** It ends
  the context first. The refusal does not depend on which tables the company
  has rows in or on the cascades' order, and it covers the view mode too, where
  3.4a's statement trigger refused the same delete only as long as an audited
  cascade happened to run before the session's own.

  - **The company the session is on:** its rows could be recorded against
    nothing, because the session goes with them.
  - **Any other company:** its rows are not the session's writes — their
    company came from the delete, not from the context. Recording them would
    copy a whole company's names, fares and assignments into an append-only log
    under the wrong session, for a delete that may exist precisely to erase
    that data, and one audit write per cascaded row would put the delete at
    risk of the statement timeout. The audit function refuses a row of another
    company too, as a second wall behind this trigger.

  Without a context the delete is the capability write it always was —
  unaudited, the D13 residual matrix.sql tags for 3.13. The `companies` trigger
  marks it (`app_private.company_hard_delete`, the account, transaction-local),
  and the audit function lets exactly those rows through unrecorded. Any other
  row a company-less platform account writes with no support session open is
  refused (`support_session_required`): a planning RPC whose session was ended
  by another transaction between resolving its company and its first write is
  refused rather than recorded against nothing.

  No other cascade is affected. Deleting a driver, a vehicle, a salary, an
  import, a planning run, a reconciliation, a document or a role inside a
  support session cascades only into audited tables of the same company, and
  none of those deletes the session, so each cascaded row is recorded like any
  other. Only a `companies` delete, or deleting the staff account itself, takes
  the context row away, and the second never happens with that account's own
  token.

  ## Volume, and why there is no rate limit here

  `platform_audit_record` caps an actor at 120 rows a minute because through
  that door a caller *chooses* what to record. Here every row is one real row of
  a customer's data that the session changed, so the log grows exactly as fast
  as the session writes and never faster: no row is written that does not
  correspond to a write, and each side of a row is bounded (the values at
  16 KiB, the reason at 500 characters), well inside audit_write's 32 KiB, so
  the audit can never be the reason a support write fails. Typical rows are
  well under 1 KiB. A bulk write does produce one row
  per row — a month's apply is thousands — and that is the point: a cap that
  refused the write would stop legitimate support work in the middle of a
  payroll month, and a cap that dropped rows would make the log lossy precisely
  when an insider bulk-edits. What bounds the volume is what bounds the
  session: the owner and support roles only, a written reason, sixty minutes,
  one company, and the request's statement timeout. Retention (D4) is where the
  volume is managed, not here.

  ## What is restated, and what was carried over

  `app_private.refuse_read_only_context_write()` is 20260917140000's body plus
  the arming. Its refusals are carried over, each deliberately:

    1. no subject (service role, GoTrue, migrations): no refusal
    2. not a platform account: no refusal. 3.4a asked the session-gated
       platform_staff_role_of(); this asks whether a platform_staff row exists
       at all, a disabled one included, because a staff account disabled by
       another transaction in the middle of a call must still reach the audit.
       What it refuses is unchanged: a session that holds no role (Google, or a
       disabled account) has no valid context, and a caller with no valid
       context was never refused
    3. a staff account with a company of its own: no refusal
    4. no open context: no refusal, and RLS answers the write as before
    5. a support context: no refusal
    6. a view context: RAISE with the same sentence, SQLSTATE P0001 and HINT
       support_session_required
    7. SECURITY DEFINER, `search_path = pg_catalog, public`, the same name and
       signature, so all 39 triggers keep pointing at it, still statement-level
    8. REVOKE from PUBLIC, anon, authenticated and service_role

  Two structural changes. 3.4a asked `platform_context_company(true)` and then
  `platform_context_company(false)`, which read the context twice; this reads
  `platform_context_row()` once and branches on its mode, with the same
  answers. And for a company member it now costs one primary-key lookup on
  `platform_staff` instead of platform_staff_role_of()'s two parses of the
  token's claims and the same lookup.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  Additive: four new functions, one body restated with the same refusals, 39
  new triggers on the audited tables and one on `companies`. No column, policy
  or grant changes. The previous release's code writes and reads exactly as
  before; its support sessions simply leave rows it never reads. Two things a
  platform owner could do before are refused now, on purpose: hard-deleting a
  company while holding a context, and a write by a company-less platform
  account that reaches an audited table with no support session open and is
  not part of a company's hard delete — which, outside that delete, only a
  session ended mid-call by another transaction can produce (see above).
*/

-- ─── 1. Which columns are never copied ──────────────────────────────────────

/*
  One regular expression per table, and the whole rule is here.

  The first two alternatives apply to every table: a column whose name says pay,
  a rate, a bank or tax identifier, a date of birth, a personnel number or
  gender — unless it is a key (`…_id`), which names a row rather than a fact
  about a person. `lohn` and `wage` are deliberately absent: `grundlohn_min` is
  minutes of base time and `wage_type_code` is a Lohnart, neither of them pay.

  The third lists, per table, the amounts and notes whose names do not give them
  away. A table that is not named gets the first two alone.
*/
CREATE OR REPLACE FUNCTION app_private.support_write_redaction_pattern(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT '^(?!.*_id$).*(salary|gehalt|payroll|gross|brutto|netto|hourly_rate|payout|bank_account|tax_id|steuer|sozialversicherung|social_security|birth|geburt|personalnummer|gender)'
      || '|^(?!.*_id$)(.*_)?(iban|bic)(_.*)?$'
      || coalesce('|^(' || CASE p_table
           WHEN 'salaries' THEN
             'calc_revenue|calc_tips|amount_due|total_paid|remaining_balance|additional_net_payment_amount|notes|additional_payment_note'
           WHEN 'salary_payments' THEN
             'amount|description'
           WHEN 'salary_cash_receipts' THEN
             'amount|due_amount|paid_cash_manual_before|paid_cash_weekly_before|paid_cash_receipts_before|paid_bank_before|remaining_before|remaining_after'
           WHEN 'cash_movements' THEN
             'amount'
           WHEN 'planning_run_adjustments' THEN
             'amount'
           WHEN 'historical_reconciliation_wh_drivers' THEN
             'total_amount_cents'
           WHEN 'driver_notes' THEN
             'note_text'
           WHEN 'document_variables' THEN
             'value|default_value'
         END || ')$', '');
$$;

COMMENT ON FUNCTION app_private.support_write_redaction_pattern(text) IS
  'The columns of a table whose values the support-write audit never copies, as '
  'one regular expression: pay, identifiers beyond the name, gender and the free '
  'text about a person''s pay or absence (20260920110000).';

-- ─── 2. The size cap ────────────────────────────────────────────────────────

/*
  The values of one side of a write, wrapped for the log — or, if they are too
  large to keep, their size and the names of their columns. Each value is
  already at most 1 KiB (section 4), so this is reached only by a row with more
  than a dozen long text columns; it exists so that audit_write's 32 KiB limit
  can never make a support write fail.
*/
CREATE OR REPLACE FUNCTION app_private.support_write_values(p_values jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
           WHEN p_values IS NULL THEN jsonb_build_object('values', NULL::jsonb)
           WHEN octet_length(p_values::text) <= 16384 THEN jsonb_build_object('values', p_values)
           ELSE jsonb_build_object(
                  'omitted', true,
                  'bytes',   octet_length(p_values::text),
                  'columns', (SELECT jsonb_agg(t.k ORDER BY t.k) FROM jsonb_object_keys(p_values) AS t(k)))
         END;
$$;

-- ─── 3. The statement trigger arms the audit ────────────────────────────────

/*
  20260917140000's refusal, and now also the one place the audit is armed. The
  header lists what was carried over; the new part is the flag.

  The flag is transaction-local (set_config(…, true)) and names one account:
  `<context id>:<account>` or `none:<account>` (the header, "The flag names an
  account"). Three rules keep it honest, in this order:

  1. A flag that names another account is cleared. That is a comparison of
     two strings, not a lookup, so it cannot be fooled by a session that
     disappears in the middle of a statement: the first version of this file
     cleared the flag when the session it named was gone, and a company's
     hard delete, which removes the session, then closed the gate on every
     audited cascade that ran after it.
  2. A company member, the service role, GoTrue and a migration never arm it,
     so for them the gate stays closed and the audit costs nothing.
  3. A company-less platform account always arms it: with its support session
     while one is valid, or `none:<account>` when none is — unless the flag
     already names a session of this same account, which then stays. So a
     planning RPC whose session ends mid-call keeps recording against it, and
     one whose session ended before its first write is refused by the audit
     function rather than let through.

  For a company member the cost is one current_setting and one primary-key
  lookup on platform_staff per statement.
*/
CREATE OR REPLACE FUNCTION app_private.refuse_read_only_context_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_flag  CONSTANT text := 'app_private.support_write_context';

  v_uid   uuid := auth.uid();
  v_armed text := nullif(current_setting(c_flag, true), '');
  v_ctx   app_private.platform_company_contexts%ROWTYPE;
BEGIN
  -- 1. The flag names one account. For anybody else it is cleared.
  IF v_armed IS NOT NULL
     AND (v_uid IS NULL OR split_part(v_armed, ':', 2) IS DISTINCT FROM v_uid::text) THEN
    PERFORM set_config(c_flag, '', true);
    v_armed := NULL;
  END IF;

  -- 2. Not a platform account, or one judged as a member: nothing to arm.
  --    Any platform_staff row counts, a disabled one included, so an account
  --    disabled by another transaction mid-call still reaches the audit.
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = v_uid) THEN
    RETURN NULL;
  END IF;
  IF app_private.account_has_company(v_uid) THEN
    RETURN NULL;
  END IF;

  v_ctx := app_private.platform_context_row();

  -- A view context writes nothing (3.4a).
  IF v_ctx.id IS NOT NULL AND v_ctx.mode <> 'support' THEN
    RAISE EXCEPTION
      'Nur-Lese-Ansicht: % auf % ist ohne offene Support-Sitzung nicht möglich.', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'P0001', HINT = 'support_session_required';
  END IF;

  -- 3. A support session: its writes are recorded against it.
  IF v_ctx.id IS NOT NULL THEN
    PERFORM set_config(c_flag, v_ctx.id::text || ':' || v_uid::text, true);
    RETURN NULL;
  END IF;

  --    No valid session. A session this account wrote in earlier in the
  --    transaction keeps the flag; otherwise the account is marked as writing
  --    without one, and the audit function decides. RLS still answers the
  --    statement as it did before this trigger existed.
  IF v_armed IS NULL THEN
    PERFORM set_config(c_flag, 'none:' || v_uid::text, true);
  END IF;
  RETURN NULL;
END;
$$;

-- ─── 3b. No hard delete of a company while a context is open ────────────────

/*
  Decides the hard delete before any foreign-key cascade runs, so the answer
  does not depend on the order in which PostgreSQL runs them (the header, "A
  company is not hard-deleted while a context is open").

  Refused for a company-less platform account that holds a valid context in
  either mode, or whose flag names a support session of its own from earlier
  in the transaction. Otherwise, for such an account, the delete is the D13
  capability write it always was, and the account is written into
  `app_private.company_hard_delete` so the audit function lets the cascade's
  rows through unrecorded. A company member cannot delete a company at all
  (companies_delete asks companies.hard_delete), and the service role, GoTrue
  and a migration are not platform accounts.
*/
CREATE OR REPLACE FUNCTION app_private.guard_company_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_flag   CONSTANT text := 'app_private.support_write_context';
  c_marker CONSTANT text := 'app_private.company_hard_delete';

  v_uid   uuid := auth.uid();
  v_armed text := nullif(current_setting(c_flag, true), '');
  v_ctx   app_private.platform_company_contexts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = v_uid) THEN
    RETURN OLD;
  END IF;
  IF app_private.account_has_company(v_uid) THEN
    RETURN OLD;
  END IF;

  v_ctx := app_private.platform_context_row();

  IF v_ctx.id IS NOT NULL
     OR (v_armed IS NOT NULL
         AND split_part(v_armed, ':', 2) = v_uid::text
         AND split_part(v_armed, ':', 1) <> 'none') THEN
    RAISE EXCEPTION
      'Solange ein Unternehmenszugriff offen ist, kann kein Unternehmen gelöscht werden. Bitte zuerst den Zugriff beenden.'
      USING ERRCODE = 'P0001', HINT = 'company_delete_context_open';
  END IF;

  PERFORM set_config(c_marker, v_uid::text, true);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_company_hard_delete ON public.companies;
CREATE TRIGGER guard_company_hard_delete
  BEFORE DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_company_hard_delete();

-- ─── 4. The audit row ───────────────────────────────────────────────────────

/*
  Runs only where the WHEN gate let it: a row written in a statement the
  refusal trigger armed. Everything below is the support session's cost, never
  a member's.

  One statement builds both sides. `changed` pairs the old and new values by
  column and keeps, for an UPDATE, only the ones that differ; `sides` splits
  them into before and after; `scrubbed` applies decision 3 to each value. The
  plan is prepared once per session by plpgsql and reused for every row.
*/
CREATE OR REPLACE FUNCTION app_private.record_support_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_flag         CONSTANT text    := 'app_private.support_write_context';
  c_marker       CONSTANT text    := 'app_private.company_hard_delete';
  -- `<context id>:<account>` or `none:<account>`; see the statement trigger.
  c_flag_pattern CONSTANT text    := '^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  -- A value longer than this is recorded by its size.
  c_value_bytes  CONSTANT integer := 1024;
  c_redacted     CONSTANT jsonb   := '{"redacted": true}';

  v_flag    text := current_setting(c_flag, true);
  v_uid     uuid := auth.uid();
  v_ctx     app_private.platform_company_contexts%ROWTYPE;
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_pattern text;
  v_before  jsonb;
  v_after   jsonb;
BEGIN
  -- 1. Whose write this is. The flag must name the caller; one that does not,
  --    or that is not in the flag's shape at all, is a flag nobody should have
  --    been able to set, and the write is refused.
  IF v_flag IS NULL OR v_flag !~ c_flag_pattern
     OR v_uid IS NULL OR split_part(v_flag, ':', 2) <> v_uid::text THEN
    RAISE EXCEPTION 'Support-Schreibzugriff auf % kann nicht protokolliert werden und wird abgelehnt.', TG_TABLE_NAME
      USING ERRCODE = 'P0001', HINT = 'support_audit_unavailable';
  END IF;

  -- 2. A company-less platform account writing with no support session open.
  --    Exactly one such write is let through, unrecorded: a company's hard
  --    delete made with no context open (the D13 residual), which the
  --    companies trigger marks before its cascade runs. Anything else — in
  --    practice a planning RPC whose session another transaction ended between
  --    resolving the company and writing — is refused, never let through.
  IF split_part(v_flag, ':', 1) = 'none' THEN
    IF current_setting(c_marker, true) = v_uid::text THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'Schreibzugriff eines Plattform-Kontos auf % ohne offene Support-Sitzung wird abgelehnt.', TG_TABLE_NAME
      USING ERRCODE = 'P0001', HINT = 'support_session_required';
  END IF;

  -- 3. The session the flag names, looked up again. It is not asked to be
  --    still valid — a session that expires or is ended mid-call keeps its
  --    writes — only to exist, to be this account's and to be a support
  --    session. It is gone only if something deleted it; the companies trigger
  --    refuses the one delete that could do that with this account's token.
  SELECT * INTO v_ctx
    FROM app_private.platform_company_contexts c
   WHERE c.id = split_part(v_flag, ':', 1)::uuid
     AND c.staff_user_id = v_uid
     AND c.mode = 'support';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support-Schreibzugriff auf % kann nicht protokolliert werden, weil die Support-Sitzung nicht mehr besteht, und wird abgelehnt.', TG_TABLE_NAME
      USING ERRCODE = 'P0001', HINT = 'support_audit_unavailable';
  END IF;

  -- 4. The row on both sides, as JSON.
  IF TG_OP <> 'INSERT' THEN
    v_old := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := to_jsonb(NEW);
  END IF;
  v_row     := coalesce(v_new, v_old);

  -- 5. A support session writes the company it opened, and nothing else. RLS
  --    and the planning and Gehaltsquittung RPCs already confine it there, and
  --    the companies trigger refuses the one capability write that would
  --    cascade into another company's rows (a hard delete while the session is
  --    open), so this is a second wall: a row of another company is not this
  --    session's write, and recording it as one would copy another company's
  --    data into the log under the wrong session. Both sides are asked,
  --    because a cascade that sets company_id to NULL shows the company only
  --    on OLD. A row without a company (a child table, or company_id NULL) is
  --    the context's.
  IF EXISTS (SELECT 1
               FROM (VALUES (v_old ->> 'company_id'), (v_new ->> 'company_id')) AS s(company)
              WHERE s.company IS NOT NULL
                AND s.company::uuid <> v_ctx.company_id) THEN
    RAISE EXCEPTION 'Die offene Support-Sitzung gilt einem anderen Unternehmen: % auf % wird abgelehnt. Bitte zuerst die Sitzung beenden.', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'P0001', HINT = 'support_session_other_company';
  END IF;
  v_pattern := app_private.support_write_redaction_pattern(TG_TABLE_NAME::text);

  -- 6. Changed columns only for an UPDATE, every column otherwise; then
  --    decision 3 on each value.
  WITH changed AS (
    SELECT coalesce(n.key, o.key) AS col,
           o.value                AS old_value,
           n.value                AS new_value
      FROM jsonb_each(v_new) AS n
      FULL JOIN jsonb_each(v_old) AS o ON o.key = n.key
     WHERE v_old IS NULL
        OR v_new IS NULL
        OR n.value IS DISTINCT FROM o.value
  ),
  sides AS (
    SELECT ch.col, 'before'::text AS side, ch.old_value AS val FROM changed ch WHERE v_old IS NOT NULL
    UNION ALL
    SELECT ch.col, 'after'::text  AS side, ch.new_value AS val FROM changed ch WHERE v_new IS NOT NULL
  ),
  scrubbed AS (
    SELECT s.col, s.side,
           CASE
             WHEN s.col ~ v_pattern THEN c_redacted
             WHEN jsonb_typeof(s.val) = 'object'
               OR (jsonb_typeof(s.val) = 'array'
                   AND jsonb_path_exists(s.val, '$[*] ? (@.type() == "object" || @.type() == "array")'))
               OR octet_length(s.val::text) > c_value_bytes
             THEN jsonb_build_object('omitted', true, 'bytes', octet_length(s.val::text))
             ELSE s.val
           END AS val
      FROM sides s
  )
  SELECT jsonb_object_agg(sc.col, sc.val) FILTER (WHERE sc.side = 'before'),
         jsonb_object_agg(sc.col, sc.val) FILTER (WHERE sc.side = 'after')
    INTO v_before, v_after
    FROM scrubbed sc;

  -- An UPDATE that changed nothing is still a write: two empty objects.
  IF TG_OP = 'UPDATE' THEN
    v_before := coalesce(v_before, '{}'::jsonb);
    v_after  := coalesce(v_after,  '{}'::jsonb);
  END IF;

  -- 7. One row, through the log's only writer. The company is the row's own
  --    when the table has the column; the five child tables and role_permissions
  --    reach theirs through a parent, which RLS confined to the context's.
  PERFORM app_private.audit_write(
    'support',
    'support_write.' || TG_TABLE_NAME::text || '.' || lower(TG_OP),
    'ok',
    CASE WHEN v_row ? 'company_id' THEN (v_row ->> 'company_id')::uuid ELSE v_ctx.company_id END,
    TG_TABLE_NAME::text,
    v_row ->> 'id',
    CASE WHEN v_old IS NULL THEN NULL ELSE app_private.support_write_values(v_before) END,
    jsonb_build_object('context_id', v_ctx.id, 'reason', v_ctx.reason)
      || app_private.support_write_values(v_after),
    NULL,
    v_ctx.session_id);

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app_private.record_support_write() IS
  'One support-category audit row per row a platform account writes inside a '
  'support session: table, operation, company, row id, changed values with pay '
  'and identifiers redacted, and the context''s id and reason (20260920110000).';

-- ─── 5. On every table the refusal trigger guards ───────────────────────────

DO $mig$
DECLARE
  v_tbl   text;
  v_count int := 0;
BEGIN
  /*
    Derived from 3.4a's trigger rather than from a list: the audit covers
    exactly the writes whose company came from the context, which is the set
    that trigger was put on. A second hand-written list would be a copy that
    can drift from the first. The self-check below compares the two sets both
    ways, and tests/rls/support-write-audit.sql does again after the whole
    chain has applied.
  */
  FOR v_tbl IN
    SELECT c.relname::text
      FROM pg_trigger g
      JOIN pg_class c     ON c.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND g.tgname = 'refuse_read_only_context_write'
       AND NOT g.tgisinternal
     ORDER BY 1
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS record_support_write ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER record_support_write '
      'AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW '
      'WHEN (current_setting(%L, true) <> %L) '
      'EXECUTE FUNCTION app_private.record_support_write()',
      v_tbl, 'app_private.support_write_context', '');
    v_count := v_count + 1;
  END LOOP;

  -- 3.4a put its trigger on 39 tables. Fewer here means the derivation matched
  -- too little, and a support session would write unrecorded.
  IF v_count < 39 THEN
    RAISE EXCEPTION '3.4c: the audit trigger went onto % tables, expected at least 39', v_count;
  END IF;

  RAISE NOTICE '3.4c: support-session writes are recorded on % tables', v_count;
END $mig$;

-- ─── 6. Ownership and privileges ────────────────────────────────────────────

-- The three SECURITY DEFINER functions reach app_private, so they must belong
-- to the role that owns it; CREATE OR REPLACE keeps whatever owner a function had.
ALTER FUNCTION app_private.refuse_read_only_context_write()      OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.guard_company_hard_delete()           OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.record_support_write()                OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.support_write_redaction_pattern(text) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.support_write_values(jsonb)           OWNER TO CURRENT_USER;

-- Fired by triggers or called from them, never by a client. Triggers do not
-- check EXECUTE; the REVOKE is the second wall behind the missing USAGE on
-- app_private.
REVOKE ALL ON FUNCTION app_private.refuse_read_only_context_write()      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_company_hard_delete()           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.record_support_write()                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.support_write_redaction_pattern(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.support_write_values(jsonb)           FROM PUBLIC, anon, authenticated, service_role;

-- ─── 7. Self-check ──────────────────────────────────────────────────────────

DO $mig$
DECLARE
  c_flag CONSTANT text := 'app_private.support_write_context';
  v_wrong text;
  v_n     int;
BEGIN
  -- 1. The functions: SECURITY DEFINER where they reach app_private, a pinned
  --    search_path, an owner that can reach app_private, and no EXECUTE for
  --    anybody the API authenticates as.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ' ORDER BY f.sig) INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
                    IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1 FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
                 OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
                 OR has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'executable by a role the API authenticates as'
             END AS problem
        FROM (VALUES
          ('app_private.refuse_read_only_context_write()',      true),
          ('app_private.guard_company_hard_delete()',           true),
          ('app_private.record_support_write()',                true),
          ('app_private.support_write_redaction_pattern(text)', false),
          ('app_private.support_write_values(jsonb)',           false)
        ) AS v(sig, definer)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4c self-check: %', v_wrong;
  END IF;

  -- 2. The audit trigger sits exactly where the refusal trigger sits — no
  --    table with one and not the other, either way round.
  SELECT string_agg(d.problem, '; ' ORDER BY d.problem) INTO v_wrong
    FROM (
      SELECT format('%s carries the refusal trigger but no audit trigger', c.relname::text) AS problem
        FROM pg_trigger g
        JOIN pg_class c     ON c.oid = g.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND g.tgname = 'refuse_read_only_context_write'
         AND NOT g.tgisinternal
         AND NOT EXISTS (SELECT 1 FROM pg_trigger a
                          WHERE a.tgrelid = g.tgrelid
                            AND a.tgname = 'record_support_write'
                            AND NOT a.tgisinternal)
      UNION ALL
      SELECT format('%s carries the audit trigger but no refusal trigger', c.relname::text)
        FROM pg_trigger a
        JOIN pg_class c ON c.oid = a.tgrelid
       WHERE a.tgname = 'record_support_write'
         AND NOT a.tgisinternal
         AND NOT EXISTS (SELECT 1 FROM pg_trigger g
                          WHERE g.tgrelid = a.tgrelid
                            AND g.tgname = 'refuse_read_only_context_write'
                            AND NOT g.tgisinternal)
    ) d;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4c self-check: %', v_wrong;
  END IF;

  -- 3. Each one is AFTER, per row, on INSERT, UPDATE and DELETE and nothing
  --    else (tgtype 29 = ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16, not BEFORE,
  --    not INSTEAD, not TRUNCATE), enabled, and gated on the flag.
  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname::text) INTO v_wrong
    FROM pg_trigger a
    JOIN pg_class c ON c.oid = a.tgrelid
   WHERE a.tgname = 'record_support_write'
     AND NOT a.tgisinternal
     AND NOT (a.tgtype = 29
              AND a.tgenabled = 'O'
              AND a.tgqual IS NOT NULL
              AND pg_get_triggerdef(a.oid) ~ 'app_private\.support_write_context');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4c self-check: the audit trigger is not an enabled, gated AFTER ROW trigger on %', v_wrong;
  END IF;

  -- 4. audit_write refuses an action or a target_type it cannot store, and a
  --    refusal inside the trigger would make the support write fail. Checked
  --    for every audited table with its longest action, and each must have the
  --    id column the row is named by.
  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname::text) INTO v_wrong
    FROM pg_trigger a
    JOIN pg_class c ON c.oid = a.tgrelid
   WHERE a.tgname = 'record_support_write'
     AND NOT a.tgisinternal
     AND NOT (('support_write.' || c.relname::text || '.delete') ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
              AND length('support_write.' || c.relname::text || '.delete') <= 100
              AND c.relname::text ~ '^[a-z][a-z0-9_]*$'
              AND length(c.relname::text) <= 60
              AND EXISTS (SELECT 1 FROM pg_attribute t
                           WHERE t.attrelid = c.oid AND t.attname = 'id'
                             AND t.attnum > 0 AND NOT t.attisdropped));

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.4c self-check: audit_write could not record a write on %', v_wrong;
  END IF;

  -- 5. The redaction rule says what the header says it does.
  SELECT count(*) INTO v_n
    FROM (VALUES
      -- table                     column                     redacted
      ('salaries',                 'netto_salary',            true),
      ('salaries',                 'amount_due',              true),
      ('salaries',                 'notes',                   true),
      ('salaries',                 'status',                  false),
      ('salaries',                 'driver_id',               false),
      ('drivers',                  'salary_ratio',            true),
      ('drivers',                  'personalnummer',          true),
      ('drivers',                  'gender',                  true),
      ('drivers',                  'planning_hourly_rate',    true),
      ('drivers',                  'iban',                    true),
      ('drivers',                  'name',                    false),
      ('drivers',                  'company_id',              false),
      ('salary_payments',          'amount',                  true),
      ('salary_payments',          'salary_id',               false),
      ('receipts',                 'expense',                 false),
      ('receipts',                 'description',             false),
      ('fahrtenbuch_trips',        'price_amount',            false),
      ('fahrtenbuch_trips',        'assigned_driver_name',    false),
      ('driver_notes',             'note_text',               true),
      ('saved_stundennachweise',   'grundlohn_min',           false),
      ('historical_payroll_targets', 'wage_type_code',        false),
      ('historical_reconciliation_drivers', 'final_gross_cents', true),
      ('document_variables',       'value',                   true),
      -- the word rule for the two short tokens: a whole word, not a substring
      ('drivers',                  'bank_bic',                true),
      ('cars',                     'cubic_capacity',          false)
    ) AS v(tbl, col, redacted)
   WHERE (v.col ~ app_private.support_write_redaction_pattern(v.tbl)) IS DISTINCT FROM v.redacted;

  IF v_n <> 0 THEN
    RAISE EXCEPTION '3.4c self-check: % redaction case(s) answer the wrong way', v_n;
  END IF;

  -- 5b. The hard delete is decided before any cascade: companies carries the
  --     guard as an enabled BEFORE DELETE row trigger and nothing else of its
  --     kind (tgtype 11 = ROW 1 + BEFORE 2 + DELETE 8). Without it a company's
  --     delete would again be refused or let through depending on the order of
  --     its foreign-key cascades.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.companies'::regclass
                    AND g.tgname = 'guard_company_hard_delete'
                    AND NOT g.tgisinternal
                    AND g.tgtype = 11
                    AND g.tgenabled = 'O'
                    AND g.tgfoid = 'app_private.guard_company_hard_delete()'::regprocedure) THEN
    RAISE EXCEPTION '3.4c self-check: companies carries no enabled BEFORE DELETE row trigger calling guard_company_hard_delete()';
  END IF;

  -- 6. A statement disarms a flag it finds that is not its caller's. The
  --    migration has no subject, so it is the case of the service role and
  --    GoTrue. WHERE false: statement triggers fire for a statement that
  --    touches no row, and this one must touch none on a live database.
  PERFORM set_config(c_flag, gen_random_uuid()::text || ':' || gen_random_uuid()::text, true);
  UPDATE public.role_permissions SET page_key = page_key WHERE false;
  IF current_setting(c_flag, true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION '3.4c self-check: a statement by a caller without a subject left the audit armed';
  END IF;

  -- 7. The size cap keeps every value audit_write is handed under its limit.
  IF octet_length(app_private.support_write_values(
       (SELECT jsonb_object_agg('c' || i, repeat('x', 1000)) FROM generate_series(1, 40) AS g(i)))::text) > 32768
     OR app_private.support_write_values(NULL) <> '{"values": null}'::jsonb THEN
    RAISE EXCEPTION '3.4c self-check: support_write_values does not cap what it is handed';
  END IF;

  -- 8. The edge functions' door stays shut to these rows: 20260916150000's
  --    allow-list refuses any action the functions do not send, and the
  --    category `support` is not one it accepts at all.
  BEGIN
    PERFORM public.platform_audit_record('write', 'support_write.drivers.update', 'ok');
    RAISE EXCEPTION '3.4c self-check: platform_audit_record accepted support_write.drivers.update';
  EXCEPTION
    WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.platform_audit_record('support', 'support_write.drivers.update', 'ok');
    RAISE EXCEPTION '3.4c self-check: platform_audit_record accepted the support category';
  EXCEPTION
    WHEN sqlstate '22023' THEN NULL;
  END;

  RAISE NOTICE '3.4c self-check: passed';
END $mig$;
