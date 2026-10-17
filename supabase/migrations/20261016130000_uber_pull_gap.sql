/*
  The scheduled Uber pull: an unmatched earner no longer costs the day

  ## The defect (latent: the job has never run)

  When Reidey reported an earner it could not resolve to one of its drivers, the
  job settled the WHOLE operating day as `blocked_unmatched` and wrote none of
  that day's rows. Reidey sends no money for such an earner, so nothing was
  protected; what was lost was every matched driver's earnings for that day,
  nightly, unattended, and found weeks later in a payroll figure.

  ## The rule now (owner, 16.10.2026: the earnings must be pulled)

  The day is written for the earners Reidey did send, and the earners it could
  not place are RECORDED ON THE RUN, durably, in `uber_pull_runs.unmatched`
  (the name and Reidey's trip count, nothing else). The outcome is the new
  `imported_with_gap`: not `imported` (a clean day) and not a failure (the rows
  are there). It is deliberately a third value, because the code that decides
  what is a failure (`isFailure`) treats every value outside its success set as
  one, and a gap that read as success would vanish from the screen.

  ## Three pieces

    1. `uber_pull_runs.unmatched` and the widened outcome CHECK.
    2. `uber_pull_note_unmatched(run, list)` records the names on the OPEN claim,
       BEFORE the writer runs. The job refuses to write the day when it cannot
       record them, so a day is never imported with its gap forgotten.
    3. The writer settles `imported_with_gap` instead of `imported` when the claim
       carries names, in the SAME transaction that wrote the rows. A day with no
       matched rows is settled by `uber_pull_settle`, which accepts the new value
       only for a claim that carries names and never sets rows.

  The writer is changed from the catalogue by splicing exactly one fragment (its
  settle), so every other line stays byte for byte what 20261015130000 has; the
  splice must match exactly once. `uber_pull_settle` is small and is restated.

  ## About names in this table

  `detail` was documented as never holding a name and still does not. `unmatched`
  is a separate column holding names of people Reidey reported to this company's
  own account, behind the table's existing company-scoped SELECT policy: the same
  people the company's own earnings screen shows. A platform account reads them
  only inside an open context, like every other row of this table.

  No SCHEMA_EPOCH bump: a column with a default, a wider CHECK and two function
  bodies the previous release never calls.
*/

-- --- 1. The column and the outcome set ---------------------------------------

ALTER TABLE public.uber_pull_runs
  ADD COLUMN IF NOT EXISTS unmatched jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.uber_pull_runs DROP CONSTRAINT IF EXISTS uber_pull_runs_unmatched_check;
ALTER TABLE public.uber_pull_runs
  ADD CONSTRAINT uber_pull_runs_unmatched_check
  CHECK (jsonb_typeof(unmatched) = 'array' AND jsonb_array_length(unmatched) <= 200);

ALTER TABLE public.uber_pull_runs DROP CONSTRAINT IF EXISTS uber_pull_runs_outcome_check;
ALTER TABLE public.uber_pull_runs
  ADD CONSTRAINT uber_pull_runs_outcome_check CHECK (outcome IS NULL OR outcome IN (
    'imported', 'imported_with_gap', 'nothing_to_import', 'blocked_unlinked', 'blocked_unmatched',
    'already_imported', 'not_connected', 'seal_unreadable', 'token_rejected',
    'partner_refused', 'partner_unavailable', 'partner_malformed',
    'company_blocked', 'refused', 'failed'));

COMMENT ON COLUMN public.uber_pull_runs.unmatched IS
  'The Uber earners Reidey could not place on this day: [{name, trips}]. No earnings arrived for them and none were imported. Written by uber_pull_note_unmatched before the day is written.';

-- --- 2. Recording the names on the open claim --------------------------------

CREATE OR REPLACE FUNCTION public.uber_pull_note_unmatched(p_run_id uuid, p_unmatched jsonb)
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
  IF p_run_id IS NULL OR p_unmatched IS NULL OR jsonb_typeof(p_unmatched) <> 'array'
     OR jsonb_array_length(p_unmatched) > 200 THEN
    RAISE EXCEPTION 'uber_pull_note_unmatched: a run and an array of at most 200 are required'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_unmatched) e
     WHERE NOT (
       jsonb_typeof(e) = 'object'
       AND jsonb_typeof(e->'name') = 'string'
       AND length(btrim(e->>'name')) BETWEEN 1 AND 100
       AND (e->'trips' IS NULL OR jsonb_typeof(e->'trips') = 'null'
            OR (jsonb_typeof(e->'trips') = 'number' AND e->>'trips' ~ '^[0-9]{1,9}$'))
     )
  ) THEN
    RAISE EXCEPTION 'uber_pull_note_unmatched: an entry is malformed' USING ERRCODE = '22023';
  END IF;

  -- Rebuilt from the two known keys, so nothing else a caller sends is stored.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', regexp_replace(btrim(e->>'name'), '[[:cntrl:]]', ' ', 'g'),
           'trips', CASE WHEN jsonb_typeof(e->'trips') = 'number' THEN (e->>'trips')::integer END)
         ORDER BY ord), '[]'::jsonb)
    INTO v_clean
    FROM jsonb_array_elements(p_unmatched) WITH ORDINALITY AS t(e, ord);

  UPDATE public.uber_pull_runs
     SET unmatched = v_clean
   WHERE id = p_run_id AND settled_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $fn$;

COMMENT ON FUNCTION public.uber_pull_note_unmatched(uuid, jsonb) IS
  'Records the earners Reidey could not place on an OPEN claim, before the day is written. Answers false for a settled or unknown claim. service_role only.';

-- --- 3. Settle: the new value, for a claim that carries names ----------------

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
  -- carries the names: a gap without them would be a day that lost its record.
  UPDATE public.uber_pull_runs
     SET outcome = p_outcome,
         detail = left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]', ' ', 'g'), 200),
         driver_count = p_driver_count,
         settled_at = now()
   WHERE id = p_id AND settled_at IS NULL
     AND (p_outcome <> 'imported_with_gap' OR jsonb_array_length(unmatched) > 0);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $fn$;

-- --- 4. The writer: settle the gap in the transaction that wrote the rows ----

DO $splice$
DECLARE
  v_def  text;
  v_old  constant text := $f$SET outcome = 'imported', settled_at = now(),$f$;
  v_new  constant text := $f$SET outcome = CASE WHEN jsonb_array_length(v_run.unmatched) > 0
                           THEN 'imported_with_gap' ELSE 'imported' END, settled_at = now(),$f$;
  v_hits integer;
BEGIN
  v_def := pg_get_functiondef('public.income_import_uber_system(uuid, jsonb)'::regprocedure);
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'uber pull gap: the writer''s settle fragment must match exactly once, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$splice$;

-- --- 5. Ownership and privileges ----------------------------------------------

ALTER FUNCTION public.uber_pull_note_unmatched(uuid, jsonb)         OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.uber_pull_note_unmatched(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.uber_pull_note_unmatched(uuid, jsonb) TO service_role;

-- --- 6. Self-check: the shape, never stored data -----------------------------

DO $check$
DECLARE
  v_def  text;
  v_src  text;
  v_frag text;
  v_sig  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'uber_pull_runs'
                    AND column_name = 'unmatched' AND data_type = 'jsonb' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'uber pull gap self-check 1: uber_pull_runs.unmatched must be jsonb NOT NULL';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.uber_pull_runs'::regclass AND c.conname = 'uber_pull_runs_outcome_check';
  FOREACH v_frag IN ARRAY ARRAY[
    'imported', 'imported_with_gap', 'nothing_to_import', 'blocked_unlinked', 'blocked_unmatched',
    'already_imported', 'not_connected', 'seal_unreadable', 'token_rejected', 'partner_refused',
    'partner_unavailable', 'partner_malformed', 'company_blocked', 'refused', 'failed'
  ] LOOP
    IF v_def IS NULL OR strpos(v_def, '''' || v_frag || '''') = 0 THEN
      RAISE EXCEPTION 'uber pull gap self-check 2: the outcome set lost %', v_frag;
    END IF;
  END LOOP;

  -- The writer: the gap is settled in its own transaction, and the old
  -- load-bearing fragments are all still there.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.income_import_uber_system(uuid, jsonb)'::regprocedure;
  FOREACH v_frag IN ARRAY ARRAY[
    'imported_with_gap', 'v_run.unmatched', 'v_replace := v_run.pass = ''recheck''',
    'partner_driver_links', 'l.status = ''linked''', 'driver_not_linked', 'already_imported',
    'run_not_open', 'company_blocked', 'FOR UPDATE',
    'pg_advisory_xact_lock(hashtextextended(''income_import_uber:'' || v_company::text, 0))',
    'i.source_period_start <= (e->>''period_end'')::date'
  ] LOOP
    IF strpos(v_src, v_frag) = 0 THEN
      RAISE EXCEPTION 'uber pull gap self-check 3: the system writer lost %', v_frag;
    END IF;
  END LOOP;
  IF (length(v_src) - length(replace(v_src, 'DELETE FROM', ''))) / length('DELETE FROM') <> 1
     OR strpos(v_src, 'SQLERRM') > 0 OR strpos(v_src, 'p_replace') > 0 OR strpos(v_src, 'auth.uid()') > 0 THEN
    RAISE EXCEPTION 'uber pull gap self-check 3: the system writer changed beyond its settle';
  END IF;

  -- Settle: imported stays the writer's alone; the gap needs names on the claim.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.uber_pull_settle(uuid, text, text, integer)'::regprocedure;
  IF strpos(v_src, 'IF p_outcome = ''imported'' THEN') = 0
     OR strpos(v_src, 'jsonb_array_length(unmatched) > 0') = 0 THEN
    RAISE EXCEPTION 'uber pull gap self-check 4: settle lost its imported guard or the names condition';
  END IF;

  -- The note: it stores only name and trips, on an open claim.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.uber_pull_note_unmatched(uuid, jsonb)'::regprocedure;
  IF strpos(v_src, 'settled_at IS NULL') = 0 OR strpos(v_src, 'jsonb_build_object(') = 0 THEN
    RAISE EXCEPTION 'uber pull gap self-check 5: the note must rebuild its entries and touch an open claim only';
  END IF;

  -- All three: service_role alone, SECURITY DEFINER, pinned search_path.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.uber_pull_note_unmatched(uuid, jsonb)',
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
      RAISE EXCEPTION 'uber pull gap self-check 6: % must be SECURITY DEFINER, pinned, and EXECUTE for service_role only', v_sig;
    END IF;
  END LOOP;

  RAISE NOTICE 'uber pull gap self-check: passed';
END
$check$;
