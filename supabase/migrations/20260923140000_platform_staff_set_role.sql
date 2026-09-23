/*
  # Changing an existing platform member's role

  Owner's request, 23.09.2026, the other half of 20260923110000. That migration
  opened all four roles to `platform_staff_add` and `platform_staff_enable`, but
  no RPC changed the role of a member who already holds one — so moving somebody
  from `support` to `billing` meant disabling the row and adding it again. That
  loses `created_by`, `created_at` and the note, and writes a removal and a fresh
  grant into the audit log for what was one change.

  ## What this adds

  `public.platform_staff_set_role(p_user_id uuid, p_role text, p_note text)`,
  built on the shape of `platform_staff_add`, `_disable` and `_enable`
  (20260916130010, `add` and `enable` restated by 20260923110000):

  - one transaction, `app_private.platform_rpc_authorize('staff.manage', …)`
    first — owners only — with its 30-denied-rows-per-actor-per-minute cap;
  - exactly one `app_private.audit_write` row of its own per call, through
    `platform_rpc_finish`: `ok` with the role before and after, `error` with the
    reason a valid caller was refused, `denied` for a refused capability. The
    staff table's own `platform_staff_audit` trigger writes its usual
    `platform_staff.update` row beside it, as it does for every other path;
  - `{success, reason, error}` with a stable reason code and a German sentence,
    never an exception for an ordinary refusal;
  - SECURITY DEFINER, a pinned `search_path`, EXECUTE for `authenticated` alone.

  ## The refusals, and why each is worded the way it is

  1. **`last_owner` — the last active owner is not demoted.** The table's trigger
     `platform_staff_keep_owner` already refuses exactly this
     (`OLD.role = 'owner' AND OLD.disabled_at IS NULL AND NEW.role <> 'owner'`),
     but it refuses by raising, and an exception rolls the audit row back with
     the change. So the function tests it first, under the same advisory lock and
     in the same order as `platform_staff_disable` (row, then lock), and answers
     a refusal that is recorded. The trigger stays exactly as it is, underneath,
     for every path that is not this function.

  2. **`not_found` / `member_disabled`.** No row at all is `not_found`, the word
     `platform_staff_disable` and `_enable` already use. A **disabled** row is
     refused separately: disable and enable are a pause button that never changes
     what is paused — `platform_staff_enable` restores the role the row already
     carries — so a role is changed while the membership is live, which keeps
     every rule this function enforces (the last active owner) computed over the
     same set it changes. The cost, stated so it is a choice and not an
     oversight: bringing a disabled `owner` back as something smaller is enable
     then set_role, and between the two calls the member is briefly a full owner.
     The way round it is to change the role **before** disabling, which this
     function allows.

  3. **`already_in_role` — a call that would change nothing is refused,** not
     answered with success. `platform_staff_disable` and `_enable` already refuse
     their own no-ops (`already_disabled`, `already_enabled`) and the reason is
     the same here: an `ok` row whose before and after are identical reads in the
     audit log as a role change that never happened, and the screen would report
     a change it did not make.

  4. **`invalid` — a role outside the four is never stored.** The same argument
     contract as `platform_staff_add`: NULL id, NULL or unknown role, or a note
     over 500 characters.

  5. **The caller may change their own row, while another active owner remains.**

     This is the one that needed deciding rather than copying, so the reasoning
     is here rather than in a commit message:

     - It can never be an escalation. `staff.manage` is the owner's capability
       alone (`app_private.platform_capability_matrix()`), so the only caller who
       reaches this function at all is already in the most privileged role. Every
       self-change it can make takes power away; a `support`, `billing` or
       `read_only` account asking to promote itself is refused at the capability
       check, with a `denied` row, before any of this runs. There is no shape of
       this call that raises the caller's own authority.
     - The lockout case is rule 1's, not this one's. An owner who is the last
       active one is refused `last_owner` whether the demotion is of their own
       row or of somebody else's, because the test is about the row, not about
       who asked.
     - What is left is an owner stepping back while a colleague still holds the
       platform. Refusing that would only mean asking the colleague to type the
       same change, which proves nothing, and it would keep owner rows alive
       longer than they are needed — the opposite of least privilege.

     So it is allowed, and it is made findable: the `ok` row's `after_value`
     carries `"self": true` when the caller changed their own row, so a
     self-demotion can be found in the log without joining the actor to the
     target. The screen says in one sentence what the person is about to lose and
     that only another owner can undo it.

  ## The note

  `p_note` NULL (or blank) leaves the note as it is; a note that is given
  replaces it. A role change must not silently erase what somebody wrote about a
  member, and this function is `set_role` — there is no note-only path through
  it, just as `platform_staff_add` only ever sets a note while adding. Clearing a
  note is therefore not something any RPC does today.

  ## The two shared helpers this restates, and what keeps the restatement honest

  - `app_private.platform_rpc_response` (live definition: 20260917140000) learns
    two sentences, `member_disabled` and `already_in_role`, and **broadens one**:
    `last_owner` said "kann nicht deaktiviert werden", which is now only half of
    what the rule refuses. The new wording is true of `platform_staff_disable`
    too, which is the function that has always returned it. Self-check 2 below
    compares every reason the function knows against its exact sentence, so this
    helper is pinned from here on — it was not pinned by anything before.
  - `app_private.platform_edge_audit_actions` (live definition: 20260916130000)
    learns `platform_staff_role.set`, the action the new `/set-role` route of the
    `platform-staff` edge function records. Self-check 3 re-asserts all eleven
    rows that were there. The action deliberately does **not** live in the
    `platform_staff.` namespace, which `platform_audit_record` refuses because
    the database writes it itself — this function's own audit row is the one that
    uses that namespace.

  `app_private.platform_rpc_record` is **not** restated: `member_disabled` and
  `already_in_role` fall to its default, `error`, which is what they are — a
  valid caller refused — and `last_owner` is already in its `denied` list.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. One new function; two helpers that
  answer more than they did and nothing less. The previous release's bundle never
  calls the new function and never sends the new action; the only change it can
  observe is the broadened `last_owner` sentence, which it displays as it comes.
*/

-- ─── platform_staff_set_role ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_staff_set_role(
  p_user_id uuid,
  p_role    text,
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_staff.set_role';
  v_row  app_private.platform_staff%ROWTYPE;
  v_note text := nullif(trim(p_note), '');
  v_next text;
  v_self boolean;
BEGIN
  IF NOT app_private.platform_rpc_authorize('staff.manage', 'staff', c_action, NULL, 'platform_staff', p_user_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  -- The four roles the table's CHECK constraint and the capability matrix know,
  -- exactly as platform_staff_add states them. Anything else is a broken
  -- request, not a policy refusal.
  IF p_user_id IS NULL OR p_role IS NULL OR p_role NOT IN ('owner', 'support', 'billing', 'read_only')
     OR length(v_note) > 500 THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'invalid', NULL, 'platform_staff', p_user_id::text,
                                           NULL, jsonb_build_object('role', p_role));
  END IF;

  SELECT * INTO v_row FROM app_private.platform_staff s WHERE s.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'not_found', NULL, 'platform_staff', p_user_id::text, NULL, NULL);
  END IF;

  -- A paused membership keeps the role it was paused with; see the header.
  IF v_row.disabled_at IS NOT NULL THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'member_disabled', NULL, 'platform_staff', p_user_id::text,
                                           NULL, jsonb_build_object('role', v_row.role));
  END IF;

  -- A call that would change nothing is refused rather than recorded as a
  -- change that happened; platform_staff_disable and _enable do the same.
  IF v_row.role = p_role THEN
    RETURN app_private.platform_rpc_finish('staff', c_action, 'already_in_role', NULL, 'platform_staff', p_user_id::text,
                                           NULL, jsonb_build_object('role', v_row.role));
  END IF;

  -- The lock platform_staff_keep_owner takes, in the same order (row, then
  -- lock) and with the same count as platform_staff_disable, so this answer and
  -- the trigger's cannot disagree. The trigger still refuses underneath.
  IF v_row.role = 'owner' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('app_private.platform_staff:active_owners', 0));
    IF NOT EXISTS (SELECT 1 FROM app_private.platform_staff s
                    WHERE s.role = 'owner' AND s.disabled_at IS NULL AND s.user_id <> p_user_id) THEN
      RETURN app_private.platform_rpc_finish('staff', c_action, 'last_owner', NULL, 'platform_staff', p_user_id::text,
                                             NULL, jsonb_build_object('role', v_row.role));
    END IF;
  END IF;

  -- IS NOT DISTINCT FROM, not `=`: auth.uid() cannot be NULL for a caller that
  -- passed the capability check, and a three-valued comparison in a value that
  -- goes into the audit log would still be wrong to write.
  v_self := (p_user_id IS NOT DISTINCT FROM auth.uid());
  v_next := coalesce(v_note, v_row.note);

  UPDATE app_private.platform_staff
     SET role = p_role,
         note = v_next
   WHERE user_id = p_user_id;

  RETURN app_private.platform_rpc_finish('staff', c_action, NULL, NULL, 'platform_staff', p_user_id::text,
                                         jsonb_build_object('role', v_row.role, 'note', v_row.note),
                                         jsonb_build_object('role', p_role, 'note', v_next, 'self', v_self));
END;
$$;

-- ─── platform_rpc_response: two sentences more, one of them broader ─────────

-- 20260917140000's body. Every branch is carried over character for character
-- except `last_owner`, which now names both halves of what the rule refuses;
-- `member_disabled` and `already_in_role` are new. Self-check 2 pins all of it.
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
        WHEN 'last_owner'         THEN 'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert oder herabgestuft werden.'
        WHEN 'role_requires_3_3'  THEN 'Andere Rollen als "owner" sind erst ab Plan-Schritt 3.3 möglich.'
        -- 20260917140000, the support sessions
        WHEN 'context_open'       THEN 'Es ist bereits ein Zugriff auf ein anderes Unternehmen offen. Bitte zuerst beenden.'
        WHEN 'reason_required'    THEN 'Für eine Support-Sitzung ist ein Grund erforderlich.'
        WHEN 'no_session'         THEN 'Diese Anmeldung ist nicht mehr gültig. Bitte erneut anmelden.'
        WHEN 'no_context'         THEN 'Es ist kein Unternehmenszugriff offen.'
        -- 20260923140000, the role change
        WHEN 'member_disabled'    THEN 'Dieses Mitglied ist deaktiviert. Bitte zuerst aktivieren und die Rolle danach ändern.'
        WHEN 'already_in_role'    THEN 'Dieses Mitglied hat diese Rolle bereits.'
        ELSE 'Die Aktion konnte nicht ausgeführt werden.'
      END)
  END;
$$;

-- ─── platform_edge_audit_actions: the /set-role route's action ──────────────

-- 20260916130000's list with one row added. Self-check 3 re-asserts the other
-- eleven, and supabase/functions/_shared/platform-access-actions.test.ts reads
-- this definition and fails the build while a route's action is missing.
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
      ('platform_staff_invite.resend', 'write', 'staff.manage'),
      -- 20260923140000: the platform-staff function's /set-role route. Not in
      -- the `platform_staff.` namespace, which platform_audit_record refuses
      -- because the database writes that one itself.
      ('platform_staff_role.set',      'write', 'staff.manage')
    ) AS a(action, category, capability);
$$;

-- ─── Ownership and privileges ───────────────────────────────────────────────

ALTER FUNCTION public.platform_staff_set_role(uuid, text, text) OWNER TO CURRENT_USER;
-- CREATE OR REPLACE keeps the owner and the grants of both helpers; these only
-- restate what 20260916130000 and 20260917140000 set. Self-check 4 proves it.
ALTER FUNCTION app_private.platform_rpc_response(text, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_edge_audit_actions() OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.platform_staff_set_role(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_set_role(uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION app_private.platform_rpc_response(text, jsonb)     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_edge_audit_actions()          FROM PUBLIC, anon, authenticated, service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_sig    CONSTANT text := 'public.platform_staff_set_role(uuid,text,text)';
  v_body   text := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = c_sig::regprocedure);
  v_missing text;
  v_wrong  text;
BEGIN
  -- 1. Shape and privileges, on the terms 20260916130010 and 20260923110000
  --    assert them for the other three staff RPCs.
  IF to_regprocedure(c_sig) IS NULL THEN
    RAISE EXCEPTION '20260923140000 self-check 1: % is missing', c_sig;
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_sig::regprocedure) THEN
    RAISE EXCEPTION '20260923140000 self-check 1: % is not SECURITY DEFINER', c_sig;
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = c_sig::regprocedure) <> 'v' THEN
    RAISE EXCEPTION '20260923140000 self-check 1: % must be VOLATILE, or PostgREST would call it with GET in a read-only transaction', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proconfig, '{}'::text[])) c(setting)
                  WHERE p.oid = c_sig::regprocedure AND c.setting LIKE 'search_path=%') THEN
    RAISE EXCEPTION '20260923140000 self-check 1: % has no pinned search_path', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = c_sig::regprocedure
                    AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
    RAISE EXCEPTION '20260923140000 self-check 1: the owner of % can call no app_private helper', c_sig;
  END IF;
  IF has_function_privilege('anon', c_sig::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', c_sig::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', c_sig::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '20260923140000 self-check 1: EXECUTE on % must be authenticated alone', c_sig;
  END IF;

  -- 2. Every rule the body carries, fragment by fragment, and every sentence
  --    platform_rpc_response answers — the helper was pinned by nothing before.
  SELECT string_agg(f.fragment, '; ') INTO v_missing
    FROM (VALUES
      ('staff.manage first',   'platform_rpc_authorize\(''staff\.manage'', ''staff'', c_action'),
      ('denied answer',        'platform_rpc_response\(''denied''\)'),
      ('the four roles',       'p_role NOT IN \(''owner'', ''support'', ''billing'', ''read_only''\)'),
      ('note length',          'length\(v_note\) > 500'),
      ('invalid',              '''invalid'''),
      ('row lock',             'WHERE s\.user_id = p_user_id FOR UPDATE'),
      ('not_found',            '''not_found'''),
      ('member_disabled',      '''member_disabled'''),
      ('already_in_role',      '''already_in_role'''),
      ('last_owner',           '''last_owner'''),
      ('owner lock',           'pg_advisory_xact_lock\(hashtextextended\(''app_private\.platform_staff:active_owners'''),
      ('counts other owners',  's\.role = ''owner'' AND s\.disabled_at IS NULL AND s\.user_id <> p_user_id'),
      ('keeps the note',       'coalesce\(v_note, v_row\.note\)'),
      ('records the self flag','''self'', v_self')
    ) AS f(fragment, pattern)
   WHERE v_body IS NULL OR v_body !~ f.pattern;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20260923140000 self-check 2: a rule of platform_staff_set_role is missing: %', v_missing;
  END IF;

  SELECT string_agg(format('%s → %L', s.reason, app_private.platform_rpc_response(s.reason) ->> 'error'), '; ')
    INTO v_wrong
    FROM (VALUES
      ('denied',             'Keine Berechtigung für diese Aktion.'),
      ('invalid',            'Ungültige Eingabe.'),
      ('not_found',          'Nicht gefunden.'),
      ('invalid_status',     'Diese Aktion ist im aktuellen Zustand nicht möglich.'),
      ('slug_taken',         'Dieser Slug ist bereits vergeben.'),
      ('code_taken',         'Dieser Code existiert bereits.'),
      ('no_trial',           'Für dieses Unternehmen ist keine Testphase eingetragen.'),
      ('plan_inactive',      'Dieser Plan ist nicht aktiv.'),
      ('account_not_found',  'Konto nicht gefunden.'),
      ('account_in_company', 'Dieses Konto gehört zu einem Unternehmen und kann nicht zum Plattform-Team hinzugefügt werden.'),
      ('already_staff',      'Dieses Konto gehört bereits zum Plattform-Team.'),
      ('already_disabled',   'Dieses Konto ist bereits deaktiviert.'),
      ('already_enabled',    'Dieses Konto ist bereits aktiv.'),
      ('last_owner',         'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert oder herabgestuft werden.'),
      ('role_requires_3_3',  'Andere Rollen als "owner" sind erst ab Plan-Schritt 3.3 möglich.'),
      ('context_open',       'Es ist bereits ein Zugriff auf ein anderes Unternehmen offen. Bitte zuerst beenden.'),
      ('reason_required',    'Für eine Support-Sitzung ist ein Grund erforderlich.'),
      ('no_session',         'Diese Anmeldung ist nicht mehr gültig. Bitte erneut anmelden.'),
      ('no_context',         'Es ist kein Unternehmenszugriff offen.'),
      ('member_disabled',    'Dieses Mitglied ist deaktiviert. Bitte zuerst aktivieren und die Rolle danach ändern.'),
      ('already_in_role',    'Dieses Mitglied hat diese Rolle bereits.'),
      -- The fallback, and that success is still success.
      ('something_else',     'Die Aktion konnte nicht ausgeführt werden.')
    ) AS s(reason, sentence)
   WHERE (app_private.platform_rpc_response(s.reason) ->> 'error') IS DISTINCT FROM s.sentence
      OR (app_private.platform_rpc_response(s.reason) ->> 'reason') IS DISTINCT FROM s.reason
      OR (app_private.platform_rpc_response(s.reason) ->> 'success') <> 'false';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923140000 self-check 2: platform_rpc_response lost or changed a sentence: %', v_wrong;
  END IF;

  IF app_private.platform_rpc_response(NULL) <> '{"success": true}'::jsonb
     OR app_private.platform_rpc_response(NULL, '{"id": 1}'::jsonb) <> '{"id": 1, "success": true}'::jsonb THEN
    RAISE EXCEPTION '20260923140000 self-check 2: platform_rpc_response no longer answers success the way it did';
  END IF;

  -- `member_disabled` and `already_in_role` are a valid caller being refused,
  -- so they must fall to platform_rpc_record's `error`, and `last_owner` must
  -- still be one of its `denied` reasons. This migration restates neither.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'app_private.platform_rpc_record(text,text,text,uuid,text,text,jsonb,jsonb)'::regprocedure)
     !~ 'p_reason IN \(''denied'', ''last_owner'', ''role_requires_3_3''\)' THEN
    RAISE EXCEPTION '20260923140000 self-check 2: platform_rpc_record no longer maps last_owner to a denied row';
  END IF;

  -- 3. The edge door's list: the new action, and all eleven that were there.
  SELECT string_agg(format('%s/%s/%s', e.action, e.category, coalesce(e.capability, 'NULL')), '; ')
    INTO v_missing
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
      ('platform_staff_invite.resend', 'write', 'staff.manage'),
      ('platform_staff_role.set',      'write', 'staff.manage')
    ) AS e(action, category, capability)
   WHERE NOT EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions() a
                      WHERE a.action = e.action AND a.category = e.category
                        AND a.capability IS NOT DISTINCT FROM e.capability);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20260923140000 self-check 3: platform_edge_audit_actions lost a row: %', v_missing;
  END IF;
  IF (SELECT count(*) FROM app_private.platform_edge_audit_actions()) <> 12 THEN
    RAISE EXCEPTION '20260923140000 self-check 3: platform_edge_audit_actions names % rows, expected 12',
      (SELECT count(*) FROM app_private.platform_edge_audit_actions());
  END IF;
  -- The namespaces platform_audit_record refuses because the database writes
  -- them: a listed action in one of them could never be recorded.
  IF EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions() a
              WHERE a.action ~ '^(platform_staff|legacy|auth|platform_read)(\.|$)') THEN
    RAISE EXCEPTION '20260923140000 self-check 3: a listed edge action sits in a namespace the database writes itself';
  END IF;

  -- 4. The two restated helpers keep the privileges they had: nobody the API
  --    authenticates as may call either.
  IF has_function_privilege('anon',          'app_private.platform_rpc_response(text,jsonb)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.platform_rpc_response(text,jsonb)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role',  'app_private.platform_rpc_response(text,jsonb)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon',          'app_private.platform_edge_audit_actions()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.platform_edge_audit_actions()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role',  'app_private.platform_edge_audit_actions()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '20260923140000 self-check 4: a restated app_private helper became callable by an API role';
  END IF;

  -- 5. The wall underneath is untouched: the trigger that refuses removing,
  --    disabling or demoting the last active owner is still on the table, and
  --    still refuses a demotion in its own right.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'app_private.platform_staff'::regclass
                    AND t.tgname = 'platform_staff_keep_owner'
                    AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '20260923140000 self-check 5: platform_staff_keep_owner is no longer on the staff table';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'app_private.platform_staff_keep_owner()'::regprocedure)
     !~ 'NEW\.role <> ''owner''' THEN
    RAISE EXCEPTION '20260923140000 self-check 5: platform_staff_keep_owner no longer refuses a demotion';
  END IF;

  -- 6. staff.manage is still the owner's alone, so no other role can reach this
  --    function at all — the reasoning behind allowing a self-demotion.
  IF NOT app_private.platform_role_can('owner', 'staff.manage')
     OR app_private.platform_role_can('support', 'staff.manage')
     OR app_private.platform_role_can('billing', 'staff.manage')
     OR app_private.platform_role_can('read_only', 'staff.manage') THEN
    RAISE EXCEPTION '20260923140000 self-check 6: staff.manage is no longer the owner role''s alone';
  END IF;
END $$;
