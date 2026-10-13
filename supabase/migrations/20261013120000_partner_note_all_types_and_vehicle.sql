-- ════════════════════════════════════════════════════════════════════════════
--  All ten note types may cross, and a note about the road names the vehicle
-- ════════════════════════════════════════════════════════════════════════════
--
--  Two owner decisions of 13.10.2026, both implemented here and neither argued.
--
--  ── 1. `sick`, `vacation` and `off` cross now (REVERSES 06.10.2026) ─────────
--
--  20261007110000 refused those three outright with `note_type_not_
--  transferable`. Its header records the owner's own words of 06.10.2026: they
--  are health and absence data, Art. 9 GDPR, and they "leave the transfer
--  entirely - the operator enters them, as they already do".
--
--  On 13.10.2026 the owner reversed that. He was told plainly what it means: a
--  named German employee's sickness becomes data that crosses between two
--  products and is stored in both. He was offered two narrower shapes - an
--  "absent" type carrying no medical reason, or letting only `vacation` and
--  `off` cross - and chose all three. This migration does that. It is written
--  down here, and beside the old reason in 20261007110000, so the next reader
--  finds the decision and its date instead of a silently widened list.
--
--  What did NOT change, and must not:
--
--    - The door is still an ALLOW-list, now of ten. A type this build has not
--      heard of is refused, never waved through; a deny-list would admit
--      `krank`, `krankheit` or a typo as an ordinary note. The tests keep
--      `krank` as the probe that tells the two shapes apart.
--    - The planning behaviour is DERIVED from the type by
--      `app_private.note_behavior_for`, never accepted from the request.
--      `sick`, `vacation` and `off` derive `exclude_from_plan`, which is exactly
--      what the owner wants: the driver leaves that month's working hours.
--    - The free text still crosses unchanged. For a sickness note it is where a
--      reason would be typed, and nothing here inspects or strips it.
--
--  ── 2. A note carries the vehicle ───────────────────────────────────────────
--
--  A police stop, a speed camera, an accident, a problem with a customer: the
--  letter that follows arrives addressed to a CAR. The owner's rule is that the
--  driver picks the vehicle from a list, never types a plate, and that for
--  these types it is not optional.
--
--  Half of it already existed and is reused, not rebuilt: 20260928120000 added
--  `driver_notes.car_id`, a nullable key into `public.cars` ON DELETE SET NULL,
--  chosen as a picker over free text so that `B-XX 1234` and `B-XX-1234` cannot
--  become two vehicles. It is plate-only, and NOTHING in the planning engine
--  reads it. All of that stays true; this migration adds the path from the
--  driver's app and nothing else, and the self-check re-asserts that no policy
--  on `driver_notes` mentions `car_id`.
--
--  The partner sends the plate string from ITS fleet list, not our id. So:
--
--    - `partner_note_submissions.vehicle_plate` keeps the plate exactly as it
--      arrived (trimmed, at most 32 characters). It is the raw record and is
--      never rewritten.
--    - `partner_note_apply` - the one place a submission becomes a note, for an
--      arrival and for a link confirmed later - resolves the plate to
--      `public.cars.id` and writes `driver_notes.car_id`.
--    - The resolver is `app_private.plate_key`, the SQL twin of the browser's
--      `normalise` plus `isValidKennzeichen` (`fahrtenbuchImportParser.ts`),
--      the pair `FahrtenbuchImportModal.buildCarMatches` uses to auto-confirm a
--      car. A plate is far more deterministic than a name, so an automatic
--      match is right here; a NAME match is not, and that line is drawn in this
--      repository because a fuzzy name match once attributed a month of salary
--      to a driver nobody had chosen. One deliberate difference from the
--      browser: it also accepts one plate merely CONTAINING another. Here the
--      two keys must be EQUAL and exactly one car of the company must carry
--      them. `B-AB 12` inside `B-AB 123` is a guess about a vehicle, and the
--      ambiguity is resolved by not resolving.
--    - A plate that does not resolve does not stop the note. It is recorded
--      with `car_id` NULL and the plate stays on the submission row. An
--      incident matters more than the vehicle link, and there is no review step
--      left to repair it later, so nothing is dropped on the floor.
--    - REQUIRED only where the type derives `must_include_in_plan`
--      (`blitzer`, `accident`, `kontrolle`, `breakdown`, `wait`). The door asks
--      `note_behavior_for`; the set is not written a second time anywhere. A
--      sickness note names no car and is never refused for it. The refusal is
--      the final reason `vehicle_required`; a blank plate and a plate that
--      names no vehicle (no letter, `null`, a coordinate pair) both count as
--      absent.
--
--  The door gains a 13th argument at the END, `p_vehicle_plate text DEFAULT
--  NULL`, so every positional caller keeps working and a named caller that has
--  not heard of it sends NULL. Adding an argument is a new signature, so the
--  old twelve-argument function is dropped (a second overload would make
--  PostgREST's named call ambiguous, and 20261013100000's self-check requires
--  exactly one signature).
--
--  ── Backward compatibility ──────────────────────────────────────────────────
--
--  The release before this one calls the door without the argument. That call
--  still works for the two neutral types and for all three absence types; for
--  the five incident types it is now refused with `vehicle_required`, which is
--  the owner's rule working, not a break.

-- ─── 1. the raw plate, kept on the submission ───────────────────────────────

ALTER TABLE public.partner_note_submissions
  ADD COLUMN IF NOT EXISTS vehicle_plate text NULL;

ALTER TABLE public.partner_note_submissions
  DROP CONSTRAINT IF EXISTS partner_note_submissions_vehicle_plate_shape;
ALTER TABLE public.partner_note_submissions
  ADD CONSTRAINT partner_note_submissions_vehicle_plate_shape
  CHECK (vehicle_plate IS NULL
         OR (btrim(vehicle_plate) <> '' AND length(vehicle_plate) <= 32));

COMMENT ON COLUMN public.partner_note_submissions.vehicle_plate IS
  'The plate the driver''s app sent, exactly as it arrived (trimmed). The raw '
  'record: the resolved vehicle lives on driver_notes.car_id, and when no car '
  'of the company carries this plate that stays NULL and this column is the '
  'only trace of which vehicle the driver meant (20261013120000).';

-- ─── 2. the plate key, twin of the browser's normalise ──────────────────────
--
--  src/utils/fahrtenbuchImportParser.ts: `normalise(s)` is lower-case with
--  everything but a-z and 0-9 removed; `isValidKennzeichen` refuses an empty
--  cell, the exporter's null marker, the words null and undefined, and any
--  value with no letter in it (which also covers a coordinate pair and a long
--  run of digits). NULL here means "this names no vehicle".

CREATE OR REPLACE FUNCTION app_private.plate_key(p_plate text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_plate IS NULL THEN NULL
    WHEN btrim(p_plate) = '' THEN NULL
    WHEN lower(btrim(p_plate)) IN ('\n', 'null', 'undefined') THEN NULL
    WHEN p_plate !~ '[a-zA-ZÄÖÜäöü]' THEN NULL
    ELSE nullif(regexp_replace(lower(p_plate), '[^a-z0-9]', '', 'g'), '')
  END;
$$;

COMMENT ON FUNCTION app_private.plate_key(text) IS
  'The comparison key of a number plate: the SQL twin of normalise() plus '
  'isValidKennzeichen() in src/utils/fahrtenbuchImportParser.ts. NULL for '
  'anything that names no vehicle. B-XX 1234 and b xx1234 are one key.';

REVOKE ALL ON FUNCTION app_private.plate_key(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. the door: ten types, and the vehicle ────────────────────────────────
--
--  Spliced from the catalogue, as 20261011100000, 20261012100000 and
--  20261013100000 did, so that the apply call they added is not restated and
--  lost. Each anchor must occur exactly once.

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_note_submission_record is not defined';
  END IF;
  v_def := replace(v_def, chr(13), '');

  -- the new last argument
  v_old := 'p_raw_payload jsonb DEFAULT NULL::jsonb)';
  v_new := 'p_raw_payload jsonb DEFAULT NULL::jsonb, p_vehicle_plate text DEFAULT NULL::text)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the door signature anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- the declaration
  v_old := '  v_driver   uuid;';
  v_new := v_old || E'\n' || '  v_plate    text;';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the door declaration anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- the allow-list: seven become ten
  v_old := '  -- The seven that may cross. An allow-list: a type this build has not heard' || E'\n'
        || '  -- of is refused, never stored and treated as neutral.' || E'\n'
        || '  c_transferable constant text[] :=' || E'\n'
        || '    ARRAY[''general'', ''other'', ''blitzer'', ''accident'', ''kontrolle'', ''breakdown'', ''wait''];';
  v_new := '  -- All ten may cross (owner, 13.10.2026; see the header of 20261013120000).' || E'\n'
        || '  -- Still an allow-list: a type this build has not heard of is refused,' || E'\n'
        || '  -- never stored and treated as neutral.' || E'\n'
        || '  c_transferable constant text[] :=' || E'\n'
        || '    ARRAY[''general'', ''sick'', ''vacation'', ''off'', ''other'', ''blitzer'', ''accident'',' || E'\n'
        || '          ''kontrolle'', ''breakdown'', ''wait''];';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the door allow-list anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- the vehicle, judged once the behaviour is known
  v_old := '  -- The table''s pattern accepts 25:00.';
  v_new := '  -- The vehicle. Trimmed and kept as it arrived; required only where the type' || E'\n'
        || '  -- derives must_include_in_plan, asked of note_behavior_for so the set is not' || E'\n'
        || '  -- written a second time. A plate that names no car of ours is NOT refused:' || E'\n'
        || '  -- it is kept on the row and resolved (or not) when the note is applied.' || E'\n'
        || '  v_plate := nullif(btrim(coalesce(p_vehicle_plate, '''')), '''');' || E'\n'
        || '  IF v_plate IS NOT NULL AND length(v_plate) > 32 THEN' || E'\n'
        || '    RAISE EXCEPTION ''vehicle plate is too long''' || E'\n'
        || '      USING ERRCODE = ''22023'', HINT = ''invalid_vehicle_plate'';' || E'\n'
        || '  END IF;' || E'\n'
        || '  IF v_behavior = ''must_include_in_plan''' || E'\n'
        || '     AND app_private.plate_key(v_plate) IS NULL THEN' || E'\n'
        || '    RAISE EXCEPTION ''this note type must name the vehicle''' || E'\n'
        || '      USING ERRCODE = ''22023'', HINT = ''vehicle_required'';' || E'\n'
        || '  END IF;' || E'\n'
        || E'\n' || v_old;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the door time-comment anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- the insert
  v_old := 'start_time, end_time, raw_payload)';
  v_new := 'start_time, end_time, raw_payload, vehicle_plate)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the door insert column anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := '          p_raw_payload)';
  v_new := '          p_raw_payload, v_plate)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the door insert value anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  -- A new signature: the old function goes, so there is exactly one door.
  DROP FUNCTION public.partner_note_submission_record(
    uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb);

  EXECUTE v_def;
END;
$do$;

COMMENT ON FUNCTION public.partner_note_submission_record(uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb, text) IS
  'Records one note a partner''s driver submitted and, for a linked driver, '
  'applies it on arrival. Service role only: the table has no INSERT policy, '
  'deliberately. All ten note types may cross (an allow-list; owner, '
  '13.10.2026, reversing 06.10.2026). A type that derives must_include_in_plan '
  'must name the vehicle (vehicle_required). Idempotent on (company, partner, '
  'external_submission_id). The driver is resolved from our own confirmed '
  'link, the planning behaviour from the type, never from the request.';

REVOKE ALL ON FUNCTION public.partner_note_submission_record(uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_note_submission_record(uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb, text)
  TO service_role;

-- ─── 4. the apply resolves the plate ────────────────────────────────────────

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'partner_note_apply';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_note_apply is not defined';
  END IF;
  v_def := replace(v_def, chr(13), '');

  v_old := '  v_note_date timestamptz;';
  v_new := v_old || E'\n' || '  v_cars      uuid[];' || E'\n' || '  v_car       uuid;';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the apply declaration anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := '  INSERT INTO public.driver_notes' || E'\n';
  v_new := '  -- The vehicle. Equal keys and exactly one car of THIS company: two cars' || E'\n'
        || '  -- with one key, or none, leave car_id NULL. The submission keeps the' || E'\n'
        || '  -- plate as it arrived, so an unresolved one is not lost.' || E'\n'
        || '  IF app_private.plate_key(v_row.vehicle_plate) IS NOT NULL THEN' || E'\n'
        || '    SELECT array_agg(c.id) INTO v_cars' || E'\n'
        || '      FROM public.cars c' || E'\n'
        || '     WHERE c.company_id = v_row.company_id' || E'\n'
        || '       AND app_private.plate_key(c.kennzeichen)' || E'\n'
        || '           = app_private.plate_key(v_row.vehicle_plate);' || E'\n'
        || '    IF cardinality(v_cars) = 1 THEN' || E'\n'
        || '      v_car := v_cars[1];' || E'\n'
        || '    END IF;' || E'\n'
        || '  END IF;' || E'\n'
        || E'\n' || v_old;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the apply insert anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := 'start_time, end_time, start_date, end_date)';
  v_new := 'start_time, end_time, start_date, end_date, car_id)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the apply column anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := 'v_row.start_time, v_row.end_time, v_row.start_date, v_row.end_date)';
  v_new := 'v_row.start_time, v_row.end_time, v_row.start_date, v_row.end_date,' || E'\n'
        || '          v_car)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'the apply value anchor is not unique';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$do$;

-- CREATE OR REPLACE keeps the grants, but the REVOKE is the second wall and is
-- cheap to state again.
REVOKE ALL ON FUNCTION app_private.partner_note_apply(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 5. self-check ──────────────────────────────────────────────────────────

DO $do$
DECLARE
  v_n     int;
  v_def   text;
  v_miss  text[] := '{}';
  v_frag  text;
  v_door  constant text :=
    'public.partner_note_submission_record(uuid, text, text, text, text, text, date, date, boolean, text, text, jsonb, text)';
  v_type  text;
  v_want  text;
BEGIN
  -- 1. one door, thirteen arguments, definer with a pinned search_path, and
  --    service_role alone may call it.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'note-types self-check 1: % signatures of the door, expected 1', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record'
                    AND p.pronargs = 13 AND p.prosecdef
                    AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                                 WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'note-types self-check 1: the door is not a 13-argument SECURITY DEFINER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_door, 'EXECUTE')
     OR has_function_privilege('authenticated', v_door, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_door, 'EXECUTE') THEN
    RAISE EXCEPTION 'note-types self-check 1: the door is not service_role''s alone';
  END IF;

  -- 2. the allow-list is the ten, as a list, and nothing was turned into a
  --    deny-list. The old seven-element text must be gone.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'partner_note_submission_record';
  FOREACH v_frag IN ARRAY ARRAY[
    '''general'', ''sick'', ''vacation'', ''off'', ''other'', ''blitzer'', ''accident'',',
    '''kontrolle'', ''breakdown'', ''wait'']',
    '= ANY (c_transferable)', 'note_type_not_transferable'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('allow-list:' || v_frag); END IF;
  END LOOP;
  IF position('''accident'', ''kontrolle'', ''breakdown''' IN v_def) <> 0 THEN
    v_miss := v_miss || 'the old seven-type list is still there'::text;
  END IF;

  -- 3. the behaviour is derived and the vehicle rule asks for it: the string
  --    'blitzer' appears once (in the allow-list), so the required set is
  --    NOT written a second time inside the door.
  FOREACH v_frag IN ARRAY ARRAY[
    'note_behavior_for(v_type)', 'v_behavior = ''must_include_in_plan''',
    'app_private.plate_key(v_plate)', 'vehicle_required', 'invalid_vehicle_plate',
    'partner_note_apply', 'public.partner_driver_links',
    'ON CONFLICT (company_id, partner, external_submission_id) DO NOTHING',
    'raw_payload, vehicle_plate)'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('door:' || v_frag); END IF;
  END LOOP;
  IF (length(v_def) - length(replace(v_def, '''blitzer''', ''))) / length('''blitzer''') <> 1 THEN
    v_miss := v_miss || 'the incident set is written more than once in the door'::text;
  END IF;

  -- 4. the apply resolves the plate by key, inside the company, and only when
  --    exactly one car carries it.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'partner_note_apply';
  FOREACH v_frag IN ARRAY ARRAY[
    'app_private.plate_key(v_row.vehicle_plate)', 'c.company_id = v_row.company_id',
    'cardinality(v_cars) = 1', 'end_date, car_id)', 'note_behavior_for(v_row.note_type)',
    'driver_not_linked', 'FOR UPDATE'
  ] LOOP
    IF position(v_frag IN v_def) = 0 THEN v_miss := v_miss || ('apply:' || v_frag); END IF;
  END LOOP;
  IF array_length(v_miss, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'note-types self-check 4: the splice lost: %', array_to_string(v_miss, ', ');
  END IF;

  -- 5. the behaviour table agrees with the owner: the three absence types
  --    exclude the driver, the five incident types must be planned, and
  --    these ten are all it knows. This pins what the derivation says; the
  --    door never repeats it.
  FOR v_type, v_want IN VALUES
    ('general', 'neutral'), ('other', 'neutral'),
    ('sick', 'exclude_from_plan'), ('vacation', 'exclude_from_plan'), ('off', 'exclude_from_plan'),
    ('blitzer', 'must_include_in_plan'), ('accident', 'must_include_in_plan'),
    ('kontrolle', 'must_include_in_plan'), ('breakdown', 'must_include_in_plan'),
    ('wait', 'must_include_in_plan')
  LOOP
    IF app_private.note_behavior_for(v_type) IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'note-types self-check 5: % derives %, expected %',
        v_type, app_private.note_behavior_for(v_type), v_want;
    END IF;
  END LOOP;
  IF app_private.note_behavior_for('krank') IS NOT NULL THEN
    RAISE EXCEPTION 'note-types self-check 5: an unknown type derives a behaviour';
  END IF;

  -- 6. plate_key: a truth table with no cars in the database, which is all the
  --    kit's fixture has. The same samples are pinned against the browser's
  --    normalise and isValidKennzeichen in src/utils/partnerPlateKey.test.ts.
  IF app_private.plate_key('B-XX 1234') IS DISTINCT FROM 'bxx1234'
     OR app_private.plate_key('b xx1234') IS DISTINCT FROM 'bxx1234'
     OR app_private.plate_key('  B-XX-1234  ') IS DISTINCT FROM 'bxx1234'
     OR app_private.plate_key('M-AB 12E') IS DISTINCT FROM 'mab12e' THEN
    RAISE EXCEPTION 'note-types self-check 6: two spellings of one plate no longer share a key';
  END IF;
  IF app_private.plate_key('B-XX 1234') IS NOT DISTINCT FROM app_private.plate_key('B-XX 1235') THEN
    RAISE EXCEPTION 'note-types self-check 6: two different plates share a key';
  END IF;
  IF app_private.plate_key(NULL) IS NOT NULL OR app_private.plate_key('') IS NOT NULL
     OR app_private.plate_key('   ') IS NOT NULL OR app_private.plate_key('null') IS NOT NULL
     OR app_private.plate_key('NULL') IS NOT NULL OR app_private.plate_key('undefined') IS NOT NULL
     OR app_private.plate_key('\N') IS NOT NULL OR app_private.plate_key('12345678') IS NOT NULL
     OR app_private.plate_key('52.52 13.40') IS NOT NULL OR app_private.plate_key('- -') IS NOT NULL THEN
    RAISE EXCEPTION 'note-types self-check 6: a value that names no vehicle has a key';
  END IF;

  -- 7. nothing in app_private is reachable by an API role.
  IF has_function_privilege('anon', 'app_private.plate_key(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.plate_key(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.plate_key(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'app_private.partner_note_apply(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.partner_note_apply(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.partner_note_apply(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'note-types self-check 7: an app_private function is executable by an API role';
  END IF;

  -- 8. the safety property of 20260928120000 still holds: car_id is not a
  --    tenancy term, and the raw plate column is not client-writable.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'driver_notes'
     AND (coalesce(qual, '') LIKE '%car_id%' OR coalesce(with_check, '') LIKE '%car_id%');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'note-types self-check 8: a driver_notes policy mentions car_id';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_note_submissions'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'note-types self-check 8: partner_note_submissions gained a client write policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'partner_note_submissions'
                    AND column_name = 'vehicle_plate')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'partner_note_submissions_vehicle_plate_shape') THEN
    RAISE EXCEPTION 'note-types self-check 8: the raw plate column or its CHECK is missing';
  END IF;

  RAISE NOTICE 'partner notes: self-checks passed - ten types cross by allow-list, the behaviour is derived, the incident types name a vehicle, an unresolved plate is kept';
END;
$do$;
