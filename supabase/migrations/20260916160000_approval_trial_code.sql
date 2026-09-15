/*
  # The trial starts when its code is redeemed, and the code comes with the approval

  ## How the trial worked until now

  - signup_create_company wrote every self-signup as status 'trial', approval
    'pending', subscription 'inactive', trial_start = now and
    trial_end = now + 14 days.
  - PlanContext counts a company as in its trial while trial_end lies in the
    future, whatever its status: the effective plan is premium. Once trial_end
    has passed and status is still 'trial', every plan-gated feature but the
    overview is locked.
  - SubscriptionGuard (App.tsx) keeps an approved company on /abo-aktivieren
    until subscription_status is 'active' and not expired. The trial fields
    never opened it: a trial company still needed a subscription code, read
    out by a platform admin and valid for 2 minutes.
  - The database enforces neither. No policy and no function reads trial_start,
    trial_end or subscription_status to decide access.

  So the 14 days ran from signup, including the days spent waiting for
  approval, and a trial on its own let nobody in.

  ## What this changes

  1. signup_create_company leaves trial_start and trial_end NULL. Nothing else
     about it changes.
  2. activation_codes accepts duration_type 'testphase', the trial code:
     - bound to one company and used at most once; a company holds at most one
       open and at most one used trial code (partial unique indexes);
     - no redemption window. expires_at is 'infinity': the code stays valid
       until it is redeemed or revoked, by a resend or by a platform admin. The
       2-minute window exists for codes read out live, and an emailed code
       cannot meet it.
  3. company_approve (service_role) sets the approval fields exactly as
     SuperAdminDashboard's handleApprove did. For a trial signup whose trial
     has not started, that holds no active subscription and never redeemed a
     trial code, it creates the trial code in the same transaction.
  4. company_resend_trial_code (service_role) revokes a company's open trial
     code and creates a new one.
  5. redeem_activation_code, for a trial code: only an active admin of its
     company, once; trial_start = now, trial_end = now + trial_length(), and
     companies.trial_activation_code_id. No subscription field is written.
  6. preview_activation_code says that a trial code starts the trial, and for
     how many days.
  7. companies.trial_activation_code_id marks a trial that came from a code.
     SubscriptionGuard admits such a company until trial_end: the smallest
     change that lets the emailed code open the app. A trial without a code
     still needs a subscription, as before.

  The trial's length is one constant, app_private.trial_length(). Redemption
  applies it; the approval mail and the preview report it.

  ## Existing companies

  No row is updated. A company whose trial started at signup keeps its dates,
  is given no trial code on approval (its trial_start is set), and
  SubscriptionGuard treats it as before.

  ## Also, in the two redefined activation-code functions

  - search_path is pinned to pg_catalog, public, and the hash uses the
    built-in sha256() (same bytes as pgcrypto's digest for six ASCII digits),
    so the functions no longer depend on the extensions schema;
  - six digits allow two rows with the same hash, and the lookup took an
    arbitrary one. It now prefers the caller's own company, then a live code,
    then the newest;
  - the company and e-mail bindings compare with IS DISTINCT FROM. With `<>` a
    caller whose profile had no company or no address passed them;
  - no function returns SQLERRM.

  ## Rollback

  Expand-only: a nullable column, a wider CHECK, two partial indexes, new
  functions, and three replaced bodies whose signatures and result keys are
  unchanged. The previous release runs against it: its approve button writes
  the approval fields directly and creates no code, so a company approved
  during a rollback gets no trial code and, as before, needs a subscription
  code. deploy/SCHEMA_EPOCH is not bumped.

  Rules as in 20260915100100: plpgsql, SECURITY DEFINER where a caller needs
  it, pinned search_path, service_role only for the new RPCs, 22023 for a
  broken argument contract, outcomes as return values.
*/

-- ─── Schema ─────────────────────────────────────────────────────────────────

ALTER TABLE public.activation_codes
  DROP CONSTRAINT activation_codes_duration_type_check,
  ADD CONSTRAINT activation_codes_duration_type_check
    CHECK (duration_type IN ('1_monat', '3_monate', '1_jahr', 'benutzerdefiniert', 'testphase'));

CREATE UNIQUE INDEX IF NOT EXISTS activation_codes_one_open_trial_code
  ON public.activation_codes (company_id)
  WHERE duration_type = 'testphase' AND status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS activation_codes_one_used_trial_code
  ON public.activation_codes (company_id)
  WHERE duration_type = 'testphase' AND status = 'used';

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS trial_activation_code_id uuid
    REFERENCES public.activation_codes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.companies.trial_activation_code_id IS
  'The trial code whose redemption started this trial. NULL for a trial that started at signup (before 20260916160000) and for a company without a trial.';

-- ─── app_private.trial_length ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.trial_length()
RETURNS interval
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_trial_length CONSTANT interval := interval '14 days';
BEGIN
  RETURN c_trial_length;
END;
$$;

-- ─── app_private.company_admin_emails ───────────────────────────────────────

-- Who receives the approval mail: the company's admins whose address is
-- confirmed and whose account can sign in. A pending_invite owner has not
-- proved the address yet, and mail must not go to an unproved address.
CREATE OR REPLACE FUNCTION app_private.company_admin_emails(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_emails jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(DISTINCT lower(u.email)), '[]'::jsonb) INTO v_emails
    FROM public.user_profiles up
    JOIN auth.users u ON u.id = up.user_id
   WHERE up.company_id = p_company_id
     AND up.role = 'admin'
     AND up.status = 'active'
     AND up.is_super_admin IS NOT TRUE
     AND coalesce(u.email, '') <> ''
     AND u.email_confirmed_at IS NOT NULL
     AND u.deleted_at IS NULL
     AND (u.banned_until IS NULL OR u.banned_until <= now());

  RETURN v_emails;
END;
$$;

-- ─── app_private.issue_trial_code ───────────────────────────────────────────

-- Revokes the company's open trial code and inserts a new one. Returns false,
-- having written nothing, when the hash already exists in any state: the
-- caller draws another code. Callers hold the company row lock.
CREATE OR REPLACE FUNCTION app_private.issue_trial_code(
  p_company_id    uuid,
  p_actor_user_id uuid,
  p_code_hash     text,
  p_code_last4    text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.activation_codes ac WHERE ac.code_hash = p_code_hash) THEN
    RETURN false;
  END IF;

  UPDATE public.activation_codes
     SET status = 'revoked', revoked_at = now(), revoked_by = p_actor_user_id
   WHERE company_id = p_company_id
     AND duration_type = 'testphase'
     AND status = 'active';

  INSERT INTO public.activation_codes
    (code_hash, code_last4, company_id, duration_type, expires_at, created_by, status)
  VALUES
    (p_code_hash, p_code_last4, p_company_id, 'testphase', 'infinity', p_actor_user_id, 'active');

  RETURN true;
END;
$$;

-- ─── app_private.redeem_trial_code ──────────────────────────────────────────

-- The trial branch of redeem_activation_code, which has already identified
-- the caller, checked the format and the attempt limit, and found the code.
CREATE OR REPLACE FUNCTION app_private.redeem_trial_code(
  p_code_id           uuid,
  p_caller_id         uuid,
  p_caller_company_id uuid,
  p_input_last4       text
)
RETURNS json
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_code      public.activation_codes%ROWTYPE;
  v_company   public.companies%ROWTYPE;
  v_now       timestamptz := now();
  v_trial_end timestamptz;
BEGIN
  SELECT * INTO v_code FROM public.activation_codes ac WHERE ac.id = p_code_id;

  -- Another company's trial code answers exactly like a code that does not
  -- exist, so it tells a caller nothing.
  IF NOT FOUND OR v_code.company_id IS DISTINCT FROM p_caller_company_id THEN
    INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (p_caller_company_id, p_caller_id, p_input_last4, false, 'Falsches Unternehmen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist ungültig.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = p_caller_id
                    AND up.company_id = v_code.company_id
                    AND up.role = 'admin'
                    AND up.status = 'active'
                    AND up.is_super_admin IS NOT TRUE) THEN
    INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (p_caller_company_id, p_caller_id, p_input_last4, false, 'Kein Administrator');
    RETURN json_build_object('success', false,
      'error', 'Nur ein Administrator des Unternehmens kann die Testphase starten.');
  END IF;

  -- Company first, then the code: the order company_approve and
  -- company_resend_trial_code lock them in.
  SELECT * INTO v_company FROM public.companies c WHERE c.id = v_code.company_id FOR UPDATE;
  SELECT * INTO v_code FROM public.activation_codes ac WHERE ac.id = p_code_id FOR UPDATE;

  IF v_code.status = 'used' THEN
    INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (p_caller_company_id, p_caller_id, p_input_last4, false, 'Bereits verwendet');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde bereits verwendet.');
  END IF;

  IF v_code.status = 'revoked' OR v_code.deleted_at IS NOT NULL THEN
    INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (p_caller_company_id, p_caller_id, p_input_last4, false, 'Widerrufen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde widerrufen.');
  END IF;

  IF v_code.status IS DISTINCT FROM 'active' THEN
    INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (p_caller_company_id, p_caller_id, p_input_last4, false, 'Abgelaufen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist abgelaufen.');
  END IF;

  IF v_company.approval_status IS DISTINCT FROM 'approved' THEN
    INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (p_caller_company_id, p_caller_id, p_input_last4, false, 'Nicht freigeschaltet');
    RETURN json_build_object('success', false, 'error', 'Ihr Unternehmen ist nicht freigeschaltet.');
  END IF;

  IF v_company.trial_start IS NOT NULL OR v_company.trial_activation_code_id IS NOT NULL THEN
    INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (p_caller_company_id, p_caller_id, p_input_last4, false, 'Testphase bereits gestartet');
    RETURN json_build_object('success', false,
      'error', 'Die Testphase dieses Unternehmens wurde bereits gestartet.');
  END IF;

  UPDATE public.activation_codes
     SET status = 'used', used_at = v_now, used_by = p_caller_id, used_company_id = v_code.company_id
   WHERE id = p_code_id;

  -- The fields signup wrote before 20260916160000, and nothing else: no
  -- subscription status, period or duration type.
  UPDATE public.companies
     SET trial_start              = v_now,
         trial_end                = v_now + app_private.trial_length(),
         trial_activation_code_id = p_code_id,
         updated_at               = v_now
   WHERE id = v_code.company_id
  RETURNING trial_end INTO v_trial_end;

  INSERT INTO public.activation_code_attempts(company_id, user_id, input_last4, success, reason)
  VALUES (p_caller_company_id, p_caller_id, p_input_last4, true, 'OK');

  RETURN json_build_object(
    'success',     true,
    'kind',        'trial',
    'trial_start', v_now,
    'trial_end',   v_trial_end
  );
END;
$$;

-- ─── company_approve ────────────────────────────────────────────────────────

-- Called by the company-approval function after it has verified the caller as
-- a platform admin. The code is generated there; only its hash arrives here.
CREATE OR REPLACE FUNCTION public.company_approve(
  p_company_id    uuid,
  p_actor_user_id uuid,
  p_code_hash     text,
  p_code_last4    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company    public.companies%ROWTYPE;
  v_now        timestamptz := now();
  v_trial_code boolean;
BEGIN
  IF p_company_id IS NULL
     OR p_actor_user_id IS NULL
     OR coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_code_last4, '') !~ '^[0-9]{4}$'
  THEN
    RAISE EXCEPTION 'company_approve: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = p_actor_user_id AND up.is_super_admin IS TRUE) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  SELECT * INTO v_company FROM public.companies c WHERE c.id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- A second click, or two admins at once: the first approval stands, and no
  -- second code or mail follows.
  IF v_company.approval_status = 'approved' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_approved', true, 'code_created', false,
      'company_name', v_company.name,
      'trial_days', (extract(epoch FROM app_private.trial_length()) / 86400)::integer,
      'recipients', '[]'::jsonb
    );
  END IF;

  v_trial_code := coalesce(
        v_company.status = 'trial'
    AND v_company.trial_start IS NULL
    AND v_company.trial_end IS NULL
    AND v_company.trial_activation_code_id IS NULL
    AND NOT (v_company.subscription_status = 'active'
             AND (v_company.subscription_expires_at IS NULL OR v_company.subscription_expires_at > v_now))
    AND NOT EXISTS (SELECT 1 FROM public.activation_codes ac
                     WHERE ac.company_id = p_company_id
                       AND ac.duration_type = 'testphase'
                       AND ac.status = 'used'),
    false);

  -- Nested rather than `v_trial_code AND NOT issue_trial_code(...)`: SQL does
  -- not promise to skip the call, and the call writes.
  IF v_trial_code THEN
    IF NOT app_private.issue_trial_code(p_company_id, p_actor_user_id, p_code_hash, p_code_last4) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'code_collision');
    END IF;
  END IF;

  -- Exactly the fields SuperAdminDashboard's handleApprove wrote.
  UPDATE public.companies
     SET approval_status  = 'approved',
         approved_at      = v_now,
         approved_by      = p_actor_user_id,
         rejection_reason = NULL,
         updated_at       = v_now
   WHERE id = p_company_id;

  RETURN jsonb_build_object(
    'ok', true, 'already_approved', false, 'code_created', v_trial_code,
    'company_name', v_company.name,
    'trial_days', (extract(epoch FROM app_private.trial_length()) / 86400)::integer,
    'recipients', app_private.company_admin_emails(p_company_id)
  );
END;
$$;

-- ─── company_resend_trial_code ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.company_resend_trial_code(
  p_company_id    uuid,
  p_actor_user_id uuid,
  p_code_hash     text,
  p_code_last4    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company public.companies%ROWTYPE;
BEGIN
  IF p_company_id IS NULL
     OR p_actor_user_id IS NULL
     OR coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_code_last4, '') !~ '^[0-9]{4}$'
  THEN
    RAISE EXCEPTION 'company_resend_trial_code: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_profiles up
                  WHERE up.user_id = p_actor_user_id AND up.is_super_admin IS TRUE) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  SELECT * INTO v_company FROM public.companies c WHERE c.id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_company.approval_status IS DISTINCT FROM 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_approved');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.activation_codes ac
                  WHERE ac.company_id = p_company_id
                    AND ac.duration_type = 'testphase'
                    AND ac.status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_open_trial_code');
  END IF;

  IF NOT app_private.issue_trial_code(p_company_id, p_actor_user_id, p_code_hash, p_code_last4) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'code_collision');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'code_created', true,
    'company_name', v_company.name,
    'trial_days', (extract(epoch FROM app_private.trial_length()) / 86400)::integer,
    'recipients', app_private.company_admin_emails(p_company_id)
  );
END;
$$;

-- ─── redeem_activation_code ─────────────────────────────────────────────────

-- The subscription path is 20260621120417's, changed only as the header says.
CREATE OR REPLACE FUNCTION public.redeem_activation_code(input_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id     uuid;
  v_company_id    uuid;
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

  SELECT company_id INTO v_company_id
  FROM user_profiles
  WHERE user_id = v_caller_id
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Kein Unternehmenskonto gefunden.');
  END IF;

  v_clean_code := trim(regexp_replace(coalesce(input_code, ''), '\s', '', 'g'));

  IF v_clean_code !~ '^[0-9]{6}$' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Ungültiges Format');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode muss genau 6 Ziffern haben.');
  END IF;

  SELECT COUNT(*) INTO v_attempt_count
  FROM activation_code_attempts
  WHERE company_id = v_company_id
    AND success = false
    AND created_at > now() - INTERVAL '15 minutes';

  IF v_attempt_count >= 10 THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Rate limit');
    RETURN json_build_object('success', false, 'error', 'Zu viele Versuche. Bitte warten Sie 15 Minuten.');
  END IF;

  v_code_hash := encode(sha256(convert_to(v_clean_code, 'UTF8')), 'hex');

  SELECT * INTO v_code
  FROM activation_codes ac
  WHERE ac.code_hash = v_code_hash
  ORDER BY (ac.company_id IS NOT DISTINCT FROM v_company_id) DESC,
           (ac.status = 'active' AND ac.expires_at > now()) DESC,
           ac.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Nicht gefunden');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist ungültig.');
  END IF;

  -- A trial code never reaches the subscription path below, whose CASE would
  -- turn an unknown duration into a month.
  IF v_code.duration_type = 'testphase' THEN
    RETURN app_private.redeem_trial_code(v_code.id, v_caller_id, v_company_id, right(v_clean_code, 4));
  END IF;

  IF v_code.status = 'used' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Bereits verwendet');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde bereits verwendet.');
  END IF;

  IF v_code.status = 'revoked' THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Widerrufen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode wurde widerrufen.');
  END IF;

  IF v_code.expires_at < now() OR v_code.status = 'expired' THEN
    UPDATE activation_codes SET status = 'expired' WHERE id = v_code.id AND status = 'active';
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Abgelaufen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode ist abgelaufen.');
  END IF;

  IF v_code.company_id IS NOT NULL AND v_code.company_id IS DISTINCT FROM v_company_id THEN
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsches Unternehmen');
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
  END IF;

  IF v_code.target_email IS NOT NULL THEN
    DECLARE
      v_caller_email text;
    BEGIN
      SELECT email INTO v_caller_email FROM user_profiles WHERE user_id = v_caller_id LIMIT 1;
      IF lower(v_caller_email) IS DISTINCT FROM lower(v_code.target_email) THEN
        INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
        VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Falsche E-Mail');
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
    INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
    VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), false, 'Race condition');
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

  INSERT INTO activation_code_attempts(company_id, user_id, input_last4, success, reason)
  VALUES (v_company_id, v_caller_id, right(v_clean_code, 4), true, 'OK');

  RETURN json_build_object(
    'success',                  true,
    'subscription_expires_at',  v_new_expiry
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', 'Interner Fehler. Bitte versuchen Sie es erneut.');
END;
$$;

-- ─── preview_activation_code ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.preview_activation_code(input_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id    uuid;
  v_company_id   uuid;
  v_caller_email text;
  v_code_hash    text;
  v_code         activation_codes%ROWTYPE;
  v_clean_code   text;
  v_seconds_rem  integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nicht authentifiziert.');
  END IF;

  SELECT company_id, email INTO v_company_id, v_caller_email
  FROM user_profiles
  WHERE user_id = v_caller_id
  LIMIT 1;

  v_clean_code := trim(regexp_replace(coalesce(input_code, ''), '\s', '', 'g'));

  IF v_clean_code !~ '^[0-9]{6}$' THEN
    RETURN json_build_object('success', false, 'error', 'Ungültiges Format.');
  END IF;

  v_code_hash := encode(sha256(convert_to(v_clean_code, 'UTF8')), 'hex');

  SELECT * INTO v_code
  FROM activation_codes ac
  WHERE ac.code_hash = v_code_hash
  ORDER BY (ac.company_id IS NOT DISTINCT FROM v_company_id) DESC,
           (ac.status = 'active' AND ac.expires_at > now()) DESC,
           ac.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode nicht gefunden.');
  END IF;

  IF v_code.duration_type = 'testphase' THEN
    IF v_code.company_id IS DISTINCT FROM v_company_id THEN
      RETURN json_build_object('success', false, 'error', 'Aktivierungscode nicht gefunden.');
    END IF;
    RETURN json_build_object(
      'success',           true,
      'kind',              'trial',
      'status',            CASE WHEN v_code.deleted_at IS NOT NULL THEN 'revoked' ELSE v_code.status END,
      'duration_type',     v_code.duration_type,
      'trial_days',        (extract(epoch FROM app_private.trial_length()) / 86400)::integer,
      'expires_at',        NULL,
      'seconds_remaining', NULL
    );
  END IF;

  -- Binding check: code locked to a specific company/email must match caller
  IF v_code.company_id IS NOT NULL AND v_code.company_id IS DISTINCT FROM v_company_id THEN
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu diesem Unternehmen.');
  END IF;

  IF v_code.target_email IS NOT NULL AND lower(v_caller_email) IS DISTINCT FROM lower(v_code.target_email) THEN
    RETURN json_build_object('success', false, 'error', 'Aktivierungscode gehört nicht zu dieser E-Mail.');
  END IF;

  v_seconds_rem := GREATEST(0, EXTRACT(EPOCH FROM (v_code.expires_at - now()))::integer);

  RETURN json_build_object(
    'success',           true,
    'status',            v_code.status,
    'expires_at',        v_code.expires_at,
    'duration_type',     v_code.duration_type,
    'seconds_remaining', v_seconds_rem
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', 'Fehler bei der Prüfung des Codes.');
END;
$$;

-- ─── signup_create_company ──────────────────────────────────────────────────

-- 20260915100200's body, except that trial_start and trial_end stay NULL: the
-- trial starts when the code sent with the approval is redeemed.
CREATE OR REPLACE FUNCTION public.signup_create_company(
  p_user_id       uuid,
  p_email         text,
  p_full_name     text,
  p_company_name  text,
  p_plan          text,
  p_billing_cycle text,
  p_car_limit     integer,
  p_referral_code text,
  p_discount_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_slug_attempts CONSTANT integer  := 10;

  v_email         text := lower(trim(p_email));
  v_full_name     text := trim(p_full_name);
  v_company_name  text := trim(p_company_name);
  v_ref_code      text := upper(trim(coalesce(p_referral_code, '')));
  v_now           timestamptz := now();
  v_plan          text;
  v_cycle         text;
  v_car_limit     integer;
  v_referral_id   uuid;
  v_ref_active    boolean;
  v_user          record;
  v_base_slug     text;
  v_company       public.companies%ROWTYPE;
  v_admin_role_id uuid;
BEGIN
  IF p_user_id IS NULL
     OR coalesce(v_email, '') = ''
     OR coalesce(v_full_name, '') = ''
     OR coalesce(v_company_name, '') = ''
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 1. The same normalization company-signup applied in TypeScript:
  --    Math.max(1, Math.min(100, Math.floor(Number(x) || 3))) — so 0 and a
  --    missing value both mean 3.
  v_plan      := CASE WHEN p_plan IN ('basic','advanced','premium') THEN p_plan ELSE 'basic' END;
  v_cycle     := CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END;
  v_car_limit := CASE WHEN coalesce(p_car_limit, 0) = 0 THEN 3
                      ELSE greatest(1, least(100, p_car_limit)) END;

  -- 2. Referral, before anything is written.
  IF v_ref_code <> '' THEN
    SELECT r.id, r.is_active INTO v_referral_id, v_ref_active
      FROM public.referrals r
     WHERE r.ref_code = v_ref_code;

    IF v_referral_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'referral_invalid');
    END IF;
    IF NOT v_ref_active THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'referral_inactive');
    END IF;
  END IF;

  -- 3. The account company-signup has just created: unconfirmed, the address
  --    the caller named, and not already attached to anything.
  SELECT u.id, u.email, u.email_confirmed_at INTO v_user
    FROM auth.users u
   WHERE u.id = p_user_id;

  IF NOT FOUND
     OR v_user.email_confirmed_at IS NOT NULL
     OR lower(v_user.email) IS DISTINCT FROM v_email
     OR EXISTS (SELECT 1 FROM app_private.pending_signups ps WHERE ps.user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.user_profiles up
                 WHERE up.user_id = p_user_id AND (up.company_id IS NOT NULL OR up.is_super_admin))
  THEN
    RAISE EXCEPTION 'signup_create_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 4. Slug: the TypeScript transliteration. Upper-case umlauts are mapped
  --    first because lower() only folds non-ASCII letters under a UTF-8
  --    ctype, while JavaScript's toLowerCase always does.
  v_base_slug := replace(replace(replace(replace(v_company_name, 'Ä', 'ä'), 'Ö', 'ö'), 'Ü', 'ü'), 'ẞ', 'ß');
  v_base_slug := lower(v_base_slug);
  v_base_slug := replace(replace(replace(replace(v_base_slug, 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
  v_base_slug := regexp_replace(v_base_slug, '[^a-z0-9]+', '-', 'g');
  v_base_slug := regexp_replace(v_base_slug, '^-|-$', '', 'g');
  v_base_slug := left(v_base_slug, 60);

  -- 5. The company. ON CONFLICT on the slug instead of a look-then-insert, so
  --    two signups with the same name cannot both pick the same free slug.
  --    trial_start and trial_end stay NULL until the trial code is redeemed.
  FOR i IN 1..c_slug_attempts LOOP
    INSERT INTO public.companies
      (name, slug, status, approval_status, plan, billing_cycle, subscription_car_limit,
       trial_start, trial_end, country, subscription_status,
       referral_id, referral_code_used, referred_at)
    VALUES
      (v_company_name,
       CASE WHEN i = 1 THEN v_base_slug
            ELSE v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6) END,
       'trial', 'pending', v_plan, v_cycle, v_car_limit,
       NULL, NULL, 'Deutschland', 'inactive',
       v_referral_id,
       CASE WHEN v_referral_id IS NOT NULL THEN v_ref_code END,
       CASE WHEN v_referral_id IS NOT NULL THEN v_now END)
    ON CONFLICT (slug) DO NOTHING
    RETURNING * INTO v_company;

    EXIT WHEN v_company.id IS NOT NULL;
  END LOOP;

  IF v_company.id IS NULL THEN
    RAISE EXCEPTION 'signup_create_company: no free slug';
  END IF;

  -- 6. The owner. pending_invite until the code is entered: an unconfirmed
  --    owner must not count as an active member of anything.
  SELECT r.id INTO v_admin_role_id
    FROM public.roles r
   WHERE r.name = 'admin' AND r.company_id IS NULL
   ORDER BY r.is_system DESC NULLS LAST, r.created_at
   LIMIT 1;

  INSERT INTO public.user_profiles
    (user_id, email, full_name, role, role_id, company_id, is_super_admin, status)
  VALUES
    (p_user_id, v_user.email, v_full_name, 'admin', v_admin_role_id, v_company.id, false, 'pending_invite')
  ON CONFLICT (user_id) DO UPDATE
    SET email          = EXCLUDED.email,
        full_name      = EXCLUDED.full_name,
        role           = EXCLUDED.role,
        role_id        = EXCLUDED.role_id,
        company_id     = EXCLUDED.company_id,
        is_super_admin = false,
        status         = 'pending_invite',
        updated_at     = now();

  -- 7.
  INSERT INTO public.company_settings (company_id, company_name)
  VALUES (v_company.id, v_company_name);

  INSERT INTO app_private.pending_signups (user_id, company_id, discount_code)
  VALUES (p_user_id, v_company.id, nullif(upper(trim(p_discount_code)), ''));

  -- 8. trial_end is kept in the result for company-signup's contract; it is
  --    NULL now.
  RETURN jsonb_build_object(
    'ok', true,
    'company', jsonb_build_object(
      'id',              v_company.id,
      'name',            v_company.name,
      'slug',            v_company.slug,
      'trial_end',       v_company.trial_end,
      'approval_status', v_company.approval_status
    )
  );
END;
$$;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION app_private.trial_length() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.company_admin_emails(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.issue_trial_code(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.redeem_trial_code(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.company_approve(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_approve(uuid, uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.company_resend_trial_code(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_resend_trial_code(uuid, uuid, text, text) TO service_role;

-- Signed-in users call these from ActivationPage, as before.
REVOKE ALL ON FUNCTION public.redeem_activation_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_activation_code(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.preview_activation_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_activation_code(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.signup_create_company(uuid, text, text, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_create_company(uuid, text, text, text, text, text, integer, text, text) TO service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

-- Fails the migration, and with it the release, if a function here came out
-- callable by a role that must not reach it, or without a pinned search_path.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.sig, to_regprocedure(v.sig) AS fn, v.definer, v.authenticated_may, v.service_role_may
      FROM (VALUES
        ('public.company_approve(uuid,uuid,text,text)',                                   true,  false, true),
        ('public.company_resend_trial_code(uuid,uuid,text,text)',                         true,  false, true),
        ('public.redeem_activation_code(text)',                                           true,  true,  true),
        ('public.preview_activation_code(text)',                                          true,  true,  true),
        ('public.signup_create_company(uuid,text,text,text,text,text,integer,text,text)', true,  false, true),
        ('app_private.trial_length()',                                                    false, false, false),
        ('app_private.company_admin_emails(uuid)',                                        false, false, false),
        ('app_private.issue_trial_code(uuid,uuid,text,text)',                             false, false, false),
        ('app_private.redeem_trial_code(uuid,uuid,uuid,text)',                            false, false, false)
      ) AS v(sig, definer, authenticated_may, service_role_may)
  LOOP
    IF r.fn IS NULL THEN
      RAISE EXCEPTION '20260916160000 self-check: % does not exist', r.sig;
    END IF;
    IF r.definer AND NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = r.fn::oid) THEN
      RAISE EXCEPTION '20260916160000 self-check: % is not SECURITY DEFINER', r.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                    WHERE p.oid = r.fn::oid AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20260916160000 self-check: % has no pinned search_path', r.sig;
    END IF;
    IF has_function_privilege('anon', r.fn::oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20260916160000 self-check: % is executable by anon', r.sig;
    END IF;
    IF has_function_privilege('authenticated', r.fn::oid, 'EXECUTE') IS DISTINCT FROM r.authenticated_may THEN
      RAISE EXCEPTION '20260916160000 self-check: authenticated EXECUTE on % is not %', r.sig, r.authenticated_may;
    END IF;
    IF has_function_privilege('service_role', r.fn::oid, 'EXECUTE') IS DISTINCT FROM r.service_role_may THEN
      RAISE EXCEPTION '20260916160000 self-check: service_role EXECUTE on % is not %', r.sig, r.service_role_may;
    END IF;
  END LOOP;

  IF has_schema_privilege('anon', 'app_private', 'USAGE')
     OR has_schema_privilege('authenticated', 'app_private', 'USAGE')
     OR has_schema_privilege('service_role', 'app_private', 'USAGE') THEN
    RAISE EXCEPTION '20260916160000 self-check: an API role has USAGE on app_private';
  END IF;
END $$;
