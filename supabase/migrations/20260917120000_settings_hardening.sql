/*
  # The settings door: a bounded log, and a feature map that must be complete

  The two follow-ups the 3.9 and 3.5 reviews left behind. Nothing new is added
  to the product; two doors opened by `20260916150000_platform_settings_price_book.sql`
  are narrowed.

  ## 1. A settings read could append audit rows without limit

  `platform_audit_record`, the edge functions' door, caps one actor at 120 rows
  a minute (`20260916130000`, restated by
  `20260916150000_platform_audit_record_allowlist.sql`), and a refused platform
  write records at most 30 `denied` rows a minute
  (`app_private.platform_rpc_authorize`). `platform_settings_get` had neither:
  every call by any active staff role wrote a row, `read_only` included, and
  `read_only` holds `settings.read`. A loop over that RPC therefore grew the
  append-only log — which nothing may delete from — as fast as the network
  allowed.

  `app_private.platform_settings_rate_limited(actor)` gives both settings RPCs
  the shape 3.5 already uses: the same 120 rows a minute, the same count over
  `app_private.platform_audit_log` (served by `platform_audit_log_actor`), the
  same per-actor budget. One budget covers `platform_settings.get` and
  `platform_settings.put` together, as 3.5 counts every edge action against one.

  It differs from 3.5 in one way, deliberately. `platform_audit_record` *raises*
  when the cap is reached, because its caller is an edge function whose audit
  must fail closed. The settings RPCs answer with a return value —
  `{"ok": false, "reason": "rate_limited"}` — because that is their whole
  contract: outcomes are return values, and only a broken argument contract
  raises (`22023`). **The refusal writes no row.** A row for "you have written
  too many rows" is the exact row the cap exists to stop.

  The check sits after the staff-role lookup and before the capability check,
  so it covers every branch below it that appends — the `denied` of a refused
  capability included — and a caller who is not platform staff is still refused
  without a row, as before.

  ## 2. One write of a short feature map locked every gated screen

  `plan_features` maps a feature key to the lowest plan that unlocks it, and the
  browser reads **a feature the map does not name as premium**
  (`src/utils/planFeatures.ts`) — fail closed, so a build that knows a screen the
  database has not heard of locks it rather than opening it. That rule stays
  exactly as it is; it is the reason this one is needed.

  The validator accepted a partial map. Together the two meant that one owner
  write of `{}`, or of a map with a key dropped by a typo, would put every gated
  screen of every non-trial company on basic or advanced behind
  `LockedFeaturePage` — no error, no warning, and the screens would come back
  only after someone noticed and wrote the map again.

  So a written map must now name **every feature key the application knows**,
  listed in `app_private.plan_feature_keys()`. A shorter one is refused with
  `plan_features.missing.<the first missing key, in byte order>`, and
  `platform_settings_put` also returns `missing_features`, every missing key, so
  the settings screen (plan 3.6c) can say which ones to add. Extra keys stay
  valid: a database that already names a feature a future release will gate is
  how a key gets seeded before the release that reads it (CLAUDE.md, "Add a new
  gated feature").

  `plan_feature_keys()` is the sixteen `FeatureKey`s of
  `src/contexts/PlanContext.tsx`. `src/utils/planFeatures.test.ts` reads this
  file and fails when the two lists differ, the way `appConfigSeed.test.ts`
  pins the seeds; self-check 4 below fails the release if the seeded map does
  not satisfy the validator this file installs.

  ## What is deliberately not here

  `public.platform_audit_record` is **not** redefined. It is the one function
  two slices have already collided on, and its live definition
  (`20260916150000_platform_audit_record_allowlist.sql`) carries both the
  reserved namespaces and the action allow-list. This file sorts after it, so a
  `CREATE OR REPLACE` here would silently drop both. It needs no change: no
  `platform_settings` action is on the allow-list, so that door still cannot
  forge a settings row. Self-check 7 asserts it, as 20260916150000's self-check 8
  does.

  ## Money

  No price, percentage or amount is read, written or computed here. The price
  book's validator is untouched.

  ## Ownership

  Both RPCs are SECURITY DEFINER and reach `app_private`, so they are handed to
  the migration role, which owns the schema (20260916110010, "Ownership"). On
  the real databases many such functions belong to `postgres`, and
  `CREATE OR REPLACE` keeps that owner, so the `ALTER … OWNER TO CURRENT_USER`
  below is what actually moves them; self-check 2 fails the release if one is
  left with an owner that cannot reach `app_private`.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. No signature, grant or table
  changes. The previous release calls both RPCs with the same arguments and
  reads the same fields; `rate_limited` and `missing_features` are new values in
  answers it already treats as `ok = false`. The one behaviour that narrows is
  the feature map's validator, and the only writer of that key is an owner
  through `platform_settings_put` — no screen writes it today (plan 3.6c builds
  the settings screens), and the seeded map already satisfies it.
*/

-- ─── The feature keys the application knows ─────────────────────────────────

-- The FeatureKey union of src/contexts/PlanContext.tsx, in byte order. A new
-- gated feature is added here, in SEED_PLAN_FEATURES, and — because this list
-- makes it mandatory — written into the plan_features setting by the migration
-- that adds it, or no plan_features write will be accepted again until it is.
CREATE OR REPLACE FUNCTION app_private.plan_feature_keys()
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN ARRAY[
    'abrechnung',
    'bargeldbestand',
    'belege',
    'benachrichtigungen',
    'dokumente',
    'fahrer',
    'fahrzeuge',
    'fixkosten',
    'gehaelter',
    'notizen',
    'overview',
    'rollen_nutzer',
    'stundennachweis',
    'trinkgeld_quittung',
    'umsaetze',
    'werkstatt'
  ];
END;
$$;

-- Which of those keys a candidate map fails to name, in byte order. Anything
-- that is not an object names none of them.
CREATE OR REPLACE FUNCTION app_private.plan_features_missing_keys(p_value jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RETURN app_private.plan_feature_keys();
  END IF;
  RETURN coalesce((SELECT array_agg(k.key ORDER BY k.key COLLATE "C")
                     FROM unnest(app_private.plan_feature_keys()) AS k(key)
                    WHERE NOT (p_value ? k.key)),
                  ARRAY[]::text[]);
END;
$$;

-- ─── The validator: a feature map must be complete ──────────────────────────

-- 20260916150000's body, with one rule added at the end of the plan_features
-- branch. The price_book branch is unchanged, character for character.
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
  IF p_key IS NULL OR p_key NOT IN ('price_book', 'plan_features') THEN
    RETURN 'unknown_key';
  END IF;
  IF p_value IS NULL OR octet_length(p_value::text) > c_max_value_bytes THEN
    RETURN 'value_size';
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

-- ─── The per-actor cap on settings rows ─────────────────────────────────────

-- Whether this actor has already written its minute's worth of settings audit
-- rows. The limit is a CONSTANT in this one function, the only place that
-- enforces it. Reads and writes share one budget, as platform_audit_record
-- counts every edge action against one; the partial index
-- platform_audit_log_actor (actor_user_id, occurred_at) serves the count.
CREATE OR REPLACE FUNCTION app_private.platform_settings_rate_limited(p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_rows_per_minute CONSTANT integer := 120;
BEGIN
  -- No actor, no row to attribute. Both callers refuse such a caller before
  -- they reach this, and neither grants EXECUTE to anon.
  IF p_actor IS NULL THEN
    RETURN false;
  END IF;

  RETURN (SELECT count(*)
            FROM app_private.platform_audit_log l
           WHERE l.actor_user_id = p_actor
             AND l.occurred_at > now() - interval '1 minute'
             AND l.action IN ('platform_settings.get', 'platform_settings.put')) >= c_rows_per_minute;
END;
$$;

-- ─── The two RPCs, with the cap ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_settings_get(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text := app_private.platform_staff_role_of(auth.uid());
  v_row  app_private.platform_settings%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) > 100 OR p_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' THEN
    RAISE EXCEPTION 'platform_settings_get: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Not platform staff: refused, and not recorded (see the header).
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  -- Every branch below this one appends a row. An actor that has written its
  -- minute's worth is refused without one: recording this refusal would be the
  -- very row the cap exists to stop.
  IF app_private.platform_settings_rate_limited(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  -- Refused before the row is looked up, so a refusal says nothing about
  -- whether the key exists.
  IF NOT app_private.platform_settings_readable(v_role, p_key) THEN
    PERFORM app_private.audit_write('read', 'platform_settings.get', 'denied', NULL,
                                    'platform_setting', p_key);
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  SELECT * INTO v_row FROM app_private.platform_settings s WHERE s.key = p_key;
  IF NOT FOUND THEN
    PERFORM app_private.audit_write('read', 'platform_settings.get', 'error', NULL,
                                    'platform_setting', p_key, NULL,
                                    jsonb_build_object('reason', 'not_found'));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- The row names what was read, never the value itself.
  PERFORM app_private.audit_write('read', 'platform_settings.get', 'ok', NULL,
                                  'platform_setting', p_key, NULL,
                                  jsonb_build_object('version', v_row.version));

  RETURN jsonb_build_object(
    'ok',         true,
    'key',        v_row.key,
    'value',      v_row.value,
    'version',    v_row.version,
    'updated_at', v_row.updated_at,
    'updated_by', v_row.updated_by
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_settings_put(
  p_key              text,
  p_value            jsonb,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_role    text := app_private.platform_staff_role_of(auth.uid());
  v_problem text;
  v_reason  text;
  v_detail  jsonb;
  v_old     app_private.platform_settings%ROWTYPE;
  v_new     app_private.platform_settings%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) > 100 OR p_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
     OR p_value IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'platform_settings_put: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Not platform staff: refused, and not recorded (see the header).
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  -- The same budget as platform_settings_get, for the same reason.
  IF app_private.platform_settings_rate_limited(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  IF NOT app_private.platform_role_can(v_role, app_private.platform_setting_write_capability(p_key)) THEN
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'denied', NULL,
                                    'platform_setting', p_key);
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  v_problem := app_private.platform_settings_problem(p_key, p_value);
  IF v_problem IS NOT NULL THEN
    v_reason := CASE WHEN v_problem = 'unknown_key' THEN 'unknown_key' ELSE 'invalid_value' END;
    v_detail := jsonb_build_object('reason', v_reason, 'problem', v_problem);
    -- An incomplete feature map also says which keys are missing, so the
    -- settings screen can name them rather than make the owner diff the map.
    IF v_problem LIKE 'plan_features.missing.%' THEN
      v_detail := v_detail || jsonb_build_object(
        'missing_features', to_jsonb(app_private.plan_features_missing_keys(p_value)));
    END IF;
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'error', NULL,
                                    'platform_setting', p_key, NULL, v_detail);
    RETURN jsonb_build_object('ok', false) || v_detail;
  END IF;

  -- The lock serialises two saves of the same key, so both cannot pass the
  -- version check.
  SELECT * INTO v_old FROM app_private.platform_settings s WHERE s.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    -- Every key with a validator is seeded by the migration that adds the
    -- validator; this is a broken release, not a user error.
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'error', NULL,
                                    'platform_setting', p_key, NULL,
                                    jsonb_build_object('reason', 'not_found'));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_old.version IS DISTINCT FROM p_expected_version THEN
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'error', NULL,
                                    'platform_setting', p_key, NULL,
                                    jsonb_build_object('reason', 'version_conflict',
                                                       'expected_version', p_expected_version,
                                                       'current_version', v_old.version));
    RETURN jsonb_build_object('ok', false, 'reason', 'version_conflict', 'current_version', v_old.version);
  END IF;

  UPDATE app_private.platform_settings s
     SET value      = p_value,
         version    = s.version + 1,
         updated_by = v_uid,
         updated_at = now()
   WHERE s.key = p_key
  RETURNING * INTO v_new;

  PERFORM app_private.audit_write('settings', 'platform_settings.put', 'ok', NULL,
                                  'platform_setting', p_key,
                                  jsonb_build_object('version', v_old.version, 'value', v_old.value),
                                  jsonb_build_object('version', v_new.version, 'value', v_new.value));

  RETURN jsonb_build_object(
    'ok',         true,
    'key',        v_new.key,
    'value',      v_new.value,
    'version',    v_new.version,
    'updated_at', v_new.updated_at,
    'updated_by', v_new.updated_by
  );
END;
$$;

-- ─── Ownership ──────────────────────────────────────────────────────────────

-- CREATE OR REPLACE keeps whatever owner a function had, and on the real
-- databases that may be `postgres`, which reaches no app_private helper.
ALTER FUNCTION app_private.plan_feature_keys()                            OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.plan_features_missing_keys(jsonb)              OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_problem(text, jsonb)         OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_rate_limited(uuid)           OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_settings_get(text)                         OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_settings_put(text, jsonb, integer)         OWNER TO CURRENT_USER;

-- ─── Privileges ─────────────────────────────────────────────────────────────

-- Supabase's default privileges grant EXECUTE on every new function to PUBLIC,
-- anon, authenticated and service_role, so each one is revoked by name, and the
-- app_private helpers are granted to nobody: the schema's USAGE is the wall,
-- the REVOKE the second one.
REVOKE ALL ON FUNCTION app_private.plan_feature_keys()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.plan_features_missing_keys(jsonb)    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_problem(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_rate_limited(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Restated exactly as 20260916150000 left them: the platform's settings screens
-- (plan 3.6c), signed in.
REVOKE ALL ON FUNCTION public.platform_settings_get(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_settings_get(text) TO authenticated;

REVOKE ALL ON FUNCTION public.platform_settings_put(text, jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_settings_put(text, jsonb, integer) TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role    text;
  v_wrong   text;
  v_keys    text[];
  v_seed    jsonb;
  v_short   jsonb;
  v_src     text;
  v_sig     text;
  v_action  text;
BEGIN
  -- 1. Nobody the API authenticates as reaches the settings table or the schema.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE')
       OR has_table_privilege(v_role, 'app_private.platform_settings',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '20260917120000 self-check: % reaches app_private.platform_settings', v_role;
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
          -- signature                                                    definer anon   authn  service
          ('public.platform_settings_get(text)',                          true,   false, true,  false),
          ('public.platform_settings_put(text,jsonb,integer)',            true,   false, true,  false),
          ('app_private.plan_feature_keys()',                             false,  false, false, false),
          ('app_private.plan_features_missing_keys(jsonb)',               false,  false, false, false),
          ('app_private.platform_settings_problem(text,jsonb)',           false,  false, false, false),
          ('app_private.platform_settings_rate_limited(uuid)',            false,  false, false, false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260917120000 self-check: %', v_wrong;
  END IF;

  -- 3. The cap is in both bodies. A later redefinition that drops it — the way
  --    20260916140000 dropped platform_audit_record's allow-list — fails here.
  FOREACH v_sig IN ARRAY ARRAY['public.platform_settings_get(text)',
                               'public.platform_settings_put(text,jsonb,integer)'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF v_src !~ 'platform_settings_rate_limited' THEN
      RAISE EXCEPTION '20260917120000 self-check: % no longer checks the per-actor cap', v_sig;
    END IF;
    IF v_src !~ 'audit_write' THEN
      RAISE EXCEPTION '20260917120000 self-check: % no longer records anything', v_sig;
    END IF;
  END LOOP;

  -- 4. The seeded map satisfies the validator this file installs: it names
  --    every key the application knows. A release that adds a FeatureKey to
  --    plan_feature_keys() without writing it into the setting fails here
  --    rather than locking the screen for every customer.
  v_keys := app_private.plan_feature_keys();
  v_seed := app_private.platform_setting_value('plan_features');

  IF v_seed IS NULL THEN
    RAISE EXCEPTION '20260917120000 self-check: the plan_features setting is missing';
  END IF;
  IF app_private.platform_settings_problem('plan_features', v_seed) IS NOT NULL THEN
    RAISE EXCEPTION '20260917120000 self-check: the stored feature map is refused by the new validator: %',
      app_private.platform_settings_problem('plan_features', v_seed);
  END IF;
  IF array_length(v_keys, 1) <> 16
     OR v_keys IS DISTINCT FROM app_private.settings_object_keys(v_seed) THEN
    RAISE EXCEPTION '20260917120000 self-check: plan_feature_keys() and the stored feature map name different features';
  END IF;

  -- 5. A map that is one key short is refused, and named.
  v_short := v_seed - 'gehaelter';
  IF app_private.platform_settings_problem('plan_features', v_short)
     IS DISTINCT FROM 'plan_features.missing.gehaelter' THEN
    RAISE EXCEPTION '20260917120000 self-check: an incomplete feature map is still accepted (%)',
      coalesce(app_private.platform_settings_problem('plan_features', v_short), 'no problem reported');
  END IF;
  IF app_private.platform_settings_problem('plan_features', '{}'::jsonb) IS NULL THEN
    RAISE EXCEPTION '20260917120000 self-check: an empty feature map is still accepted';
  END IF;
  -- A key this build does not know stays valid: that is how a feature is seeded
  -- before the release that gates it.
  IF app_private.platform_settings_problem('plan_features',
       v_seed || '{"a_feature_of_a_later_release": "basic"}'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION '20260917120000 self-check: a complete map with an extra key should stay valid';
  END IF;

  -- 6. The price book's validator is untouched: today's book still passes, and
  --    the refusals 20260916150000 pinned still refuse.
  IF app_private.platform_settings_problem('price_book',
       app_private.platform_setting_value('price_book')) IS NOT NULL THEN
    RAISE EXCEPTION '20260917120000 self-check: the stored price book no longer validates';
  END IF;
  IF app_private.platform_settings_problem('price_book', '{}'::jsonb) IS DISTINCT FROM 'price_book'
     OR app_private.platform_settings_problem('seller', '{}'::jsonb) IS DISTINCT FROM 'unknown_key' THEN
    RAISE EXCEPTION '20260917120000 self-check: the price_book and unknown_key paths moved';
  END IF;

  -- 7. platform_audit_record is deliberately not redefined here, and still
  --    refuses to forge a settings row (20260916150000's self-check 8). Every
  --    check below its argument contract runs before the staff lookup, so each
  --    raises here too, where auth.uid() is NULL.
  FOREACH v_action IN ARRAY ARRAY['platform_settings.get', 'platform_settings.put'] LOOP
    BEGIN
      PERFORM public.platform_audit_record('read', v_action, 'ok');
      RAISE EXCEPTION '20260917120000 self-check: platform_audit_record accepts the forbidden action %', v_action;
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;   -- 22023: the refusal this pins
    END;
  END LOOP;
END $$;
