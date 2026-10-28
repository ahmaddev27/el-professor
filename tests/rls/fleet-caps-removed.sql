/*
  20261026110000: the two fleet caps are gone, and a company at its limit adds
  the car anyway.

  The owner's rule, stated three times and again on 26.10.2026: a company that
  has reached its car allowance ADDS the car, the invoice goes up, and the car
  count goes up. Billing, never blocking. Before that migration two triggers
  refused instead, live on production:

    trg_enforce_car_limit    on cars    -> 'Fahrzeuglimit erreicht...'   (P0001)
    trg_enforce_driver_limit on drivers -> 'Fahrerlimit erreicht...'      (P0001)

  Measured on production 26.10.2026, two companies could not add a car:
  Customer A (5 active cars of 5) and Customer G (3 of 3).

  ## What is claimed

  Three things, in this order, and the third is what makes the first two mean
  something:

    1. CATALOGUE — neither trigger, neither function, and no surviving function
       body or policy expression that names either.

    2. BEHAVIOUR — a company whose `subscription_car_limit` is 2 inserts a third
       car, as an ordinary company administrator through RLS; and a company
       whose allowance times `drivers_per_car_limit` is 1 inserts a second
       driver. Section 1 alone could pass against a database where the refusal
       had moved into a policy or a CHECK instead of a trigger.

    3. A NEGATIVE CONTROL that re-creates the car trigger inside this
       transaction and requires the same INSERT to be refused. Without it,
       section 2 proves only that the INSERT works — it could pass on a database
       where the trigger was never there, where the limit column was NULL, or
       where the fixture never reached the limit at all. With it, section 2 is
       measured against the exact mechanism that was removed.

  The control is why this file is not merely "an INSERT succeeds". A probe run
  where the thing it probes for was never present measures nothing, and this
  repository has shipped that twice.

  ## What it does not claim

  The quote. `tests/rls/pricing.sql` owns `platform_invoice_quotes` and section
  6c of that file is where the billed quantity following the fleet is asserted.
  Tenancy and the page gate on `cars` and `drivers` are matrix.sql's and
  permission-coverage.sql's and nothing here re-derives them: every probe stays
  inside company A as its own administrator.

  Runs inside BEGIN … ROLLBACK, so the files after it see only the migrations
  and the seeds — including the trigger the control re-creates.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _fc_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  -- A password sign-in: the claim shape 20260919130000 expects and every other
  -- file in the kit sends.
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _fc_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  One statement as one principal in a subtransaction that is always rolled back:
  `rows N`, the scalar for a SELECT, or `ERR <sqlstate> <message>`. The rollback
  is what lets the same INSERT be probed with the trigger absent and then with
  it present without the first probe's row changing the second's count.
*/
CREATE OR REPLACE FUNCTION _fc_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _fc_as(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ008', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ008' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _fc_reset();
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION _fc_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'fleet-caps-removed: FAIL — %', p_label;
  END IF;
  RAISE NOTICE 'fleet-caps-removed: ok — %', p_label;
END $$;

-- ─── 1. the catalogue ───────────────────────────────────────────────────────

DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(x.what, ', ') INTO v_left
    FROM (
      SELECT 'trigger ' || t.tgname || ' on ' || c.relname AS what
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname IN ('trg_enforce_car_limit', 'trg_enforce_driver_limit')
      UNION ALL
      SELECT 'function ' || p.oid::regprocedure::text
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'app_private')
         AND p.proname IN ('enforce_car_limit', 'enforce_driver_limit')
    ) x;
  PERFORM _fc_ok('the two cap triggers and their two functions are gone from the catalogue',
                 v_left IS NULL);

  -- A surviving caller would fail at call time with 42883 — a defect found by a
  -- customer rather than by a release. This is the reader that finds it first.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND (p.prosrc LIKE '%enforce_car_limit%' OR p.prosrc LIKE '%enforce_driver_limit%');
  PERFORM _fc_ok('no surviving function body names either dropped function', v_left IS NULL);

  SELECT string_agg(pol.polname || ' on ' || pol.polrelid::regclass::text, ', ') INTO v_left
    FROM pg_policy pol
   WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
         || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
         LIKE ANY (ARRAY['%enforce_car_limit%', '%enforce_driver_limit%']);
  PERFORM _fc_ok('no policy expression names either dropped function', v_left IS NULL);

  -- The refusal must not have moved into a constraint either. `cars` keeps
  -- exactly its status CHECK and its keys; a new CHECK mentioning a count or a
  -- limit would be the same cap wearing a different hat.
  SELECT string_agg(con.conname, ', ') INTO v_left
    FROM pg_constraint con
   WHERE con.conrelid IN ('public.cars'::regclass, 'public.drivers'::regclass)
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%limit%';
  PERFORM _fc_ok('no CHECK constraint on cars or drivers mentions a limit', v_left IS NULL);

  -- And the triggers this file had no business touching are still there. A
  -- tenant table without both of these stops being audited, and
  -- support-write-audit.sql section 1 would be the only thing left to notice.
  PERFORM _fc_ok('the support-session trigger pair survives on cars and on drivers',
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname IN ('cars', 'drivers')
        AND t.tgname IN ('refuse_read_only_context_write', 'record_support_write')) = 4);
END $$;

-- ─── 2. the behaviour, and 3. the control ───────────────────────────────────

DO $$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  c_add_car    constant text :=
    $s$INSERT INTO cars (company_id, kennzeichen, created_by)
       VALUES ('c0000000-0000-4000-8000-00000000000a', 'FC-OVER-1',
               'a0000000-0000-4000-8000-000000000001')$s$;
  c_add_driver constant text :=
    $s$INSERT INTO drivers (company_id, name)
       VALUES ('c0000000-0000-4000-8000-00000000000a', 'FC over-limit driver')$s$;
  v_answer text;
BEGIN
  -- The fixture puts company A exactly at the allowance the dropped trigger
  -- compared against: two cars against a limit of two. One car and a limit of
  -- five would make section 2 pass whatever the trigger did, which is the shape
  -- matrix.sql happens to have and the reason it reports nothing here.
  UPDATE public.companies SET subscription_car_limit = 2 WHERE id = co_a;
  INSERT INTO public.cars (company_id, kennzeichen, created_by, status) VALUES
    (co_a, 'FC-AT-LIMIT-1', admin_a, 'active'),
    (co_a, 'FC-AT-LIMIT-2', admin_a, 'active');

  -- And exactly at the driver allowance: limit 2 times one driver per car is 2,
  -- with two drivers already present. (seed.sql's company_settings row names
  -- only company_name, so drivers_per_car_limit is set here explicitly rather
  -- than relying on the trigger's COALESCE default of 4.)
  UPDATE public.company_settings SET drivers_per_car_limit = 1 WHERE company_id = co_a;
  INSERT INTO public.drivers (company_id, name) VALUES
    (co_a, 'FC at-limit driver 1'),
    (co_a, 'FC at-limit driver 2');

  PERFORM _fc_ok('fixture: company A is at its car allowance and at its driver allowance',
    (SELECT subscription_car_limit FROM public.companies WHERE id = co_a) = 2
    AND (SELECT count(*) FROM public.cars WHERE company_id = co_a AND status IS DISTINCT FROM 'inactive') >= 2
    AND (SELECT drivers_per_car_limit FROM public.company_settings WHERE company_id = co_a) = 1
    AND (SELECT count(*) FROM public.drivers WHERE company_id = co_a AND status IS DISTINCT FROM 'inactive') >= 2);

  -- 2a. The car goes in.
  v_answer := _fc_try(admin_a, c_add_car);
  PERFORM _fc_ok(format('a company at its car allowance adds the car anyway (got: %s)', v_answer),
                 v_answer = 'rows 1');

  -- 2b. So does the driver. The dropped driver trigger multiplied the same
  --     column by company_settings.drivers_per_car_limit, so this probe is not
  --     redundant: a revert that restored only one of the two functions would
  --     be caught by exactly one of these two lines.
  v_answer := _fc_try(admin_a, c_add_driver);
  PERFORM _fc_ok(format('a company at its driver allowance adds the driver anyway (got: %s)', v_answer),
                 v_answer = 'rows 1');

  -- 2c. Neither insert is a quirk of an absent allowance: a NULL
  --     subscription_car_limit was the dropped trigger's own "no limit, allow"
  --     branch, so a fixture that reached here with NULL would pass 2a and 2b
  --     while proving nothing. The CHECK forbids NULL, and this says so.
  PERFORM _fc_ok('the allowance is a real number, not the trigger''s NULL bypass',
    (SELECT subscription_car_limit IS NOT NULL FROM public.companies WHERE id = co_a));

  -- ── 3. the negative control ───────────────────────────────────────────────
  --
  -- Re-create the car cap exactly as 20260531103227 and 20260607124839 left it
  -- on production (body read from the live catalogue, 26.10.2026) and require
  -- the SAME statement, as the SAME principal, against the SAME fixture, to be
  -- refused. If this does not refuse, section 2 is measuring nothing.
  -- In `public` and not `pg_temp`: a trigger on a permanent table reaching a
  -- temporary function is a shape nothing in this product uses, and the point
  -- of a control is to reproduce the mechanism, not a near relative of it.
  -- BEGIN … ROLLBACK removes it either way.
  CREATE FUNCTION public._fc_control_car_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $ctl$
  DECLARE
    car_limit   integer;
    active_cars integer;
  BEGIN
    IF NEW.status IS NOT DISTINCT FROM 'inactive' THEN
      RETURN NEW;
    END IF;
    SELECT subscription_car_limit INTO car_limit FROM companies WHERE id = NEW.company_id;
    IF car_limit IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT COUNT(*) INTO active_cars
      FROM cars
     WHERE company_id = NEW.company_id
       AND status IS DISTINCT FROM 'inactive'
       AND id IS DISTINCT FROM NEW.id;
    IF active_cars >= car_limit THEN
      RAISE EXCEPTION 'Fahrzeuglimit erreicht. Ihr Abonnement erlaubt maximal % aktive Fahrzeuge.', car_limit
      USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END;
  $ctl$;

  CREATE TRIGGER _fc_control_car_limit
    BEFORE INSERT OR UPDATE ON public.cars
    FOR EACH ROW EXECUTE FUNCTION public._fc_control_car_limit();

  v_answer := _fc_try(admin_a, c_add_car);
  PERFORM _fc_ok(format('CONTROL: with the cap back, the same insert by the same principal is refused P0001 (got: %s)', v_answer),
                 v_answer LIKE 'ERR P0001 Fahrzeuglimit erreicht%');

  DROP TRIGGER _fc_control_car_limit ON public.cars;
  DROP FUNCTION public._fc_control_car_limit();

  -- And with it gone again, the insert goes through again. The pair is the
  -- measurement: absent -> allowed, present -> refused, absent -> allowed.
  v_answer := _fc_try(admin_a, c_add_car);
  PERFORM _fc_ok(format('CONTROL: with the cap removed again, the insert goes through again (got: %s)', v_answer),
                 v_answer = 'rows 1');
END $$;

ROLLBACK;
