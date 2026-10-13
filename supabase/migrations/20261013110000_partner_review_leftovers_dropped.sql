-- ════════════════════════════════════════════════════════════════════════════
--  The partner review step is gone, and now so are its leftovers
-- ════════════════════════════════════════════════════════════════════════════
--
--  20261013100000 removed the review: a submission from the driver app is
--  accepted the moment it arrives. It deliberately dropped nothing, saying a
--  function other code might call is for the owner to retire. The owner was
--  asked on 13.10.2026 whether the leftovers should go and said yes.
--
--  What goes, and why each is unreachable:
--
--    partner_receipt_accept(uuid), partner_receipt_reject(uuid, text),
--    partner_note_accept(uuid), partner_note_reject(uuid, text)
--        The reviewer's decisions. The browser's callers went with the review
--        screen in 20261013100000's own commit. Both accepts can no longer
--        succeed on any row (a pending submission never has a driver, and
--        both refuse that), and a rejection has no one to be sent to.
--
--    partner_submission_push_target(uuid), partner_submission_push_record(uuid, text)
--        The sender behind the edge function partner-notify, which told a
--        driver about a REJECTION. Nothing rejects any more.
--
--  The edge function partner-notify goes in the same commit (its directory and
--  its FUNCTION_ENV line in the router). It was never listed in
--  deploy/docker-compose.yml.
--
--  What stays, on purpose: the columns status_pushed_at and status_push_error
--  and the rejected_reason column are history of what was once announced and
--  decided; retiring a function does not need a column dropped. The submission
--  tables, both doors, the claim, the link review, the pull and the doorbell
--  are the live path and are asserted present below.
--
--  Backward compatibility, for rollback: production has no partner migration
--  at all (measured 13.10.2026: no partner table), so no production release
--  calls these functions. Staging's previous release does, which is why a
--  rollback of staging across this point would leave a review screen calling a
--  function that is not there; see the PR for why SCHEMA_EPOCH is not bumped.
--
--  Dropped without CASCADE: a dependent object would make this fail loudly
--  rather than disappear silently. plpgsql bodies carry no dependency, so
--  self-check 4 reads the live bodies for the six names.

-- ─── 1. drop ─────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.partner_receipt_accept(uuid);
DROP FUNCTION IF EXISTS public.partner_receipt_reject(uuid, text);
DROP FUNCTION IF EXISTS public.partner_note_accept(uuid);
DROP FUNCTION IF EXISTS public.partner_note_reject(uuid, text);
DROP FUNCTION IF EXISTS public.partner_submission_push_target(uuid);
DROP FUNCTION IF EXISTS public.partner_submission_push_record(uuid, text);

-- ─── self-check ──────────────────────────────────────────────────────────────

DO $do$
DECLARE
  v_n     integer;
  v_fn    text;
  v_oid   oid;
  v_miss  text[];
BEGIN
  -- 1. none of the six exists under any signature. By name, not by signature:
  --    a re-created overload with another argument list is the same function
  --    to anyone copying an old migration. Counted in the catalogue because
  --    has_function_privilege raises on a function that is not there.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('partner_receipt_accept', 'partner_receipt_reject',
                       'partner_note_accept', 'partner_note_reject',
                       'partner_submission_push_target', 'partner_submission_push_record');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'review leftovers self-check 1: % of 6 retired functions remain', v_n;
  END IF;

  -- 2. the live path is still there, one signature each, SECURITY DEFINER.
  FOREACH v_fn IN ARRAY ARRAY[
    'partner_receipt_submission_record', 'partner_note_submission_record',
    'partner_submission_claim_driver', 'partner_driver_link_confirm',
    'partner_driver_link_reject', 'partner_doorbell_resolve',
    'partner_pull_record', 'partner_sealed_token', 'partner_credential_company',
    'partner_roster_apply', 'partner_driver_resolve'
  ] LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn AND p.prosecdef;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'review leftovers self-check 2: % has % SECURITY DEFINER signature(s), expected 1', v_fn, v_n;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'partner_receipt_apply', 'partner_note_apply', 'partner_receipt_number'
  ] LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app_private' AND p.proname = v_fn AND p.prosecdef;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'review leftovers self-check 2: app_private.% is missing or not SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;

  -- 3. their grants are intact. The service-role-only ones reach no API role;
  --    the three a signed-in reviewer calls are executable by authenticated and
  --    never by anon.
  FOR v_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('partner_receipt_submission_record', 'partner_note_submission_record',
                         'partner_doorbell_resolve', 'partner_pull_record', 'partner_sealed_token',
                         'partner_credential_company', 'partner_roster_apply',
                         'partner_driver_resolve')
  LOOP
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'review leftovers self-check 3: % has the wrong grants', v_oid::regprocedure;
    END IF;
  END LOOP;

  FOR v_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('partner_submission_claim_driver', 'partner_driver_link_confirm',
                         'partner_driver_link_reject')
  LOOP
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'review leftovers self-check 3: % has the wrong grants', v_oid::regprocedure;
    END IF;
  END LOOP;

  -- 4. no function of ours still calls a retired one. The catalogue keeps no
  --    dependency for plpgsql, so this is how a caller left behind is found
  --    here instead of at the first request.
  SELECT array_agg(n.nspname || '.' || p.proname) INTO v_miss
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND p.prokind = 'f'
     AND p.prosrc ~ '(partner_receipt_(accept|reject)|partner_note_(accept|reject)|partner_submission_push_(target|record))[[:space:]]*\(';
  IF v_miss IS NOT NULL THEN
    RAISE EXCEPTION 'review leftovers self-check 4: still called from: %', array_to_string(v_miss, ', ');
  END IF;

  RAISE NOTICE 'partner review leftovers: self-checks passed - six functions dropped, the live path and its grants intact';
END;
$do$;
