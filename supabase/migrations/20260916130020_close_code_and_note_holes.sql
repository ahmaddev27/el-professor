/*
  # The code, attempt and approval-note holes of plan 3.5

  Plan 3.5, the second half: the holes `tests/rls/matrix.sql` has recorded as
  current behaviour since 3.0, each tagged `HOLE[3.5]` there. Every cell this
  file moves is changed in the matrix in the same commit.

  ## What was wrong

  - **Anyone signed in could read every discount code.** A SELECT policy on
    `discount_codes` admitted every authenticated caller, so a viewer of one
    company read the code text, the discount and the company a code was assigned
    to. The platform's own screen already reads them through the
    `codes.manage` policy 20260916110010 wrote.
  - **`activation_code_attempts` had `WITH CHECK (true)`.** Any signed-in caller
    could write failed attempts in any company's name, and ten of them lock that
    company out of redeeming its own valid code for fifteen minutes.
  - **`preview_activation_code` had no limit and recorded nothing**, so the
    six-digit space could be searched through it without leaving a trace, and
    without ever reaching the limit `redeem_activation_code` applies.
  - **Its binding comparisons were NULL-blind.** `v_code.company_id <>
    v_company_id` and `lower(v_caller_email) <> lower(v_code.target_email)` are
    NULL, not true, when the caller has no company or no address on its profile,
    and the `IF` then fell through: a code bound to a company was previewed by a
    caller belonging to none, and a code bound to an address by a profile
    carrying none. `redeem_activation_code` had the same hole on the address.
  - **`redeem_activation_code` was open to every member.** A viewer could spend
    an activation code on the company's subscription.
  - **`companies.approval_note` was readable by every member.** It is the
    platform's internal note on an approval decision; nothing in the product
    writes or reads it any more.
  - **A SECURITY DEFINER function in `public` had no pinned `search_path`**
    (`enforce_car_limit`), so its unqualified names resolve through whatever
    search_path the caller brings.

  ## What this does

  - Drops every SELECT policy on `discount_codes` that does not ask
    `platform_can`, leaving the platform's. Nothing else reads the table: the
    signup form validates a code through the `validate-discount-code` function
    and `redeem_discount_code`, both of which run with the service role.
  - Replaces `any_insert_attempts` with a policy that admits an attempt only for
    the caller's own company. It is not a grant to members: the two RPCs write
    every real attempt, and because a SECURITY DEFINER function keeps the
    caller's `auth.uid()`, the same policy admits their inserts whether or not
    their owner also owns the table.
  - `activation_code_attempts.kind` tells a redeem attempt from a preview one.
    Each limit counts its own kind, so previews cannot spend the redeem budget
    and lock a company out — the shape of the hole above, from the inside.
    Existing rows and any writer that does not name the column are `redeem`,
    which is what they were.
  - `preview_activation_code`: records every attempt, refuses after
    `c_preview_limit` failures in fifteen minutes, compares both bindings with
    `IS DISTINCT FROM`, and answers a caller without a company at all. What it
    returns for a valid code is unchanged, which is what the matrix records as
    intended.
  - `redeem_activation_code`: company administrators only, the address binding
    made NULL-safe, attempts recorded as `redeem`, and the limit counting only
    that kind. Everything else — the period arithmetic, the columns written, the
    German answers — is untouched.
  - Neither function returns `SQLERRM` any more: a caller was shown Postgres's
    own message, which names columns and constraints.
  - `companies.approval_note` is retired. Any note that exists is copied into
    the platform audit log as `legacy.company_approval_note`, the column is
    emptied, and a trigger keeps it empty. The platform's record of an approval
    is the audit row `platform_company_set_approval` writes (20260916130000),
    which carries the decision, the reason and who made it.
    `rejection_reason` stays readable: a rejected company's own owner is shown
    it on the rejected page, which is the product's behaviour, not a leak.
  - Pins `search_path` on every SECURITY DEFINER function in `public` that has
    none, with `ALTER FUNCTION … SET`, so no body is replaced. Bodies here may
    differ from what the migrations say (see "cannot bootstrap a database" in
    CLAUDE.md), and this way that does not matter.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. The previous release's screens keep
  working: nothing in it reads `discount_codes` outside the platform screen,
  nothing writes `activation_code_attempts` except these two functions, and
  nothing reads or writes `approval_note`. A rollback leaves the narrower rules
  in place, which refuse more than the old code ever asked for.
*/

-- ─── Discount codes: the platform's policy, and no other reader ─────────────

DO $$
DECLARE
  r       record;
  v_drops text[] := '{}';
BEGIN
  FOR r IN
    SELECT policyname, coalesce(qual, '') AS qual
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'discount_codes' AND cmd = 'SELECT'
  LOOP
    -- The platform's own reader is the one 20260916110010 wrote; every other
    -- SELECT policy here admits people who have no business reading codes.
    IF r.qual !~ 'platform_can' THEN
      EXECUTE format('DROP POLICY %I ON public.discount_codes', r.policyname);
      v_drops := v_drops || r.policyname;
    END IF;
  END LOOP;

  RAISE NOTICE '20260916130020: dropped % member-facing SELECT polic(y/ies) on discount_codes: %',
    coalesce(array_length(v_drops, 1), 0), coalesce(array_to_string(v_drops, ', '), '—');
END $$;

-- ─── Activation code attempts: own company only, and a kind per limit ───────

ALTER TABLE public.activation_code_attempts
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'redeem';

ALTER TABLE public.activation_code_attempts
  DROP CONSTRAINT IF EXISTS activation_code_attempts_kind_check;
ALTER TABLE public.activation_code_attempts
  ADD CONSTRAINT activation_code_attempts_kind_check CHECK (kind IN ('redeem', 'preview'));

CREATE INDEX IF NOT EXISTS idx_activation_code_attempts_company_kind
  ON public.activation_code_attempts (company_id, kind, created_at);

DROP POLICY IF EXISTS any_insert_attempts ON public.activation_code_attempts;

-- The RPCs below write every real attempt. They are SECURITY DEFINER, which
-- changes the executing role but not auth.uid(), so this policy admits their
-- inserts as well — whether or not their owner happens to own the table. A
-- caller with no company matches nothing: NULL = NULL is NULL, and a policy
-- denies on NULL.
CREATE POLICY own_company_insert_attempts ON public.activation_code_attempts
  FOR INSERT TO authenticated
  WITH CHECK (company_id = (SELECT public.get_user_company_id()));

-- ─── preview_activation_code ────────────────────────────────────────────────

-- The body of 20260621110309, with: the attempt record and its limit, NULL-safe
-- binding comparisons, an answer for a caller without a company, and no SQLERRM
-- in what it returns. What it answers for a valid, matching code is unchanged.
CREATE OR REPLACE FUNCTION public.preview_activation_code(input_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  -- Previews are cheap and a person types a code more than once, so the budget
  -- is larger than redeem's ten; it is the same fifteen-minute window.
  c_preview_limit  CONSTANT integer  := 20;
  c_preview_window CONSTANT interval := interval '15 minutes';

  v_caller_id    uuid;
  v_company_id   uuid;
  v_caller_email text;
  v_code_hash    text;
  v_code         activation_codes%ROWTYPE;
  v_clean_code   text;
  v_seconds_rem  integer;
  v_attempts     integer;

  -- Records this preview against the caller's company. Every refusal below
  -- leaves a row, so a search through the code space is visible and bounded.
  PROCEDURE_note text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
  END IF;

  SELECT company_id, email INTO v_company_id, v_caller_email
  FROM user_profiles
  WHERE user_id = v_caller_id
  LIMIT 1;

  -- A caller belonging to no company can preview nothing: the bindings below
  -- are checked against that company, and the attempt is recorded against it.
  IF v_company_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Kein Unternehmenskonto gefunden.');
  END IF;

  SELECT COUNT(*) INTO v_attempts
  FROM activation_code_attempts
  WHERE company_id = v_company_id
    AND kind = 'preview'
    AND success = false
    AND created_at > now() - c_preview_window;

  IF v_attempts >= c_preview_limit THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, NULL, false, 'Rate limit', 'preview');
    RETURN json_build_object('success', false, 'error', 'Zu viele Versuche. Bitte warten Sie 15 Minuten.');
  END IF;

  v_clean_code := trim(regexp_replace(input_code, '\s', '', 'g'));

  IF v_clean_code !~ '^[0-9]{6}$' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Ungültiges Format', 'preview');
    RETURN json_build_object('success', false, 'error', 'Ungültiges Format.');
  END IF;

  v_code_hash := encode(digest(v_clean_code::bytea, 'sha256'), 'hex');

  SELECT * INTO v_code
  FROM activation_codes
  WHERE code_hash = v_code_hash
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Nicht gefunden', 'preview');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode nicht gefunden.');
  END IF;

  -- Binding checks. IS DISTINCT FROM, because a NULL on either side made the
  -- comparison NULL and let the code through the IF.
  IF v_code.company_id IS NOT NULL AND v_code.company_id IS DISTINCT FROM v_company_id THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsches Unternehmen', 'preview');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
  END IF;

  IF v_code.target_email IS NOT NULL
     AND lower(v_caller_email) IS DISTINCT FROM lower(v_code.target_email) THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsche E-Mail', 'preview');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu dieser E-Mail.');
  END IF;

  v_seconds_rem := GREATEST(0, EXTRACT(EPOCH FROM (v_code.expires_at - now()))::integer);

  INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
  VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), true, 'OK', 'preview');

  RETURN json_build_object(
    'success',           true,
    'status',            v_code.status,
    'expires_at',        v_code.expires_at,
    'duration_type',     v_code.duration_type,
    'seconds_remaining', v_seconds_rem
  );

EXCEPTION WHEN OTHERS THEN
  -- Never SQLERRM: it names columns and constraints, and this function runs as
  -- its owner.
  RETURN json_build_object('success', false, 'error', 'Der Code konnte nicht geprüft werden.');
END;
$$;

-- ─── redeem_activation_code ─────────────────────────────────────────────────

-- The body of 20260621120417, with: company administrators only, a NULL-safe
-- address binding, `kind` on every attempt it writes, a limit that counts only
-- redeem attempts, and no SQLERRM in what it returns. The period arithmetic and
-- every column it writes are untouched.
CREATE OR REPLACE FUNCTION public.redeem_activation_code(input_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_id     uuid;
  v_company_id    uuid;
  v_caller_role   text;
  v_code_hash     text;
  v_code          activation_codes%ROWTYPE;
  v_base_date     timestamptz;
  v_new_expiry    timestamptz;
  v_attempt_count integer;
  v_clean_code    text;
  v_sub_status    text;
  v_sub_expiry    timestamptz;
  v_start_date    timestamptz;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
  END IF;

  SELECT company_id, role INTO v_company_id, v_caller_role
  FROM user_profiles
  WHERE user_id = v_caller_id
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Kein Unternehmenskonto gefunden.');
  END IF;

  -- Spending an activation code changes what the company pays for. Plan 3.5
  -- puts it with the company's administrators; the conservative reading of
  -- "administrator" is the role itself, not a page permission that happens to
  -- include settings. coalesce(): a profile without a role is not one.
  IF coalesce(v_caller_role, '') <> 'admin' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, NULL, false, 'Keine Berechtigung', 'redeem');
    RETURN json_build_object('success', false,
      'error', 'Nur Administratoren des Unternehmens können einen Aktivierungscode einlösen.');
  END IF;

  v_clean_code := trim(regexp_replace(input_code, '\s', '', 'g'));

  IF v_clean_code !~ '^[0-9]{6}$' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Ungültiges Format', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode muss genau 6 Ziffern haben.');
  END IF;

  -- Only redeem attempts count here. A preview has its own budget, so previews
  -- can no longer spend this one.
  SELECT COUNT(*) INTO v_attempt_count
  FROM activation_code_attempts
  WHERE company_id = v_company_id
    AND kind = 'redeem'
    AND success = false
    AND created_at > now() - INTERVAL '15 minutes';

  IF v_attempt_count >= 10 THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Rate limit', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Zu viele Versuche. Bitte warten Sie 15 Minuten.');
  END IF;

  v_code_hash := encode(digest(v_clean_code::bytea, 'sha256'), 'hex');

  SELECT * INTO v_code
  FROM activation_codes
  WHERE code_hash = v_code_hash
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Nicht gefunden', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist ungültig.');
  END IF;

  IF v_code.status = 'used' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Bereits verwendet', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde bereits verwendet.');
  END IF;

  IF v_code.status = 'revoked' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Widerrufen', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde widerrufen.');
  END IF;

  IF v_code.expires_at < now() OR v_code.status = 'expired' THEN
    UPDATE activation_codes SET status = 'expired' WHERE id = v_code.id AND status = 'active';
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Abgelaufen', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist abgelaufen.');
  END IF;

  IF v_code.company_id IS NOT NULL AND v_code.company_id IS DISTINCT FROM v_company_id THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsches Unternehmen', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
  END IF;

  IF v_code.target_email IS NOT NULL THEN
    DECLARE
      v_caller_email text;
    BEGIN
      SELECT email INTO v_caller_email FROM user_profiles WHERE user_id = v_caller_id LIMIT 1;
      -- IS DISTINCT FROM: a profile without an address made this NULL, and the
      -- IF fell through to redeeming a code bound to someone else.
      IF lower(v_caller_email) IS DISTINCT FROM lower(v_code.target_email) THEN
        INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
        VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsche E-Mail', 'redeem');
        RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
      END IF;
    END;
  END IF;

  -- Atomically mark code as used
  UPDATE activation_codes
  SET status          = 'used',
      used_at         = now(),
      used_by         = v_caller_id,
      used_company_id = v_company_id
  WHERE id = v_code.id
    AND status = 'active'
    AND expires_at > now();

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Race condition', 'redeem');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode konnte nicht eingelöst werden. Bitte erneut versuchen.');
  END IF;

  -- Calculate new subscription expiry
  -- Extend from current active subscription if not yet expired
  SELECT subscription_status, subscription_expires_at
  INTO v_sub_status, v_sub_expiry
  FROM companies WHERE id = v_company_id;

  IF v_sub_status = 'active' AND v_sub_expiry IS NOT NULL AND v_sub_expiry > now() THEN
    v_base_date := v_sub_expiry;
  ELSE
    v_base_date := now();
  END IF;

  v_start_date := v_base_date;

  CASE v_code.duration_type
    WHEN '1_monat'   THEN v_new_expiry := v_base_date + INTERVAL '1 month';
    WHEN '3_monate'  THEN v_new_expiry := v_base_date + INTERVAL '3 months';
    WHEN '1_jahr'    THEN v_new_expiry := v_base_date + INTERVAL '1 year';
    WHEN 'benutzerdefiniert' THEN
      IF v_code.custom_expires_at IS NOT NULL THEN
        -- Absolute expiry date: use directly as both start and end
        v_new_expiry := v_code.custom_expires_at;
        v_start_date := now();
      ELSIF v_code.custom_days IS NOT NULL THEN
        v_new_expiry := v_base_date + (v_code.custom_days || ' days')::INTERVAL;
      ELSE
        v_new_expiry := v_base_date + INTERVAL '30 days';
      END IF;
    ELSE
      v_new_expiry := v_base_date + INTERVAL '1 month';
  END CASE;

  -- Write applied period back onto the activation_codes row
  UPDATE activation_codes
  SET applied_subscription_started_at = v_start_date,
      applied_subscription_expires_at  = v_new_expiry
  WHERE id = v_code.id;

  -- Update company subscription atomically
  UPDATE companies SET
    subscription_status        = 'active',
    subscription_started_at    = v_start_date,
    subscription_expires_at    = v_new_expiry,
    subscription_duration_type = v_code.duration_type,
    last_activation_code_id    = v_code.id,
    updated_at                 = now()
  WHERE id = v_company_id;

  INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason, kind)
  VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), true, 'OK', 'redeem');

  RETURN json_build_object(
    'success',                  true,
    'subscription_expires_at',  v_new_expiry
  );

EXCEPTION WHEN OTHERS THEN
  -- Never SQLERRM (see preview_activation_code).
  RETURN json_build_object('success', false, 'error', 'Der Aktivierungscode konnte nicht eingelöst werden.');
END;
$$;

-- ─── companies.approval_note is retired ─────────────────────────────────────

-- Whatever notes exist are kept, out of every company member's reach, next to
-- the platform's other history. The category is `legacy`, like the one-time
-- copy 20260916110000 made of the two subscription audit tables.
DO $$
DECLARE
  r       record;
  v_moved integer := 0;
BEGIN
  FOR r IN SELECT id, approval_note, updated_at FROM public.companies WHERE approval_note IS NOT NULL LOOP
    PERFORM app_private.audit_write(
      'legacy', 'legacy.company_approval_note', 'ok', r.id,
      'company', r.id::text,
      jsonb_build_object('approval_note', r.approval_note), NULL,
      NULL, NULL, coalesce(r.updated_at, now()));
    v_moved := v_moved + 1;
  END LOOP;

  UPDATE public.companies SET approval_note = NULL WHERE approval_note IS NOT NULL;
  RAISE NOTICE '20260916130020: % approval note(s) moved into the platform audit log', v_moved;
END $$;

-- The column stays so the previous release keeps selecting it; it is simply
-- always empty. A platform decision is recorded by platform_company_set_approval
-- (20260916130000), which writes the decision, its reason and its actor into the
-- audit log. Clearing rather than raising: nothing writes this column, and a
-- refusal would turn an unrelated UPDATE that happens to carry it into an error.
CREATE OR REPLACE FUNCTION app_private.companies_clear_approval_note()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.approval_note := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_clear_approval_note ON public.companies;
CREATE TRIGGER companies_clear_approval_note
  BEFORE INSERT OR UPDATE OF approval_note ON public.companies
  FOR EACH ROW EXECUTE FUNCTION app_private.companies_clear_approval_note();

REVOKE ALL ON FUNCTION app_private.companies_clear_approval_note() FROM PUBLIC, anon, authenticated, service_role;

-- ─── Every SECURITY DEFINER function in public gets a pinned search_path ────

-- ALTER FUNCTION … SET, not CREATE OR REPLACE: some of these bodies were created
-- outside version control and the migrations do not describe them, so nothing
-- here may rewrite one. `extensions` is included where it exists, because the
-- activation-code functions resolve pgcrypto's digest() through it.
DO $$
DECLARE
  r      record;
  v_path text := 'pg_catalog, public'
                 || CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions')
                         THEN ', extensions' ELSE '' END;
  v_list text[] := '{}';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%')
     ORDER BY 1
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %s', r.sig, v_path);
    v_list := v_list || r.sig::text;
  END LOOP;

  RAISE NOTICE '20260916130020: pinned search_path on % function(s): %',
    coalesce(array_length(v_list, 1), 0), coalesce(array_to_string(v_list, ', '), '—');
END $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────

-- As 20260915110000 left them: signed-in callers only.
REVOKE ALL ON FUNCTION public.preview_activation_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_activation_code(text) TO authenticated;

REVOKE ALL ON FUNCTION public.redeem_activation_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_activation_code(text) TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong text;
  v_n     integer;
BEGIN
  -- 1. No SECURITY DEFINER function in public is left without a pinned path.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_wrong
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916130020 self-check: SECURITY DEFINER without a pinned search_path: %', v_wrong;
  END IF;

  -- 2. discount_codes is readable through the platform's policy and nothing else.
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'discount_codes' AND cmd = 'SELECT'
     AND coalesce(qual, '') !~ 'platform_can';
  IF v_n > 0 THEN
    RAISE EXCEPTION '20260916130020 self-check: % SELECT polic(y/ies) on discount_codes do not ask platform_can', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'discount_codes' AND cmd = 'SELECT'
                    AND coalesce(qual, '') ~ 'platform_can') THEN
    RAISE EXCEPTION '20260916130020 self-check: the platform can no longer read discount_codes';
  END IF;

  -- 3. An attempt can only be written for the caller's own company.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'activation_code_attempts' AND cmd = 'INSERT'
                AND coalesce(with_check, '') !~ 'get_user_company_id') THEN
    RAISE EXCEPTION '20260916130020 self-check: activation_code_attempts still accepts an insert for any company';
  END IF;

  -- 4. Both activation-code functions: their grants, and no SQLERRM in either.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') THEN 'anon holds EXECUTE'
               WHEN NOT has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'authenticated lost EXECUTE'
               -- Comments stripped first: the bodies say in a comment why they
               -- never return the database's own message, and that sentence
               -- must not be what fails this check.
               WHEN regexp_replace((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)),
                                   '--[^\n]*', '', 'g') ~ 'SQLERRM'
                 THEN 'returns SQLERRM'
               WHEN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) !~ 'IS DISTINCT FROM'
                 THEN 'a binding comparison is not NULL-safe'
             END AS problem
        FROM (VALUES
          ('public.preview_activation_code(text)'),
          ('public.redeem_activation_code(text)')
        ) AS v(sig)
    ) f
   WHERE f.problem IS NOT NULL;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916130020 self-check: %', v_wrong;
  END IF;

  -- 5. Only a company administrator redeems.
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.redeem_activation_code(text)'::regprocedure)
       !~ 'v_caller_role.*<> ''admin''' THEN
    RAISE EXCEPTION '20260916130020 self-check: redeem_activation_code does not check for a company administrator';
  END IF;

  -- 6. The approval note is gone from every company row and stays gone.
  IF EXISTS (SELECT 1 FROM public.companies WHERE approval_note IS NOT NULL) THEN
    RAISE EXCEPTION '20260916130020 self-check: a company row still carries an approval note';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.companies'::regclass
                    AND tgname = 'companies_clear_approval_note'
                    AND NOT tgisinternal) THEN
    RAISE EXCEPTION '20260916130020 self-check: nothing keeps companies.approval_note empty';
  END IF;
END $$;
