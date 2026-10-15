/*
  The capability matrix, two decisions (owner, 15.10.2026).

  D2, answered: `support` may approve, reject and suspend companies. Asked who
  approves companies, the owner answered "owner and support". `support` gains
  `companies.lifecycle`.

  D3, answered: every platform staff role reads the whole audit log. The owner
  answered "all as read only so no problem to read the data of clients".
  `owner` held `audit.read` already; `support`, `billing` and `read_only` gain
  it.

  Nothing else moves. In particular `billing` does not gain `business.read`:
  the second decision is about the audit log, which is not a tenant table.

  What the two capabilities reach, written here so a review does not have to
  rediscover it:

  - `companies.lifecycle` is more than the approval buttons. It is the
    capability that the lifecycle RPCs of 20260916130000 ask (create, update,
    approve/reject/suspend, set status, the lifecycle menu, extend trial), the
    capability behind the `companies` insert and update policies
    (20260917130000), and a term in the profile privilege guard. A `support`
    account therefore also creates and edits companies, and may PATCH those
    `companies` columns the U3 wall does not guard. That is the capability as
    it has always been defined. Narrowing it to approve/reject/suspend would
    be a new capability, which this migration does not invent.
    `companies.hard_delete`, `billing.manage`, `settings.manage` and
    `staff.manage` stay as they were.
  - `audit.read` is read by one function, `public.platform_audit_list` (the
    whole log for its holder, the caller's own rows otherwise). No policy
    names it.

  The function is replaced as it was written with those four pairs added, in
  the same shape (LANGUAGE sql, IMMUTABLE, SET search_path = pg_catalog).
  CREATE OR REPLACE keeps the owner and the REVOKE of 20260916110000, and the
  self-check asserts both anyway.

  Rollback needs no SCHEMA_EPOCH bump. The release before this one runs
  against the wider matrix and merely shows less: its sidebar already asks
  `audit.read` for the Protokoll entry, and its Freigaben controls ask
  `companies.lifecycle`.

  Earlier migrations that apply this one's predecessors assert the old matrix
  at the moment they run (20260916110000's self-check 3, 20260923110000's
  self-check 5). They run in filename order, before this file, so they still
  see the matrix they were written for.
*/

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

      -- D2, answered 15.10.2026: owner and support approve, reject, suspend.
      ('owner',     'companies.lifecycle'),
      ('support',   'companies.lifecycle'),

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

      -- D3, answered 15.10.2026: every role reads the whole audit log.
      ('owner',     'audit.read'),
      ('support',   'audit.read'),
      ('billing',   'audit.read'),
      ('read_only', 'audit.read'),

      ('owner',     'staff.manage')
    ) AS m(role, capability);
$$;

-- ─── self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_fn regprocedure := 'app_private.platform_capability_matrix()'::regprocedure;
BEGIN
  -- 1. The 28 old pairs plus the four new ones, nothing else.
  IF (SELECT count(*) FROM app_private.platform_capability_matrix()) <> 32
     OR (SELECT count(DISTINCT m.capability) FROM app_private.platform_capability_matrix() m) <> 14
     OR (SELECT count(*) FROM app_private.platform_capability_matrix() WHERE role = 'owner') <> 14
     OR EXISTS (SELECT 1 FROM app_private.platform_capability_matrix()
                 WHERE role NOT IN ('owner','support','billing','read_only'))
  THEN
    RAISE EXCEPTION '20261015140000 self-check 1: the matrix is not 32 pairs of 14 capabilities for four roles';
  END IF;

  -- 2. The two decisions, each on its own so neither can hide the other.
  IF NOT (app_private.platform_role_can('owner', 'companies.lifecycle')
          AND app_private.platform_role_can('support', 'companies.lifecycle'))
  THEN
    RAISE EXCEPTION '20261015140000 self-check 2a: owner and support must hold companies.lifecycle (D2)';
  END IF;
  IF NOT (app_private.platform_role_can('owner', 'audit.read')
          AND app_private.platform_role_can('support', 'audit.read')
          AND app_private.platform_role_can('billing', 'audit.read')
          AND app_private.platform_role_can('read_only', 'audit.read'))
  THEN
    RAISE EXCEPTION '20261015140000 self-check 2b: all four roles must hold audit.read (D3)';
  END IF;

  -- 3. Nothing else moved: the cells next to the two that did.
  IF app_private.platform_role_can('billing', 'companies.lifecycle')
     OR app_private.platform_role_can('read_only', 'companies.lifecycle')
     OR app_private.platform_role_can('billing', 'business.read')
     OR NOT app_private.platform_role_can('support', 'business.read')
     OR NOT app_private.platform_role_can('read_only', 'business.read')
     OR app_private.platform_role_can('support', 'billing.manage')
     OR app_private.platform_role_can('read_only', 'billing.manage')
     OR EXISTS (SELECT 1 FROM app_private.platform_capability_matrix()
                 WHERE capability IN ('companies.hard_delete', 'settings.manage', 'staff.manage')
                   AND role <> 'owner')
  THEN
    RAISE EXCEPTION '20261015140000 self-check 3: a cell other than the two decided ones moved';
  END IF;

  -- 4. The function kept its shape and stays out of every API role's reach.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_language l ON l.oid = p.prolang
                 WHERE p.oid = v_fn AND l.lanname = 'sql' AND p.provolatile = 'i'
                   AND NOT p.prosecdef
                   AND p.proconfig = ARRAY['search_path=pg_catalog']::text[])
  THEN
    RAISE EXCEPTION '20261015140000 self-check 4: the matrix function lost its shape (sql, immutable, search_path = pg_catalog)';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
  THEN
    RAISE EXCEPTION '20261015140000 self-check 4: an API role can execute the matrix function';
  END IF;

  -- 5. The one reader of audit.read still scopes by it.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.platform_audit_list(uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz, bigint, integer)'::regprocedure)
     !~ 'platform_can\(''audit\.read''\)'
  THEN
    RAISE EXCEPTION '20261015140000 self-check 5: platform_audit_list no longer asks audit.read';
  END IF;
END $$;
