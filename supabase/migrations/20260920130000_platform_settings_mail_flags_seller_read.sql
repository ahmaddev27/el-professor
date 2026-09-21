/*
  # Settings: the mail sender and templates, the feature flags, and the invoice
  # reading the seller

  Plan 3.10, second half, and the settings half of plan 3.11 (section 3.E).
  Builds on `20260916150000_platform_settings_price_book.sql` (the settings
  table and its two RPCs), `20260917120000_settings_hardening.sql` (the
  per-actor cap, the complete-feature-map rule) and
  `20260919120000_platform_settings_seller_trial_invoice.sql` (the seller, the
  trial and the invoice defaults). `20260920130010` adds the announcements and
  teaches `get_app_config()` to return them and these flags.

  ## What this adds

  Six keys in `app_private.platform_settings`, each with its validator in this
  file, because `platform_settings_put` refuses a key it has no validator for:

  - **`mail.sender`** — `{"name": "El-Professor"}`: the display name in the
    From header of every mail the edge functions send (the one-time codes, the
    "address changed" notice, the activation codes). The seed is the value both
    hosts set today (`deploy/set-resend.sh` writes `SMTP_SENDER_NAME
    "El-Professor"`, and the compose default is the same), so nothing changes
    on deploy. **The address is not a setting**: it must sit on the domain
    Resend has verified, and a wrong one stops every mail, so it stays
    `SMTP_SENDER` in each `.env`. GoTrue's own templates keep GoTrue's sender
    name, which is an environment variable the database cannot reach.
  - **`mail.template.<purpose>`** for `signup_verify`, `password_reset`,
    `invite_activate` and `email_change` — the four code mails anybody still
    receives (`platform_login` has had no mail since the owner's decision of
    16.09.2026 that platform sign-in has no second step). Each is an
    *override*: any of `subject`, `heading`, `paragraphs` and — where the mail
    has one — `button`. **Each is seeded `{}`**, so every mail reads exactly as
    it does today until the owner changes a field; the default text lives in
    `supabase/functions/_shared/mail-template.ts`, and a field left out keeps
    following it.
  - **`feature_flags`** — `{}`: flag name to boolean. Nothing reads a flag yet;
    `useFlag(key)` (AppConfigContext) answers false for a flag the map does not
    name.

  And two readers:

  - **`public.platform_invoice_seller()`** — the invoice PDF's sender. Until now
    `SubscriptionBillingPage` read the `company_settings` of whichever company
    the signed-in platform account sat in (none, on both real databases), and
    the `seller` key sat unread. The invoice screen needs `companies.read` —
    every staff role holds it — while `platform_settings_get('seller')` needs
    `settings.read`, which billing holds for the prices alone and support not at
    all; so the three roles that download most invoices could not have read the
    sender printed on them. This reader asks exactly the capability that reads
    an invoice (`subscription_invoices_select`'s platform branch): whoever may
    read the invoice may read what is printed on it. It returns the value and
    nothing else, writes one audited `read` row per call, and shares the
    settings RPCs' per-actor budget.
  - **`public.mail_delivery_settings(purpose)`** — the sender and one mail's
    template, for the edge functions, with the service role only. It is not
    audited: its caller is the system mailing a code, not a platform actor, and
    it returns the owner's own wording.

  ## The rules a template may not break

  - **The code never appears in a subject.** The subject accepts no variable at
    all, `{code}` is not a variable anywhere (the layout draws the code in its
    own box), and six digits in a row are refused as `…subject.code`. The edge
    function checks once more at the moment it knows the code.
  - **A paragraph uses only its mail's variables**: `{email}` everywhere,
    `{company}` in the invitation, `{new_email}` in the address change. Any
    other brace is refused, so a placeholder can never reach a reader unfilled.
  - **An invalid template falls back to the default text.** The validator
    refuses one here; `buildOtpMail` refuses to read one there and sends the
    default wording instead. A code that never arrives locks somebody out.
  - No control characters anywhere: the plain-text part and the HTML part of
    one mail must say the same thing, and a line break inside a paragraph would
    be dropped by one and kept by the other.

  ## Capabilities

  All six keys are `settings.manage`, which plan 3.A gives the owner alone
  ("settings.manage (بائع، تجربة، إيميلات، إعلانات، ميزات)"). That falls out of
  `app_private.platform_setting_is_pricing()` unchanged: only `price_book` is a
  pricing key. Reading is `settings.read` — owner and read_only; billing holds it
  for the prices alone, support not at all.

  ## The per-actor budget

  `app_private.platform_settings_rate_limited` is restated to count the new
  actions in the same 120-rows-a-minute budget: `platform_settings.invoice_seller`
  here, and the three `platform_announcements.*` actions of `20260920130010`,
  named now so the budget is defined once. The rest of its body — the constant,
  the fail-closed answer for a NULL actor — is carried over unchanged.

  ## What is deliberately not redefined

  `public.platform_settings_get`, `public.platform_settings_put` and
  `public.platform_audit_record`, for the reason every settings slice has
  given: each carries rules a re-creation silently drops. The new actions are
  written by the database itself; `platform_audit_record`'s action allow-list
  names none of them, so that door cannot forge one — self-check 8 asserts it.

  `app_private.platform_settings_problem` *is* replaced, because a validator can
  only be added there. The price book and feature-map branches are carried over
  character for character from `20260919120000`, as is the dispatch of the three
  3.10 keys to `platform_settings_problem_3_10`; self-check 4 restates the rules
  those branches must still enforce.

  ## Money

  No price, percentage or amount is read, written or computed here.

  ## Compatibility

  Expansive; **no SCHEMA_EPOCH bump**. Six rows are added, one validator learns
  them, one limiter counts more actions, and two functions are new. The previous
  release calls nothing that changed; its edge functions send the default text
  under `SMTP_SENDER_NAME`, which is what the seeds say anyway.
*/

-- ─── Validators ─────────────────────────────────────────────────────────────

-- A single-line text value: a JSON string, not blank, within p_max characters,
-- with no control character. The template and sender rules share it.
CREATE OR REPLACE FUNCTION app_private.settings_plain_text_bad(p_value jsonb, p_max integer)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_text text;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
    RETURN true;
  END IF;
  v_text := p_value #>> '{}';
  RETURN btrim(v_text) = ''
      OR length(v_text) > p_max
      OR v_text ~ '[[:cntrl:]]';
END;
$$;

/*
  The sender and the four code-mail templates. The bounds are
  supabase/functions/_shared/mail-template.ts's; mail-template.test.ts beside it
  reads the constants below out of this file and fails when the two differ.
*/
CREATE OR REPLACE FUNCTION app_private.platform_settings_problem_mail(p_key text, p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The mails whose text may change, in byte order.
  c_purposes       CONSTANT text[]  := ARRAY['email_change', 'invite_activate', 'password_reset', 'signup_verify'];
  c_subject_max    CONSTANT integer := 150;
  c_heading_max    CONSTANT integer := 150;
  c_button_max     CONSTANT integer := 60;
  c_paragraph_max  CONSTANT integer := 1000;
  c_paragraphs_max CONSTANT integer := 5;
  c_sender_max     CONSTANT integer := 80;

  v_purpose text;
  v_allowed text[];
  v_vars    text[];
  v_text    text;
  v_rest    text;
  v_count   integer;
  v_index   integer;
BEGIN
  IF p_key = 'mail.sender' THEN
    IF app_private.settings_object_keys(p_value) IS DISTINCT FROM ARRAY['name'] THEN
      RETURN 'mail.sender';
    END IF;
    IF app_private.settings_plain_text_bad(p_value -> 'name', c_sender_max) THEN
      RETURN 'mail.sender.name';
    END IF;
    v_text := p_value ->> 'name';
    -- A display name that looks like an address ("support@bank.de" <noreply@…>)
    -- is how a mail pretends to come from somebody else; chr(92) is a backslash.
    IF v_text <> btrim(v_text) OR v_text ~ '[<>"@]' OR strpos(v_text, chr(92)) > 0 THEN
      RETURN 'mail.sender.name';
    END IF;
    RETURN NULL;
  END IF;

  IF left(p_key, 14) <> 'mail.template.' THEN
    RETURN 'unknown_key';
  END IF;
  v_purpose := substr(p_key, 15);
  IF v_purpose IS NULL OR NOT (v_purpose = ANY (c_purposes)) THEN
    RETURN 'unknown_key';
  END IF;

  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RETURN p_key;
  END IF;

  -- The address change has neither a button nor a link, so it takes no label.
  v_allowed := CASE WHEN v_purpose = 'email_change'
                    THEN ARRAY['heading', 'paragraphs', 'subject']
                    ELSE ARRAY['button', 'heading', 'paragraphs', 'subject'] END;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) AS k(key) WHERE NOT (k.key = ANY (v_allowed))) THEN
    RETURN p_key;
  END IF;

  v_vars := CASE v_purpose
              WHEN 'invite_activate' THEN ARRAY['email', 'company']
              WHEN 'email_change'    THEN ARRAY['email', 'new_email']
              ELSE ARRAY['email'] END;

  IF p_value ? 'subject' THEN
    IF app_private.settings_plain_text_bad(p_value -> 'subject', c_subject_max) THEN
      RETURN p_key || '.subject';
    END IF;
    v_text := p_value ->> 'subject';
    -- Mail providers log subjects and show them on lock screens.
    IF v_text ~* '[{][[:space:]]*code[[:space:]]*[}]' OR v_text ~ '[0-9]{6}' THEN
      RETURN p_key || '.subject.code';
    END IF;
    IF v_text ~ '[{}]' THEN
      RETURN p_key || '.subject';
    END IF;
  END IF;

  IF p_value ? 'heading' THEN
    IF app_private.settings_plain_text_bad(p_value -> 'heading', c_heading_max)
       OR (p_value ->> 'heading') ~ '[{}]' THEN
      RETURN p_key || '.heading';
    END IF;
  END IF;

  IF p_value ? 'paragraphs' THEN
    IF jsonb_typeof(p_value -> 'paragraphs') IS DISTINCT FROM 'array' THEN
      RETURN p_key || '.paragraphs';
    END IF;
    v_count := jsonb_array_length(p_value -> 'paragraphs');
    IF v_count < 1 OR v_count > c_paragraphs_max THEN
      RETURN p_key || '.paragraphs';
    END IF;
    FOR v_index IN 0 .. v_count - 1 LOOP
      IF app_private.settings_plain_text_bad(p_value -> 'paragraphs' -> v_index, c_paragraph_max) THEN
        RETURN p_key || '.paragraphs.' || v_index;
      END IF;
      -- Remove every variable this mail knows; a brace left over is either a
      -- variable it does not know or a stray one, and both would reach the
      -- reader unfilled.
      v_text := p_value -> 'paragraphs' ->> v_index;
      v_rest := regexp_replace(v_text, '[{](' || array_to_string(v_vars, '|') || ')[}]', '', 'g');
      IF v_rest ~ '[{}]' THEN
        RETURN p_key || '.paragraphs.' || v_index;
      END IF;
    END LOOP;
  END IF;

  IF p_value ? 'button' THEN
    IF app_private.settings_plain_text_bad(p_value -> 'button', c_button_max)
       OR (p_value ->> 'button') ~ '[{}]' THEN
      RETURN p_key || '.button';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- Flag name to boolean. src/lib/featureFlags.ts reads a map with the same rules.
CREATE OR REPLACE FUNCTION app_private.platform_settings_problem_flags(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_flags CONSTANT integer := 100;
  c_max_key   CONSTANT integer := 60;
  v_entry     record;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RETURN 'feature_flags';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_value)) > c_max_flags THEN
    RETURN 'feature_flags';
  END IF;
  FOR v_entry IN
    SELECT e.key, e.value FROM jsonb_each(p_value) AS e ORDER BY e.key COLLATE "C"
  LOOP
    IF length(v_entry.key) > c_max_key OR v_entry.key !~ '^[a-z][a-z0-9_]*$' THEN
      RETURN 'feature_flags.key';
    END IF;
    IF jsonb_typeof(v_entry.value) IS DISTINCT FROM 'boolean' THEN
      RETURN 'feature_flags.' || v_entry.key;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

/*
  20260919120000's body with two changes and no others: the key gate names the
  six new keys, and they are handed to the two validators above. The price_book
  and plan_features branches, and the dispatch of seller, trial and invoice to
  platform_settings_problem_3_10, are carried over character for character.
  Self-check 4 restates what each must still do.
*/
CREATE OR REPLACE FUNCTION app_private.platform_settings_problem(p_key text, p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_value_bytes CONSTANT integer := 16384;
  c_max_cents       CONSTANT integer := 1000000;   -- 10.000,00 € per car per month
  c_max_tiers       CONSTANT integer := 20;
  c_max_min_cars    CONSTANT integer := 100000;
  c_max_features    CONSTANT integer := 200;
  -- Open decision D11: the three plans are fixed until the owner decides
  -- otherwise, so a price book names exactly these, in byte order.
  c_plans           CONSTANT text[]  := ARRAY['advanced', 'basic', 'premium'];

  v_part    jsonb;
  v_tier    jsonb;
  v_plan    text;
  v_index   integer;
  v_prev    integer;
  v_entry   record;
  v_missing text[];
BEGIN
  IF p_key IS NULL
     OR p_key NOT IN ('price_book', 'plan_features', 'seller', 'trial', 'invoice',
                      'mail.sender',
                      'mail.template.signup_verify', 'mail.template.password_reset',
                      'mail.template.invite_activate', 'mail.template.email_change',
                      'feature_flags') THEN
    RETURN 'unknown_key';
  END IF;
  IF p_value IS NULL OR octet_length(p_value::text) > c_max_value_bytes THEN
    RETURN 'value_size';
  END IF;

  -- Plan 3.10, first half. Checked after the size limit above, so every key
  -- shares one bound on how much one row may hold.
  IF p_key IN ('seller', 'trial', 'invoice') THEN
    RETURN app_private.platform_settings_problem_3_10(p_key, p_value);
  END IF;

  -- Plan 3.10, second half, and plan 3.11's flags (20260920130000).
  IF p_key = 'mail.sender' OR left(p_key, 14) = 'mail.template.' THEN
    RETURN app_private.platform_settings_problem_mail(p_key, p_value);
  END IF;
  IF p_key = 'feature_flags' THEN
    RETURN app_private.platform_settings_problem_flags(p_value);
  END IF;

  IF p_key = 'price_book' THEN
    IF app_private.settings_object_keys(p_value)
       IS DISTINCT FROM ARRAY['fleet_discount_tiers', 'price_per_car_cents', 'yearly_discount_percent'] THEN
      RETURN 'price_book';
    END IF;

    v_part := p_value -> 'price_per_car_cents';
    IF app_private.settings_object_keys(v_part) IS DISTINCT FROM c_plans THEN
      RETURN 'price_book.price_per_car_cents';
    END IF;
    FOREACH v_plan IN ARRAY c_plans LOOP
      IF NOT app_private.settings_integer_between(v_part -> v_plan, 0, c_max_cents) THEN
        RETURN 'price_book.price_per_car_cents.' || v_plan;
      END IF;
    END LOOP;

    v_part := p_value -> 'fleet_discount_tiers';
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'array' THEN
      RETURN 'price_book.fleet_discount_tiers';
    END IF;
    IF jsonb_array_length(v_part) > c_max_tiers THEN
      RETURN 'price_book.fleet_discount_tiers';
    END IF;
    v_prev := 0;
    FOR v_index IN 0 .. jsonb_array_length(v_part) - 1 LOOP
      v_tier := v_part -> v_index;
      IF app_private.settings_object_keys(v_tier) IS DISTINCT FROM ARRAY['min_cars', 'percent'] THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      IF NOT app_private.settings_integer_between(v_tier -> 'min_cars', 1, c_max_min_cars)
         OR NOT app_private.settings_integer_between(v_tier -> 'percent', 0, 100) THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      -- Sorted by min_cars, strictly increasing, so the tier a car count
      -- reaches is never ambiguous.
      IF (v_tier ->> 'min_cars')::integer <= v_prev THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      v_prev := (v_tier ->> 'min_cars')::integer;
    END LOOP;

    IF NOT app_private.settings_integer_between(p_value -> 'yearly_discount_percent', 0, 100) THEN
      RETURN 'price_book.yearly_discount_percent';
    END IF;
    RETURN NULL;
  END IF;

  -- plan_features: feature key -> the minimum plan.
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RETURN 'plan_features';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_value)) > c_max_features THEN
    RETURN 'plan_features';
  END IF;
  FOR v_entry IN
    SELECT e.key, e.value FROM jsonb_each(p_value) AS e ORDER BY e.key COLLATE "C"
  LOOP
    IF length(v_entry.key) > 60 OR v_entry.key !~ '^[a-z][a-z0-9_]*$' THEN
      RETURN 'plan_features.key';
    END IF;
    IF jsonb_typeof(v_entry.value) IS DISTINCT FROM 'string'
       OR (v_entry.value #>> '{}') <> ALL (c_plans) THEN
      RETURN 'plan_features.' || v_entry.key;
    END IF;
  END LOOP;

  -- Every feature the application knows must be named. The browser reads a
  -- feature the map does not name as premium, so a short map would silently
  -- lock those screens for every non-trial company below premium. Reported
  -- after the shape checks above, so a bad value is still named as a bad value.
  -- Keys this build does not know stay valid: that is how a feature is seeded
  -- before the release that gates it.
  v_missing := app_private.plan_features_missing_keys(p_value);
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RETURN 'plan_features.missing.' || v_missing[1];
  END IF;

  RETURN NULL;
END;
$$;

-- ─── The six keys ───────────────────────────────────────────────────────────

-- supabase/functions/_shared/mail-template.test.ts parses these blocks out of
-- this file: the sender must be the SMTP_SENDER_NAME both hosts set, and every
-- template must be the empty override, so nothing changes on deploy.
INSERT INTO app_private.platform_settings (key, value) VALUES
  ('mail.sender', $seed_mail_sender$
{
  "name": "El-Professor"
}
$seed_mail_sender$::jsonb),
  ('mail.template.signup_verify',   $seed_mail_template$ {} $seed_mail_template$::jsonb),
  ('mail.template.password_reset',  $seed_mail_template$ {} $seed_mail_template$::jsonb),
  ('mail.template.invite_activate', $seed_mail_template$ {} $seed_mail_template$::jsonb),
  ('mail.template.email_change',    $seed_mail_template$ {} $seed_mail_template$::jsonb),
  ('feature_flags', $seed_feature_flags$ {} $seed_feature_flags$::jsonb);

-- ─── One budget for every settings action ───────────────────────────────────

-- The actions the per-actor budget counts. The three platform_announcements
-- actions are 20260920130010's; they are named here so the budget is defined in
-- one place.
CREATE OR REPLACE FUNCTION app_private.platform_settings_audit_actions()
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN ARRAY[
    'platform_settings.get',
    'platform_settings.put',
    'platform_settings.invoice_seller',
    'platform_announcements.list',
    'platform_announcements.save',
    'platform_announcements.delete'
  ];
END;
$$;

-- 20260917120000's body with one change: the action list is the helper above
-- rather than the two settings actions alone. The limit, and the answer "spent"
-- for a NULL actor, are carried over.
CREATE OR REPLACE FUNCTION app_private.platform_settings_rate_limited(p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_rows_per_minute CONSTANT integer := 120;
BEGIN
  -- No actor, no budget that can be counted, so the answer is "spent", never
  -- "untouched": a guard in app_private fails closed.
  IF p_actor IS NULL THEN
    RETURN true;
  END IF;

  RETURN (SELECT count(*)
            FROM app_private.platform_audit_log l
           WHERE l.actor_user_id = p_actor
             AND l.occurred_at > now() - interval '1 minute'
             AND l.action = ANY (app_private.platform_settings_audit_actions())) >= c_rows_per_minute;
END;
$$;

-- ─── The invoice's sender ───────────────────────────────────────────────────

/*
  The seller document, for the invoice PDF. companies.read is the capability
  that reads an invoice (subscription_invoices_select), and every staff role
  holds it, so whoever may read an invoice may read the sender printed on it.
  The shape of platform_settings_get: outcomes are return values; a caller who
  is not staff is refused without a row; the budget is checked before anything
  appends; the row names the version read, never the value.
*/
CREATE OR REPLACE FUNCTION public.platform_invoice_seller()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text := app_private.platform_staff_role_of(auth.uid());
  v_row  app_private.platform_settings%ROWTYPE;
BEGIN
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  IF app_private.platform_settings_rate_limited(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  IF NOT app_private.platform_role_can(v_role, 'companies.read') THEN
    PERFORM app_private.audit_write('read', 'platform_settings.invoice_seller', 'denied', NULL,
                                    'platform_setting', 'seller');
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  SELECT * INTO v_row FROM app_private.platform_settings s WHERE s.key = 'seller';
  -- A document the validator would refuse is not printed on a customer's
  -- invoice: the screen refuses to build the PDF instead.
  IF NOT FOUND OR app_private.platform_settings_problem('seller', v_row.value) IS NOT NULL THEN
    PERFORM app_private.audit_write('read', 'platform_settings.invoice_seller', 'error', NULL,
                                    'platform_setting', 'seller', NULL,
                                    jsonb_build_object('reason', 'not_found'));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  PERFORM app_private.audit_write('read', 'platform_settings.invoice_seller', 'ok', NULL,
                                  'platform_setting', 'seller', NULL,
                                  jsonb_build_object('version', v_row.version));

  RETURN jsonb_build_object('ok', true, 'value', v_row.value, 'version', v_row.version);
END;
$$;

-- ─── What the edge functions read before they send ──────────────────────────

/*
  The sender and, for a code mail, its template, as stored. The edge functions
  call it with the service role and validate both themselves
  (mail-template.ts): an unreadable value means the default, never a failed
  mail. p_purpose NULL asks for the sender alone.
*/
CREATE OR REPLACE FUNCTION public.mail_delivery_settings(p_purpose text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_purpose IS NOT NULL AND (length(p_purpose) > 60 OR p_purpose !~ '^[a-z][a-z0-9_]*$') THEN
    RAISE EXCEPTION 'mail_delivery_settings: invalid arguments' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'sender',   app_private.platform_setting_value('mail.sender'),
    'template', CASE WHEN p_purpose IS NULL THEN NULL
                     ELSE app_private.platform_setting_value('mail.template.' || p_purpose) END
  );
END;
$$;

-- ─── Ownership ──────────────────────────────────────────────────────────────

-- CREATE OR REPLACE keeps whatever owner a function had, and on the real
-- databases that may be `postgres`, which reaches no app_private helper.
ALTER FUNCTION app_private.settings_plain_text_bad(jsonb, integer)            OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_problem_mail(text, jsonb)        OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_problem_flags(jsonb)             OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_problem(text, jsonb)             OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_audit_actions()                  OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_rate_limited(uuid)               OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_seller()                               OWNER TO CURRENT_USER;
ALTER FUNCTION public.mail_delivery_settings(text)                            OWNER TO CURRENT_USER;

-- ─── Privileges ─────────────────────────────────────────────────────────────

-- Supabase's default privileges grant EXECUTE on every new function to PUBLIC,
-- anon, authenticated and service_role, so each one is revoked by name. Nobody
-- the API authenticates as holds USAGE on app_private; these REVOKEs are the
-- second wall.
REVOKE ALL ON FUNCTION app_private.settings_plain_text_bad(jsonb, integer)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_problem_mail(text, jsonb)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_problem_flags(jsonb)       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_problem(text, jsonb)       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_audit_actions()            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_rate_limited(uuid)         FROM PUBLIC, anon, authenticated, service_role;

-- The invoice screen, signed in.
REVOKE ALL ON FUNCTION public.platform_invoice_seller() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_invoice_seller() TO authenticated;

-- The edge functions, with the service role. "service_role only" means revoking
-- all three client roles (CLAUDE.md, "Every new function is executable by anon").
REVOKE ALL ON FUNCTION public.mail_delivery_settings(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mail_delivery_settings(text) TO service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role     text;
  v_wrong    text;
  v_seed     jsonb;
  v_src      text;
  v_sig      text;
  v_key      text;
  v_action   text;
  v_template jsonb;
BEGIN
  -- 1. Nobody the API authenticates as reaches the schema or the settings table.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE')
       OR has_table_privilege(v_role, 'app_private.platform_settings',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '20260920130000 self-check: % reaches app_private', v_role;
    END IF;
  END LOOP;

  -- 2. Every function this file created or replaced: SECURITY DEFINER where it
  --    should be, a pinned search_path, an owner that reaches app_private, and
  --    exactly the stated EXECUTE grants.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1
                        FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                                  definer anon   authn  service
          ('app_private.settings_plain_text_bad(jsonb,integer)',        false,  false, false, false),
          ('app_private.platform_settings_problem_mail(text,jsonb)',    false,  false, false, false),
          ('app_private.platform_settings_problem_flags(jsonb)',        false,  false, false, false),
          ('app_private.platform_settings_problem(text,jsonb)',         false,  false, false, false),
          ('app_private.platform_settings_audit_actions()',             false,  false, false, false),
          ('app_private.platform_settings_rate_limited(uuid)',          false,  false, false, false),
          ('public.platform_invoice_seller()',                          true,   false, true,  false),
          ('public.mail_delivery_settings(text)',                       true,   false, false, true)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920130000 self-check: %', v_wrong;
  END IF;

  -- 3. The six keys are seeded, at version 1, by nobody — and they are the only
  --    ones added. Every stored document passes its own validator.
  IF (SELECT count(*) FROM app_private.platform_settings
       WHERE key IN ('mail.sender', 'mail.template.signup_verify', 'mail.template.password_reset',
                     'mail.template.invite_activate', 'mail.template.email_change', 'feature_flags')
         AND version = 1 AND updated_by IS NULL) <> 6
     OR (SELECT count(*) FROM app_private.platform_settings) <> 11 THEN
    RAISE EXCEPTION '20260920130000 self-check: the six new keys are not the only ones added';
  END IF;

  SELECT string_agg(format('%s: %s', s.key, app_private.platform_settings_problem(s.key, s.value)), ', ')
    INTO v_wrong
    FROM app_private.platform_settings s
   WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920130000 self-check: a stored setting is refused by its own validator: %', v_wrong;
  END IF;

  IF app_private.platform_setting_value('mail.sender') IS DISTINCT FROM '{"name": "El-Professor"}'::jsonb
     OR app_private.platform_setting_value('feature_flags') IS DISTINCT FROM '{}'::jsonb
     OR EXISTS (SELECT 1 FROM app_private.platform_settings s
                 WHERE left(s.key, 14) = 'mail.template.' AND s.value IS DISTINCT FROM '{}'::jsonb) THEN
    RAISE EXCEPTION '20260920130000 self-check: a seed is not the value that keeps every mail and screen as it was';
  END IF;

  -- 4. The rules the earlier settings migrations installed survive the copy of
  --    platform_settings_problem, so a botched copy fails here and not on a
  --    customer's screen.
  v_seed := app_private.platform_setting_value('plan_features');
  IF app_private.platform_settings_problem('plan_features', v_seed) IS NOT NULL
     OR app_private.platform_settings_problem('plan_features', v_seed - 'gehaelter')
          IS DISTINCT FROM 'plan_features.missing.gehaelter'
     OR app_private.platform_settings_problem('plan_features', '{}'::jsonb) IS NULL
     OR app_private.platform_settings_problem('plan_features',
          v_seed || '{"a_feature_of_a_later_release": "basic"}'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION '20260920130000 self-check: the complete-feature-map rule of 20260917120000 did not survive';
  END IF;

  IF app_private.platform_settings_problem('price_book', app_private.platform_setting_value('price_book')) IS NOT NULL
     OR app_private.platform_settings_problem('price_book', '{}'::jsonb) IS DISTINCT FROM 'price_book'
     OR app_private.platform_settings_problem('trial', '{"days": 0}'::jsonb) IS DISTINCT FROM 'trial.days'
     OR app_private.platform_settings_problem('seller', '{}'::jsonb) IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('invoice', '{}'::jsonb) IS DISTINCT FROM 'invoice'
     OR app_private.platform_settings_problem('mail.template.platform_login', '{}'::jsonb) IS DISTINCT FROM 'unknown_key'
     OR app_private.platform_settings_problem('mail.other', '{}'::jsonb) IS DISTINCT FROM 'unknown_key' THEN
    RAISE EXCEPTION '20260920130000 self-check: a branch of platform_settings_problem moved';
  END IF;

  -- 5. The new validators, at their edges.
  v_template := '{"subject": "Ihr Code – El-Professor", "heading": "Willkommen",
                  "paragraphs": ["Hallo {email}, willkommen bei {company}.", "Zweiter Absatz."],
                  "button": "Einladung annehmen"}'::jsonb;
  IF app_private.platform_settings_problem('mail.template.invite_activate', v_template) IS NOT NULL
     OR app_private.platform_settings_problem('mail.template.signup_verify', v_template)
          IS DISTINCT FROM 'mail.template.signup_verify.paragraphs.0'
     OR app_private.platform_settings_problem('mail.template.email_change', v_template)
          IS DISTINCT FROM 'mail.template.email_change'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Ihr Code {code}"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject.code'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Code 482915"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject.code'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Hallo {email}"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{paragraphs}', '["Ihr Code: {code}"]'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.paragraphs.0'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{paragraphs}', '[]'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.paragraphs'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{heading}', '"Zeile\neins"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.heading'
     OR app_private.platform_settings_problem('mail.sender', '{"name": "Support"}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('mail.sender', '{"name": "support@bank.de"}'::jsonb)
          IS DISTINCT FROM 'mail.sender.name'
     OR app_private.platform_settings_problem('mail.sender', '{"name": " El-Professor"}'::jsonb)
          IS DISTINCT FROM 'mail.sender.name'
     OR app_private.platform_settings_problem('feature_flags', '{"new_banner": true}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('feature_flags', '{"new_banner": "yes"}'::jsonb)
          IS DISTINCT FROM 'feature_flags.new_banner'
     OR app_private.platform_settings_problem('feature_flags', '{"New Banner": true}'::jsonb)
          IS DISTINCT FROM 'feature_flags.key' THEN
    RAISE EXCEPTION '20260920130000 self-check: a validator this file installs does not refuse what it must';
  END IF;

  -- 6. Who may write the six keys, and who may read them: settings.manage —
  --    owner only — and settings.read for owner and read_only. Billing holds
  --    settings.read for the prices alone.
  FOREACH v_key IN ARRAY ARRAY['mail.sender', 'mail.template.signup_verify', 'feature_flags'] LOOP
    IF app_private.platform_setting_write_capability(v_key) IS DISTINCT FROM 'settings.manage'
       OR app_private.platform_setting_is_pricing(v_key)
       OR app_private.platform_settings_readable('billing', v_key)
       OR app_private.platform_settings_readable('support', v_key)
       OR NOT app_private.platform_settings_readable('owner', v_key)
       OR NOT app_private.platform_settings_readable('read_only', v_key) THEN
      RAISE EXCEPTION '20260920130000 self-check: the authority over % is not the one plan 3.A states', v_key;
    END IF;
  END LOOP;

  -- Every staff role reads the invoice's sender: companies.read is held by all four.
  IF (SELECT count(DISTINCT m.role) FROM app_private.platform_capability_matrix() m
       WHERE m.capability = 'companies.read') <> 4 THEN
    RAISE EXCEPTION '20260920130000 self-check: companies.read is no longer every staff role''s, so the invoice screen and its sender disagree';
  END IF;

  -- 7. The budget counts every settings action, the old two included, and still
  --    answers "spent" for a caller it cannot count.
  IF NOT (app_private.platform_settings_audit_actions()
          @> ARRAY['platform_settings.get', 'platform_settings.put', 'platform_settings.invoice_seller',
                   'platform_announcements.list', 'platform_announcements.save', 'platform_announcements.delete'])
     OR app_private.platform_settings_rate_limited(NULL) IS NOT TRUE THEN
    RAISE EXCEPTION '20260920130000 self-check: the per-actor budget no longer covers every settings action';
  END IF;

  -- 8. Neither settings RPC was redefined, so both still carry the per-actor cap
  --    and their audit write; and platform_audit_record still refuses to forge a
  --    row under any action the database writes itself. Category 'read': a
  --    'settings' call would be refused on the category before the action
  --    allow-list — the rule this pins — is ever consulted.
  FOREACH v_sig IN ARRAY ARRAY['public.platform_settings_get(text)',
                               'public.platform_settings_put(text,jsonb,integer)'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF v_src !~ 'platform_settings_rate_limited' OR v_src !~ 'audit_write' THEN
      RAISE EXCEPTION '20260920130000 self-check: % has lost its cap or its audit row', v_sig;
    END IF;
  END LOOP;

  FOREACH v_action IN ARRAY app_private.platform_settings_audit_actions() LOOP
    BEGIN
      PERFORM public.platform_audit_record('read', v_action, 'ok');
      RAISE EXCEPTION '20260920130000 self-check: platform_audit_record accepts the forbidden action %', v_action;
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;   -- 22023: the refusal this pins
    END;
  END LOOP;

  -- 9. The delivery reader answers the seeds, and the sender alone for NULL.
  IF public.mail_delivery_settings('signup_verify')
       IS DISTINCT FROM '{"sender": {"name": "El-Professor"}, "template": {}}'::jsonb
     OR public.mail_delivery_settings(NULL)
       IS DISTINCT FROM '{"sender": {"name": "El-Professor"}, "template": null}'::jsonb
     OR public.mail_delivery_settings('platform_login') -> 'template' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION '20260920130000 self-check: mail_delivery_settings does not answer the seeded values';
  END IF;
END $$;
