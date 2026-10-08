-- ════════════════════════════════════════════════════════════════════════════
--  The doorbell — a ring is bounded, and it carries nothing we store
-- ════════════════════════════════════════════════════════════════════════════
--
--  `20261008170000`. The ring carries **no credential**, by the owner's
--  decision of 08.10.2026: Reidey cannot replay the token it issued, so the
--  partner rings and we fetch with the token we hold sealed. That makes the
--  limits the only thing standing between the anon key — which ships in the
--  browser bundle — and a loop that hammers the partner on our behalf.
--
--  Four probes carry the slice:
--
--    §3  the three counters, including the GLOBAL one. Without it an attacker
--        inventing fleet ids has an unbounded number of per-fleet budgets, and
--        a per-fleet-only limit reads as a limit while bounding nothing.
--    §3  a refused ring is NOT counted twice, or a fleet past its limit could
--        never come back inside the window.
--    §4  a REVOKED connection is not an answer. The ring is how a submission
--        enters this product, so revoking must stop them arriving.
--    §4  an unknown fleet and a revoked one are the same answer, so a ring
--        cannot be used to ask which fleets this product knows.

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _db_call(p_sql text) RETURNS text
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

CREATE TEMP TABLE _db_out (
  n integer PRIMARY KEY, label text NOT NULL,
  actual text NOT NULL, expected text NOT NULL, matched boolean NOT NULL
);

CREATE OR REPLACE FUNCTION _db_rec(p_n integer, p_label text, p_actual text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  v_ok := p_actual = p_expected;
  INSERT INTO _db_out VALUES (p_n, p_label, p_actual, p_expected, v_ok);
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

-- A revoked connection carries its time: `partner_connections_revoked_has_time`
-- ties the two, which the first version of this fixture did not know and the
-- kit refused the insert for.
INSERT INTO partner_connections
       (id, company_id, partner, external_company_id, external_company_name, status, revoked_at)
VALUES ('5a000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000a',
        'reidey', 'fleet-a', 'Fleet A', 'active', NULL),
       ('5a000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000b',
        'reidey', 'fleet-b', 'Fleet B', 'revoked', now());

-- ─── 1. the argument contract ───────────────────────────────────────────────

DO $$
BEGIN
  PERFORM _db_rec(1, 'a ring with no partner is refused',
    _db_call($q$SELECT partner_doorbell_resolve(NULL, 'fleet-a')::text$q$),
    'ERR 22023 invalid_request');

  PERFORM _db_rec(2, 'and one with no fleet',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', '   ')::text$q$),
    'ERR 22023 invalid_request');
END $$;

-- ─── 2. the fleet resolves to one company ──────────────────────────────────

DO $$
BEGIN
  PERFORM _db_rec(3, 'a connected fleet resolves to its company',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-a') ->> 'company_id'$q$),
    'c0000000-0000-4000-8000-00000000000a');

  PERFORM _db_rec(4, 'the partner name is case-insensitive, like everywhere else',
    _db_call($q$SELECT partner_doorbell_resolve('REIDEY', 'fleet-a') ->> 'company_id'$q$),
    'c0000000-0000-4000-8000-00000000000a');

  -- The ring is how a submission enters this product, so a company that
  -- revoked its connection must stop receiving them.
  PERFORM _db_rec(5, 'a REVOKED connection is not an answer',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-b') ->> 'reason'$q$),
    'not_connected');

  -- Same answer, so a ring cannot be used to ask which fleets we know.
  PERFORM _db_rec(6, 'and an unknown fleet is the SAME answer',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-nobody') ->> 'reason'$q$),
    'not_connected');

  PERFORM _db_rec(7, 'an unknown partner likewise',
    _db_call($q$SELECT partner_doorbell_resolve('someone-else', 'fleet-a') ->> 'reason'$q$),
    'not_connected');
END $$;

-- ─── 3. the three counters ─────────────────────────────────────────────────

DO $$
DECLARE
  v_before int;
  v_n      int;
BEGIN
  -- Every ring so far was counted, the refused ones included: counting an
  -- unknown fleet is what bounds enumeration.
  SELECT count(*) INTO v_before FROM app_private.partner_doorbell_events;
  PERFORM _db_rec(8, 'every ring so far was counted, refusals included',
    (v_before >= 5)::text, 'true');

  -- Per fleet per minute: 20. now() is the transaction's start, so every row
  -- here is inside the same minute.
  DELETE FROM app_private.partner_doorbell_events;
  INSERT INTO app_private.partner_doorbell_events (partner, external_company_id, rung_at)
  SELECT 'reidey', 'fleet-a', now() FROM generate_series(1, 19);

  PERFORM _db_rec(9, 'the 20th ring in a minute is still answered',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-a') ->> 'company_id'$q$),
    'c0000000-0000-4000-8000-00000000000a');

  PERFORM _db_rec(10, 'and the 21st is rate limited',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-a') ->> 'reason'$q$),
    'rate_limited');

  -- A refused ring must not be counted, or a fleet past its limit could never
  -- come back inside the window: each refusal would push the window along.
  SELECT count(*) INTO v_n FROM app_private.partner_doorbell_events
   WHERE partner = 'reidey' AND external_company_id = 'fleet-a';
  PERFORM _db_rec(11, 'a refused ring is not counted again',
    v_n::text, '20');

  -- Another fleet has its own minute budget.
  PERFORM _db_rec(12, 'a different fleet is unaffected by it',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-nobody') ->> 'reason'$q$),
    'not_connected');
END $$;

DO $$
DECLARE v_n int;
BEGIN
  -- Per fleet per hour: 120, and the rows have to be INSIDE the hour while
  -- being outside the last minute. The first version spread them over 121
  -- MINUTES, so sixty of them were older than the window and the counter saw
  -- 59 -- the probe read as "the limit does not fire" when the fixture was what
  -- did not. 28 seconds apart from 70 seconds ago: 120 rows, newest 1m10s old,
  -- oldest 56m42s, none of them in the last minute and none past the hour.
  DELETE FROM app_private.partner_doorbell_events;
  INSERT INTO app_private.partner_doorbell_events (partner, external_company_id, rung_at)
  SELECT 'reidey', 'fleet-a',
         now() - interval '70 seconds' - (g * 28 || ' seconds')::interval
    FROM generate_series(0, 119) g;

  SELECT count(*) INTO v_n FROM app_private.partner_doorbell_events
   WHERE rung_at > now() - interval '1 hour';
  PERFORM _db_rec(13, 'all 120 are inside the hour (the control the fixture failed)',
    v_n::text, '120');

  SELECT count(*) INTO v_n FROM app_private.partner_doorbell_events
   WHERE rung_at > now() - interval '1 minute';
  PERFORM _db_rec(22, 'and none of them is inside the last minute (the other control)',
    v_n::text, '0');

  PERFORM _db_rec(14, 'the 121st ring in an hour is rate limited',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-a') ->> 'reason'$q$),
    'rate_limited');
END $$;

DO $$
DECLARE v_n int;
BEGIN
  -- The global counter, and it is the one that matters: without it an attacker
  -- inventing fleet ids has an unbounded number of per-fleet budgets.
  DELETE FROM app_private.partner_doorbell_events;
  INSERT INTO app_private.partner_doorbell_events (partner, external_company_id, rung_at)
  SELECT 'reidey', 'invented-' || g, now() FROM generate_series(1, 240) g;

  SELECT count(*) INTO v_n FROM app_private.partner_doorbell_events
   WHERE partner = 'reidey' AND external_company_id = 'fleet-a';
  PERFORM _db_rec(15, 'fleet-a has rung zero times (the control)',
    v_n::text, '0');

  PERFORM _db_rec(16, 'a fleet with no rings of its own is refused by the GLOBAL limit',
    _db_call($q$SELECT partner_doorbell_resolve('reidey', 'fleet-a') ->> 'reason'$q$),
    'rate_limited');
END $$;

DO $$
DECLARE v_n int;
BEGIN
  -- The purge, which is why no host cron line was needed. Rows older than the
  -- longest window go; nothing a counter reads is touched.
  DELETE FROM app_private.partner_doorbell_events;
  INSERT INTO app_private.partner_doorbell_events (partner, external_company_id, rung_at)
  VALUES ('reidey', 'old', now() - interval '3 hours'),
         ('reidey', 'recent', now() - interval '30 minutes');

  PERFORM partner_doorbell_resolve('reidey', 'fleet-a');

  SELECT count(*) INTO v_n FROM app_private.partner_doorbell_events
   WHERE external_company_id = 'old';
  PERFORM _db_rec(17, 'a ring purges events older than the longest window',
    v_n::text, '0');

  SELECT count(*) INTO v_n FROM app_private.partner_doorbell_events
   WHERE external_company_id = 'recent';
  PERFORM _db_rec(18, 'and keeps everything a counter still reads',
    v_n::text, '1');
END $$;

-- ─── 4. the shape ──────────────────────────────────────────────────────────

DO $$
DECLARE v_n int;
BEGIN
  PERFORM _db_rec(19, 'the resolver is not executable by anon or authenticated',
    (has_function_privilege('anon', 'public.partner_doorbell_resolve(text,text)', 'EXECUTE')::int
     + has_function_privilege('authenticated', 'public.partner_doorbell_resolve(text,text)', 'EXECUTE')::int)::text,
    '0');

  PERFORM _db_rec(20, 'and the events table is reachable by no API role',
    (has_table_privilege('anon', 'app_private.partner_doorbell_events', 'SELECT')::int
     + has_table_privilege('authenticated', 'app_private.partner_doorbell_events', 'SELECT')::int
     + has_table_privilege('service_role', 'app_private.partner_doorbell_events', 'SELECT')::int
     + has_table_privilege('service_role', 'app_private.partner_doorbell_events', 'DELETE')::int)::text,
    '0');

  -- A limiter whose own table a caller could empty is not a limiter. The wall
  -- is missing USAGE on the schema; this is the second one.
  SELECT count(*) INTO v_n FROM information_schema.table_privileges
   WHERE table_schema = 'app_private' AND table_name = 'partner_doorbell_events'
     AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC');
  PERFORM _db_rec(21, 'no grant of any kind on the limiter''s table',
    v_n::text, '0');
END $$;

-- ─── the verdict ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT matched), count(*) INTO v_bad, v_all FROM _db_out;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'partner doorbell: % of % probe(s) did not match — read the XX lines above', v_bad, v_all;
  END IF;
  RAISE NOTICE '── partner doorbell: all % probes matched ──', v_all;
END $$;

ROLLBACK;
