/*
  # Announcements, and the configuration that carries them and the flags

  Plan 3.11 (section 3.E). Builds on `20260920130000`, which added the
  `feature_flags` key and counts this file's three actions in the settings
  budget, and on `20260916150000`, whose `get_app_config()` has returned an
  empty `feature_flags` and an empty `announcements` since 3.9 so the browser's
  shape would not change now.

  ## What this adds

  - **`app_private.platform_announcements`** — one row per announcement: a tone
    (`info` or `warning`), a German title and body (required: German is the
    product's source language and the fallback), an English title and body
    (optional, both or neither; a blank one shows the German), an audience —
    every company, the companies on some plans, or named companies — and a
    validity window `[starts_at, ends_at)`, open-ended when `ends_at` is NULL.
  - **Three RPCs for the panel**, each audited, each inside the settings
    budget, each refusing by return value: `platform_announcements_list()`
    (`settings.read`, which billing holds for the prices alone and so does not
    get here), `platform_announcement_save(id, value, expected_version)` and
    `platform_announcement_delete(id, expected_version)` (`settings.manage`,
    owner only — plan 3.A lists announcements under it). A save or a delete
    carries the version the screen read, and a stale one writes nothing.
  - **`get_app_config()`** now returns the stored `feature_flags` and the
    announcements that apply to the caller's company now. Its other three
    parts — the price book, the feature map, the trial length — are carried over
    exactly.

  ## Whose company, and which announcements

  The caller's company is `get_active_company_id()`: the company whose business
  data the caller may touch. So a company the screens refuse — suspended,
  unapproved, unsubscribed — and an account that belongs to none are shown
  nothing, and a platform account inside a support session sees what the
  company it is looking at sees. "Every company" means every company, not every
  account: a platform account outside a session gets no announcement, because
  announcements are written for customers.

  An announcement applies when `starts_at <= now()` and `ends_at` is NULL or
  later than `now()`. **The window is two timestamps, never two dates.** A
  date compared with `current_date` means midnight in the database's zone
  (UTC here, and in the RLS kit) where the owner meant midnight in Berlin, and
  an announcement for "the 20th" would appear two hours late and vanish two
  hours early. So the validator accepts a time only with an explicit offset
  (`Z` or `+02:00`), and the cast from it cannot depend on the session's zone.

  A plan audience matches `companies.plan`, the stored plan billing assigns
  and the recompute derives (3.8) — not the premium a running trial is shown.

  ## What a tenant never sees

  `get_app_config()` returns an announcement's id, version, tone, texts and
  window, and **never its audience**: a list of company ids is who the platform's
  other customers are. `tests/rls/announcements.sql` pins the returned keys one
  by one.

  ## Refusals and the audit log

  The shape of `platform_settings_get` / `_put`: outcomes are return values; a
  caller without an active staff role is refused without a row; the budget is
  checked before anything appends, and its refusal writes nothing; a refused
  capability is recorded as `denied`; a valid caller's refused value as `error`
  naming the problem; an accepted save or delete as `settings`, with the row
  before and after. A list names how many rows it returned, never their text.

  ## Compatibility

  Expansive; **no SCHEMA_EPOCH bump**. One table and four functions are new, and
  `get_app_config()` keeps its signature, its grant and its five keys. The
  previous release reads `feature_flags` and `announcements` as the empty values
  it always got, whatever they now hold — `parseAppConfig` passed its fallback
  through for both.
*/

-- ─── The table ──────────────────────────────────────────────────────────────

CREATE TABLE app_private.platform_announcements (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tone                 text        NOT NULL CHECK (tone IN ('info', 'warning')),
  title_de             text        NOT NULL CHECK (btrim(title_de) <> '' AND length(title_de) <= 120),
  body_de              text        NOT NULL CHECK (btrim(body_de) <> '' AND length(body_de) <= 1000),
  -- '' means "show the German", and both are blank or neither is.
  title_en             text        NOT NULL DEFAULT '' CHECK (length(title_en) <= 120),
  body_en              text        NOT NULL DEFAULT '' CHECK (length(body_en) <= 1000),
  audience             text        NOT NULL CHECK (audience IN ('all', 'plans', 'companies')),
  audience_plans       text[]      NOT NULL DEFAULT '{}'
                                   CHECK (audience_plans <@ ARRAY['basic', 'advanced', 'premium']::text[]),
  -- No foreign key: a company may be deleted after it was named here, and the
  -- announcement then simply reaches nobody there. The save RPC refuses an id
  -- that does not exist at the time of writing.
  audience_company_ids uuid[]      NOT NULL DEFAULT '{}',
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NULL,
  version              integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- No foreign keys: whoever wrote an announcement may leave later. The audit
  -- log keeps every change.
  created_by           uuid        NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK ((btrim(title_en) = '') = (btrim(body_en) = '')),
  CHECK ((audience = 'plans')     = (cardinality(audience_plans) > 0)),
  CHECK ((audience = 'companies') = (cardinality(audience_company_ids) > 0))
);

-- get_app_config() asks for the rows whose window contains now().
CREATE INDEX platform_announcements_window ON app_private.platform_announcements (starts_at, ends_at);

REVOKE ALL ON TABLE app_private.platform_announcements FROM PUBLIC, anon, authenticated, service_role;

-- ─── The validator ──────────────────────────────────────────────────────────

/*
  What is wrong with an announcement document, as a short fixed path, or NULL
  when nothing is. src/lib/announcements.ts reads a form with the same rules
  and the same bounds, and names the same paths.

  STABLE, not IMMUTABLE: the text-to-timestamptz cast is STABLE. With the
  explicit offset the pattern requires, its result does not depend on the
  session's zone — which is the point of requiring it.
*/
CREATE OR REPLACE FUNCTION app_private.platform_announcement_problem(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_keys          CONSTANT text[]  := ARRAY['audience', 'body_de', 'body_en', 'company_ids', 'ends_at',
                                            'plans', 'starts_at', 'title_de', 'title_en', 'tone'];
  c_plans         CONSTANT text[]  := ARRAY['advanced', 'basic', 'premium'];
  c_title_max     CONSTANT integer := 120;
  c_body_max      CONSTANT integer := 1000;
  c_max_companies CONSTANT integer := 200;
  -- An ISO 8601 time WITH its offset. Without one the cast would read the
  -- wall-clock time in the session's zone.
  c_instant       CONSTANT text    :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$';
  c_uuid          CONSTANT text    :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_audience text;
  v_part     jsonb;
  v_count    integer;
  v_index    integer;
  v_start    timestamptz;
  v_end      timestamptz;
BEGIN
  IF app_private.settings_object_keys(p_value) IS DISTINCT FROM c_keys THEN
    RETURN 'announcement';
  END IF;

  IF jsonb_typeof(p_value -> 'tone') IS DISTINCT FROM 'string'
     OR NOT ((p_value ->> 'tone') = ANY (ARRAY['info', 'warning'])) THEN
    RETURN 'announcement.tone';
  END IF;

  IF app_private.settings_plain_text_bad(p_value -> 'title_de', c_title_max) THEN
    RETURN 'announcement.title_de';
  END IF;
  IF app_private.settings_plain_text_bad(p_value -> 'body_de', c_body_max) THEN
    RETURN 'announcement.body_de';
  END IF;

  -- English is optional, so blank is allowed here; the length and control
  -- characters are not.
  IF jsonb_typeof(p_value -> 'title_en') IS DISTINCT FROM 'string'
     OR length(p_value ->> 'title_en') > c_title_max
     OR (p_value ->> 'title_en') ~ '[[:cntrl:]]' THEN
    RETURN 'announcement.title_en';
  END IF;
  IF jsonb_typeof(p_value -> 'body_en') IS DISTINCT FROM 'string'
     OR length(p_value ->> 'body_en') > c_body_max
     OR (p_value ->> 'body_en') ~ '[[:cntrl:]]' THEN
    RETURN 'announcement.body_en';
  END IF;
  -- Half a translation shows an English title over a German body.
  IF (btrim(p_value ->> 'title_en') = '') <> (btrim(p_value ->> 'body_en') = '') THEN
    RETURN 'announcement.english';
  END IF;

  IF jsonb_typeof(p_value -> 'audience') IS DISTINCT FROM 'string'
     OR NOT ((p_value ->> 'audience') = ANY (ARRAY['all', 'plans', 'companies'])) THEN
    RETURN 'announcement.audience';
  END IF;
  v_audience := p_value ->> 'audience';

  v_part := p_value -> 'plans';
  IF jsonb_typeof(v_part) IS DISTINCT FROM 'array' THEN
    RETURN 'announcement.plans';
  END IF;
  v_count := jsonb_array_length(v_part);
  IF (v_audience = 'plans') <> (v_count > 0) OR v_count > 3 THEN
    RETURN 'announcement.plans';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_part) AS e(plan)
              WHERE jsonb_typeof(e.plan) IS DISTINCT FROM 'string'
                 OR NOT ((e.plan #>> '{}') = ANY (c_plans)))
     OR (SELECT count(DISTINCT e.plan) FROM jsonb_array_elements(v_part) AS e(plan)) <> v_count THEN
    RETURN 'announcement.plans';
  END IF;

  v_part := p_value -> 'company_ids';
  IF jsonb_typeof(v_part) IS DISTINCT FROM 'array' THEN
    RETURN 'announcement.company_ids';
  END IF;
  v_count := jsonb_array_length(v_part);
  IF (v_audience = 'companies') <> (v_count > 0) OR v_count > c_max_companies THEN
    RETURN 'announcement.company_ids';
  END IF;
  FOR v_index IN 0 .. v_count - 1 LOOP
    IF jsonb_typeof(v_part -> v_index) IS DISTINCT FROM 'string'
       OR (v_part ->> v_index) !~ c_uuid THEN
      RETURN 'announcement.company_ids.' || v_index;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT lower(e.id)) FROM jsonb_array_elements_text(v_part) AS e(id)) <> v_count THEN
    RETURN 'announcement.company_ids';
  END IF;

  IF jsonb_typeof(p_value -> 'starts_at') IS DISTINCT FROM 'string'
     OR (p_value ->> 'starts_at') !~ c_instant THEN
    RETURN 'announcement.starts_at';
  END IF;
  BEGIN
    v_start := (p_value ->> 'starts_at')::timestamptz;
  EXCEPTION
    WHEN data_exception THEN RETURN 'announcement.starts_at';   -- month 13, the 31st of June
  END;

  IF jsonb_typeof(p_value -> 'ends_at') = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value -> 'ends_at') IS DISTINCT FROM 'string'
     OR (p_value ->> 'ends_at') !~ c_instant THEN
    RETURN 'announcement.ends_at';
  END IF;
  BEGIN
    v_end := (p_value ->> 'ends_at')::timestamptz;
  EXCEPTION
    WHEN data_exception THEN RETURN 'announcement.ends_at';
  END;
  IF v_end <= v_start THEN
    RETURN 'announcement.ends_at';
  END IF;

  RETURN NULL;
END;
$$;

-- One row as the panel sees it: everything, audience included.
CREATE OR REPLACE FUNCTION app_private.platform_announcement_json(p_row app_private.platform_announcements)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'id',          p_row.id,
    'version',     p_row.version,
    'tone',        p_row.tone,
    'title_de',    p_row.title_de,
    'body_de',     p_row.body_de,
    'title_en',    p_row.title_en,
    'body_en',     p_row.body_en,
    'audience',    p_row.audience,
    'plans',       to_jsonb(p_row.audience_plans),
    'company_ids', to_jsonb(p_row.audience_company_ids),
    'starts_at',   p_row.starts_at,
    'ends_at',     p_row.ends_at,
    'created_at',  p_row.created_at,
    'created_by',  p_row.created_by,
    'updated_at',  p_row.updated_at,
    'updated_by',  p_row.updated_by
  );
END;
$$;

/*
  The announcements that apply to one company now, as a tenant receives them:
  no audience, newest start first, at most five. NULL company, none.
*/
CREATE OR REPLACE FUNCTION app_private.announcements_for_company(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_shown CONSTANT integer := 5;
  v_plan      text;
BEGIN
  IF p_company_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  v_plan := (SELECT c.plan FROM public.companies c WHERE c.id = p_company_id);

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id',        a.id,
             'version',   a.version,
             'tone',      a.tone,
             'title_de',  a.title_de,
             'body_de',   a.body_de,
             'title_en',  a.title_en,
             'body_en',   a.body_en,
             'starts_at', a.starts_at,
             'ends_at',   a.ends_at)
           ORDER BY a.starts_at DESC, a.id)
      FROM (SELECT x.*
              FROM app_private.platform_announcements x
             WHERE x.starts_at <= now()
               AND (x.ends_at IS NULL OR x.ends_at > now())
               AND (x.audience = 'all'
                    OR (x.audience = 'plans' AND v_plan IS NOT NULL AND v_plan = ANY (x.audience_plans))
                    OR (x.audience = 'companies' AND p_company_id = ANY (x.audience_company_ids)))
             ORDER BY x.starts_at DESC, x.id
             LIMIT c_max_shown) AS a
  ), '[]'::jsonb);
END;
$$;

-- ─── The panel's three RPCs ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_announcements_list()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_rows CONSTANT integer := 200;
  v_uid      uuid := auth.uid();
  v_role     text := app_private.platform_staff_role_of(auth.uid());
  v_items    jsonb;
BEGIN
  -- Not platform staff: refused, and not recorded.
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  IF app_private.platform_settings_rate_limited(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  -- settings.read, and billing holds it for the prices alone: the question
  -- platform_settings_get asks, for a key that is not a price.
  IF NOT app_private.platform_settings_readable(v_role, 'announcements') THEN
    PERFORM app_private.audit_write('read', 'platform_announcements.list', 'denied', NULL,
                                    'platform_announcement', NULL);
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  -- The whole row goes to platform_announcement_json, so the newest rows are
  -- picked by id in a subquery rather than aggregated out of one: a subquery's
  -- row is an anonymous record, not the table's type.
  v_items := coalesce((
    SELECT jsonb_agg(app_private.platform_announcement_json(x) ORDER BY x.starts_at DESC, x.id)
      FROM app_private.platform_announcements x
     WHERE x.id IN (SELECT y.id
                      FROM app_private.platform_announcements y
                     ORDER BY y.starts_at DESC, y.id
                     LIMIT c_max_rows)
  ), '[]'::jsonb);

  -- The row names how many were read, never their text.
  PERFORM app_private.audit_write('read', 'platform_announcements.list', 'ok', NULL,
                                  'platform_announcement', NULL, NULL,
                                  jsonb_build_object('count', jsonb_array_length(v_items)));

  RETURN jsonb_build_object('ok', true, 'items', v_items);
END;
$$;

/*
  Create (p_id NULL, p_expected_version NULL) or update (both set) one
  announcement. Anything else is a broken contract and raises 22023.
*/
CREATE OR REPLACE FUNCTION public.platform_announcement_save(
  p_id               uuid,
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
  v_index   integer;
  v_plans   text[];
  v_ids     uuid[];
  v_old     app_private.platform_announcements%ROWTYPE;
  v_new     app_private.platform_announcements%ROWTYPE;
BEGIN
  IF p_value IS NULL OR (p_id IS NULL) <> (p_expected_version IS NULL) THEN
    RAISE EXCEPTION 'platform_announcement_save: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  IF app_private.platform_settings_rate_limited(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  IF NOT app_private.platform_role_can(v_role, 'settings.manage') THEN
    PERFORM app_private.audit_write('settings', 'platform_announcements.save', 'denied', NULL,
                                    'platform_announcement', p_id::text);
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  v_problem := app_private.platform_announcement_problem(p_value);

  -- A named company must exist when it is named; an announcement for a company
  -- nobody has would reach nobody without anybody noticing.
  IF v_problem IS NULL AND p_value ->> 'audience' = 'companies' THEN
    FOR v_index IN 0 .. jsonb_array_length(p_value -> 'company_ids') - 1 LOOP
      IF NOT EXISTS (SELECT 1 FROM public.companies c
                      WHERE c.id = (p_value -> 'company_ids' ->> v_index)::uuid) THEN
        v_problem := 'announcement.company_ids.' || v_index;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_problem IS NOT NULL THEN
    PERFORM app_private.audit_write('settings', 'platform_announcements.save', 'error', NULL,
                                    'platform_announcement', p_id::text, NULL,
                                    jsonb_build_object('reason', 'invalid_value', 'problem', v_problem));
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_value', 'problem', v_problem);
  END IF;

  v_plans := ARRAY(SELECT e.plan FROM jsonb_array_elements_text(p_value -> 'plans') AS e(plan) ORDER BY 1);
  v_ids   := ARRAY(SELECT e.id::uuid FROM jsonb_array_elements_text(p_value -> 'company_ids') AS e(id) ORDER BY 1);

  IF p_id IS NULL THEN
    INSERT INTO app_private.platform_announcements AS a
      (tone, title_de, body_de, title_en, body_en, audience, audience_plans, audience_company_ids,
       starts_at, ends_at, created_by, updated_by)
    VALUES
      (p_value ->> 'tone', p_value ->> 'title_de', p_value ->> 'body_de',
       p_value ->> 'title_en', p_value ->> 'body_en', p_value ->> 'audience', v_plans, v_ids,
       (p_value ->> 'starts_at')::timestamptz, (p_value ->> 'ends_at')::timestamptz, v_uid, v_uid)
    RETURNING * INTO v_new;

    PERFORM app_private.audit_write('settings', 'platform_announcements.save', 'ok', NULL,
                                    'platform_announcement', v_new.id::text, NULL,
                                    app_private.platform_announcement_json(v_new));
    RETURN jsonb_build_object('ok', true, 'item', app_private.platform_announcement_json(v_new));
  END IF;

  -- The lock serialises two saves of one announcement, so both cannot pass the
  -- version check.
  SELECT * INTO v_old FROM app_private.platform_announcements a WHERE a.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM app_private.audit_write('settings', 'platform_announcements.save', 'error', NULL,
                                    'platform_announcement', p_id::text, NULL,
                                    jsonb_build_object('reason', 'not_found'));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_old.version IS DISTINCT FROM p_expected_version THEN
    PERFORM app_private.audit_write('settings', 'platform_announcements.save', 'error', NULL,
                                    'platform_announcement', p_id::text, NULL,
                                    jsonb_build_object('reason', 'version_conflict',
                                                       'expected_version', p_expected_version,
                                                       'current_version', v_old.version));
    RETURN jsonb_build_object('ok', false, 'reason', 'version_conflict', 'current_version', v_old.version);
  END IF;

  UPDATE app_private.platform_announcements a
     SET tone                 = p_value ->> 'tone',
         title_de             = p_value ->> 'title_de',
         body_de              = p_value ->> 'body_de',
         title_en             = p_value ->> 'title_en',
         body_en              = p_value ->> 'body_en',
         audience             = p_value ->> 'audience',
         audience_plans       = v_plans,
         audience_company_ids = v_ids,
         starts_at            = (p_value ->> 'starts_at')::timestamptz,
         ends_at              = (p_value ->> 'ends_at')::timestamptz,
         version              = a.version + 1,
         updated_by           = v_uid,
         updated_at           = now()
   WHERE a.id = p_id
  RETURNING * INTO v_new;

  PERFORM app_private.audit_write('settings', 'platform_announcements.save', 'ok', NULL,
                                  'platform_announcement', p_id::text,
                                  app_private.platform_announcement_json(v_old),
                                  app_private.platform_announcement_json(v_new));
  RETURN jsonb_build_object('ok', true, 'item', app_private.platform_announcement_json(v_new));
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_announcement_delete(p_id uuid, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text := app_private.platform_staff_role_of(auth.uid());
  v_old  app_private.platform_announcements%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'platform_announcement_delete: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  IF app_private.platform_settings_rate_limited(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  IF NOT app_private.platform_role_can(v_role, 'settings.manage') THEN
    PERFORM app_private.audit_write('settings', 'platform_announcements.delete', 'denied', NULL,
                                    'platform_announcement', p_id::text);
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  SELECT * INTO v_old FROM app_private.platform_announcements a WHERE a.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM app_private.audit_write('settings', 'platform_announcements.delete', 'error', NULL,
                                    'platform_announcement', p_id::text, NULL,
                                    jsonb_build_object('reason', 'not_found'));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_old.version IS DISTINCT FROM p_expected_version THEN
    PERFORM app_private.audit_write('settings', 'platform_announcements.delete', 'error', NULL,
                                    'platform_announcement', p_id::text, NULL,
                                    jsonb_build_object('reason', 'version_conflict',
                                                       'expected_version', p_expected_version,
                                                       'current_version', v_old.version));
    RETURN jsonb_build_object('ok', false, 'reason', 'version_conflict', 'current_version', v_old.version);
  END IF;

  DELETE FROM app_private.platform_announcements a WHERE a.id = p_id;

  -- The audit log keeps what was deleted; the table does not.
  PERFORM app_private.audit_write('settings', 'platform_announcements.delete', 'ok', NULL,
                                  'platform_announcement', p_id::text,
                                  app_private.platform_announcement_json(v_old), NULL);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ─── What every signed-in screen reads ──────────────────────────────────────

/*
  20260916150000's body with two changes and no others: feature_flags is the
  stored setting rather than an empty object, and announcements are the ones
  that apply to the caller's company now rather than an empty list. The price
  book, the feature map and the trial length are read exactly as before.
*/
CREATE OR REPLACE FUNCTION public.get_app_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'price_book',    app_private.platform_setting_value('price_book'),
    'plan_features', app_private.platform_setting_value('plan_features'),
    'trial_days',    app_private.signup_trial_days(),
    'feature_flags', coalesce(app_private.platform_setting_value('feature_flags'), '{}'::jsonb),
    'announcements', app_private.announcements_for_company(public.get_active_company_id())
  );
END;
$$;

-- ─── Ownership ──────────────────────────────────────────────────────────────

ALTER TABLE    app_private.platform_announcements                                            OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_announcement_problem(jsonb)                               OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_announcement_json(app_private.platform_announcements)     OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.announcements_for_company(uuid)                                    OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_announcements_list()                                           OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_announcement_save(uuid, jsonb, integer)                        OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_announcement_delete(uuid, integer)                             OWNER TO CURRENT_USER;
ALTER FUNCTION public.get_app_config()                                                        OWNER TO CURRENT_USER;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION app_private.platform_announcement_problem(jsonb)                           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_announcement_json(app_private.platform_announcements) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.announcements_for_company(uuid)                                FROM PUBLIC, anon, authenticated, service_role;

-- The panel, signed in.
REVOKE ALL ON FUNCTION public.platform_announcements_list() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_announcements_list() TO authenticated;
REVOKE ALL ON FUNCTION public.platform_announcement_save(uuid, jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_announcement_save(uuid, jsonb, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.platform_announcement_delete(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_announcement_delete(uuid, integer) TO authenticated;

-- Restated exactly as 20260916150000 left it: every signed-in screen.
REVOKE ALL ON FUNCTION public.get_app_config() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_app_config() TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role   text;
  v_wrong  text;
  v_config jsonb;
  v_doc    jsonb;
  v_action text;
BEGIN
  -- 1. Nobody the API authenticates as reaches the new table.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'app_private.platform_announcements',
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '20260920130010 self-check: % reaches app_private.platform_announcements', v_role;
    END IF;
  END LOOP;

  -- 2. Every function this file created or replaced.
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
          -- signature                                                                      definer anon   authn  service
          ('app_private.platform_announcement_problem(jsonb)',                              false,  false, false, false),
          ('app_private.platform_announcement_json(app_private.platform_announcements)',    false,  false, false, false),
          ('app_private.announcements_for_company(uuid)',                                   false,  false, false, false),
          ('public.platform_announcements_list()',                                          true,   false, true,  false),
          ('public.platform_announcement_save(uuid,jsonb,integer)',                         true,   false, true,  false),
          ('public.platform_announcement_delete(uuid,integer)',                             true,   false, true,  false),
          ('public.get_app_config()',                                                       true,   false, true,  false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920130010 self-check: %', v_wrong;
  END IF;

  -- 3. get_app_config keeps its five keys and reads the three old ones exactly
  --    as before. Here, with no signed-in caller, the company is NULL, so the
  --    announcements are the empty list, whatever the table holds.
  v_config := public.get_app_config();
  IF app_private.settings_object_keys(v_config)
       IS DISTINCT FROM ARRAY['announcements', 'feature_flags', 'plan_features', 'price_book', 'trial_days']
     OR v_config -> 'price_book'    IS DISTINCT FROM app_private.platform_setting_value('price_book')
     OR v_config -> 'plan_features' IS DISTINCT FROM app_private.platform_setting_value('plan_features')
     OR (v_config ->> 'trial_days')::integer IS DISTINCT FROM app_private.signup_trial_days()
     OR v_config -> 'feature_flags' IS DISTINCT FROM app_private.platform_setting_value('feature_flags')
     OR v_config -> 'announcements' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION '20260920130010 self-check: get_app_config no longer answers what it did';
  END IF;

  -- 4. The validator, at its edges — the time zone above all.
  v_doc := '{"tone": "info", "title_de": "Wartung", "body_de": "Heute Nacht ist El-Professor kurz nicht erreichbar.",
             "title_en": "", "body_en": "", "audience": "all", "plans": [], "company_ids": [],
             "starts_at": "2026-09-20T22:00:00+02:00", "ends_at": "2026-09-21T02:00:00+02:00"}'::jsonb;
  IF app_private.platform_announcement_problem(v_doc) IS NOT NULL
     OR app_private.platform_announcement_problem(v_doc || '{"ends_at": null}'::jsonb) IS NOT NULL
     -- no offset: the cast would read the session's zone
     OR app_private.platform_announcement_problem(v_doc || '{"starts_at": "2026-09-20T22:00:00"}'::jsonb)
          IS DISTINCT FROM 'announcement.starts_at'
     OR app_private.platform_announcement_problem(v_doc || '{"starts_at": "2026-09-20"}'::jsonb)
          IS DISTINCT FROM 'announcement.starts_at'
     OR app_private.platform_announcement_problem(v_doc || '{"starts_at": "2026-13-40T22:00:00Z"}'::jsonb)
          IS DISTINCT FROM 'announcement.starts_at'
     OR app_private.platform_announcement_problem(v_doc || '{"ends_at": "2026-09-20T20:00:00Z"}'::jsonb)
          IS DISTINCT FROM 'announcement.ends_at'
     OR app_private.platform_announcement_problem(v_doc || '{"tone": "danger"}'::jsonb) IS DISTINCT FROM 'announcement.tone'
     OR app_private.platform_announcement_problem(v_doc || '{"title_de": "  "}'::jsonb) IS DISTINCT FROM 'announcement.title_de'
     OR app_private.platform_announcement_problem(v_doc || '{"title_en": "Maintenance"}'::jsonb) IS DISTINCT FROM 'announcement.english'
     OR app_private.platform_announcement_problem(v_doc || '{"audience": "plans"}'::jsonb) IS DISTINCT FROM 'announcement.plans'
     OR app_private.platform_announcement_problem(v_doc || '{"audience": "plans", "plans": ["gold"]}'::jsonb)
          IS DISTINCT FROM 'announcement.plans'
     OR app_private.platform_announcement_problem(v_doc || '{"audience": "plans", "plans": ["basic"]}'::jsonb) IS NOT NULL
     OR app_private.platform_announcement_problem(v_doc || '{"plans": ["basic"]}'::jsonb) IS DISTINCT FROM 'announcement.plans'
     OR app_private.platform_announcement_problem(v_doc || '{"audience": "companies", "company_ids": ["x"]}'::jsonb)
          IS DISTINCT FROM 'announcement.company_ids.0'
     OR app_private.platform_announcement_problem(v_doc - 'body_en') IS DISTINCT FROM 'announcement' THEN
    RAISE EXCEPTION '20260920130010 self-check: the announcement validator does not refuse what it must';
  END IF;

  -- 5. platform_audit_record cannot forge an announcement row: its allow-list
  --    names none of these actions.
  FOREACH v_action IN ARRAY ARRAY['platform_announcements.list', 'platform_announcements.save',
                                  'platform_announcements.delete'] LOOP
    BEGIN
      PERFORM public.platform_audit_record('read', v_action, 'ok');
      RAISE EXCEPTION '20260920130010 self-check: platform_audit_record accepts the forbidden action %', v_action;
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;   -- 22023: the refusal this pins
    END;
  END LOOP;

  -- 6. The budget 20260920130000 defined counts these three actions.
  IF NOT (app_private.platform_settings_audit_actions()
          @> ARRAY['platform_announcements.list', 'platform_announcements.save', 'platform_announcements.delete']) THEN
    RAISE EXCEPTION '20260920130010 self-check: the settings budget does not count the announcement actions';
  END IF;
END $$;
