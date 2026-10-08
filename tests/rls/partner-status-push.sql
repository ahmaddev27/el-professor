-- ════════════════════════════════════════════════════════════════════════════
--  M3's sender — only a rejection travels, and a failure stays visible
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261008130000`'s two functions. Three probes are the reason this file
--  exists rather than the self-checks alone:
--
--    §2  an ACCEPTED submission is never a push. The owner's decision of
--        06.10.2026 — a rejection is news the driver must act on, an acceptance
--        is not worth a push — and the only thing keeping an accepted note from
--        becoming a notification nobody asked for.
--    §3  a FAILED delivery leaves `status_pushed_at` NULL. If it stamped the
--        time anyway, an undelivered rejection would read as delivered and
--        nobody would ever look again.
--    §2  the target carries the reviewer's words and NOT the note's text. A
--        driver is told why their submission was refused, not sent their own
--        note back with the company's internal record attached.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _sp_call(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out  text;
  v_hint text;
BEGIN
  EXECUTE p_sql INTO v_out;
  RETURN coalesce(v_out, 'null');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
  RETURN 'ERR ' || SQLSTATE || ' ' || coalesce(nullif(v_hint, ''), '(no hint)');
END;
$$;

CREATE TEMP TABLE _sp_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _sp_rec(p_n integer, p_label text, p_actual text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := p_actual = p_expected;
  INSERT INTO _sp_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END;
$$;

-- ─── fixtures: one of each state a push must tell apart ─────────────────────

INSERT INTO drivers (id, company_id, name) VALUES
  ('3a000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'Push Driver');

INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
VALUES ('3b000000-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000001',
        '3a000000-0000-4000-8000-000000000001', 'angenommen', 'c0000000-0000-4000-8000-00000000000a');

INSERT INTO partner_note_submissions
       (id, company_id, partner, external_submission_id, external_driver_id,
        driver_id, note_type, note_text, status, rejected_reason)
VALUES ('3c000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'sp-rejected', 'sp-1', '3a000000-0000-4000-8000-000000000001',
        'breakdown', 'Panne auf der A100', 'rejected', 'Beleg fehlt');

INSERT INTO partner_note_submissions
       (id, company_id, partner, external_submission_id, external_driver_id,
        driver_id, note_type, note_text, status, driver_note_id)
VALUES ('3c000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'sp-accepted', 'sp-2', '3a000000-0000-4000-8000-000000000001',
        'wait', 'Wartezeit', 'accepted', '3b000000-0000-4000-8000-000000000001');

INSERT INTO partner_note_submissions
       (id, company_id, partner, external_submission_id, external_driver_id,
        note_type, note_text)
VALUES ('3c000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'sp-pending', 'sp-3', 'general', 'offen');

-- ─── 1. the argument contract ───────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sp_rec(1, 'a target with no submission is refused',
    _sp_call($q$SELECT partner_submission_push_target(NULL)::text$q$),
    'ERR 22023 invalid_request');

  PERFORM _sp_rec(2, 'a submission that does not exist is a return value, not a raise',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-0000000000ff') ->> 'reason'$q$),
    'submission_not_found');

  PERFORM _sp_rec(3, 'and recording against one that does not exist says so too',
    _sp_call($q$SELECT partner_submission_push_record('3c000000-0000-4000-8000-0000000000ff') ->> 'reason'$q$),
    'submission_not_found');
END $$;

-- ─── 2. only a rejection travels, and only what the driver needs ────────────

DO $$
BEGIN
  PERFORM _sp_rec(4, 'a rejection is pushable',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ->> 'ok'$q$),
    'true');

  -- The owner's decision, and the only thing stopping an accepted note from
  -- becoming a notification nobody asked for.
  PERFORM _sp_rec(5, 'an ACCEPTED submission is never pushed',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-000000000002') ->> 'reason'$q$),
    'not_pushable');

  PERFORM _sp_rec(6, 'and neither is one still pending',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-000000000003') ->> 'reason'$q$),
    'not_pushable');

  PERFORM _sp_rec(7, 'the target names the partner''s own ids, which is what addresses it',
    _sp_call($q$SELECT (partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ->> 'external_submission_id')
                   || ' / ' || (partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ->> 'external_driver_id')$q$),
    'sp-rejected / sp-1');

  PERFORM _sp_rec(8, 'and carries the reviewer''s own words',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ->> 'reason_text'$q$),
    'Beleg fehlt');

  -- A driver is told WHY their submission was refused — not sent their own note
  -- back, and not the company's internal record of who decided.
  PERFORM _sp_rec(9, 'it carries NOT the note''s text, nor the reviewer, nor the note id',
    _sp_call($q$SELECT (
        (partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ? 'note_text')::int
      + (partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ? 'reviewed_by')::int
      + (partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ? 'driver_note_id')::int
      + (partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ? 'raw_payload')::int
      )::text$q$),
    '0');

  PERFORM _sp_rec(10, 'and it names the company, so a caller can check it against its own',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ->> 'company_id'$q$),
    'c0000000-0000-4000-8000-00000000000a');
END $$;

-- ─── 3. a failure stays visible ─────────────────────────────────────────────
-- There is no scheduler here, so nothing retries on its own. `status_pushed_at
-- IS NULL` on a rejected submission is exactly "the driver has not been told".

DO $$
BEGIN
  PERFORM _sp_rec(11, 'a failed delivery is recorded as not delivered',
    _sp_call($q$SELECT partner_submission_push_record('3c000000-0000-4000-8000-000000000001', 'HTTP 502') ->> 'delivered'$q$),
    'false');

  -- The probe this section exists for.
  PERFORM _sp_rec(12, 'so the timestamp stays NULL and the reason is kept',
    (SELECT coalesce(status_pushed_at::text, 'null') || ' / ' || coalesce(status_push_error, 'null')
       FROM partner_note_submissions WHERE id = '3c000000-0000-4000-8000-000000000001'),
    'null / HTTP 502');

  PERFORM _sp_rec(13, 'and it is still pushable, so the operator can try again',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ->> 'ok'$q$),
    'true');

  PERFORM _sp_rec(14, 'a success stamps the time and clears the reason',
    _sp_call($q$SELECT partner_submission_push_record('3c000000-0000-4000-8000-000000000001') ->> 'delivered'$q$),
    'true');

  PERFORM _sp_rec(15, 'so the row shows delivered with no error',
    (SELECT CASE WHEN status_pushed_at IS NULL THEN 'null' ELSE 'stamped' END
            || ' / ' || coalesce(status_push_error, 'null')
       FROM partner_note_submissions WHERE id = '3c000000-0000-4000-8000-000000000001'),
    'stamped / null');

  -- Without this, "a rejection is pushable" would stay true for ever and the
  -- screen would ask for a delivery that already happened.
  PERFORM _sp_rec(16, 'and it is no longer pushable',
    _sp_call($q$SELECT partner_submission_push_target('3c000000-0000-4000-8000-000000000001') ->> 'reason'$q$),
    'already_pushed');

  -- A later failure must not erase a delivery that did happen.
  PERFORM _sp_call($q$SELECT partner_submission_push_record('3c000000-0000-4000-8000-000000000001', 'HTTP 502')::text$q$);
  PERFORM _sp_rec(17, 'a later failure does NOT un-deliver what was delivered',
    (SELECT CASE WHEN status_pushed_at IS NULL THEN 'null' ELSE 'stamped' END
       FROM partner_note_submissions WHERE id = '3c000000-0000-4000-8000-000000000001'),
    'stamped');
END $$;

-- ─── 4. the shape ──────────────────────────────────────────────────────────

DO $$
DECLARE v_n int;
BEGIN
  PERFORM _sp_rec(18, 'neither function is executable by anon or authenticated',
    (has_function_privilege('anon', 'public.partner_submission_push_target(uuid)', 'EXECUTE')::int
     + has_function_privilege('authenticated', 'public.partner_submission_push_target(uuid)', 'EXECUTE')::int
     + has_function_privilege('anon', 'public.partner_submission_push_record(uuid,text)', 'EXECUTE')::int
     + has_function_privilege('authenticated', 'public.partner_submission_push_record(uuid,text)', 'EXECUTE')::int)::text,
    '0');

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_note_submissions'
     AND cmd IN ('INSERT', 'DELETE');
  PERFORM _sp_rec(19, 'the submission table still has no INSERT and no DELETE policy',
    v_n::text, '0');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _sp_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner status push: % of % probe(s) did not match — read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── partner status push: all % probes matched ──', v_all;
END $$;

ROLLBACK;
