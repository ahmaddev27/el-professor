-- ════════════════════════════════════════════════════════════════════════════
--  M3's sender is gone, and stays gone
-- ════════════════════════════════════════════════════════════════════════════
--
--  This file used to measure `partner_submission_push_target` and
--  `partner_submission_push_record`, the two functions behind the edge function
--  `partner-notify`: only a rejection travelled, and a failed delivery stayed
--  visible. There is no rejection any more (20261013100000: every submission
--  is accepted on arrival), so 20261013110000 dropped both functions and the
--  edge function with them, and the probes about what they did went too.
--
--  What is left is the one thing worth asserting: that they are not there. A
--  removal nobody asserts comes back the next time someone copies an old
--  migration, and the owner's rule is that a rejected submission can no longer
--  exist to be announced. Counted in the catalogue, because
--  has_function_privilege raises on a function that does not exist.

BEGIN;

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

DO $$
BEGIN
  PERFORM _sp_rec(1, 'partner_submission_push_target no longer exists',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_target'),
    '0');
  PERFORM _sp_rec(2, 'nor does partner_submission_push_record',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'partner_submission_push_record'),
    '0');
  -- The columns are history and stay: they record what was once announced.
  PERFORM _sp_rec(3, 'the push bookkeeping columns are untouched',
    (SELECT count(*)::text FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'partner_note_submissions'
        AND column_name = 'status_pushed_at'),
    '1');
END $$;

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _sp_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner status push: % of % probe(s) did not match - read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── partner status push: all % probes matched ──', v_all;
END $$;

ROLLBACK;
