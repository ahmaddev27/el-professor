/*
  # Platform staff, their capabilities, and the platform audit log

  Plan 3.1 (sections 3.A and 3.B). This file only adds; 20260916110010 then
  moves every check that read `user_profiles.is_super_admin` onto what is
  created here.

  ## What was wrong

  Platform rights came from a single boolean on the profile. Fifteen policies
  and nine functions read it directly, `is_user_super_admin()` read it for
  every other policy, and whoever could write that column held the whole
  platform. There was no narrower platform role, and nothing recorded what a
  platform account did.

  ## What this adds

  - `app_private.platform_staff`: one row per platform account, with one of
    four fixed roles (owner, support, billing, read_only). A disabled row
    grants nothing. A trigger refuses to remove, disable or demote the last
    active owner, whichever path tries it, deleting the auth user included.
  - `app_private.platform_capability_matrix()`: the capability matrix of plan
    3.A. It is the only place the matrix is written down; every helper reads
    it, and so does the self-check at the end.
  - `public.platform_staff_role()` and `public.platform_can(capability)`: the
    helpers policies and functions call, for signed-in callers only. Every
    policy that calls platform_can applies TO authenticated, so anon holds
    EXECUTE on neither; both answer NULL or false for a caller without a role.
  - `public.platform_whoami()`: what the signed-in account may do on the
    platform, for the browser: its role, its capabilities, and
    `company_context`, which stays null until 3.4.
  - `public.platform_can_manage_account(user_id)`: whether the caller may act,
    as platform staff, on one account. An account with a staff row needs
    `staff.manage`, any other one `company_users.manage`, so support cannot
    take over an owner through manage-users. Authenticated only.
  - `app_private.platform_audit_log`: append-only. A trigger refuses UPDATE,
    DELETE and TRUNCATE, and nobody but the schema owner holds a privilege on
    it. `app_private.audit_write(...)` is its only writer. Outcomes are
    `attempt` (written before a platform write starts), `ok`, `denied` and
    `error`.
  - `public.platform_audit_record(...)`: how an edge function records a
    platform action under the caller's own JWT. It writes only for platform
    staff and returns NULL for everyone else. It accepts only the categories
    `read` and `write`, and refuses actions in the namespaces the database
    writes itself (`platform_staff.`, `legacy.`, `auth.`).
  - The backfill: every profile flagged as a platform account becomes an
    owner. Today that flag carries full platform power, so owner preserves
    behaviour. Only the count is reported (open decision D5).
  - A one-time copy of `subscription_payment_audit` and
    `subscription_admin_actions` into the audit log, category `legacy`. Both
    tables keep their writers until phase 3.5 and 3.8 move them.

  ## How the column stays in step

  `user_profiles.is_super_admin` remains only as a routing hint for the
  browser. `app_private.platform_staff_sync_profile()` sets it whenever a staff
  row changes and when a profile is created for someone who already has one.
  It follows the table; the table never follows it.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. The previous release reads the
  column, which this file keeps exactly as it was. Retention (open decision D4)
  is not part of this slice: a later cleanup job needs a deliberate way past
  the append-only trigger.
*/

-- ─── The audit log ──────────────────────────────────────────────────────────

CREATE TABLE app_private.platform_audit_log (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- No foreign keys, on purpose: a row must outlive the account, the staff
  -- row and the company it names.
  actor_user_id uuid        NULL,
  -- The actor's platform role when the row was written, NULL for a caller
  -- without one (a system job, a legacy row).
  actor_role    text        NULL CHECK (actor_role IN ('owner','support','billing','read_only')),
  -- auth.sessions.id from the caller's JWT, when there was one.
  session_id    uuid        NULL,
  company_id    uuid        NULL,
  category      text        NOT NULL CHECK (category IN ('read','write','support','auth','settings','staff','legacy')),
  action        text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(action) <= 100),
  -- 'attempt' is written before a platform write starts, so an action whose
  -- outcome row is lost still leaves a trace.
  outcome       text        NOT NULL CHECK (outcome IN ('attempt','ok','denied','error')),
  target_type   text        NULL CHECK (target_type ~ '^[a-z][a-z0-9_]*$' AND length(target_type) <= 60),
  target_id     text        NULL CHECK (length(target_id) <= 200),
  before_value  jsonb       NULL,
  after_value   jsonb       NULL
);

CREATE INDEX platform_audit_log_occurred_at ON app_private.platform_audit_log (occurred_at);
CREATE INDEX platform_audit_log_actor       ON app_private.platform_audit_log (actor_user_id, occurred_at)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX platform_audit_log_company     ON app_private.platform_audit_log (company_id, occurred_at)
  WHERE company_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.platform_audit_log_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only: % refused', TG_OP USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER platform_audit_log_append_only
  BEFORE UPDATE OR DELETE ON app_private.platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION app_private.platform_audit_log_refuse_change();

CREATE TRIGGER platform_audit_log_no_truncate
  BEFORE TRUNCATE ON app_private.platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.platform_audit_log_refuse_change();

-- ─── Platform staff ─────────────────────────────────────────────────────────

CREATE TABLE app_private.platform_staff (
  -- ON DELETE CASCADE lets GoTrue delete a staff account like any other. The
  -- last active owner is the exception: platform_staff_keep_owner raises, and
  -- the account deletion fails with it instead of silently removing the owner.
  user_id     uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('owner','support','billing','read_only')),
  -- No FK: whoever added a colleague may leave later. The audit log keeps it.
  created_by  uuid        NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz NULL,
  note        text        NULL CHECK (length(note) <= 500)
);

CREATE INDEX platform_staff_active_role ON app_private.platform_staff (role) WHERE disabled_at IS NULL;

-- The capability matrix of plan 3.A, and the only copy of it. A capability
-- missing here is refused everywhere; the self-check at the end of this file
-- and of 20260916110010 fails a release that names one that does not exist.
CREATE OR REPLACE FUNCTION app_private.platform_capability_matrix()
RETURNS TABLE (role text, capability text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT m.role, m.capability
    FROM (VALUES
      ('owner',     'companies.read'),
      ('support',   'companies.read'),
      ('billing',   'companies.read'),
      ('read_only', 'companies.read'),

      ('owner',     'business.read'),
      ('support',   'business.read'),
      ('read_only', 'business.read'),

      ('owner',     'support.session'),
      ('support',   'support.session'),

      ('owner',     'company_users.manage'),
      ('support',   'company_users.manage'),

      -- Open decision D2: whether support may also approve, suspend and
      -- archive companies. Until the owner decides, only owners may.
      ('owner',     'companies.lifecycle'),

      ('owner',     'companies.hard_delete'),

      ('owner',     'billing.manage'),
      ('billing',   'billing.manage'),
      ('owner',     'pricing.manage'),
      ('billing',   'pricing.manage'),
      ('owner',     'codes.manage'),
      ('billing',   'codes.manage'),

      -- Billing reads settings for the price book only; phase 3.9 narrows
      -- what settings.read returns to that role.
      ('owner',     'settings.read'),
      ('billing',   'settings.read'),
      ('read_only', 'settings.read'),

      ('owner',     'settings.manage'),

      ('owner',     'metrics.read'),
      ('billing',   'metrics.read'),
      ('read_only', 'metrics.read'),

      -- Open decision D3: whether read_only reads the whole audit log. Until
      -- the owner decides, only owners do. Everyone's own activity is a read
      -- model of phase 3.6b, not a capability.
      ('owner',     'audit.read'),

      ('owner',     'staff.manage')
    ) AS m(role, capability);
$$;

-- The active role of one account, or NULL: no row, a disabled row, or no id.
CREATE OR REPLACE FUNCTION app_private.platform_staff_role_of(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT s.role
            FROM app_private.platform_staff s
           WHERE s.user_id = p_user_id
             AND s.disabled_at IS NULL);
END;
$$;

CREATE OR REPLACE FUNCTION app_private.platform_role_can(p_role text, p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT p_role IS NOT NULL
     AND p_capability IS NOT NULL
     AND EXISTS (SELECT 1
                   FROM app_private.platform_capability_matrix() m
                  WHERE m.role = p_role
                    AND m.capability = p_capability);
$$;

-- ─── audit_write ────────────────────────────────────────────────────────────

-- The only writer of the audit log. Called by SECURITY DEFINER functions and
-- triggers owned by the migration role; nobody else holds EXECUTE.
--
-- The actor defaults to the JWT subject and the session to the JWT's
-- session_id, so a caller acting for itself passes neither. The actor's role is
-- always looked up here, never passed. `p_occurred_at` exists for the legacy
-- copy alone: every other category is stamped now(), so nothing can backdate
-- a row.
CREATE OR REPLACE FUNCTION app_private.audit_write(
  p_category      text,
  p_action        text,
  p_outcome       text        DEFAULT 'ok',
  p_company_id    uuid        DEFAULT NULL,
  p_target_type   text        DEFAULT NULL,
  p_target_id     text        DEFAULT NULL,
  p_before        jsonb       DEFAULT NULL,
  p_after         jsonb       DEFAULT NULL,
  p_actor_user_id uuid        DEFAULT NULL,
  p_session_id    uuid        DEFAULT NULL,
  p_occurred_at   timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_value_bytes CONSTANT integer := 32768;
  c_uuid_pattern    CONSTANT text    := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_actor   uuid;
  v_session uuid := p_session_id;
  v_claim   text;
  v_id      bigint;
BEGIN
  IF p_category IS NULL
     OR p_category NOT IN ('read','write','support','auth','settings','staff','legacy')
     OR p_action IS NULL OR length(p_action) > 100
     OR p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
     OR p_outcome IS NULL OR p_outcome NOT IN ('attempt','ok','denied','error')
     OR (p_target_type IS NOT NULL AND (length(p_target_type) > 60 OR p_target_type !~ '^[a-z][a-z0-9_]*$'))
     OR (p_target_id IS NOT NULL AND length(p_target_id) > 200)
     OR (p_before IS NOT NULL AND octet_length(p_before::text) > c_max_value_bytes)
     OR (p_after  IS NOT NULL AND octet_length(p_after::text)  > c_max_value_bytes)
     OR (p_occurred_at IS NOT NULL AND p_category <> 'legacy')
  THEN
    RAISE EXCEPTION 'audit_write: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_actor := coalesce(p_actor_user_id, auth.uid());

  -- PostgREST puts the verified claims here. A missing or malformed session_id
  -- leaves the column empty rather than failing the action being recorded.
  IF v_session IS NULL THEN
    v_claim := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
    IF v_claim ~ c_uuid_pattern THEN
      v_session := v_claim::uuid;
    END IF;
  END IF;

  INSERT INTO app_private.platform_audit_log
    (occurred_at, actor_user_id, actor_role, session_id, company_id, category, action, outcome,
     target_type, target_id, before_value, after_value)
  VALUES
    (coalesce(p_occurred_at, now()), v_actor,
     CASE WHEN p_category = 'legacy' THEN NULL ELSE app_private.platform_staff_role_of(v_actor) END,
     v_session, p_company_id, p_category, p_action, p_outcome,
     p_target_type, p_target_id, p_before, p_after)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ─── Staff triggers ─────────────────────────────────────────────────────────

-- Refuses any change that would leave no active owner. The advisory lock
-- serialises such changes, so two sessions cannot each remove "the other"
-- owner; each statement below takes a fresh snapshot under READ COMMITTED and
-- sees the other's commit.
CREATE OR REPLACE FUNCTION app_private.platform_staff_keep_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_removes_owner boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_removes_owner := OLD.role = 'owner' AND OLD.disabled_at IS NULL;
  ELSE
    v_removes_owner := OLD.role = 'owner' AND OLD.disabled_at IS NULL
                       AND (NEW.role <> 'owner' OR NEW.disabled_at IS NOT NULL OR NEW.user_id <> OLD.user_id);
  END IF;

  IF v_removes_owner THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('app_private.platform_staff:active_owners', 0));
    IF NOT EXISTS (SELECT 1
                     FROM app_private.platform_staff s
                    WHERE s.role = 'owner'
                      AND s.disabled_at IS NULL
                      AND s.user_id <> OLD.user_id) THEN
      RAISE EXCEPTION 'platform_staff: the last active owner cannot be removed, disabled or demoted'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Keeps the profile's routing hint in step with the staff table. On
-- platform_staff it runs after every change; on user_profiles it runs before an
-- INSERT, so a profile created after its staff row starts in step. It never
-- lowers a flag on insert, and it never reads the flag to decide anything.
CREATE OR REPLACE FUNCTION app_private.platform_staff_sync_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'user_profiles' THEN
    IF app_private.platform_staff_role_of(NEW.user_id) IS NOT NULL THEN
      NEW.is_super_admin := true;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.user_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.user_id];
  ELSE
    v_ids := ARRAY[OLD.user_id, NEW.user_id];
  END IF;

  UPDATE public.user_profiles up
     SET is_super_admin = (app_private.platform_staff_role_of(up.user_id) IS NOT NULL)
   WHERE up.user_id = ANY (v_ids)
     AND up.is_super_admin IS DISTINCT FROM (app_private.platform_staff_role_of(up.user_id) IS NOT NULL);

  RETURN NULL;
END;
$$;

-- Every change to the staff table is audited, whichever path made it: a
-- migration, a platform RPC, or GoTrue deleting an account.
CREATE OR REPLACE FUNCTION app_private.platform_staff_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app_private.audit_write('staff', 'platform_staff.insert', 'ok', NULL,
      'platform_staff', NEW.user_id::text, NULL, to_jsonb(NEW));
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM app_private.audit_write('staff', 'platform_staff.update', 'ok', NULL,
      'platform_staff', NEW.user_id::text, to_jsonb(OLD), to_jsonb(NEW));
  ELSE
    PERFORM app_private.audit_write('staff', 'platform_staff.delete', 'ok', NULL,
      'platform_staff', OLD.user_id::text, to_jsonb(OLD), NULL);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER platform_staff_keep_owner
  BEFORE UPDATE OR DELETE ON app_private.platform_staff
  FOR EACH ROW EXECUTE FUNCTION app_private.platform_staff_keep_owner();

CREATE TRIGGER platform_staff_sync_profile
  AFTER INSERT OR UPDATE OR DELETE ON app_private.platform_staff
  FOR EACH ROW EXECUTE FUNCTION app_private.platform_staff_sync_profile();

CREATE TRIGGER platform_staff_audit
  AFTER INSERT OR UPDATE OR DELETE ON app_private.platform_staff
  FOR EACH ROW EXECUTE FUNCTION app_private.platform_staff_audit();

-- Named to sort before user_profiles_privilege_guard: BEFORE triggers fire in
-- name order, and the guard must see the flag this one sets.
DROP TRIGGER IF EXISTS platform_staff_sync ON public.user_profiles;
CREATE TRIGGER platform_staff_sync
  BEFORE INSERT ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION app_private.platform_staff_sync_profile();

-- ─── The helpers callers use ────────────────────────────────────────────────

-- For signed-in callers. The fifteen platform policies of 20260916110010 call
-- platform_can and apply TO authenticated, and nothing anonymous calls either
-- helper, so anon holds EXECUTE on neither. For a caller without a role both
-- answer NULL / false.
CREATE OR REPLACE FUNCTION public.platform_staff_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN app_private.platform_staff_role_of(auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_can(p_capability text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN app_private.platform_role_can(app_private.platform_staff_role_of(auth.uid()), p_capability);
END;
$$;

-- For the browser: the caller's role, its capabilities and the company it has
-- opened (3.4 fills it; null until then). Platform sign-in is an address and a
-- password, with no second step (the owner's decision of 16.09.2026), so there
-- is no verification state to report.
CREATE OR REPLACE FUNCTION public.platform_whoami()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text := app_private.platform_staff_role_of(auth.uid());
BEGIN
  RETURN jsonb_build_object(
    'role',            v_role,
    'capabilities',    coalesce((SELECT jsonb_agg(m.capability ORDER BY m.capability)
                                   FROM app_private.platform_capability_matrix() m
                                  WHERE m.role = v_role), '[]'::jsonb),
    'company_context', NULL::jsonb
  );
END;
$$;

-- An edge function records a platform action here with the caller's own JWT,
-- so the actor, role and session come from the token and cannot be named by
-- the caller. Writes only for an account with an active staff role and
-- returns NULL for anyone else. VOLATILE, so PostgREST calls it with POST.
--
-- Any active staff role may call it, read_only included, so it accepts only
-- what edge functions send: the categories read and write, and no action in a
-- namespace the database writes itself (platform_staff. by the trigger above,
-- legacy. by the copy below, auth. for sign-in events). Otherwise a
-- staff member could add a row that passes for one the database wrote, say a
-- category staff row claiming platform_staff.delete.
CREATE OR REPLACE FUNCTION public.platform_audit_record(
  p_category    text,
  p_action      text,
  p_outcome     text,
  p_company_id  uuid  DEFAULT NULL,
  p_target_type text  DEFAULT NULL,
  p_target_id   text  DEFAULT NULL,
  p_before      jsonb DEFAULT NULL,
  p_after       jsonb DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_category IS NULL OR p_category NOT IN ('read','write')
     OR p_action IS NULL
     OR p_action ~ '^(platform_staff|legacy|auth)(\.|$)'
  THEN
    RAISE EXCEPTION 'platform_audit_record: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF app_private.platform_staff_role_of(auth.uid()) IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN app_private.audit_write(p_category, p_action, p_outcome, p_company_id,
                                 p_target_type, p_target_id, p_before, p_after);
END;
$$;

-- Whether the caller may act, as platform staff, on one existing account.
-- manage-users asks it before every platform change to an account. An account
-- with a staff row, a disabled one included, belongs to the platform itself and
-- needs staff.manage: otherwise support, which holds company_users.manage, could
-- set an owner's address and password through the service role and sign in as
-- that owner. Any other account needs company_users.manage. False, never NULL,
-- for anon, a caller without an active role and a missing id.
CREATE OR REPLACE FUNCTION public.platform_can_manage_account(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text := app_private.platform_staff_role_of(auth.uid());
BEGIN
  IF p_user_id IS NULL OR v_role IS NULL THEN
    RETURN false;
  END IF;

  RETURN coalesce(
    app_private.platform_role_can(v_role, 'staff.manage')
    OR (app_private.platform_role_can(v_role, 'company_users.manage')
        AND NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = p_user_id)),
    false);
END;
$$;

-- ─── Backfill ───────────────────────────────────────────────────────────────

-- Every platform account holds the whole platform today, so owner is the role
-- that preserves behaviour. A profile without an auth account cannot sign in
-- and is skipped. Only counts are printed (open decision D5).
DO $$
DECLARE
  v_owners       integer;
  v_skipped      integer;
  v_with_company integer;
BEGIN
  WITH added AS (
    INSERT INTO app_private.platform_staff (user_id, role, created_by, note)
    SELECT up.user_id, 'owner', NULL, 'backfill 20260916110000: platform account before phase 3.1'
      FROM public.user_profiles up
      JOIN auth.users u ON u.id = up.user_id
     WHERE up.is_super_admin
    ON CONFLICT (user_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_owners FROM added;

  SELECT count(*) INTO v_skipped
    FROM public.user_profiles up
   WHERE up.is_super_admin
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = up.user_id);

  -- A platform profile that still sits in a company is out of its company
  -- admins' reach (manage-users and the profile guard refuse them), and plan
  -- 3.7b detaches it. Printed so the production release shows how many exist.
  SELECT count(*) INTO v_with_company
    FROM public.user_profiles up
   WHERE up.is_super_admin
     AND up.company_id IS NOT NULL;

  RAISE NOTICE '20260916110000 backfill: % platform owner(s) added, % platform profile(s) without an account skipped, % platform profile(s) still attached to a company',
    v_owners, v_skipped, v_with_company;
END $$;

-- ─── Legacy audit rows ──────────────────────────────────────────────────────

-- A one-time copy. The source tables stay, and keep receiving rows until
-- their writers move to the audit log.
DO $$
DECLARE
  r           record;
  v_payment   integer := 0;
  v_admin     integer := 0;
BEGIN
  -- SHARE mode holds the tables' writers until the transaction commits.
  -- deploy.sh applies this file in one transaction, so a row inserted between
  -- the copy and self-check 5 cannot fail the completeness check and roll the
  -- release back. Readers are not blocked. Taken inside the block because a
  -- bare LOCK TABLE outside a transaction block is an error, and the RLS kit
  -- applies a file statement by statement.
  LOCK TABLE public.subscription_payment_audit, public.subscription_admin_actions IN SHARE MODE;

  FOR r IN SELECT * FROM public.subscription_payment_audit ORDER BY created_at, id LOOP
    PERFORM app_private.audit_write(
      'legacy', 'legacy.subscription_payment_audit', 'ok', r.company_id,
      'subscription_invoice', r.invoice_id::text,
      jsonb_build_object('status', r.old_status),
      jsonb_build_object('legacy_id', r.id, 'action', r.action, 'status', r.new_status,
                         'amount', r.amount, 'note', r.note),
      r.changed_by, NULL, r.created_at);
    v_payment := v_payment + 1;
  END LOOP;

  FOR r IN SELECT * FROM public.subscription_admin_actions ORDER BY created_at, id LOOP
    PERFORM app_private.audit_write(
      'legacy', 'legacy.subscription_admin_actions', 'ok', r.company_id,
      'company', r.company_id::text,
      jsonb_build_object('subscription_status', r.old_status, 'subscription_expires_at', r.old_expires_at),
      jsonb_build_object('legacy_id', r.id, 'action_type', r.action_type,
                         'subscription_status', r.new_status, 'subscription_expires_at', r.new_expires_at,
                         'reason', r.reason),
      r.created_by, NULL, r.created_at);
    v_admin := v_admin + 1;
  END LOOP;

  RAISE NOTICE '20260916110000 legacy copy: % subscription_payment_audit row(s), % subscription_admin_actions row(s)',
    v_payment, v_admin;
END $$;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON ALL TABLES    IN SCHEMA app_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app_private FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION app_private.platform_audit_log_refuse_change()             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_capability_matrix()                   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_role_of(uuid)                   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_role_can(text, text)                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.audit_write(text, text, text, uuid, text, text, jsonb, jsonb, uuid, uuid, timestamptz)
                                                                                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_keep_owner()                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_sync_profile()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_audit()                         FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.platform_staff_role() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_role() TO authenticated;

REVOKE ALL ON FUNCTION public.platform_can(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_can(text) TO authenticated;

REVOKE ALL ON FUNCTION public.platform_whoami() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_whoami() TO authenticated;

REVOKE ALL ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  TO authenticated;

-- Reads app_private, so it must run as a role that reaches it (see the
-- ownership note in 20260916110010). It is new here and already belongs to the
-- migration role; stated so a later copy of this block cannot forget it.
ALTER FUNCTION public.platform_can_manage_account(uuid) OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.platform_can_manage_account(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_can_manage_account(uuid) TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role  text;
  v_rel   text;
  v_wrong text;
BEGIN
  -- 1. Nobody the API authenticates as reaches the schema or anything in it.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE') THEN
      RAISE EXCEPTION '20260916110000 self-check: % has USAGE on app_private', v_role;
    END IF;
    SELECT c.relname INTO v_rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app_private'
       AND ((c.relkind = 'r' AND has_table_privilege(v_role, c.oid,
               'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
         OR (c.relkind = 'S' AND has_sequence_privilege(v_role, c.oid, 'USAGE, SELECT, UPDATE')))
     LIMIT 1;
    IF v_rel IS NOT NULL THEN
      RAISE EXCEPTION '20260916110000 self-check: % holds a privilege on app_private.%', v_role, v_rel;
    END IF;
  END LOOP;

  -- 2. Every function here: SECURITY DEFINER where it should be, a pinned
  --    search_path, and exactly the EXECUTE grants stated above.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               -- A SECURITY DEFINER function here reaches app_private, which only
               -- its owner or a superuser can (see 20260916110010, "Ownership").
               WHEN v.definer AND NOT EXISTS (
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
          -- signature                                                                              definer anon   authn  service
          ('public.platform_can_manage_account(uuid)',                                              true,   false, true,  false),
          ('app_private.platform_audit_log_refuse_change()',                                        false,  false, false, false),
          ('app_private.platform_capability_matrix()',                                              false,  false, false, false),
          ('app_private.platform_staff_role_of(uuid)',                                              false,  false, false, false),
          ('app_private.platform_role_can(text,text)',                                              false,  false, false, false),
          ('app_private.audit_write(text,text,text,uuid,text,text,jsonb,jsonb,uuid,uuid,timestamptz)', true, false, false, false),
          ('app_private.platform_staff_keep_owner()',                                               true,   false, false, false),
          ('app_private.platform_staff_sync_profile()',                                             true,   false, false, false),
          ('app_private.platform_staff_audit()',                                                    true,   false, false, false),
          ('public.platform_staff_role()',                                                          true,   false, true,  false),
          ('public.platform_can(text)',                                                             true,   false, true,  false),
          ('public.platform_whoami()',                                                              true,   false, true,  false),
          ('public.platform_audit_record(text,text,text,uuid,text,text,jsonb,jsonb)',               true,   false, true,  false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916110000 self-check: %', v_wrong;
  END IF;

  -- 3. The matrix says what plan 3.A says, including the two open decisions.
  IF (SELECT count(DISTINCT capability) FROM app_private.platform_capability_matrix()) <> 14
     OR (SELECT count(*) FROM app_private.platform_capability_matrix() WHERE role = 'owner') <> 14
     OR EXISTS (SELECT 1 FROM app_private.platform_capability_matrix()
                 WHERE role NOT IN ('owner','support','billing','read_only'))
     OR app_private.platform_role_can('support', 'companies.lifecycle')
     OR app_private.platform_role_can('read_only', 'audit.read')
     OR app_private.platform_role_can('billing', 'business.read')
     OR app_private.platform_role_can('read_only', 'billing.manage')
  THEN
    RAISE EXCEPTION '20260916110000 self-check: the capability matrix does not match plan 3.A';
  END IF;

  -- 4. The backfill took every platform account that can sign in.
  IF EXISTS (SELECT 1
               FROM public.user_profiles up
               JOIN auth.users u ON u.id = up.user_id
              WHERE up.is_super_admin
                AND app_private.platform_staff_role_of(up.user_id) IS DISTINCT FROM 'owner') THEN
    RAISE EXCEPTION '20260916110000 self-check: a platform account has no active owner row';
  END IF;

  -- 5. The legacy copy is complete.
  IF (SELECT count(*) FROM app_private.platform_audit_log WHERE action = 'legacy.subscription_payment_audit')
       <> (SELECT count(*) FROM public.subscription_payment_audit)
     OR (SELECT count(*) FROM app_private.platform_audit_log WHERE action = 'legacy.subscription_admin_actions')
       <> (SELECT count(*) FROM public.subscription_admin_actions) THEN
    RAISE EXCEPTION '20260916110000 self-check: the legacy audit copy is incomplete';
  END IF;
END $$;
