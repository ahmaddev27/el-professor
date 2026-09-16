/*
  # Platform writes: audited RPCs for companies, billing and codes

  Plan 3.5. Builds on 20260916110000 and 20260916110010 (plan 3.1), which
  created the staff table, the capability matrix, platform_can() and
  app_private.audit_write(). Nothing here restructures them.

  ## What was wrong

  The platform screens changed companies, subscriptions, invoices and discount
  codes with direct table writes. Those writes left no trace in the platform
  audit log, and a direct UPDATE could not be told apart from any other. The
  four platform RPCs 3.1 rewrote (revoke, hide and delete an activation code, the
  manual subscription update) checked a capability but recorded nothing either.

  `public.platform_audit_record`, the edge functions' door to the log, let any
  active staff role write an unlimited number of rows under its own name, with
  any action and any outcome (the 3.1 review).

  ## What this adds

  - Every platform write is one SECURITY DEFINER function, one transaction. It
    asks the capability first, and every call writes exactly one audit row
    through `app_private.audit_write` in the same transaction: `ok` with the
    values before and after, `error` with the reason a valid caller was
    refused, or `denied` when the caller lacks the capability. A denied row is
    written for any signed-in caller (actor_role NULL for a company user), at
    most 30 per actor per minute so a refused caller cannot flood the log.
  - Each function answers `{success: true, ...}` or `{success: false, reason,
    error}`. `reason` is a stable code the browser translates; `error` is a
    German sentence for callers that show it as it is.
  - Companies (`companies.lifecycle`, owners only per open decision D2):
    `platform_company_create`, `platform_company_update`,
    `platform_company_set_approval` (approve, reject, suspend: exactly the
    columns SuperAdminDashboard wrote, no code and no mail),
    `platform_company_set_status`, `platform_company_lifecycle` (suspend,
    reactivate, archive, restore, mark_deleted, with the user status changes
    CompaniesPage made) and `platform_company_extend_trial`. Hard delete stays
    out (D13): CompaniesPage keeps its direct DELETE.
  - Billing (`billing.manage`), on the tables as they are:
    `platform_company_set_plan`, `platform_subscription_assign`,
    `platform_invoice_mark_paid`, `platform_invoice_mark_unpaid`,
    `platform_invoice_cancel`. They keep writing `subscription_payment_audit`,
    whose rows company members read; phase 3.8 moves that writer.
    `update_company_subscription_manual` keeps its signature and answers and
    gains its audit row, and its status check no longer lets NULL through.
  - Codes (`codes.manage`): `revoke_activation_code`, `hide_activation_code` and
    `delete_activation_code` keep their signatures and answers and gain their
    audit rows. `platform_discount_code_save` (create and update),
    `platform_discount_code_set_active` (revoke and re-activate) and
    `platform_discount_code_delete`. Activation code creation stays in the
    generate-activation-code function.
  - `platform_audit_record` accepts only the actions the edge functions send,
    listed with their category and capability in
    `app_private.platform_edge_audit_actions()`. A role that lacks an action's
    capability may record only its refusal (`denied`), and one actor may write
    at most 120 such rows a minute.
  - `companies.status` accepts `archived` and `deleted`. CompaniesPage has
    written both since 20260501182906 added archived_at and deleted_at, and
    the check constraint, never widened, refused every archive and soft delete.

  ## Money

  `platform_invoice_mark_paid` takes the received amount in integer cents and
  stores `round(cents / 100, 2)` euros in `cash_received_amount`, the column's
  existing unit. A plan's `monthly_price` is copied into the subscription as it
  is stored. No other function here does arithmetic on money.

  ## Open decisions taken conservatively (marked where they apply)

  - D2: only owners hold companies.lifecycle, so only owners approve, reject,
    suspend, archive and create companies.
  - Trial extension asks companies.lifecycle, the capability of the companies
    bullet of plan 3.5, not billing.manage.
  - D13: hard delete is not here.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. Only additions, the widened check
  constraint, and function bodies whose signatures and answers are unchanged.
  The previous release's direct writes still pass their policies. Every
  function created or redefined here reaches app_private and is handed to the
  role running the migration (see "Ownership" in 20260916110010).
*/

-- ─── companies.status: the values CompaniesPage writes ──────────────────────

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_status_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_status_check
  CHECK (status = ANY (ARRAY['active', 'suspended', 'inactive', 'trial', 'archived', 'deleted']));

-- ─── Helpers the platform RPCs share ────────────────────────────────────────

-- The answer a platform RPC returns. p_reason NULL is success.
CREATE OR REPLACE FUNCTION app_private.platform_rpc_response(p_reason text, p_extra jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_reason IS NULL THEN jsonb_build_object('success', true) || coalesce(p_extra, '{}'::jsonb)
    ELSE jsonb_build_object(
      'success', false,
      'reason',  p_reason,
      'error',   CASE p_reason
        WHEN 'denied'             THEN 'Keine Berechtigung für diese Aktion.'
        WHEN 'invalid'            THEN 'Ungültige Eingabe.'
        WHEN 'not_found'          THEN 'Nicht gefunden.'
        WHEN 'invalid_status'     THEN 'Diese Aktion ist im aktuellen Zustand nicht möglich.'
        WHEN 'slug_taken'         THEN 'Dieser Slug ist bereits vergeben.'
        WHEN 'code_taken'         THEN 'Dieser Code existiert bereits.'
        WHEN 'no_trial'           THEN 'Für dieses Unternehmen ist keine Testphase eingetragen.'
        WHEN 'plan_inactive'      THEN 'Dieser Plan ist nicht aktiv.'
        WHEN 'account_not_found'  THEN 'Konto nicht gefunden.'
        WHEN 'account_in_company' THEN 'Dieses Konto gehört zu einem Unternehmen und kann nicht zum Plattform-Team hinzugefügt werden.'
        WHEN 'already_staff'      THEN 'Dieses Konto gehört bereits zum Plattform-Team.'
        WHEN 'already_disabled'   THEN 'Dieses Konto ist bereits deaktiviert.'
        WHEN 'already_enabled'    THEN 'Dieses Konto ist bereits aktiv.'
        WHEN 'last_owner'         THEN 'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert werden.'
        WHEN 'role_requires_3_3'  THEN 'Andere Rollen als "owner" sind erst ab Plan-Schritt 3.3 möglich.'
        ELSE 'Die Aktion konnte nicht ausgeführt werden.'
      END)
  END;
$$;

-- Writes the one audit row of a call that passed authorization. A reason makes
-- it a refusal: `denied` for the refusals that protect the platform itself,
-- `error` for everything else a valid caller can run into.
CREATE OR REPLACE FUNCTION app_private.platform_rpc_record(
  p_category    text,
  p_action      text,
  p_reason      text,
  p_company_id  uuid,
  p_target_type text,
  p_target_id   text,
  p_before      jsonb,
  p_after       jsonb
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM app_private.audit_write(
    p_category,
    p_action,
    CASE
      WHEN p_reason IS NULL THEN 'ok'
      WHEN p_reason IN ('denied', 'last_owner', 'role_requires_3_3') THEN 'denied'
      ELSE 'error'
    END,
    p_company_id,
    p_target_type,
    p_target_id,
    CASE WHEN p_reason IS NULL THEN p_before END,
    CASE WHEN p_reason IS NULL THEN p_after
         ELSE jsonb_build_object('reason', p_reason) || coalesce(p_after, '{}'::jsonb) END);
END;
$$;

-- Record and answer in one step.
CREATE OR REPLACE FUNCTION app_private.platform_rpc_finish(
  p_category    text,
  p_action      text,
  p_reason      text,
  p_company_id  uuid,
  p_target_type text,
  p_target_id   text,
  p_before      jsonb,
  p_after       jsonb,
  p_extra       jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM app_private.platform_rpc_record(p_category, p_action, p_reason, p_company_id,
                                          p_target_type, p_target_id, p_before, p_after);
  RETURN app_private.platform_rpc_response(p_reason, CASE WHEN p_reason IS NULL THEN p_extra END);
END;
$$;

-- Whether the caller holds the capability. When it does not, the refusal is
-- recorded here: for any signed-in caller, a company user included (its row
-- carries no role), but at most c_denied_per_minute rows per actor, so calling
-- a platform RPC in a loop cannot grow the log without bound. A caller without
-- a subject is never recorded; the public RPCs grant anon nothing anyway.
CREATE OR REPLACE FUNCTION app_private.platform_rpc_authorize(
  p_capability  text,
  p_category    text,
  p_action      text,
  p_company_id  uuid DEFAULT NULL,
  p_target_type text DEFAULT NULL,
  p_target_id   text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_denied_per_minute CONSTANT integer := 30;
  v_actor uuid := auth.uid();
BEGIN
  IF app_private.platform_role_can(app_private.platform_staff_role_of(v_actor), p_capability) THEN
    RETURN true;
  END IF;

  IF v_actor IS NOT NULL
     AND (SELECT count(*)
            FROM app_private.platform_audit_log l
           WHERE l.actor_user_id = v_actor
             AND l.outcome = 'denied'
             AND l.occurred_at > now() - interval '1 minute') < c_denied_per_minute
  THEN
    PERFORM app_private.audit_write(p_category, p_action, 'denied', p_company_id, p_target_type, p_target_id,
                                    NULL, jsonb_build_object('reason', 'denied', 'capability', p_capability));
  END IF;
  RETURN false;
END;
$$;

-- ─── platform_audit_record: only what the edge functions send ───────────────

-- Every action an edge function records through platform_audit_record, its
-- category, and the capability a role needs to record anything but its
-- refusal. A new edge action is a migration that replaces this function; the
-- vitest parity test in _shared/platform-access-actions.test.ts fails while a
-- route's action is missing here. NULL capability: only a refusal or an error
-- can happen under that name.
CREATE OR REPLACE FUNCTION app_private.platform_edge_audit_actions()
RETURNS TABLE (action text, category text, capability text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT a.action, a.category, a.capability
    FROM (VALUES
      ('manage_users.list',            'read',  'business.read'),
      ('manage_users.create',          'write', 'company_users.manage'),
      ('manage_users.update',          'write', 'company_users.manage'),
      ('manage_users.set_status',      'write', 'company_users.manage'),
      ('manage_users.resend_invite',   'write', 'company_users.manage'),
      ('manage_users.reset_password',  'write', 'company_users.manage'),
      ('manage_users.delete',          'write', 'company_users.manage'),
      ('manage_users.unknown',         'write', NULL),
      ('activation_code.generate',     'write', 'codes.manage'),
      ('platform_staff_invite.create', 'write', 'staff.manage'),
      ('platform_staff_invite.resend', 'write', 'staff.manage')
    ) AS a(action, category, capability);
$$;

-- Signature, grants and the NULL answer for a caller without a role are as in
-- 20260916110000. New: the action must be one the edge functions send, in its
-- category; only a role holding that action's capability may record an
-- attempt, an ok or an error (any staff role may record its own refusal); and
-- one actor gets at most c_rows_per_minute edge rows a minute. Every refusal
-- raises, so an edge function's fail-closed helper stops the action.
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
DECLARE
  c_rows_per_minute CONSTANT integer := 120;
  v_actor      uuid := auth.uid();
  v_role       text;
  v_capability text;
BEGIN
  IF p_category IS NULL OR p_category NOT IN ('read','write')
     OR p_action IS NULL
     OR p_action ~ '^(platform_staff|legacy|auth)(\.|$)'
     OR p_outcome IS NULL OR p_outcome NOT IN ('attempt','ok','denied','error')
     OR NOT EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions() a
                     WHERE a.action = p_action AND a.category = p_category)
  THEN
    RAISE EXCEPTION 'platform_audit_record: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_role := app_private.platform_staff_role_of(v_actor);
  IF v_role IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.capability INTO v_capability
    FROM app_private.platform_edge_audit_actions() a
   WHERE a.action = p_action;

  IF p_outcome <> 'denied' AND NOT app_private.platform_role_can(v_role, v_capability) THEN
    RAISE EXCEPTION 'platform_audit_record: this role may record only a refusal of %', p_action
      USING ERRCODE = '42501';
  END IF;

  IF (SELECT count(*)
        FROM app_private.platform_audit_log l
       WHERE l.actor_user_id = v_actor
         AND l.occurred_at > now() - interval '1 minute'
         AND l.action IN (SELECT a.action FROM app_private.platform_edge_audit_actions() a)) >= c_rows_per_minute
  THEN
    RAISE EXCEPTION 'platform_audit_record: too many rows for this actor, try again in a minute'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN app_private.audit_write(p_category, p_action, p_outcome, p_company_id,
                                 p_target_type, p_target_id, p_before, p_after);
END;
$$;

-- ─── Companies (companies.lifecycle) ────────────────────────────────────────

-- CreateCompanyModal: the company row only, as the screen inserted it. The
-- first administrator is created through manage-users afterwards.
CREATE OR REPLACE FUNCTION public.platform_company_create(
  p_name        text,
  p_slug        text,
  p_legal_name  text DEFAULT NULL,
  p_email       text DEFAULT NULL,
  p_phone       text DEFAULT NULL,
  p_address     text DEFAULT NULL,
  p_city        text DEFAULT NULL,
  p_postal_code text DEFAULT NULL,
  p_country     text DEFAULT NULL,
  p_status      text DEFAULT 'active'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'company.create';
  v_name    text := nullif(trim(p_name), '');
  v_slug    text := nullif(trim(p_slug), '');
  v_company public.companies%ROWTYPE;
BEGIN
  -- Open decision D2: companies.lifecycle is the owners' until decided.
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', c_action, NULL, 'company', NULL) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF v_name IS NULL OR v_slug IS NULL
     OR p_status IS NULL OR p_status NOT IN ('active', 'trial', 'suspended', 'inactive') THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', NULL, 'company', NULL, NULL,
                                           jsonb_build_object('slug', v_slug, 'status', p_status));
  END IF;

  BEGIN
    INSERT INTO public.companies (name, slug, legal_name, email, phone, address, city, postal_code, country, status)
    VALUES (v_name, v_slug,
            nullif(trim(p_legal_name), ''), nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
            nullif(trim(p_address), ''), nullif(trim(p_city), ''), nullif(trim(p_postal_code), ''),
            coalesce(nullif(trim(p_country), ''), 'Deutschland'), p_status)
    RETURNING * INTO v_company;
  EXCEPTION WHEN unique_violation THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'slug_taken', NULL, 'company', NULL, NULL,
                                           jsonb_build_object('slug', v_slug));
  END;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_company.id, 'company', v_company.id::text,
                                         NULL, to_jsonb(v_company),
                                         jsonb_build_object('company', to_jsonb(v_company)));
END;
$$;

-- EditCompanyModal: every field of the form, and the status it offers. A NULL
-- status keeps the current one.
CREATE OR REPLACE FUNCTION public.platform_company_update(
  p_company_id  uuid,
  p_name        text,
  p_slug        text,
  p_legal_name  text DEFAULT NULL,
  p_email       text DEFAULT NULL,
  p_phone       text DEFAULT NULL,
  p_address     text DEFAULT NULL,
  p_city        text DEFAULT NULL,
  p_postal_code text DEFAULT NULL,
  p_country     text DEFAULT NULL,
  p_status      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'company.update';
  v_name   text := nullif(trim(p_name), '');
  v_slug   text := nullif(trim(p_slug), '');
  v_before public.companies%ROWTYPE;
  v_after  public.companies%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR v_name IS NULL OR v_slug IS NULL
     OR (p_status IS NOT NULL AND p_status NOT IN ('active', 'trial', 'suspended', 'inactive')) THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('slug', v_slug, 'status', p_status));
  END IF;

  -- NO KEY UPDATE: rows of other tables that reference the company keep being
  -- insertable while this runs.
  SELECT * INTO v_before FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  BEGIN
    UPDATE public.companies
       SET name        = v_name,
           slug        = v_slug,
           legal_name  = nullif(trim(p_legal_name), ''),
           email       = nullif(trim(p_email), ''),
           phone       = nullif(trim(p_phone), ''),
           address     = nullif(trim(p_address), ''),
           city        = nullif(trim(p_city), ''),
           postal_code = nullif(trim(p_postal_code), ''),
           country     = coalesce(nullif(trim(p_country), ''), 'Deutschland'),
           status      = coalesce(p_status, status),
           updated_at  = now()
     WHERE id = p_company_id
    RETURNING * INTO v_after;
  EXCEPTION WHEN unique_violation THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'slug_taken', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('slug', v_slug));
  END;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
                                         to_jsonb(v_before), to_jsonb(v_after),
                                         jsonb_build_object('company', to_jsonb(v_after)));
END;
$$;

-- The approval decisions of SuperAdminDashboard, column for column. Approving
-- sends no code and no mail, and neither does rejecting: the owner's decision
-- of 15.09.2026 keeps approval as it was.
CREATE OR REPLACE FUNCTION public.platform_company_set_approval(
  p_company_id uuid,
  p_decision   text,
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action text := CASE p_decision
                     WHEN 'approve' THEN 'company.approve'
                     WHEN 'reject'  THEN 'company.reject'
                     WHEN 'suspend' THEN 'company.suspend_approval'
                     ELSE 'company.set_approval'
                   END;
  v_actor  uuid := auth.uid();
  v_before public.companies%ROWTYPE;
  v_after  public.companies%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', v_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approve', 'reject', 'suspend') THEN
    RETURN app_private.platform_rpc_finish('write', v_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('decision', p_decision));
  END IF;

  SELECT * INTO v_before FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', v_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  IF p_decision = 'approve' THEN
    UPDATE public.companies
       SET approval_status  = 'approved',
           approved_at      = now(),
           approved_by      = v_actor,
           rejection_reason = NULL,
           updated_at       = now()
     WHERE id = p_company_id
    RETURNING * INTO v_after;
  ELSIF p_decision = 'reject' THEN
    UPDATE public.companies
       SET approval_status  = 'rejected',
           rejected_at      = now(),
           rejected_by      = v_actor,
           rejection_reason = nullif(trim(p_reason), ''),
           updated_at       = now()
     WHERE id = p_company_id
    RETURNING * INTO v_after;
  ELSE
    UPDATE public.companies
       SET approval_status = 'suspended',
           updated_at      = now()
     WHERE id = p_company_id
    RETURNING * INTO v_after;
  END IF;

  RETURN app_private.platform_rpc_finish('write', v_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('approval_status', v_before.approval_status, 'rejection_reason', v_before.rejection_reason,
                       'approved_at', v_before.approved_at, 'rejected_at', v_before.rejected_at),
    jsonb_build_object('approval_status', v_after.approval_status, 'rejection_reason', v_after.rejection_reason,
                       'approved_at', v_after.approved_at, 'rejected_at', v_after.rejected_at));
END;
$$;

-- The status select and the activate button of SuperAdminDashboard: the
-- company's status only, users untouched.
CREATE OR REPLACE FUNCTION public.platform_company_set_status(p_company_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'company.set_status';
  v_before text;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR p_status IS NULL OR p_status NOT IN ('active', 'trial', 'suspended', 'inactive') THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('status', p_status));
  END IF;

  SELECT c.status INTO v_before FROM public.companies c WHERE c.id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  UPDATE public.companies SET status = p_status, updated_at = now() WHERE id = p_company_id;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
                                         jsonb_build_object('status', v_before), jsonb_build_object('status', p_status));
END;
$$;

-- The lifecycle menu of CompaniesPage, with the user changes it made:
--   suspend       status suspended; the company's users suspended
--   reactivate    status active; its suspended users active again
--   archive       status archived, archived_at; its users deactivated
--   restore       status inactive, archived_at and deleted_at cleared
--   mark_deleted  status deleted, deleted_at; its users deactivated
-- A user with an active staff row is left alone, as the screen skipped the
-- profiles it flagged as platform accounts. The profile guard lets the change
-- through because the caller holds companies.lifecycle.
CREATE OR REPLACE FUNCTION public.platform_company_lifecycle(p_company_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action text := CASE WHEN p_action IN ('suspend', 'reactivate', 'archive', 'restore', 'mark_deleted')
                        THEN 'company.' || p_action ELSE 'company.lifecycle' END;
  v_before public.companies%ROWTYPE;
  v_after  public.companies%ROWTYPE;
  v_users  integer := 0;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', v_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR v_action = 'company.lifecycle' THEN
    RETURN app_private.platform_rpc_finish('write', v_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('action', p_action));
  END IF;

  SELECT * INTO v_before FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', v_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  CASE p_action
    WHEN 'suspend' THEN
      UPDATE public.companies SET status = 'suspended', updated_at = now()
       WHERE id = p_company_id RETURNING * INTO v_after;
      UPDATE public.user_profiles up SET status = 'suspended'
       WHERE up.company_id = p_company_id
         AND up.status IS DISTINCT FROM 'suspended'
         AND app_private.platform_staff_role_of(up.user_id) IS NULL;
      GET DIAGNOSTICS v_users = ROW_COUNT;
    WHEN 'reactivate' THEN
      UPDATE public.companies SET status = 'active', updated_at = now()
       WHERE id = p_company_id RETURNING * INTO v_after;
      UPDATE public.user_profiles up SET status = 'active'
       WHERE up.company_id = p_company_id
         AND up.status = 'suspended';
      GET DIAGNOSTICS v_users = ROW_COUNT;
    WHEN 'archive' THEN
      UPDATE public.companies SET status = 'archived', archived_at = now(), updated_at = now()
       WHERE id = p_company_id RETURNING * INTO v_after;
      UPDATE public.user_profiles up SET status = 'deactivated'
       WHERE up.company_id = p_company_id
         AND up.status IS DISTINCT FROM 'deactivated'
         AND app_private.platform_staff_role_of(up.user_id) IS NULL;
      GET DIAGNOSTICS v_users = ROW_COUNT;
    WHEN 'restore' THEN
      UPDATE public.companies SET status = 'inactive', archived_at = NULL, deleted_at = NULL, updated_at = now()
       WHERE id = p_company_id RETURNING * INTO v_after;
    WHEN 'mark_deleted' THEN
      UPDATE public.companies SET status = 'deleted', deleted_at = now(), updated_at = now()
       WHERE id = p_company_id RETURNING * INTO v_after;
      UPDATE public.user_profiles up SET status = 'deactivated'
       WHERE up.company_id = p_company_id
         AND up.status IS DISTINCT FROM 'deactivated'
         AND app_private.platform_staff_role_of(up.user_id) IS NULL;
      GET DIAGNOSTICS v_users = ROW_COUNT;
  END CASE;

  RETURN app_private.platform_rpc_finish('write', v_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('status', v_before.status, 'archived_at', v_before.archived_at, 'deleted_at', v_before.deleted_at),
    jsonb_build_object('status', v_after.status, 'archived_at', v_after.archived_at, 'deleted_at', v_after.deleted_at,
                       'users_changed', v_users));
END;
$$;

-- The "extend by 7 days" buttons: trial_end moves by whole days, computed here
-- rather than from the browser's copy of the date.
CREATE OR REPLACE FUNCTION public.platform_company_extend_trial(p_company_id uuid, p_days integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action   CONSTANT text    := 'company.extend_trial';
  c_max_days CONSTANT integer := 365;
  v_before timestamptz;
  v_after  timestamptz;
BEGIN
  -- Open decision (trial changes): plan 3.5 lists the trial under the
  -- companies bullet, so it asks companies.lifecycle, the narrower capability,
  -- not billing.manage.
  IF NOT app_private.platform_rpc_authorize('companies.lifecycle', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR p_days IS NULL OR p_days < 1 OR p_days > c_max_days THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('days', p_days));
  END IF;

  SELECT c.trial_end INTO v_before FROM public.companies c WHERE c.id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;
  IF v_before IS NULL THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'no_trial', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('days', p_days));
  END IF;

  UPDATE public.companies
     SET trial_end = trial_end + make_interval(days => p_days), updated_at = now()
   WHERE id = p_company_id
  RETURNING trial_end INTO v_after;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
                                         jsonb_build_object('trial_end', v_before),
                                         jsonb_build_object('trial_end', v_after, 'days', p_days),
                                         jsonb_build_object('trial_end', v_after));
END;
$$;

-- ─── Billing (billing.manage) ───────────────────────────────────────────────

-- The tariff, billing cycle and car limit selects of SuperAdminDashboard. A
-- NULL argument leaves that column as it is; the car limit keeps the screen's
-- bounds of 1 to 200.
CREATE OR REPLACE FUNCTION public.platform_company_set_plan(
  p_company_id    uuid,
  p_plan          text    DEFAULT NULL,
  p_billing_cycle text    DEFAULT NULL,
  p_car_limit     integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'billing.set_plan';
  v_before public.companies%ROWTYPE;
  v_after  public.companies%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL
     OR (p_plan IS NULL AND p_billing_cycle IS NULL AND p_car_limit IS NULL)
     OR (p_plan IS NOT NULL AND p_plan NOT IN ('basic', 'advanced', 'premium'))
     OR (p_billing_cycle IS NOT NULL AND p_billing_cycle NOT IN ('monthly', 'yearly'))
     OR (p_car_limit IS NOT NULL AND (p_car_limit < 1 OR p_car_limit > 200))
  THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text, NULL,
      jsonb_build_object('plan', p_plan, 'billing_cycle', p_billing_cycle, 'car_limit', p_car_limit));
  END IF;

  SELECT * INTO v_before FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  UPDATE public.companies
     SET plan                   = coalesce(p_plan, plan),
         billing_cycle          = coalesce(p_billing_cycle, billing_cycle),
         subscription_car_limit = coalesce(p_car_limit, subscription_car_limit),
         updated_at             = now()
   WHERE id = p_company_id
  RETURNING * INTO v_after;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('plan', v_before.plan, 'billing_cycle', v_before.billing_cycle,
                       'subscription_car_limit', v_before.subscription_car_limit),
    jsonb_build_object('plan', v_after.plan, 'billing_cycle', v_after.billing_cycle,
                       'subscription_car_limit', v_after.subscription_car_limit));
END;
$$;

-- AssignSubscriptionModal: a cash subscription on an active plan, starting
-- today (the UTC date the screen sent), and the plan's limits copied onto the
-- company and its settings, all in one transaction instead of three requests.
CREATE OR REPLACE FUNCTION public.platform_subscription_assign(
  p_company_id  uuid,
  p_plan_id     uuid,
  p_billing_day integer DEFAULT 1,
  p_notes       text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'subscription.assign';
  v_plan   public.subscription_plans%ROWTYPE;
  v_sub    public.company_subscriptions%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR p_plan_id IS NULL OR p_billing_day IS NULL OR p_billing_day < 1 OR p_billing_day > 28 THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text, NULL,
      jsonb_build_object('plan_id', p_plan_id, 'billing_day', p_billing_day));
  END IF;

  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  SELECT * INTO v_plan FROM public.subscription_plans WHERE id = p_plan_id;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('plan_id', p_plan_id));
  END IF;
  IF NOT v_plan.is_active THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'plan_inactive', p_company_id, 'company', p_company_id::text,
                                           NULL, jsonb_build_object('plan_id', p_plan_id));
  END IF;

  INSERT INTO public.company_subscriptions
    (company_id, plan_id, status, starts_at, billing_day, monthly_price, payment_method, notes)
  VALUES
    (p_company_id, p_plan_id, 'active', (now() AT TIME ZONE 'UTC')::date, p_billing_day,
     v_plan.monthly_price, 'cash', nullif(trim(p_notes), ''))
  RETURNING * INTO v_sub;

  UPDATE public.companies SET subscription_car_limit = v_plan.included_cars WHERE id = p_company_id;
  UPDATE public.company_settings SET drivers_per_car_limit = v_plan.drivers_per_car_limit WHERE company_id = p_company_id;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, p_company_id, 'company_subscription', v_sub.id::text,
    NULL,
    jsonb_build_object('plan_id', p_plan_id, 'status', v_sub.status, 'starts_at', v_sub.starts_at,
                       'billing_day', v_sub.billing_day, 'monthly_price', v_sub.monthly_price,
                       'subscription_car_limit', v_plan.included_cars,
                       'drivers_per_car_limit', v_plan.drivers_per_car_limit),
    jsonb_build_object('subscription_id', v_sub.id));
END;
$$;

-- MarkPaidModal: a cash payment of an open invoice. The amount arrives in
-- integer cents and is stored as euros with two decimals, the column's unit.
-- The payment trail row keeps the German wording the screen wrote.
CREATE OR REPLACE FUNCTION public.platform_invoice_mark_paid(
  p_invoice_id   uuid,
  p_amount_cents bigint,
  p_paid_at      timestamptz DEFAULT NULL,
  p_note         text        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'invoice.mark_paid';
  v_actor   uuid := auth.uid();
  v_invoice public.subscription_invoices%ROWTYPE;
  v_amount  numeric;
  v_paid_at timestamptz := coalesce(p_paid_at, now());
  v_name    text;
  v_email   text;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            NULL, 'subscription_invoice', p_invoice_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_invoice_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', NULL, 'subscription_invoice', p_invoice_id::text,
                                           NULL, jsonb_build_object('amount_cents', p_amount_cents));
  END IF;

  SELECT * INTO v_invoice FROM public.subscription_invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'subscription_invoice', p_invoice_id::text, NULL, NULL);
  END IF;
  -- The screen offers the action only for an invoice that is neither paid nor canceled.
  IF v_invoice.status IN ('paid', 'canceled') THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid_status', v_invoice.company_id,
                                           'subscription_invoice', p_invoice_id::text, NULL,
                                           jsonb_build_object('status', v_invoice.status));
  END IF;

  v_amount := round(p_amount_cents::numeric / 100, 2);

  SELECT up.full_name, up.email INTO v_name, v_email
    FROM public.user_profiles up
   WHERE up.user_id = v_actor
   LIMIT 1;

  UPDATE public.subscription_invoices
     SET status               = 'paid',
         paid_at              = v_paid_at,
         paid_by              = v_actor,
         collected_by         = v_actor,
         cash_received_amount = v_amount,
         receipt_note         = nullif(trim(p_note), '')
   WHERE id = p_invoice_id;

  INSERT INTO public.subscription_payment_audit
    (invoice_id, company_id, action, old_status, new_status, amount, changed_by, note)
  VALUES
    (p_invoice_id, v_invoice.company_id, 'marked_paid_cash', v_invoice.status, 'paid', v_amount, v_actor,
     coalesce(nullif(trim(p_note), ''),
              format('Barzahlung von %s erfasst', coalesce(nullif(v_name, ''), nullif(v_email, ''), 'Admin'))));

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_invoice.company_id,
                                         'subscription_invoice', p_invoice_id::text,
                                         jsonb_build_object('status', v_invoice.status),
                                         jsonb_build_object('status', 'paid', 'amount_cents', p_amount_cents,
                                                            'paid_at', v_paid_at));
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_invoice_mark_unpaid(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'invoice.mark_unpaid';
  v_invoice public.subscription_invoices%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            NULL, 'subscription_invoice', p_invoice_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_invoice FROM public.subscription_invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'subscription_invoice', p_invoice_id::text, NULL, NULL);
  END IF;
  IF v_invoice.status <> 'paid' THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid_status', v_invoice.company_id,
                                           'subscription_invoice', p_invoice_id::text, NULL,
                                           jsonb_build_object('status', v_invoice.status));
  END IF;

  UPDATE public.subscription_invoices
     SET status = 'open', paid_at = NULL, paid_by = NULL, collected_by = NULL, cash_received_amount = NULL
   WHERE id = p_invoice_id;

  INSERT INTO public.subscription_payment_audit
    (invoice_id, company_id, action, old_status, new_status, amount, changed_by, note)
  VALUES
    (p_invoice_id, v_invoice.company_id, 'marked_unpaid', v_invoice.status, 'open', v_invoice.amount, auth.uid(),
     'Als unbezahlt markiert');

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_invoice.company_id,
                                         'subscription_invoice', p_invoice_id::text,
                                         jsonb_build_object('status', v_invoice.status, 'paid_at', v_invoice.paid_at,
                                                            'cash_received_amount', v_invoice.cash_received_amount),
                                         jsonb_build_object('status', 'open'));
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_invoice_cancel(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'invoice.cancel';
  v_invoice public.subscription_invoices%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            NULL, 'subscription_invoice', p_invoice_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_invoice FROM public.subscription_invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'subscription_invoice', p_invoice_id::text, NULL, NULL);
  END IF;
  IF v_invoice.status = 'canceled' THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid_status', v_invoice.company_id,
                                           'subscription_invoice', p_invoice_id::text, NULL,
                                           jsonb_build_object('status', v_invoice.status));
  END IF;

  UPDATE public.subscription_invoices SET status = 'canceled' WHERE id = p_invoice_id;

  INSERT INTO public.subscription_payment_audit
    (invoice_id, company_id, action, old_status, new_status, amount, changed_by)
  VALUES
    (p_invoice_id, v_invoice.company_id, 'invoice_canceled', v_invoice.status, 'canceled', v_invoice.amount, auth.uid());

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_invoice.company_id,
                                         'subscription_invoice', p_invoice_id::text,
                                         jsonb_build_object('status', v_invoice.status),
                                         jsonb_build_object('status', 'canceled'));
END;
$$;

-- Unchanged from 20260916110010 except the audit rows, `reason` next to each
-- error, and a status check that no longer lets NULL through (NULL <> ALL(...)
-- is NULL, and the IF fell through to the table's NOT NULL constraint).
CREATE OR REPLACE FUNCTION public.update_company_subscription_manual(
  p_company_id                 uuid,
  p_subscription_status        text,
  p_subscription_started_at    timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_subscription_expires_at    timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_subscription_duration_type text DEFAULT NULL::text,
  p_reason                     text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'subscription.manual_update';
  v_caller_id        uuid := auth.uid();
  v_company          public.companies%ROWTYPE;
  v_allowed_statuses text[] := ARRAY['inactive','active','expired','suspended'];
BEGIN
  IF NOT app_private.platform_rpc_authorize('billing.manage', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert', 'reason', 'denied');
  END IF;

  IF p_subscription_status IS NULL OR NOT (p_subscription_status = ANY (v_allowed_statuses)) THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                            NULL, jsonb_build_object('subscription_status', p_subscription_status));
    RETURN jsonb_build_object('success', false, 'error', 'Ungültiger Abo-Status', 'reason', 'invalid');
  END IF;

  SELECT * INTO v_company FROM public.companies WHERE id = p_company_id;
  IF NOT FOUND THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
    RETURN jsonb_build_object('success', false, 'error', 'Unternehmen nicht gefunden', 'reason', 'not_found');
  END IF;

  INSERT INTO public.subscription_admin_actions
    (company_id, action_type, old_status, new_status, old_expires_at, new_expires_at, reason, created_by)
  VALUES
    (p_company_id, 'manual_edit',
     v_company.subscription_status, p_subscription_status,
     v_company.subscription_expires_at, p_subscription_expires_at,
     p_reason, v_caller_id);

  UPDATE public.companies
     SET subscription_status        = p_subscription_status,
         subscription_started_at    = COALESCE(p_subscription_started_at, subscription_started_at),
         subscription_expires_at    = p_subscription_expires_at,
         subscription_duration_type = COALESCE(p_subscription_duration_type, subscription_duration_type),
         updated_at                 = now()
   WHERE id = p_company_id;

  PERFORM app_private.platform_rpc_record('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('subscription_status', v_company.subscription_status,
                       'subscription_started_at', v_company.subscription_started_at,
                       'subscription_expires_at', v_company.subscription_expires_at,
                       'subscription_duration_type', v_company.subscription_duration_type),
    jsonb_build_object('subscription_status', p_subscription_status,
                       'subscription_started_at', COALESCE(p_subscription_started_at, v_company.subscription_started_at),
                       'subscription_expires_at', p_subscription_expires_at,
                       'subscription_duration_type', COALESCE(p_subscription_duration_type, v_company.subscription_duration_type),
                       'reason', p_reason));

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── Activation codes (codes.manage) ────────────────────────────────────────

-- The three bodies of 20260916110010, unchanged except their audit rows and a
-- `reason` next to each error. Creating a code stays in the
-- generate-activation-code function, which records it itself.

CREATE OR REPLACE FUNCTION public.delete_activation_code(p_code_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'activation_code.delete';
  v_caller_id uuid := auth.uid();
  v_code      public.activation_codes%ROWTYPE;
  v_now       timestamptz := now();
BEGIN
  IF NOT app_private.platform_rpc_authorize('codes.manage', 'write', c_action, NULL, 'activation_code', p_code_id::text) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert', 'reason', 'denied');
  END IF;

  SELECT * INTO v_code FROM public.activation_codes WHERE id = p_code_id;
  IF NOT FOUND THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'not_found', NULL, 'activation_code', p_code_id::text, NULL, NULL);
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden', 'reason', 'not_found');
  END IF;
  IF v_code.used_at IS NOT NULL OR v_code.used_company_id IS NOT NULL THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'invalid_status', v_code.company_id, 'activation_code', p_code_id::text,
                                            NULL, jsonb_build_object('status', v_code.status));
    RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht gelöscht werden', 'reason', 'invalid_status');
  END IF;
  IF v_code.deleted_at IS NOT NULL THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'invalid_status', v_code.company_id, 'activation_code', p_code_id::text,
                                            NULL, jsonb_build_object('deleted_at', v_code.deleted_at));
    RETURN jsonb_build_object('success', false, 'error', 'Code wurde bereits gelöscht', 'reason', 'invalid_status');
  END IF;

  UPDATE public.activation_codes
     SET deleted_at = v_now, deleted_by = v_caller_id
   WHERE id = p_code_id;

  PERFORM app_private.platform_rpc_record('write', c_action, NULL, v_code.company_id, 'activation_code', p_code_id::text,
                                          jsonb_build_object('deleted_at', NULL),
                                          jsonb_build_object('deleted_at', v_now));
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.hide_activation_code(p_code_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'activation_code.hide';
  v_caller_id uuid := auth.uid();
  v_code      public.activation_codes%ROWTYPE;
  v_now       timestamptz := now();
BEGIN
  IF NOT app_private.platform_rpc_authorize('codes.manage', 'write', c_action, NULL, 'activation_code', p_code_id::text) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert', 'reason', 'denied');
  END IF;

  SELECT * INTO v_code FROM public.activation_codes WHERE id = p_code_id;
  IF NOT FOUND THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'not_found', NULL, 'activation_code', p_code_id::text, NULL, NULL);
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden', 'reason', 'not_found');
  END IF;

  UPDATE public.activation_codes
     SET hidden_at = v_now, hidden_by = v_caller_id, hidden_reason = p_reason
   WHERE id = p_code_id;

  PERFORM app_private.platform_rpc_record('write', c_action, NULL, v_code.company_id, 'activation_code', p_code_id::text,
                                          jsonb_build_object('hidden_at', v_code.hidden_at, 'hidden_reason', v_code.hidden_reason),
                                          jsonb_build_object('hidden_at', v_now, 'hidden_reason', p_reason));
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_activation_code(p_code_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'activation_code.revoke';
  v_caller_id uuid := auth.uid();
  v_code      public.activation_codes%ROWTYPE;
  v_now       timestamptz := now();
BEGIN
  IF NOT app_private.platform_rpc_authorize('codes.manage', 'write', c_action, NULL, 'activation_code', p_code_id::text) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nicht autorisiert', 'reason', 'denied');
  END IF;

  SELECT * INTO v_code FROM public.activation_codes WHERE id = p_code_id;
  IF NOT FOUND THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'not_found', NULL, 'activation_code', p_code_id::text, NULL, NULL);
    RETURN jsonb_build_object('success', false, 'error', 'Code nicht gefunden', 'reason', 'not_found');
  END IF;
  IF v_code.status <> 'active' THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'invalid_status', v_code.company_id, 'activation_code', p_code_id::text,
                                            NULL, jsonb_build_object('status', v_code.status));
    RETURN jsonb_build_object('success', false, 'error', 'Nur aktive Codes können widerrufen werden', 'reason', 'invalid_status');
  END IF;
  IF v_code.used_at IS NOT NULL THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'invalid_status', v_code.company_id, 'activation_code', p_code_id::text,
                                            NULL, jsonb_build_object('used_at', v_code.used_at));
    RETURN jsonb_build_object('success', false, 'error', 'Verwendete Codes können nicht widerrufen werden', 'reason', 'invalid_status');
  END IF;

  UPDATE public.activation_codes
     SET status = 'revoked', revoked_at = v_now, revoked_by = v_caller_id
   WHERE id = p_code_id;

  PERFORM app_private.platform_rpc_record('write', c_action, NULL, v_code.company_id, 'activation_code', p_code_id::text,
                                          jsonb_build_object('status', v_code.status),
                                          jsonb_build_object('status', 'revoked', 'revoked_at', v_now));
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── Discount codes (codes.manage) ──────────────────────────────────────────

-- DiscountCodeModal, create (p_id NULL) and edit. p_fields holds the columns
-- the form sends and nothing else; a key missing from it keeps the current
-- value on edit and the column default on create. The screen's own rules hold
-- here too: a code is upper-cased and trimmed, the value is positive, and a
-- percentage is at most 100. discount_value is stored as the form sent it.
CREATE OR REPLACE FUNCTION public.platform_discount_code_save(p_id uuid, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_editable CONSTANT text[] := ARRAY[
    'code', 'description', 'discount_type', 'discount_value', 'usage_mode', 'audience_type',
    'max_redemptions', 'valid_from', 'valid_until', 'active', 'applies_to_plan',
    'applies_to_billing_cycle', 'min_cars', 'max_cars', 'assigned_company_id'];
  v_action text := CASE WHEN p_id IS NULL THEN 'discount_code.create' ELSE 'discount_code.update' END;
  v_fields jsonb;
  v_old    public.discount_codes%ROWTYPE;
  v_new    public.discount_codes%ROWTYPE;
  v_row    public.discount_codes%ROWTYPE;
  v_reason text;
BEGIN
  IF NOT app_private.platform_rpc_authorize('codes.manage', 'write', v_action, NULL, 'discount_code', p_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_fields) k WHERE k <> ALL (c_editable)) THEN
    RETURN app_private.platform_rpc_finish('write', v_action, 'invalid', NULL, 'discount_code', p_id::text, NULL, NULL);
  END IF;

  v_fields := p_fields;
  IF v_fields ? 'code' THEN
    v_fields := jsonb_set(v_fields, '{code}', to_jsonb(upper(trim(coalesce(v_fields ->> 'code', '')))));
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.discount_codes WHERE id = p_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN app_private.platform_rpc_finish('write', v_action, 'not_found', NULL, 'discount_code', p_id::text, NULL, NULL);
    END IF;
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      v_new := jsonb_populate_record(NULL::public.discount_codes,
                 '{"active": true, "applies_to_plan": "all", "applies_to_billing_cycle": "all"}'::jsonb || v_fields);
    ELSE
      v_new := jsonb_populate_record(v_old, v_fields);
    END IF;

    IF coalesce(v_new.code, '') = '' OR v_new.discount_value IS NULL OR v_new.discount_value <= 0
       OR (v_new.discount_type = 'percentage' AND v_new.discount_value > 100) THEN
      v_reason := 'invalid';
    ELSIF p_id IS NULL THEN
      INSERT INTO public.discount_codes
        (code, description, discount_type, discount_value, usage_mode, audience_type, max_redemptions,
         valid_from, valid_until, active, applies_to_plan, applies_to_billing_cycle, min_cars, max_cars,
         assigned_company_id, created_by)
      VALUES
        (v_new.code, v_new.description, v_new.discount_type, v_new.discount_value, v_new.usage_mode,
         v_new.audience_type, v_new.max_redemptions, v_new.valid_from, v_new.valid_until, v_new.active,
         v_new.applies_to_plan, v_new.applies_to_billing_cycle, v_new.min_cars, v_new.max_cars,
         v_new.assigned_company_id, auth.uid())
      RETURNING * INTO v_row;
    ELSE
      UPDATE public.discount_codes
         SET code                     = v_new.code,
             description              = v_new.description,
             discount_type            = v_new.discount_type,
             discount_value           = v_new.discount_value,
             usage_mode               = v_new.usage_mode,
             audience_type            = v_new.audience_type,
             max_redemptions          = v_new.max_redemptions,
             valid_from               = v_new.valid_from,
             valid_until              = v_new.valid_until,
             active                   = v_new.active,
             applies_to_plan          = v_new.applies_to_plan,
             applies_to_billing_cycle = v_new.applies_to_billing_cycle,
             min_cars                 = v_new.min_cars,
             max_cars                 = v_new.max_cars,
             assigned_company_id      = v_new.assigned_company_id
       WHERE id = p_id
      RETURNING * INTO v_row;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      v_reason := 'code_taken';
    WHEN data_exception OR integrity_constraint_violation THEN
      v_reason := 'invalid';
  END;

  IF v_reason IS NOT NULL THEN
    RETURN app_private.platform_rpc_finish('write', v_action, v_reason, v_old.assigned_company_id, 'discount_code', p_id::text,
                                           NULL, jsonb_build_object('code', v_fields ->> 'code'));
  END IF;

  RETURN app_private.platform_rpc_finish('write', v_action, NULL, v_row.assigned_company_id, 'discount_code', v_row.id::text,
                                         CASE WHEN p_id IS NULL THEN NULL ELSE to_jsonb(v_old) END, to_jsonb(v_row),
                                         jsonb_build_object('discount_code', to_jsonb(v_row)));
END;
$$;

-- The active toggle: revoking a discount code is switching it off, and the
-- same switch turns it back on.
CREATE OR REPLACE FUNCTION public.platform_discount_code_set_active(p_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'discount_code.set_active';
  v_code public.discount_codes%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('codes.manage', 'write', c_action, NULL, 'discount_code', p_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_id IS NULL OR p_active IS NULL THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', NULL, 'discount_code', p_id::text, NULL, NULL);
  END IF;

  SELECT * INTO v_code FROM public.discount_codes WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'discount_code', p_id::text, NULL, NULL);
  END IF;

  UPDATE public.discount_codes SET active = p_active WHERE id = p_id;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_code.assigned_company_id, 'discount_code', p_id::text,
                                         jsonb_build_object('active', v_code.active), jsonb_build_object('active', p_active));
END;
$$;

-- Deleting a code removes it, and with it its redemptions: the foreign key of
-- discount_code_redemptions cascades, exactly as the screen's DELETE did. The
-- audit row keeps the code's values.
CREATE OR REPLACE FUNCTION public.platform_discount_code_delete(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'discount_code.delete';
  v_code public.discount_codes%ROWTYPE;
BEGIN
  IF NOT app_private.platform_rpc_authorize('codes.manage', 'write', c_action, NULL, 'discount_code', p_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  SELECT * INTO v_code FROM public.discount_codes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'discount_code', p_id::text, NULL, NULL);
  END IF;

  DELETE FROM public.discount_codes WHERE id = p_id;

  RETURN app_private.platform_rpc_finish('write', c_action, NULL, v_code.assigned_company_id, 'discount_code', p_id::text,
                                         to_jsonb(v_code), NULL);
END;
$$;

-- ─── Ownership ──────────────────────────────────────────────────────────────

-- Each of these reaches app_private. On staging and production the functions
-- redefined here may belong to postgres, which cannot call the app_private
-- helpers, and CREATE OR REPLACE keeps the owner (see 20260916110010).
ALTER FUNCTION app_private.platform_rpc_response(text, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_rpc_record(text, text, text, uuid, text, text, jsonb, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_rpc_finish(text, text, text, uuid, text, text, jsonb, jsonb, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_rpc_authorize(text, text, text, uuid, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_edge_audit_actions() OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_create(text, text, text, text, text, text, text, text, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_update(uuid, text, text, text, text, text, text, text, text, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_set_approval(uuid, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_set_status(uuid, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_lifecycle(uuid, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_extend_trial(uuid, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_set_plan(uuid, text, text, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_subscription_assign(uuid, uuid, integer, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_mark_paid(uuid, bigint, timestamptz, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_mark_unpaid(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_cancel(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.delete_activation_code(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.hide_activation_code(uuid, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.revoke_activation_code(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_discount_code_save(uuid, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_discount_code_set_active(uuid, boolean) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_discount_code_delete(uuid) OWNER TO CURRENT_USER;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION app_private.platform_rpc_response(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_rpc_record(text, text, text, uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_rpc_finish(text, text, text, uuid, text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_rpc_authorize(text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_edge_audit_actions() FROM PUBLIC, anon, authenticated, service_role;

-- CREATE OR REPLACE kept 20260916110000's grants; restated so this file's
-- self-check does not lean on an earlier one.
REVOKE ALL ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb) TO authenticated;

-- The platform screens call these signed in, and nothing else does: no anon,
-- and no service role, which has no auth.uid() to be an actor.
DO $$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.platform_company_create(text, text, text, text, text, text, text, text, text, text)',
    'public.platform_company_update(uuid, text, text, text, text, text, text, text, text, text, text)',
    'public.platform_company_set_approval(uuid, text, text)',
    'public.platform_company_set_status(uuid, text)',
    'public.platform_company_lifecycle(uuid, text)',
    'public.platform_company_extend_trial(uuid, integer)',
    'public.platform_company_set_plan(uuid, text, text, integer)',
    'public.platform_subscription_assign(uuid, uuid, integer, text)',
    'public.platform_invoice_mark_paid(uuid, bigint, timestamptz, text)',
    'public.platform_invoice_mark_unpaid(uuid)',
    'public.platform_invoice_cancel(uuid)',
    'public.platform_discount_code_save(uuid, jsonb)',
    'public.platform_discount_code_set_active(uuid, boolean)',
    'public.platform_discount_code_delete(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
  END LOOP;
END $$;

-- The four RPCs of 20260916110010 keep the grants it gave them.
REVOKE ALL ON FUNCTION public.delete_activation_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_activation_code(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.hide_activation_code(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hide_activation_code(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_activation_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_activation_code(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_company_subscription_manual(uuid, text, timestamptz, timestamptz, text, text) TO authenticated, service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong text;
BEGIN
  -- 1. Every function here: SECURITY DEFINER where stated, a pinned
  --    search_path, an owner that can reach app_private, and exactly the
  --    stated EXECUTE grants.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (SELECT 1
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
          -- signature                                                                                  definer anon   authn  service
          ('app_private.platform_rpc_response(text,jsonb)',                                             false,  false, false, false),
          ('app_private.platform_rpc_record(text,text,text,uuid,text,text,jsonb,jsonb)',                false,  false, false, false),
          ('app_private.platform_rpc_finish(text,text,text,uuid,text,text,jsonb,jsonb,jsonb)',          false,  false, false, false),
          ('app_private.platform_rpc_authorize(text,text,text,uuid,text,text)',                         false,  false, false, false),
          ('app_private.platform_edge_audit_actions()',                                                 false,  false, false, false),
          ('public.platform_audit_record(text,text,text,uuid,text,text,jsonb,jsonb)',                   true,   false, true,  false),
          ('public.platform_company_create(text,text,text,text,text,text,text,text,text,text)',         true,   false, true,  false),
          ('public.platform_company_update(uuid,text,text,text,text,text,text,text,text,text,text)',    true,   false, true,  false),
          ('public.platform_company_set_approval(uuid,text,text)',                                      true,   false, true,  false),
          ('public.platform_company_set_status(uuid,text)',                                             true,   false, true,  false),
          ('public.platform_company_lifecycle(uuid,text)',                                              true,   false, true,  false),
          ('public.platform_company_extend_trial(uuid,integer)',                                        true,   false, true,  false),
          ('public.platform_company_set_plan(uuid,text,text,integer)',                                  true,   false, true,  false),
          ('public.platform_subscription_assign(uuid,uuid,integer,text)',                               true,   false, true,  false),
          ('public.platform_invoice_mark_paid(uuid,bigint,timestamptz,text)',                           true,   false, true,  false),
          ('public.platform_invoice_mark_unpaid(uuid)',                                                 true,   false, true,  false),
          ('public.platform_invoice_cancel(uuid)',                                                      true,   false, true,  false),
          ('public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)',    true,   false, true,  true),
          ('public.delete_activation_code(uuid)',                                                       true,   false, true,  true),
          ('public.hide_activation_code(uuid,text)',                                                    true,   false, true,  true),
          ('public.revoke_activation_code(uuid)',                                                       true,   false, true,  true),
          ('public.platform_discount_code_save(uuid,jsonb)',                                            true,   false, true,  false),
          ('public.platform_discount_code_set_active(uuid,boolean)',                                    true,   false, true,  false),
          ('public.platform_discount_code_delete(uuid)',                                                true,   false, true,  false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916130000 self-check: %', v_wrong;
  END IF;

  -- 2. No SECURITY DEFINER function that reaches app_private belongs to a role
  --    that cannot call its helpers (20260916110010, check 3).
  SELECT string_agg(p.oid::regprocedure::text || ' owned by ' || r.rolname, ', ') INTO v_wrong
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosecdef
     AND p.prosrc ~ 'app_private\.'
     AND NOT r.rolsuper
     AND r.oid <> (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916130000 self-check: owner cannot reach app_private: %', v_wrong;
  END IF;

  -- 3. Every capability a function or the edge action list names exists: a
  --    typo would refuse everyone, silently.
  SELECT string_agg(DISTINCT c.name, ', ') INTO v_wrong
    FROM (
      SELECT (regexp_matches(p.prosrc, 'platform_(?:role_can|rpc_authorize|can)\((?:[a-z_]+, *)?''([a-z_.]+)''', 'g'))[1] AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT a.capability FROM app_private.platform_edge_audit_actions() a WHERE a.capability IS NOT NULL
    ) c
   WHERE c.name NOT IN (SELECT m.capability FROM app_private.platform_capability_matrix() m);
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916130000 self-check: unknown capability named: %', v_wrong;
  END IF;

  -- 4. None of the public platform functions reads the profile flag (the
  --    app_private trigger that keeps it in step is the one that may).
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname LIKE 'platform\_%'
                AND p.prosrc ~ '(^|[^a-z_])is_super_admin([^a-z_]|$)') THEN
    RAISE EXCEPTION '20260916130000 self-check: a platform function reads user_profiles.is_super_admin';
  END IF;

  -- 5. The archive and soft delete of CompaniesPage pass the status check.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.companies'::regclass
                    AND conname = 'companies_status_check'
                    AND pg_get_constraintdef(oid) LIKE '%archived%'
                    AND pg_get_constraintdef(oid) LIKE '%deleted%') THEN
    RAISE EXCEPTION '20260916130000 self-check: companies_status_check does not accept archived and deleted';
  END IF;
END $$;
