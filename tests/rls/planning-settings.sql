/*
  What an applied planning run stores about how it was planned
  (migration 20260928110000).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it.

  ── WHY THIS FILE TESTS A FUNCTION SHAPE AND NOT A ROW ────────────────────

  The kit's fixture is a `--schema=public` dump: no companies, so no
  `company_planning_runs` row can be inserted (the table's company_id is a
  foreign key), and no import to apply. So this file reads the two functions'
  own definitions out of the catalogue and asserts the shape of the object they
  build, plus the *behaviour* of the two expressions they build it from — which
  it extracts from the live definition and evaluates against synthetic
  payloads, so it tests what ships rather than a copy of it.

  ── THE RULE BEING PINNED ─────────────────────────────────────────────────

  `FinalizePlanningModal` is a hard gate with no override. Its
  `Fahrzeugwechsel zu kurz` check reads `vehicle_switch_buffer_minutes` out of
  the applied run's `settings_json` and falls back to a hard-coded 30 when the
  run carries none. Until 20260928110000 neither RPC stored it, so a company
  that configured a buffer below 30 planned a month to its own number and had
  it judged against 30 — and could never finalize it. The reader honours a
  stored 0 (`storedBuffer >= 0`), which is why an omitted key must store NULL
  and never 0: a 0 would set the gap to zero and disable the check outright.

  What is covered, in order:

    1. writers     exactly two functions write settings_json, and both are
                   plpgsql SECURITY DEFINER with a pinned search_path
    2. settings    the settings object carries the three keys it always did,
                   `replaced_run_id` where it did, and both new ones
    3. no leak     of every jsonb_build_object in each function, exactly ONE
                   names each new key — so summary_json, apply_summary_json and
                   the returns were not widened. apply_summary_json is asserted
                   clean by name as well: CLAUDE.md records that its
                   `updated_trips` count is re-verified during finalization, so
                   it is not an object this change may touch
    4. negative    the pre-migration settings object — three keys in `apply`,
       control     those three plus `replaced_run_id` in `replace` — no longer
                   occurs, and no new key is defaulted with COALESCE
    5. behaviour   the two expressions, taken from the live definition and
                   evaluated: omitted, JSON null and "" all store NULL, while
                   0, 20 and both booleans are stored as given
    6. forward     a stored NULL and an absent key are indistinguishable to the
       only        reader, so no run applied before the migration changes its
                   verdict
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _ps_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $fn$;

/** The two functions under test, by signature. */
CREATE OR REPLACE FUNCTION _ps_sigs() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ARRAY['public.apply_monthly_planning_run(jsonb)',
               'public.replace_monthly_planning_run(jsonb, uuid)'];
$fn$;

/** The live source of one of them. Raises rather than returning NULL, so a
    missing function is a loud failure and not a check that quietly passes. */
CREATE OR REPLACE FUNCTION _ps_def(p_sig text) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  v_oid oid := to_regprocedure(p_sig);
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'planning-settings: % does not exist', p_sig;
  END IF;
  RETURN pg_get_functiondef(v_oid);
END $fn$;

/*
  Every jsonb_build_object(...) call in a function, one per row.

  Two levels of nesting are allowed, and the second level is not spare
  capacity. These bodies need one — `(p_payload->>'k')::int`,
  `NULLIF(p_payload->>'k','')::int` — but a one-level pattern cannot see past
  `COALESCE((p_payload->>'k')::int, 0)`, which is exactly the wrong fix section
  4 forbids. Measured against a copy of both functions carrying that wrong fix:
  a one-level pattern found 4 objects in `apply` and recognised NONE of them as
  the settings object, so the run failed on "builds exactly one settings
  object" and never reached the check that names the real problem. With two
  levels it finds 5 and exactly 1, and the COALESCE check is what fires. A
  check that fails for the wrong reason is only accidentally a check.
*/
CREATE OR REPLACE FUNCTION _ps_objects(p_sig text) RETURNS SETOF text
LANGUAGE sql AS $fn$
  SELECT m[1]
    FROM regexp_matches(_ps_def(p_sig),
      $rx$jsonb_build_object\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)$rx$, 'g') AS m;
$fn$;

/** The settings object: of the four objects these functions build, it is the
    only one whose first key is block_separator_minutes. summary_json opens on
    'source_file_name', apply_summary_json on 'updated_trips', and the returns
    on 'success'. */
CREATE OR REPLACE FUNCTION _ps_settings(p_sig text) RETURNS text
LANGUAGE sql AS $fn$
  SELECT o FROM _ps_objects(p_sig) AS o
   WHERE o ~ $rx$^jsonb_build_object\(\s*'block_separator_minutes'$rx$;
$fn$;

/** Evaluates one of the two spliced expressions, lifted out of the live
    definition, against a payload of our own. `p_payload` is the functions' own
    argument name, so substituting it turns the expression into a SELECT. */
CREATE OR REPLACE FUNCTION _ps_eval(p_sig text, p_key text, p_cast text, p_payload jsonb)
RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  v_expr text;
  v_out  text;
BEGIN
  v_expr := (regexp_match(_ps_settings(p_sig),
    format($rx$'%s',\s*(NULLIF\([^)]*\)::%s)$rx$, p_key, p_cast)))[1];
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'planning-settings: % does not build % with a NULLIF(...)::% expression', p_sig, p_key, p_cast;
  END IF;
  EXECUTE format('SELECT (%s)::text',
    replace(v_expr, 'p_payload', format('%L::jsonb', p_payload::text)))
    INTO v_out;
  RETURN v_out;
END $fn$;

-- ─── 1. Who writes settings_json, and how they run ──────────────────────────

DO $$
DECLARE
  v_sig text;
BEGIN
  -- A third writer would be a second place for these keys to go missing.
  PERFORM _ps_ok('settings_json is written by exactly the two planning RPCs',
    (SELECT array_agg(n.nspname || '.' || p.proname ORDER BY p.proname)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'app_private')
        AND p.prosrc ~ 'settings_json')
    = ARRAY['public.apply_monthly_planning_run',
            'public.replace_monthly_planning_run']);

  FOREACH v_sig IN ARRAY _ps_sigs() LOOP
    PERFORM _ps_ok(format('%s is plpgsql, SECURITY DEFINER, search_path pinned', v_sig),
      EXISTS (SELECT 1 FROM pg_proc p
               WHERE p.oid = to_regprocedure(v_sig)
                 AND p.prosecdef
                 AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                 AND array_to_string(COALESCE(p.proconfig, ARRAY[]::text[]), ',') LIKE '%search_path%'));
  END LOOP;
END $$;

-- ─── 2. What the settings object carries ────────────────────────────────────

DO $$
DECLARE
  v_sig      text;
  v_settings text;
  v_key      text;
BEGIN
  FOREACH v_sig IN ARRAY _ps_sigs() LOOP
    -- Exactly one object opens on block_separator_minutes, or "the settings
    -- object" is not a thing this file can identify.
    PERFORM _ps_ok(format('%s builds exactly one settings object', v_sig),
      (SELECT count(*) FROM _ps_objects(v_sig) AS o
        WHERE o ~ $rx$^jsonb_build_object\(\s*'block_separator_minutes'$rx$) = 1);

    v_settings := _ps_settings(v_sig);

    FOREACH v_key IN ARRAY ARRAY[
      -- the three it always stored; MonatsplanungAppliedRuns.tsx:652 reads the
      -- last two, and no migration before 20260928110000 ever wrote them
      'block_separator_minutes',
      'min_block_duration_minutes',
      'max_block_duration_minutes',
      -- the two 20260928110000 adds
      'vehicle_switch_buffer_minutes',
      'one_vehicle_per_driver_day'
    ] LOOP
      PERFORM _ps_ok(format('%s: settings_json carries %s', v_sig, v_key),
        v_settings ~ v_key);
    END LOOP;
  END LOOP;

  -- replace's settings object records which run it superseded, and the splice
  -- had to survive that fourth key: it is why the three-key tail that names
  -- the settings object in `apply` names apply_summary_json and the return in
  -- `replace`, and never its settings object.
  PERFORM _ps_ok('replace: settings_json still carries replaced_run_id',
    _ps_settings('public.replace_monthly_planning_run(jsonb, uuid)') ~ 'replaced_run_id');
  PERFORM _ps_ok('apply: settings_json does not carry replaced_run_id',
    _ps_settings('public.apply_monthly_planning_run(jsonb)') !~ 'replaced_run_id');
END $$;

-- ─── 3. Nothing else was widened ────────────────────────────────────────────

DO $$
DECLARE
  v_sig     text;
  v_key     text;
  v_applysm text;
BEGIN
  FOREACH v_sig IN ARRAY _ps_sigs() LOOP
    FOREACH v_key IN ARRAY ARRAY[
      'vehicle_switch_buffer_minutes', 'one_vehicle_per_driver_day'
    ] LOOP
      -- `apply` builds five jsonb objects and `replace` four. Exactly one of
      -- them may name a new key. Two would mean the splice also hit
      -- summary_json, apply_summary_json or a return value.
      PERFORM _ps_ok(format('%s: exactly one jsonb object names %s', v_sig, v_key),
        (SELECT count(*) FROM _ps_objects(v_sig) AS o WHERE o ~ v_key) = 1);

      -- And the one that does is the settings object, not some other object
      -- that happens to be alone in naming it.
      PERFORM _ps_ok(format('%s: the object naming %s is settings_json', v_sig, v_key),
        _ps_settings(v_sig) ~ v_key);
    END LOOP;

    /*
      apply_summary_json by name. CLAUDE.md: "Phase 5 writes
      company_planning_runs, batch-updates trips via RPC, inserts manual
      exceptions, and stores an `apply_summary_json` whose `updated_trips`
      count is re-verified later during finalization." A settings key has no
      business in it, and a blind string replace on the three-key tail would
      have put one there in both functions.
    */
    v_applysm := (regexp_match(_ps_def(v_sig),
      $rx$apply_summary_json\s*=\s*jsonb_build_object\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)$rx$))[1];
    PERFORM _ps_ok(format('%s: apply_summary_json is still identifiable', v_sig),
      v_applysm IS NOT NULL AND v_applysm ~ 'updated_trips');
    PERFORM _ps_ok(format('%s: apply_summary_json names neither new key', v_sig),
      v_applysm !~ 'vehicle_switch_buffer_minutes'
      AND v_applysm !~ 'one_vehicle_per_driver_day');
  END LOOP;
END $$;

-- ─── 4. Negative control: the pre-migration shape is gone ───────────────────

DO $$
DECLARE
  -- The settings object exactly as it read before 20260928110000. Written out
  -- rather than described, so this section fails on the old code and passes on
  -- the new one for the one reason it is meant to.
  c_old_apply CONSTANT text :=
      $rx$jsonb_build_object\(\s*'block_separator_minutes',\s*v_block_sep,\s*$rx$
   || $rx$'min_block_duration_minutes',\s*v_min_block,\s*$rx$
   || $rx$'max_block_duration_minutes',\s*v_max_block\s*\)$rx$;
  c_old_replace CONSTANT text :=
      $rx$jsonb_build_object\(\s*'block_separator_minutes',\s*v_block_sep,\s*$rx$
   || $rx$'min_block_duration_minutes',\s*v_min_block,\s*$rx$
   || $rx$'max_block_duration_minutes',\s*v_max_block,\s*$rx$
   || $rx$'replaced_run_id',\s*p_old_run_id\s*\)$rx$;
  v_sig text;
BEGIN
  PERFORM _ps_ok('apply: the old three-key settings object no longer occurs',
    _ps_def('public.apply_monthly_planning_run(jsonb)') !~ c_old_apply);
  PERFORM _ps_ok('replace: the old four-key settings object no longer occurs',
    _ps_def('public.replace_monthly_planning_run(jsonb, uuid)') !~ c_old_replace);

  /*
    The other way to get this wrong. `COALESCE((p_payload->>'…')::int, 0)`
    would store 0 for an omitted key, and the reader accepts 0 as a real
    buffer (`typeof storedBuffer === 'number' && storedBuffer >= 0`), so every
    vehicle change would pass the gate — the check disabled instead of fixed.
    Section 5 measures the difference; this one forbids the shape.
  */
  FOREACH v_sig IN ARRAY _ps_sigs() LOOP
    PERFORM _ps_ok(format('%s: no new settings key is defaulted with COALESCE', v_sig),
      _ps_settings(v_sig) !~ 'COALESCE');
    PERFORM _ps_ok(format('%s: settings_json reads both new keys through NULLIF', v_sig),
      (SELECT count(*) FROM regexp_matches(_ps_settings(v_sig), $rx$NULLIF\(p_payload$rx$, 'g')) = 2);
  END LOOP;
END $$;

-- ─── 5. What the spliced expressions actually store ─────────────────────────

DO $$
DECLARE
  v_sig text;
  r     record;
BEGIN
  FOREACH v_sig IN ARRAY _ps_sigs() LOOP
    FOR r IN
      SELECT *
        FROM (VALUES
          -- payload                                         buffer  one-vehicle
          ('{}'::jsonb,                                       NULL,   NULL),
          ('{"vehicle_switch_buffer_minutes":null,
             "one_vehicle_per_driver_day":null}'::jsonb,      NULL,   NULL),
          ('{"vehicle_switch_buffer_minutes":"",
             "one_vehicle_per_driver_day":""}'::jsonb,        NULL,   NULL),
          -- 0 is a legal buffer and must survive as 0, not become the
          -- fallback: a company may genuinely allow an immediate switch.
          ('{"vehicle_switch_buffer_minutes":0,
             "one_vehicle_per_driver_day":false}'::jsonb,     '0',    'false'),
          -- the case the defect broke: below the hard-coded 30
          ('{"vehicle_switch_buffer_minutes":20,
             "one_vehicle_per_driver_day":true}'::jsonb,      '20',   'true'),
          ('{"vehicle_switch_buffer_minutes":45,
             "one_vehicle_per_driver_day":false}'::jsonb,     '45',   'false')
        ) AS t(payload, want_buffer, want_one)
    LOOP
      PERFORM _ps_ok(format('%s: %s -> buffer %s',
          v_sig, r.payload::text, COALESCE(r.want_buffer, 'NULL')),
        _ps_eval(v_sig, 'vehicle_switch_buffer_minutes', 'int', r.payload)
          IS NOT DISTINCT FROM r.want_buffer);

      PERFORM _ps_ok(format('%s: %s -> one_vehicle %s',
          v_sig, r.payload::text, COALESCE(r.want_one, 'NULL')),
        _ps_eval(v_sig, 'one_vehicle_per_driver_day', 'boolean', r.payload)
          IS NOT DISTINCT FROM r.want_one);
    END LOOP;
  END LOOP;

  -- The measured difference between the fix and the wrong fix, on the payload
  -- that tells them apart.
  PERFORM _ps_ok('an omitted buffer stores NULL, where COALESCE(...,0) would store 0',
    _ps_eval('public.apply_monthly_planning_run(jsonb)',
             'vehicle_switch_buffer_minutes', 'int', '{}'::jsonb) IS NULL
    AND COALESCE(('{}'::jsonb ->> 'vehicle_switch_buffer_minutes')::int, 0)::text = '0');
END $$;

-- ─── 6. Forward only ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_stored_null jsonb := jsonb_build_object('vehicle_switch_buffer_minutes', NULL::int);
  v_absent      jsonb := '{}'::jsonb;
BEGIN
  /*
    A run applied before 20260928110000 has no key at all; a run applied after
    it with nothing configured has the key at JSON null. The reader's test is
    `typeof storedBuffer === 'number'`, which rejects both, so both fall back
    to 30 and no existing run changes its verdict. In SQL the same equivalence
    is that `->>` answers NULL either way.
  */
  PERFORM _ps_ok('a stored JSON null and an absent key read alike',
    (v_stored_null ->> 'vehicle_switch_buffer_minutes') IS NULL
    AND (v_absent ->> 'vehicle_switch_buffer_minutes') IS NULL);

  -- And the key really is present-but-null rather than dropped, which is what
  -- lets a later reader tell "planned with no buffer configured" from
  -- "planned before the run recorded one".
  PERFORM _ps_ok('the key is stored, holding JSON null',
    v_stored_null ? 'vehicle_switch_buffer_minutes'
    AND jsonb_typeof(v_stored_null -> 'vehicle_switch_buffer_minutes') = 'null');
END $$;

DO $$ BEGIN RAISE NOTICE '── planning-settings: all checks passed ──'; END $$;

ROLLBACK;
