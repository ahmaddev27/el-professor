-- ════════════════════════════════════════════════════════════════════════════
--  M1.5 — what a roster pull does, and what the owner's decision looks like
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261008120000`'s two functions. The migration's self-check 4 reads the
--  body and refuses an UPDATE that assigns `status` or `driver_id`; this file
--  proves the behaviour instead of the shape, because a body can satisfy a
--  regex and still be wrong.
--
--  Four probes are the reason the file exists rather than a comment:
--
--    §3  a CONFIRMED link whose driver has left the partner's fleet keeps its
--        `linked` status and its driver. That is the owner's decision of
--        08.10.2026 — badge, never unlink — and it is the one thing here a
--        future "tidy-up" would undo.
--    §3  a driver who RETURNS has the badge cleared, so the column records the
--        occurrence and not the day a pull happened to run.
--    §4  a pull records a failure without erasing the last success, so "it ran
--        and failed" is distinguishable from "it never ran".
--    §4  a pull never revives a revoked connection.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _rp_call(p_sql text) RETURNS text
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

CREATE TEMP TABLE _rp_out (
  n        integer PRIMARY KEY,
  label    text    NOT NULL,
  actual   text    NOT NULL,
  expected text    NOT NULL,
  matched  boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _rp_rec(p_n integer, p_label text, p_actual text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := p_actual = p_expected;
  INSERT INTO _rp_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok  %  %', lpad(p_n::text, 2), p_label;
  ELSE
    RAISE WARNING 'XX  %  %', lpad(p_n::text, 2), p_label;
    RAISE WARNING '        expected: %', p_expected;
    RAISE WARNING '        actual:   %', p_actual;
  END IF;
END;
$$;

-- ─── fixtures ───────────────────────────────────────────────────────────────

INSERT INTO drivers (id, company_id, name) VALUES
  ('2a000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a', 'Confirmed Driver');

-- A connection to stamp, and a revoked one that a pull must never revive.
INSERT INTO partner_connections (id, company_id, partner, status, last_success_at) VALUES
  ('2b000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
   'reidey', 'active', '2026-10-01 10:00+02');
INSERT INTO partner_connections (id, company_id, partner, status, revoked_at) VALUES
  ('2b000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000a',
   'gone', 'revoked', now());

-- One link already CONFIRMED, so §3 measures what a pull does to a decision a
-- person made rather than to a fresh proposal.
INSERT INTO partner_driver_links
       (id, company_id, partner, external_driver_id, driver_id, status, linked_at)
VALUES ('2c000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'rp-1', '2a000000-0000-4000-8000-000000000001', 'linked', now());

-- ─── 1. the argument contract ───────────────────────────────────────────────

DO $$
DECLARE v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _rp_rec(1, 'a roster with no company is refused',
    _rp_call($q$SELECT partner_roster_apply(NULL, 'reidey', '[]'::jsonb)::text$q$),
    'ERR 22023 invalid_request');

  PERFORM _rp_rec(2, 'a roster that is not an array is refused by name',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', '{"id":"x"}'::jsonb)::text$q$, v_co)),
    'ERR 22023 invalid_roster');

  PERFORM _rp_rec(3, 'an empty page is a valid pull that saw nothing',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', '[]'::jsonb) ->> 'seen'$q$, v_co)),
    '0');
END $$;

-- ─── 2. what the pull records, and what it refreshes ────────────────────────

DO $$
DECLARE v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _rp_rec(4, 'two new drivers are proposed',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', $j$[
        {"id": "rp-2", "name": "Neu Eins", "email": "A@X.DE", "phone": "+49170"},
        {"id": "rp-3", "name": "Neu Zwei"}
      ]$j$::jsonb) ->> 'new'$q$, v_co)),
    '2');

  PERFORM _rp_rec(5, 'and they arrive pending, with no driver',
    (SELECT status || ' / ' || coalesce(driver_id::text, 'null') FROM partner_driver_links
      WHERE company_id = v_co::uuid AND partner = 'reidey' AND external_driver_id = 'rp-2'),
    'pending / null');

  PERFORM _rp_rec(6, 'the e-mail is stored lower-cased, as every other address is',
    (SELECT proposed_email FROM partner_driver_links
      WHERE company_id = v_co::uuid AND partner = 'reidey' AND external_driver_id = 'rp-2'),
    'a@x.de');

  -- A second pull refreshes what the partner proposes. A driver who corrected
  -- their details there must be shown correctly here.
  PERFORM _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', $j$[
      {"id": "rp-2", "name": "Korrigiert", "phone": "+49171"}
    ]$j$::jsonb)::text$q$, v_co));

  PERFORM _rp_rec(7, 'a second pull refreshes the name and clears what is now absent',
    (SELECT proposed_name || ' / ' || coalesce(proposed_email, 'null') || ' / ' || coalesce(proposed_phone, 'null')
       FROM partner_driver_links
      WHERE company_id = v_co::uuid AND partner = 'reidey' AND external_driver_id = 'rp-2'),
    'Korrigiert / null / +49171');

  PERFORM _rp_rec(8, 'and it is not a second row',
    (SELECT count(*)::text FROM partner_driver_links
      WHERE company_id = v_co::uuid AND partner = 'reidey' AND external_driver_id = 'rp-2'),
    '1');

  -- A driver the partner cannot identify is skipped, not stored under a blank
  -- key where it would collide with every other such row.
  PERFORM _rp_rec(9, 'a driver with no id is skipped rather than stored blank',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', $j$[
        {"name": "Kein Schlüssel"}, {"id": "  ", "name": "Leer"}
      ]$j$::jsonb) ->> 'seen'$q$, v_co)),
    '0');
END $$;

-- ─── 3. the owner's decision: badge, never unlink ───────────────────────────
-- 08.10.2026. Unlinking would silently detach the driver from the submissions
-- and notes already attributed to them, and "this person left the other
-- product" is a different fact from "this person is not our driver".

DO $$
DECLARE v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _rp_rec(10, 'the partner reports the confirmed driver as departed',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', $j$[
        {"id": "rp-1", "name": "Confirmed Driver", "roster_removed_at": "2026-10-07T08:00:00+02:00"}
      ]$j$::jsonb) ->> 'departed'$q$, v_co)),
    '1');

  -- The probe this whole file is for.
  PERFORM _rp_rec(11, 'the link KEEPS its status and its driver — it is a badge',
    (SELECT status || ' / ' || coalesce(driver_id::text, 'null')
       FROM partner_driver_links WHERE id = '2c000000-0000-4000-8000-000000000001'),
    'linked / 2a000000-0000-4000-8000-000000000001');

  PERFORM _rp_rec(12, 'and the departure is recorded where a screen can read it',
    (SELECT CASE WHEN partner_removed_at IS NULL THEN 'null' ELSE 'recorded' END
       FROM partner_driver_links WHERE id = '2c000000-0000-4000-8000-000000000001'),
    'recorded');

  -- Reporting it again is the same occurrence, not a second departure.
  PERFORM _rp_rec(13, 'reporting the same departure again counts nothing new',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', $j$[
        {"id": "rp-1", "roster_removed_at": "2026-10-07T08:00:00+02:00"}
      ]$j$::jsonb) ->> 'departed'$q$, v_co)),
    '0');

  -- And the driver comes back. Without this, probe 12 would also pass for an
  -- implementation that can only ever set the badge.
  PERFORM _rp_rec(14, 'a driver who RETURNS has the badge cleared',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', $j$[
        {"id": "rp-1", "name": "Confirmed Driver"}
      ]$j$::jsonb) ->> 'returned'$q$, v_co)),
    '1');

  PERFORM _rp_rec(15, 'so the column records the occurrence, not the run',
    (SELECT CASE WHEN partner_removed_at IS NULL THEN 'null' ELSE 'recorded' END
       FROM partner_driver_links WHERE id = '2c000000-0000-4000-8000-000000000001'),
    'null');

  PERFORM _rp_rec(16, 'and the link is still exactly as the person left it',
    (SELECT status || ' / ' || coalesce(driver_id::text, 'null')
       FROM partner_driver_links WHERE id = '2c000000-0000-4000-8000-000000000001'),
    'linked / 2a000000-0000-4000-8000-000000000001');

  -- An unreadable timestamp must not cost us the driver.
  PERFORM _rp_rec(17, 'an unreadable departure date still records the driver',
    _rp_call(format($q$SELECT partner_roster_apply(%L, 'reidey', $j$[
        {"id": "rp-4", "name": "Kaputtes Datum", "roster_removed_at": "gestern"}
      ]$j$::jsonb) ->> 'seen'$q$, v_co)),
    '1');

  PERFORM _rp_rec(18, 'and simply does not claim the departure',
    (SELECT CASE WHEN partner_removed_at IS NULL THEN 'null' ELSE 'recorded' END
       FROM partner_driver_links
      WHERE company_id = v_co::uuid AND partner = 'reidey' AND external_driver_id = 'rp-4'),
    'null');
END $$;

-- ─── 4. the pull's own record ───────────────────────────────────────────────

DO $$
DECLARE v_co constant text := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _rp_rec(19, 'a failed pull is stamped and keeps the last success',
    _rp_call(format($q$SELECT partner_pull_record(%L, 'reidey', 'HTTP 502') ->> 'ok'$q$, v_co)),
    'true');

  -- The distinction a record of failure exists for: "it ran and failed" is not
  -- "it never ran".
  PERFORM _rp_rec(20, 'so the connection shows failed, an error, and the OLD success',
    (SELECT status || ' / ' || coalesce(last_error, 'null') || ' / '
            || CASE WHEN last_success_at = '2026-10-01 10:00+02'::timestamptz
                    THEN 'the old success' ELSE 'moved' END
       FROM partner_connections WHERE id = '2b000000-0000-4000-8000-000000000001'),
    'failed / HTTP 502 / the old success');

  PERFORM _rp_rec(21, 'and last_pull_at moved even though nothing succeeded',
    (SELECT CASE WHEN last_pull_at IS NULL THEN 'null' ELSE 'stamped' END
       FROM partner_connections WHERE id = '2b000000-0000-4000-8000-000000000001'),
    'stamped');

  PERFORM _rp_rec(22, 'a success clears the error and moves the success',
    _rp_call(format($q$SELECT partner_pull_record(%L, 'reidey') ->> 'ok'$q$, v_co)),
    'true');

  PERFORM _rp_rec(23, 'so the connection is active again with no error',
    (SELECT status || ' / ' || coalesce(last_error, 'null') || ' / '
            || CASE WHEN last_success_at > '2026-10-01 10:00+02'::timestamptz
                    THEN 'moved' ELSE 'the old success' END
       FROM partner_connections WHERE id = '2b000000-0000-4000-8000-000000000001'),
    'active / null / moved');

  -- A revoked connection is a decision a person made.
  PERFORM _rp_call(format($q$SELECT partner_pull_record(%L, 'gone')::text$q$, v_co));
  PERFORM _rp_rec(24, 'a pull never revives a revoked connection',
    (SELECT status || ' / ' || CASE WHEN last_pull_at IS NULL THEN 'untouched' ELSE 'stamped' END
       FROM partner_connections WHERE id = '2b000000-0000-4000-8000-000000000002'),
    'revoked / untouched');
END $$;

-- ─── 5. the shape ───────────────────────────────────────────────────────────

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_driver_links'
     AND cmd IN ('INSERT', 'DELETE');
  PERFORM _rp_rec(25, 'the links table still has no INSERT and no DELETE policy',
    v_n::text, '0');

  PERFORM _rp_rec(26, 'neither pull function is executable by anon or authenticated',
    (has_function_privilege('anon', 'public.partner_roster_apply(uuid,text,jsonb)', 'EXECUTE')::int
     + has_function_privilege('authenticated', 'public.partner_roster_apply(uuid,text,jsonb)', 'EXECUTE')::int
     + has_function_privilege('anon', 'public.partner_pull_record(uuid,text,text)', 'EXECUTE')::int
     + has_function_privilege('authenticated', 'public.partner_pull_record(uuid,text,text)', 'EXECUTE')::int)::text,
    '0');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _rp_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner roster pull: % of % probe(s) did not match — read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── partner roster pull: all % probes matched ──', v_all;
END $$;

ROLLBACK;
