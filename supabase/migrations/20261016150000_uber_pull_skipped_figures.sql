/*
  The scheduled Uber pull: a figure below zero is recorded, not dropped

  ## Why

  Reidey formats every earnings figure (fare, promotion, tips, cash) with one
  function that prefixes a minus sign when the value is below zero: a refund, a
  clawback, a reversed tip, a cash adjustment. The parser used to refuse the sign
  and so refused the whole day. It now reads it (16.10.2026).

  `income.amount` is `CHECK (amount >= 0)` and the weekly aggregations sum it,
  so a negative figure cannot be stored as a row; dropping that CHECK would be a
  decision about every income writer and every total, and is not taken here. The
  row builder has always skipped a figure that is not above zero. What must not
  happen is that the skip is SILENT: this migration gives the run a durable list
  of what was left out, exactly as 20261016130000 did for unmatched earners.

  ## Pieces

    1. `uber_pull_runs.skipped`: `[{name, type, cents}]`, `cents` below zero.
    2. `uber_pull_note_skipped(run, list)` records it on the OPEN claim, before
       the day is written (the job refuses to write a day whose list cannot be
       recorded).
    3. A run is a gap when it has unmatched earners OR skipped figures: the
       writer's settle (one spliced fragment) and `uber_pull_settle` (restated)
       both ask for either.
*/

ALTER TABLE public.uber_pull_runs
  ADD COLUMN IF NOT EXISTS skipped jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.uber_pull_runs DROP CONSTRAINT IF EXISTS uber_pull_runs_skipped_check;
ALTER TABLE public.uber_pull_runs
  ADD CONSTRAINT uber_pull_runs_skipped_check
  CHECK (jsonb_typeof(skipped) = 'array' AND jsonb_array_length(skipped) <= 200);

COMMENT ON COLUMN public.uber_pull_runs.skipped IS
  'Figures Reidey sent below zero that were not imported because income.amount cannot hold them: [{name, type, cents}]. Written by uber_pull_note_skipped before the day is written.';

CREATE OR REPLACE FUNCTION public.uber_pull_note_skipped(p_run_id uuid, p_skipped jsonb)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_clean jsonb;
  v_rows  integer;
BEGIN
  IF p_run_id IS NULL OR p_skipped IS NULL OR jsonb_typeof(p_skipped) <> 'array'
     OR jsonb_array_length(p_skipped) > 200 THEN
    RAISE EXCEPTION 'uber_pull_note_skipped: a run and an array of at most 200 are required'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_skipped) e
     WHERE NOT (
       jsonb_typeof(e) = 'object'
       AND jsonb_typeof(e->'name') = 'string'
       AND length(btrim(e->>'name')) BETWEEN 1 AND 100
       AND e->>'type' IN ('umsatz', 'aktionen', 'trinkgeld', 'bargeld')
       AND jsonb_typeof(e->'cents') = 'number'
       AND e->>'cents' ~ '^-[1-9][0-9]{0,8}$'
     )
  ) THEN
    RAISE EXCEPTION 'uber_pull_note_skipped: an entry is malformed' USING ERRCODE = '22023';
  END IF;

  -- Rebuilt from the three known keys, so nothing else a caller sends is stored.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', regexp_replace(btrim(e->>'name'), '[[:cntrl:]]', ' ', 'g'),
           'type', e->>'type',
           'cents', (e->>'cents')::integer)
         ORDER BY ord), '[]'::jsonb)
    INTO v_clean
    FROM jsonb_array_elements(p_skipped) WITH ORDINALITY AS t(e, ord);

  UPDATE public.uber_pull_runs
     SET skipped = v_clean
   WHERE id = p_run_id AND settled_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $fn$;

COMMENT ON FUNCTION public.uber_pull_note_skipped(uuid, jsonb) IS
  'Records the figures below zero that were not imported on an OPEN claim, before the day is written. Answers false for a settled or unknown claim. service_role only.';

CREATE OR REPLACE FUNCTION public.uber_pull_settle(
  p_id           uuid,
  p_outcome      text,
  p_detail       text,
  p_driver_count integer DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_rows integer;
BEGIN
  IF p_id IS NULL OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'uber_pull_settle: id and outcome are required' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'imported' THEN
    RAISE EXCEPTION 'uber_pull_settle: imported is settled by the writer only' USING ERRCODE = '22023';
  END IF;
  IF p_driver_count IS NULL OR p_driver_count < 0 THEN
    RAISE EXCEPTION 'uber_pull_settle: driver count must not be negative' USING ERRCODE = '22023';
  END IF;

  -- A gap with nothing to write is settled here, and only for a claim that
  -- carries what it left out: unmatched earners or skipped figures.
  UPDATE public.uber_pull_runs
     SET outcome = p_outcome,
         detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200),
         driver_count = p_driver_count,
         settled_at = now()
   WHERE id = p_id AND settled_at IS NULL
     AND (p_outcome <> 'imported_with_gap'
          OR jsonb_array_length(unmatched) + jsonb_array_length(skipped) > 0);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $fn$;

DO $splice$
DECLARE
  v_def  text;
  v_old  constant text := $f$jsonb_array_length(v_run.unmatched) > 0$f$;
  v_new  constant text := $f$jsonb_array_length(v_run.unmatched) + jsonb_array_length(v_run.skipped) > 0$f$;
  v_hits integer;
BEGIN
  v_def := pg_get_functiondef('public.income_import_uber_system(uuid, jsonb)'::regprocedure);
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'uber pull skipped: the writer''s gap condition must match exactly once, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$splice$;

ALTER FUNCTION public.uber_pull_note_skipped(uuid, jsonb)         OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.uber_pull_note_skipped(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.uber_pull_note_skipped(uuid, jsonb) TO service_role;

-- Self-check: the shape, never stored data.
DO $check$
DECLARE
  v_src text;
  v_sig text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'uber_pull_runs'
                    AND column_name = 'skipped' AND data_type = 'jsonb' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'uber pull skipped self-check 1: uber_pull_runs.skipped must be jsonb NOT NULL';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.income_import_uber_system(uuid, jsonb)'::regprocedure;
  IF strpos(v_src, 'jsonb_array_length(v_run.skipped)') = 0
     OR strpos(v_src, 'jsonb_array_length(v_run.unmatched)') = 0
     OR strpos(v_src, 'imported_with_gap') = 0
     OR strpos(v_src, 'v_replace := v_run.pass = ''recheck''') = 0
     OR (length(v_src) - length(replace(v_src, 'DELETE FROM', ''))) / length('DELETE FROM') <> 1 THEN
    RAISE EXCEPTION 'uber pull skipped self-check 2: the system writer lost the gap condition or changed beyond it';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.uber_pull_settle(uuid, text, text, integer)'::regprocedure;
  IF strpos(v_src, 'IF p_outcome = ''imported'' THEN') = 0
     OR strpos(v_src, 'jsonb_array_length(unmatched) + jsonb_array_length(skipped) > 0') = 0 THEN
    RAISE EXCEPTION 'uber pull skipped self-check 3: settle lost its imported guard or the gap condition';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.uber_pull_note_skipped(uuid, jsonb)'::regprocedure;
  IF strpos(v_src, 'settled_at IS NULL') = 0 OR strpos(v_src, 'jsonb_build_object(') = 0 THEN
    RAISE EXCEPTION 'uber pull skipped self-check 4: the note must rebuild its entries and touch an open claim only';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.uber_pull_note_skipped(uuid, jsonb)',
    'public.uber_pull_settle(uuid, text, text, integer)',
    'public.income_import_uber_system(uuid, jsonb)'
  ] LOOP
    IF has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                   WHERE p.oid = to_regprocedure(v_sig) AND a.grantee = 0)
       OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)
                       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION 'uber pull skipped self-check 5: % must be SECURITY DEFINER, pinned, and EXECUTE for service_role only', v_sig;
    END IF;
  END LOOP;

  RAISE NOTICE 'uber pull skipped self-check: passed';
END
$check$;
