/*
  # platform_audit_record keeps both of its rules

  Plan 3.5, after 3.6b. This file only restates one function; it adds nothing
  new.

  ## What happened

  `20260916130000` (plan 3.5) narrowed `public.platform_audit_record` to the
  actions the edge functions actually send, made a role without an action's
  capability able to record nothing but its own refusal, and capped one actor at
  120 rows a minute — the follow-up to the 3.1 review, where any active staff
  role could write unlimited rows attributed to itself, with any action and any
  outcome.

  `20260916140000` (plan 3.6b) then re-created the same function with
  `CREATE OR REPLACE` to add its own reserved namespace, `platform_read.`. It
  carried the namespace rule and the staff check, but not the three above, so
  the last definition in the chain reopened the door: on a database with both
  migrations applied, an owner could again record `matrix.probe`, or any other
  name, with outcome `ok`.

  Nothing was wrong with either change on its own. They were written on branches
  that never saw each other, and the function is the one place where both rules
  have to live.

  `tests/rls/matrix.sql` is what caught it: the RPC probe
  `platform_audit_record(an action nothing sends)` expects `PEEEEEE` and came
  back `P00000Y` — the unlisted action was accepted for the platform owner.

  ## What this does

  Restates the function with **both** rules, and nothing else:

  - the categories `read` and `write` only;
  - no action in a namespace the database writes itself — `platform_staff.`,
    `legacy.`, `auth.` and `platform_read.` (3.6b's);
  - only an action listed in `app_private.platform_edge_audit_actions()`, in its
    category (3.5's);
  - a role that lacks that action's capability may record only `denied`;
  - at most 120 rows per actor per minute;
  - NULL, not an error, for a caller without an active staff row.

  The self-check at the end asserts the body names both `platform_read` and
  `platform_edge_audit_actions`, so a future edit that drops one of the two
  rules fails here rather than on a live database.

  ## Numbering

  The prefix of this slice is `20260916130000`. A file numbered inside it would
  sort *before* `20260916140000` and lose again, so this one is numbered after
  it. That is the whole reason for the number.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump: one function body, same signature,
  same grants, same answers for every call either branch intended to allow.
*/

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
  -- The namespaces the database writes itself (3.6b's platform_read. included)
  -- and the actions the edge functions send (3.5). Both, always.
  IF p_category IS NULL OR p_category NOT IN ('read','write')
     OR p_action IS NULL
     OR p_action ~ '^(platform_staff|legacy|auth|platform_read)(\.|$)'
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

-- It reaches app_private, so it must run as a role that can (see "Ownership" in
-- 20260916110010); CREATE OR REPLACE keeps whatever owner it had.
ALTER FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  TO authenticated;

DO $$
DECLARE
  c_sig CONSTANT text := 'public.platform_audit_record(text,text,text,uuid,text,text,jsonb,jsonb)';
  v_src text;
BEGIN
  IF to_regprocedure(c_sig) IS NULL THEN
    RAISE EXCEPTION '20260916150000 self-check: platform_audit_record is missing';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(c_sig);

  -- Both rules, named. A redefinition that drops either one fails here.
  IF v_src !~ 'platform_read' THEN
    RAISE EXCEPTION '20260916150000 self-check: the reserved namespaces of 20260916140000 are gone';
  END IF;
  IF v_src !~ 'platform_edge_audit_actions' THEN
    RAISE EXCEPTION '20260916150000 self-check: the action allow-list of 20260916130000 is gone';
  END IF;

  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(c_sig)) THEN
    RAISE EXCEPTION '20260916150000 self-check: not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                  WHERE p.oid = to_regprocedure(c_sig) AND c.setting LIKE 'search_path=%') THEN
    RAISE EXCEPTION '20260916150000 self-check: no pinned search_path';
  END IF;
  IF NOT EXISTS (SELECT 1
                   FROM pg_proc p
                   JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure(c_sig)
                    AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
    RAISE EXCEPTION '20260916150000 self-check: owner can call no app_private helper';
  END IF;
  IF has_function_privilege('anon', to_regprocedure(c_sig), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure(c_sig), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure(c_sig), 'EXECUTE') THEN
    RAISE EXCEPTION '20260916150000 self-check: EXECUTE should be authenticated only';
  END IF;
END $$;
