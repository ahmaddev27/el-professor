-- ════════════════════════════════════════════════════════════════════════════
--  The support-write audit hides a driver's sentence on both of its paths
-- ════════════════════════════════════════════════════════════════════════════
--
--  `app_private.support_write_redaction_pattern()` decides, per table, which
--  column values a support session's audit row copies and which it replaces
--  with a marker. It names `driver_notes.note_text` -- free text about a
--  person's absence -- and, until this file, named nothing at all on
--  `partner_note_submissions`.
--
--  Those two columns hold the same sentence. A note that arrives from the
--  driver's app is stored twice: once on the submission the partner sent, and
--  once on the `driver_notes` row the reviewer accepted it into. So a platform
--  agent inside a support session who touched the note got an audit row with
--  the sentence hidden, and one who touched -- or cascaded into -- the
--  submission that produced it got the same sentence copied in full.
--
--  ── Measured, not inferred ─────────────────────────────────────────────────
--
--  `tests/rls/note-submission-delete.sql` probe 37 recorded it on a real write:
--  a support session deleting an accepted note leaves two audit rows, and the
--  note's read `{"redacted": true}` while the cascaded submission's read the
--  note's text. That probe is rewritten here into the positive assertion.
--
--  The live definition was read from the catalogue on both stacks on
--  23.10.2026, read-only, with `pg_get_functiondef`:
--
--    - staging: `20260920110000`'s body as spliced by `20261022150000`, whose
--      `driver_notes` arm reads `note_text|rejected_reason|latitude|longitude`.
--    - production: `20260920110000`'s body unspliced, `driver_notes` arm
--      `note_text`. `20261022150000` has not been released there yet, and it
--      sorts before this file, so it applies first in the same release.
--
--  Both are owned by `supabase_admin`, `LANGUAGE sql IMMUTABLE`, SECURITY
--  INVOKER, `SET search_path TO 'pg_catalog'`. This file is therefore anchored
--  on `document_variables`, which is in both, and never on the `driver_notes`
--  arm, whose text differs between the two.
--
--  ── What is redacted, and what is deliberately left in clear ───────────────
--
--  `partner_note_submissions`
--
--    note_text        REDACTED. The driver's own words about their absence or
--                     an incident -- the same sentence as
--                     `driver_notes.note_text`, which has been redacted since
--                     `20260920110000`. This is the defect.
--    rejected_reason  REDACTED. `driver_notes.rejected_reason` is redacted by
--                     `20261022150000` for the stated reason "free text about a
--                     person's report", and this is the same column in the same
--                     sense: the reviewer's words about what a named person
--                     submitted, pushed back to that person by
--                     `20261008130000`. Leaving it would keep the asymmetry
--                     this file exists to remove, one column further along.
--
--    Left in clear, each because it identifies a row or an act and not a
--    person's circumstances -- which is what keeps the audit row useful:
--    `id`, `company_id`, `driver_id`, `driver_note_id`, `reviewed_by`
--    (keys); `partner`, `external_submission_id`, `external_driver_id` (the
--    partner's own identifiers for the row and the link, not identifiers of a
--    person in the sense the generic arm screens -- no Personalnummer, tax or
--    social-security number, no IBAN); `note_type` (a closed vocabulary
--    validated against `app_private.note_behavior_for()`); `status`,
--    `status_pushed_at`, `status_push_error` (what happened to the record and
--    whether the driver was told -- a transport diagnostic written by our own
--    sender, never about a person); `start_date`, `end_date`, `start_time`,
--    `end_time`, `is_full_day`, `submitted_at`, `updated_at`, `reviewed_at`
--    (the window and the clock); `vehicle_plate` (the header of
--    `20260920110000` lists plates among what is copied).
--
--    `raw_payload` needs no branch: it is `jsonb`, and the audit already
--    records a JSON document as `{"omitted": true, "bytes": n}` by type.
--
--  `partner_receipt_submissions`
--
--    rejected_reason  REDACTED, by the same argument, and because
--                     `20261008150000` built the rejection sender for the two
--                     submission tables as a pair and deliberately gave them
--                     one shape. Redacting the column on one of a matched pair
--                     and not the other is the defect in miniature.
--
--    Left in clear, and this is a decision rather than an omission:
--    `description`, `merchant_name`, `category`, `city`, `postal_code`,
--    `amount`, `litres`, `price_per_litre`, `odometer_km`, `range_km`,
--    `receipt_date`, `receipt_time`, `document_path`, `captured_at`,
--    `read_by_agent`, `confirmed_by_driver`, `payment_method`. Every one of
--    them is a column of the Beleg, mirrored on `public.receipts` by
--    `20261005140000`, `20261011100000` and `20261012100000` -- and `receipts`
--    has no arm in this function, so the very same values are copied in clear
--    on the row the submission becomes. They describe a purchase, not a
--    person's pay or absence. The rule this function states is not "anything a
--    person typed"; redacting a Beleg's description would widen it, and would
--    recreate the asymmetry in the opposite direction. `amount` is a business
--    expense and not pay, which is the reading `20261019110000` already took
--    for its own `amount`.
--
--  ── The one rule that makes this file dangerous ────────────────────────────
--
--  This function must be restated to change it, and a restatement that drops a
--  branch is a silent data leak: nothing fails, the log simply starts copying a
--  salary again. So it is not retyped. Section 1 reads the live body out of the
--  catalogue, asserts its anchor occurs exactly once, splices the two new arms
--  in front of `document_variables`, and then compares the pattern of thirteen
--  tables before and after: every one but the two new ones must be character
--  for character what it was, and each new one must be exactly the old generic
--  answer plus its own alternative. Section 2 re-asserts every pre-existing
--  branch from the catalogue afterwards, including the ones this file did not
--  touch, by payload rather than by a substring that another arm also
--  satisfies.
--
--  ── Rolling back ───────────────────────────────────────────────────────────
--
--  The release before this one reads the function and never its text, and a
--  wider pattern only hides more. No `SCHEMA_EPOCH` bump.

-- ─── 1. the splice ──────────────────────────────────────────────────────────

DO $splice$
DECLARE
  -- Present in both live definitions, exactly once. Never anchor on the
  -- `driver_notes` arm: its text differs between staging and production.
  c_anchor CONSTANT text := 'WHEN ''document_variables'' THEN';

  -- The two new arms, then the anchor again. The indentation is the body's own
  -- (11 spaces before WHEN, 13 before its payload), so the stored definition
  -- stays readable to the next person who reads it out of the catalogue.
  c_insert CONSTANT text :=
    'WHEN ''partner_note_submissions'' THEN
             ''note_text|rejected_reason''
           WHEN ''partner_receipt_submissions'' THEN
             ''rejected_reason''
           WHEN ''document_variables'' THEN';

  -- The eight arms that already existed, the two added here, and three tables
  -- with no arm at all, so the comparison covers the generic answer too.
  c_tables CONSTANT text[] := ARRAY[
    'salaries', 'salary_payments', 'salary_cash_receipts', 'cash_movements',
    'planning_run_adjustments', 'historical_reconciliation_wh_drivers',
    'driver_notes', 'document_variables',
    'partner_note_submissions', 'partner_receipt_submissions',
    'drivers', 'receipts', 'no_such_table'];

  v_oid    regprocedure;
  v_def    text;
  v_hits   int;
  v_before jsonb;
  v_after  jsonb;
  v_want   text;
  v_t      text;
BEGIN
  v_oid := pg_catalog.to_regprocedure('app_private.support_write_redaction_pattern(text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      '20261023180000: app_private.support_write_redaction_pattern(text) does not exist. It is created by 20260920110000, which sorts before this file; the migration chain is broken.';
  END IF;

  v_def := pg_catalog.pg_get_functiondef(v_oid);

  -- Idempotent, as 20261022150000's splice is: a definition that already names
  -- the table has been spliced, and splicing twice would nest the arms.
  IF pg_catalog.strpos(v_def, 'partner_note_submissions') > 0 THEN
    RAISE NOTICE '20261023180000: the redaction pattern already names partner_note_submissions; nothing spliced';
    RETURN;
  END IF;

  -- Counted by length rather than by a regular expression, because the anchor
  -- itself contains quotes and a regex of it is one escaping mistake away from
  -- matching nothing and reporting zero.
  v_hits := (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, c_anchor, '')))
            / pg_catalog.length(c_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '20261023180000: expected the anchor %L exactly once in app_private.support_write_redaction_pattern, found %. The function was changed since 20260920110000; extend it by hand rather than guess.',
      c_anchor, v_hits;
  END IF;

  SELECT jsonb_object_agg(t, app_private.support_write_redaction_pattern(t))
    INTO v_before FROM unnest(c_tables) AS t;

  EXECUTE pg_catalog.replace(v_def, c_anchor, c_insert);

  SELECT jsonb_object_agg(t, app_private.support_write_redaction_pattern(t))
    INTO v_after FROM unnest(c_tables) AS t;

  FOREACH v_t IN ARRAY c_tables LOOP
    IF v_t = 'partner_note_submissions' THEN
      v_want := (v_before ->> v_t) || '|^(note_text|rejected_reason)$';
    ELSIF v_t = 'partner_receipt_submissions' THEN
      v_want := (v_before ->> v_t) || '|^(rejected_reason)$';
    ELSE
      v_want := v_before ->> v_t;
    END IF;

    IF v_after ->> v_t IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION
        '20261023180000: the redaction pattern for % is not what the splice intended | expected: % | actual: %',
        v_t, v_want, coalesce(v_after ->> v_t, '<null>');
    END IF;
  END LOOP;

  RAISE NOTICE '20261023180000: spliced two arms into app_private.support_write_redaction_pattern; % patterns compared, % unchanged',
    array_length(c_tables, 1), array_length(c_tables, 1) - 2;
END
$splice$;

-- CREATE OR REPLACE keeps the owner and the privileges, so neither is assigned
-- here. The REVOKE is re-issued because it is the second wall of the
-- `app_private` rule and is idempotent: nobody the API authenticates as may
-- call this, and revoking from `authenticated` alone -- forgetting `anon`, to
-- which Supabase grants EXECUTE on every new function -- is a recorded past
-- defect.
REVOKE ALL ON FUNCTION app_private.support_write_redaction_pattern(text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.support_write_redaction_pattern(text) IS
  'The columns of a table whose values the support-write audit never copies, as '
  'one regular expression: pay, identifiers beyond the name, gender and the free '
  'text about a person''s pay, absence or report (20260920110000; the driver '
  'note''s reason and position 20261022150000; both partner submission tables '
  '20261023180000).';

-- ─── 2. self-check ──────────────────────────────────────────────────────────
--
-- Read from the catalogue, and arm by arm rather than by a substring: `amount`
-- appears in four arms and `rejected_reason` in three, so a `strpos` on a
-- payload proves nothing about the arm it was meant to prove. Each arm is
-- therefore asserted through the function's own answer, which is the arm's
-- payload appended to the generic answer -- character for character, and
-- independent of how `pg_get_functiondef` happens to lay the body out.

DO $check$
DECLARE
  c_generic1 CONSTANT text :=
    '^(?!.*_id$).*(salary|gehalt|payroll|gross|brutto|netto|hourly_rate|payout|bank_account|tax_id|steuer|sozialversicherung|social_security|birth|geburt|personalnummer|gender)';
  c_generic2 CONSTANT text := '|^(?!.*_id$)(.*_)?(iban|bic)(_.*)?$';

  -- Every arm that must exist after this file, with its payload. `driver_notes`
  -- is the one whose payload depends on whether 20261022150000 has run, so it
  -- is checked separately against both shapes it is allowed to have.
  c_arms CONSTANT text[][] := ARRAY[
    ['salaries',
     'calc_revenue|calc_tips|amount_due|total_paid|remaining_balance|additional_net_payment_amount|notes|additional_payment_note'],
    ['salary_payments',
     'amount|description'],
    ['salary_cash_receipts',
     'amount|due_amount|paid_cash_manual_before|paid_cash_weekly_before|paid_cash_receipts_before|paid_bank_before|remaining_before|remaining_after'],
    ['cash_movements',                       'amount'],
    ['planning_run_adjustments',             'amount'],
    ['historical_reconciliation_wh_drivers', 'total_amount_cents'],
    ['document_variables',                   'value|default_value'],
    ['partner_note_submissions',             'note_text|rejected_reason'],
    ['partner_receipt_submissions',          'rejected_reason']];

  v_oid     regprocedure;
  v_def     text;
  v_generic text;
  v_dn      text;
  v_role    text;
  v_tbl     text;
  i         int;
BEGIN
  v_oid := pg_catalog.to_regprocedure('app_private.support_write_redaction_pattern(text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'self-check 1: app_private.support_write_redaction_pattern(text) is gone';
  END IF;
  v_def := pg_catalog.pg_get_functiondef(v_oid);

  -- 1. the shape of the function itself. SECURITY INVOKER and IMMUTABLE are
  --    load-bearing: it is a pure expression called from the audit trigger and
  --    from four other migrations' self-checks in regex position, and a definer
  --    would be a second, pointless privilege boundary over it.
  PERFORM 1 FROM pg_catalog.pg_proc p
   WHERE p.oid = v_oid
     AND p.prolang = (SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname = 'sql')
     AND p.provolatile = 'i'
     AND NOT p.prosecdef
     AND NOT p.proretset
     AND p.proconfig @> ARRAY['search_path=pg_catalog'];
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'self-check 1: app_private.support_write_redaction_pattern is no longer LANGUAGE sql IMMUTABLE, SECURITY INVOKER, single-valued with search_path pinned to pg_catalog. It is: %', v_def;
  END IF;

  -- 2. no role the API authenticates as may call it.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF pg_catalog.has_function_privilege(v_role, v_oid::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check 2: % may execute app_private.support_write_redaction_pattern', v_role;
    END IF;
  END LOOP;

  -- 3. the two generic alternatives, which apply to every table and carry the
  --    whole pay-and-identifier rule, survived character for character. Asked
  --    of the function, so this is the answer the audit actually gets, and of
  --    the body, so an arm that happened to produce the same string could not
  --    stand in for them.
  v_generic := app_private.support_write_redaction_pattern('no_such_table');
  IF v_generic IS DISTINCT FROM c_generic1 || c_generic2 THEN
    RAISE EXCEPTION
      'self-check 3: a table with no arm is no longer screened by exactly the two generic alternatives | expected: % | actual: %',
      c_generic1 || c_generic2, coalesce(v_generic, '<null>');
  END IF;
  IF pg_catalog.strpos(v_def, c_generic1) = 0
     OR pg_catalog.strpos(v_def, c_generic2) = 0
     OR pg_catalog.strpos(v_def, 'coalesce(''|^('' || CASE p_table') = 0 THEN
    RAISE EXCEPTION
      'self-check 3: the body no longer contains the two generic alternatives and the per-table CASE. It is: %', v_def;
  END IF;

  -- 4. the generic rule still does its job in both directions, so a pattern
  --    that matched nothing could not pass section 3 by accident.
  IF NOT ('gross_salary' ~ v_generic) OR 'driver_id' ~ v_generic OR 'status' ~ v_generic THEN
    RAISE EXCEPTION
      'self-check 4: the generic arm no longer redacts a pay column, or now redacts a key or a status';
  END IF;

  -- 5. every arm, by payload. The expected answer is the generic one plus the
  --    arm, which is what the body's coalesce builds.
  FOR i IN 1 .. array_length(c_arms, 1) LOOP
    IF app_private.support_write_redaction_pattern(c_arms[i][1])
       IS DISTINCT FROM v_generic || '|^(' || c_arms[i][2] || ')$' THEN
      RAISE EXCEPTION
        'self-check 5: the arm for % is not %L any more. The function answers: %',
        c_arms[i][1], c_arms[i][2], app_private.support_write_redaction_pattern(c_arms[i][1]);
    END IF;
  END LOOP;

  -- 6. `driver_notes`, whose arm 20261022150000 widens. Both shapes are
  --    allowed, and nothing else is: the point is that this file did not touch
  --    it, not which release the database is on.
  v_dn := app_private.support_write_redaction_pattern('driver_notes');
  IF v_dn IS DISTINCT FROM v_generic || '|^(note_text)$'
     AND v_dn IS DISTINCT FROM v_generic || '|^(note_text|rejected_reason|latitude|longitude)$' THEN
    RAISE EXCEPTION
      'self-check 6: the driver_notes arm is neither 20260920110000''s nor 20261022150000''s. The function answers: %', v_dn;
  END IF;

  -- 7. the two tables this file is about, read against their real columns. The
  --    set is exact in both directions, so neither a missing nor an extra
  --    column passes.
  IF (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.partner_note_submissions'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname ~ app_private.support_write_redaction_pattern('partner_note_submissions'))
     IS DISTINCT FROM 'note_text,rejected_reason' THEN
    RAISE EXCEPTION
      'self-check 7: the redacted columns of partner_note_submissions are not exactly note_text and rejected_reason';
  END IF;

  IF (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.partner_receipt_submissions'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname ~ app_private.support_write_redaction_pattern('partner_receipt_submissions'))
     IS DISTINCT FROM 'rejected_reason' THEN
    RAISE EXCEPTION
      'self-check 7: the redacted columns of partner_receipt_submissions are not exactly rejected_reason';
  END IF;

  -- 8. and the columns deliberately left in clear are still in clear, named one
  --    by one. This is the half a widening would break, and the reason each is
  --    listed in the header.
  IF (SELECT string_agg(c, ',' ORDER BY c) FROM unnest(ARRAY[
        'id', 'company_id', 'partner', 'external_submission_id', 'external_driver_id',
        'driver_id', 'note_type', 'status', 'driver_note_id', 'reviewed_by', 'reviewed_at',
        'submitted_at', 'updated_at', 'start_date', 'end_date', 'is_full_day',
        'start_time', 'end_time', 'raw_payload', 'status_pushed_at', 'status_push_error',
        'vehicle_plate']) AS c
       WHERE c ~ app_private.support_write_redaction_pattern('partner_note_submissions')) IS NOT NULL THEN
    RAISE EXCEPTION
      'self-check 8: a partner_note_submissions column this file leaves in clear is now redacted: %',
      (SELECT string_agg(c, ',' ORDER BY c) FROM unnest(ARRAY[
         'id', 'company_id', 'partner', 'external_submission_id', 'external_driver_id',
         'driver_id', 'note_type', 'status', 'driver_note_id', 'reviewed_by', 'reviewed_at',
         'submitted_at', 'updated_at', 'start_date', 'end_date', 'is_full_day',
         'start_time', 'end_time', 'raw_payload', 'status_pushed_at', 'status_push_error',
         'vehicle_plate']) AS c
        WHERE c ~ app_private.support_write_redaction_pattern('partner_note_submissions'));
  END IF;

  IF (SELECT string_agg(c, ',' ORDER BY c) FROM unnest(ARRAY[
        'id', 'company_id', 'partner', 'external_submission_id', 'external_driver_id',
        'driver_id', 'receipt_id', 'status', 'reviewed_by', 'reviewed_at', 'submitted_at',
        'updated_at', 'description', 'merchant_name', 'category', 'city', 'postal_code',
        'amount', 'litres', 'price_per_litre', 'odometer_km', 'range_km', 'receipt_date',
        'receipt_time', 'document_path', 'captured_at', 'read_by_agent',
        'confirmed_by_driver', 'payment_method', 'raw_payload', 'status_pushed_at',
        'status_push_error']) AS c
       WHERE c ~ app_private.support_write_redaction_pattern('partner_receipt_submissions')) IS NOT NULL THEN
    RAISE EXCEPTION
      'self-check 8: a partner_receipt_submissions column this file leaves in clear is now redacted: %',
      (SELECT string_agg(c, ',' ORDER BY c) FROM unnest(ARRAY[
         'id', 'company_id', 'partner', 'external_submission_id', 'external_driver_id',
         'driver_id', 'receipt_id', 'status', 'reviewed_by', 'reviewed_at', 'submitted_at',
         'updated_at', 'description', 'merchant_name', 'category', 'city', 'postal_code',
         'amount', 'litres', 'price_per_litre', 'odometer_km', 'range_km', 'receipt_date',
         'receipt_time', 'document_path', 'captured_at', 'read_by_agent',
         'confirmed_by_driver', 'payment_method', 'raw_payload', 'status_pushed_at',
         'status_push_error']) AS c
        WHERE c ~ app_private.support_write_redaction_pattern('partner_receipt_submissions'));
  END IF;

  -- 9. both tables still carry the pair of context triggers, so there is an
  --    audit row for this pattern to apply to in the first place.
  FOREACH v_tbl IN ARRAY ARRAY['partner_note_submissions', 'partner_receipt_submissions'] LOOP
    IF (SELECT count(*) FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = ('public.' || v_tbl)::regclass
           AND NOT t.tgisinternal
           AND t.tgname IN ('refuse_read_only_context_write', 'record_support_write')) <> 2 THEN
      RAISE EXCEPTION
        'self-check 9: % does not carry both context triggers, so this file''s redaction would apply to no audit row',
        v_tbl;
    END IF;
  END LOOP;

  RAISE NOTICE '20261023180000: self-check passed (9 sections, % arms asserted by payload)',
    array_length(c_arms, 1);
END
$check$;
