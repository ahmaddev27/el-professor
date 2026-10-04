/*
  The applied planning run stores the two settings the finalization gate reads:
  `vehicle_switch_buffer_minutes` and `one_vehicle_per_driver_day`.

  ── THE RULE THIS PRESERVES ────────────────────────────────────────────────

  `FinalizePlanningModal` is a hard gate with no override, and one of its ~10
  blocking checks is `Fahrzeugwechsel zu kurz`: no driver may change vehicle
  with less than the configured buffer between the two rides. It resolves that
  buffer from the applied run, and falls back to a hard-coded 30 when the run
  does not carry one (src/components/FinalizePlanningModal.tsx:50, :277-282):

      const storedBuffer = settingsJson['vehicle_switch_buffer_minutes'];
      const MIN_CAR_SWITCH_GAP_MINUTES =
        (typeof storedBuffer === 'number' && storedBuffer >= 0)
          ? storedBuffer : DEFAULT_CAR_SWITCH_GAP_MINUTES;   // 30

  `MonatsplanungAssignmentPreview` already sends both keys in the apply payload
  (:631-632 for apply, :695-696 for replace), and the planning engine already
  honours the configured buffer when it assigns (utils/monatsplanungPhase3.ts,
  `vehicle_switch_buffer_violation`, a *hard* rejection reason). Only the
  storage side was missing: neither RPC put the two keys into `settings_json`,
  so the gate never saw them.

  The consequence, and it is the one this migration exists to end: a company
  that configures a buffer **below** 30 gets a month planned to its own number
  and then judged against 30 — every legitimate vehicle change between the
  configured value and 30 reads as `Fahrzeugwechsel zu kurz`, the gate blocks,
  there is no override, and the month can never be finalized. Measured on
  staging before writing this: 0 rows affected, so the defect is LATENT — no
  existing run is mis-judged today.

  ── WHAT IS DELIBERATELY NOT CHANGED ──────────────────────────────────────

  · Forward-only. The reader's fallback to 30 stays exactly as it is, so every
    run applied before this migration keeps the verdict it has. Nothing is
    backfilled: we do not know what buffer those months were planned with.
  · No epoch bump. This only adds keys to a jsonb column; the previous release
    reads `settings_json` with fallbacks and ignores keys it does not know, so a
    rollback across it is safe.
  · `apply_summary_json` is NOT widened. Its `updated_trips` count is
    re-verified during finalization, so that object is not ours to touch.
  · `summary_json` and each function's return value are not widened either.

  ── WHY A SPLICE AND NOT A RESTATEMENT ────────────────────────────────────

  The live bodies of both functions already write `min_block_duration_minutes`
  and `max_block_duration_minutes`, which **no migration in this chain
  contains** (`grep -c min_block_duration_minutes supabase/migrations/` returns
  nothing), and `MonatsplanungAppliedRuns.tsx:652` reads them. So the live
  definition is ahead of the chain, and a hand-copied body would silently drop
  two keys a screen depends on. This migration therefore reads
  `pg_get_functiondef()` and splices, the way 20260921110010 and 20260923130000
  do for these same functions.

  ── THE ANCHOR, AND WHY THE OBVIOUS ONE IS WRONG ──────────────────────────

  Measured against both live databases (read-only) before writing this:

    the three-key tail
        'block_separator_minutes', v_block_sep,
        'min_block_duration_minutes', v_min_block,
        'max_block_duration_minutes', v_max_block )
    occurs 3 times in apply_monthly_planning_run  (settings_json,
        apply_summary_json, the RETURN)
    and 2 times in replace_monthly_planning_run   (apply_summary_json,
        the RETURN — and NOT its settings_json at all)

  because `replace`'s settings object carries a fourth key,
  `'replaced_run_id', p_old_run_id`. So in `replace` that tail never names the
  settings object, and in `apply` it names it only one time in three. Anchoring
  on it would widen `apply_summary_json` in both functions and miss the target
  in one of them.

  The anchor used instead is `jsonb_build_object(` immediately followed by
  `'block_separator_minutes'` — the settings object is the only one of the four
  in each function whose FIRST key is that. The others open with
  `'source_file_name'` (summary_json), `'updated_trips'` (apply_summary_json)
  and `'success'` (the RETURN). Measured: exactly 1 hit per function on staging
  and on production. The loop below re-counts it and RAISEs unless it is
  exactly 1, so a body that drifts stops the release instead of being edited
  blind.

  `[^()]*` is what makes the anchor terminate at the object's own closing
  paren: the pre-splice settings object contains no nested call, so the class
  cannot run past it into the rest of the function.

  ── NULL, NEVER 0 ─────────────────────────────────────────────────────────

  Each new key is `NULLIF(p_payload->>'…','')::…`, never `COALESCE(…, 0)`.
  0 is a legal buffer and the reader honours it (`storedBuffer >= 0`), so a
  default of 0 written for an omitted key would set the gap to zero and
  disable the gate outright — worse than the defect being fixed. An omitted,
  null or empty key therefore stores JSON null, which the reader's
  `typeof storedBuffer === 'number'` test rejects, falling back to 30 exactly
  as it does for a run that has no key at all. `one_vehicle_per_driver_day`
  is read by `readBoolFromJson` (MonatsplanungAppliedRuns.tsx:135-139), which
  likewise answers null for anything that is not a JSON boolean.
*/

-- ─── 1. Splice the two keys into each function's settings object ────────────

DO $mig$
DECLARE
  /*
    Group 1 is the settings object from its opening paren through its last
    non-space character; group 2 is the whitespace and the closing paren. The
    replacement puts both back verbatim and only inserts between them, so the
    rest of the body — including the two keys no migration in this chain knows
    about — is reproduced character for character.
  */
  c_anchor CONSTANT text :=
    $a$(jsonb_build_object\(\s*'block_separator_minutes'[^()]*[^()[:space:]])(\s*\))$a$;

  c_addition CONSTANT text :=
       $r$\1,$r$ || chr(10)
    || $r$'vehicle_switch_buffer_minutes', NULLIF(p_payload->>'vehicle_switch_buffer_minutes','')::int,$r$ || chr(10)
    || $r$'one_vehicle_per_driver_day', NULLIF(p_payload->>'one_vehicle_per_driver_day','')::boolean$r$
    || $r$\2$r$;

  v_sig     text;
  v_oid     oid;
  v_def     text;
  v_new     text;
  v_hits    integer;
  v_owner   name;
  v_secdef  boolean;
  v_config  text[];
  v_changed integer := 0;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)'
  ]
  LOOP
    /*
      Absence is a release-stopping failure, not something to skip. Both
      functions are ordinary `public` functions, so the RLS kit's
      `--schema=public` fixture carries them; 20260923130000 already RAISEs on
      their absence for the same reason and the kit passes on it.
    */
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'switch-buffer splice: % does not exist', v_sig;
    END IF;

    SELECT pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
      INTO v_owner, v_secdef, v_config
      FROM pg_proc p WHERE p.oid = v_oid;

    v_def := pg_get_functiondef(v_oid);

    IF v_def ~ 'vehicle_switch_buffer_minutes'
       OR v_def ~ 'one_vehicle_per_driver_day' THEN
      RAISE EXCEPTION 'switch-buffer splice: % already names one of the two keys — read its body before running this again', v_sig;
    END IF;

    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, c_anchor, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'switch-buffer splice: % opens a jsonb_build_object on ''block_separator_minutes'' % times, not exactly once — read its body before changing this',
        v_sig, v_hits;
    END IF;

    v_new := regexp_replace(v_def, c_anchor, c_addition);

    IF v_new = v_def THEN
      RAISE EXCEPTION 'switch-buffer splice: the splice changed nothing in %', v_sig;
    END IF;

    EXECUTE v_new;

    /*
      `CREATE OR REPLACE` keeps the owner, and on the live databases these two
      belong to `postgres` rather than to the role running the migrations. A
      changed owner would move which role this SECURITY DEFINER function runs
      as, so it is asserted rather than assumed. The same for the definer flag
      and the pinned search_path: this migration adds no call that needs a
      grant, so nothing else about the security of these functions may move.
    */
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(v_sig)
         AND pg_get_userbyid(p.proowner) = v_owner
         AND p.prosecdef IS NOT DISTINCT FROM v_secdef
         AND p.proconfig IS NOT DISTINCT FROM v_config
    ) THEN
      RAISE EXCEPTION 'switch-buffer splice: % changed owner, SECURITY DEFINER or search_path', v_sig;
    END IF;

    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed <> 2 THEN
    RAISE EXCEPTION 'switch-buffer splice: changed % functions, expected exactly 2', v_changed;
  END IF;
  RAISE NOTICE 'switch-buffer splice: % planning RPCs store the buffer and the one-vehicle rule', v_changed;
END $mig$;

-- ─── 2. Keep the existing comment and record what changed ───────────────────

DO $mig$
DECLARE
  v_sig  text;
  v_oid  oid;
  v_note CONSTANT text :=
    ' 20260928110000: settings_json also carries vehicle_switch_buffer_minutes'
    || ' and one_vehicle_per_driver_day, so the finalization gate judges the'
    || ' month against the buffer it was planned with. Both are NULL when the'
    || ' payload omits them, never 0.';
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)'
  ]
  LOOP
    v_oid := to_regprocedure(v_sig);
    -- COALESCE, or a function with no comment yet would have its comment set
    -- to NULL, which drops it.
    EXECUTE format('COMMENT ON FUNCTION %s IS %L',
      v_sig, COALESCE(obj_description(v_oid, 'pg_proc'), '') || v_note);
  END LOOP;
END $mig$;

-- ─── 3. Self-check ──────────────────────────────────────────────────────────
--
-- Section 1 has already raised if either function was missing, so this block
-- may assume both exist. It asserts the shape of what was written rather than
-- any data: the RLS kit's fixture carries no companies and no planning runs,
-- and this migration seeds none.

DO $selfcheck$
DECLARE
  /*
    The same object, matched after the splice. Two levels of nesting are
    allowed: the two new values are NULLIF(...) calls, one level, but a
    one-level pattern cannot see past a `COALESCE((p_payload->>'k')::int, 0)`
    either — and check 5 below has to be able to find that in order to refuse
    it. Measured: against a copy of both functions carrying that wrong fix, a
    one-level pattern matched no settings object at all, which would have
    failed check 1 with a misleading message instead of check 5 with the right
    one.
  */
  c_settings CONSTANT text :=
    $s$jsonb_build_object\(\s*'block_separator_minutes'(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)$s$;

  v_sig      text;
  v_oid      oid;
  v_def      text;
  v_settings text;
  v_n        integer;
  v_seen     integer := 0;
  v_key      text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.apply_monthly_planning_run(jsonb)',
    'public.replace_monthly_planning_run(jsonb, uuid)'
  ]
  LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'switch-buffer self-check: % does not exist', v_sig;
    END IF;
    v_def := pg_get_functiondef(v_oid);

    -- 1. The settings object is still identifiable, and now names both keys.
    v_settings := (regexp_match(v_def, c_settings))[1];
    IF v_settings IS NULL THEN
      RAISE EXCEPTION 'switch-buffer self-check: cannot find the settings object in %', v_sig;
    END IF;
    IF v_settings !~ 'vehicle_switch_buffer_minutes'
       OR v_settings !~ 'one_vehicle_per_driver_day' THEN
      RAISE EXCEPTION 'switch-buffer self-check: %''s settings object does not name both new keys', v_sig;
    END IF;

    -- 2. The keys it already stored are still there, in that object.
    FOREACH v_key IN ARRAY ARRAY[
      'block_separator_minutes', 'min_block_duration_minutes', 'max_block_duration_minutes'
    ]
    LOOP
      IF v_settings !~ v_key THEN
        RAISE EXCEPTION 'switch-buffer self-check: %''s settings object lost %', v_sig, v_key;
      END IF;
    END LOOP;

    -- 3. `replace` records which run it superseded; that key is load-bearing
    --    for MonatsplanungAppliedRuns and must have survived the splice.
    IF v_sig LIKE 'public.replace%' AND v_settings !~ 'replaced_run_id' THEN
      RAISE EXCEPTION 'switch-buffer self-check: replace''s settings object lost replaced_run_id';
    END IF;

    /*
      4. Nothing leaked into the other three objects. Each new key must occur
         in the whole definition exactly twice: once as the key name, once in
         the NULLIF that reads it off the payload. A splice that had also hit
         summary_json, apply_summary_json or the RETURN would count 4 or more —
         and apply_summary_json in particular is not ours to widen, because its
         `updated_trips` count is re-verified during finalization.
    */
    FOREACH v_key IN ARRAY ARRAY[
      'vehicle_switch_buffer_minutes', 'one_vehicle_per_driver_day'
    ]
    LOOP
      SELECT count(*) INTO v_n FROM regexp_matches(v_def, v_key, 'g');
      IF v_n <> 2 THEN
        RAISE EXCEPTION 'switch-buffer self-check: % names % % times, expected exactly 2 (the key and the payload read) — it may have been written into a second object',
          v_sig, v_key, v_n;
      END IF;
    END LOOP;

    /*
      5. NULL, never 0. The reader honours a stored 0 as a real buffer
         (`storedBuffer >= 0`), so a default of 0 for an omitted key would
         disable the Fahrzeugwechsel check instead of falling back to 30.
    */
    SELECT count(*) INTO v_n FROM regexp_matches(v_settings, 'NULLIF\(p_payload', 'g');
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'switch-buffer self-check: %''s settings object has % NULLIF payload reads, expected 2', v_sig, v_n;
    END IF;
    IF v_settings ~ 'COALESCE' THEN
      RAISE EXCEPTION 'switch-buffer self-check: %''s settings object defaults a new key with COALESCE — 0 is a legal buffer and would disable the gate', v_sig;
    END IF;

    -- 6. Nothing about how these functions run has moved.
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = v_oid
         AND p.prosecdef
         AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
         AND array_to_string(COALESCE(p.proconfig, ARRAY[]::text[]), ',') LIKE '%search_path%'
    ) THEN
      RAISE EXCEPTION 'switch-buffer self-check: % is no longer a plpgsql SECURITY DEFINER with a pinned search_path', v_sig;
    END IF;

    v_seen := v_seen + 1;
  END LOOP;

  IF v_seen <> 2 THEN
    RAISE EXCEPTION 'switch-buffer self-check: checked % functions, expected 2', v_seen;
  END IF;

  RAISE NOTICE 'switch-buffer self-check: both planning RPCs store the buffer and the one-vehicle rule, NULL when omitted, and no other object was widened';
END $selfcheck$;
