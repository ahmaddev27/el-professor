/*
  # `roles` and `role_permissions`: a platform write needs a support session

  The two tables slice 3.13a (`20260921110000`) did not reach, closed on the
  same terms and in the same shape, because `20260923110000` is what makes the
  gap reachable.

  ## The gap, measured rather than assumed

  `20260917130000` gave both tables a write branch that names a capability and
  **no company**:

      roles_update   USING (is_system = false
                            AND ((company_id = get_user_company_id() AND is_company_admin())
                                 OR platform_can('company_users.manage')))
      roles_delete   USING (is_system = false
                            AND ((company_id = get_user_company_id() AND is_company_admin())
                                 OR platform_can('company_users.manage')))

  `tests/rls/matrix.sql` reads `..` for both cells and says why, in its own
  comment beside them: "`company_users.manage` still says yes, but the row is no
  longer *visible* … A U, D or M probe whose WHERE reads a column needs SELECT
  rights too, so PostgreSQL applies that policy before the write policy is ever
  consulted."

  That is true of the probe, and it is exactly as far as it goes. **A statement
  that reads no column consults no SELECT policy.** `DELETE FROM public.roles;`
  — no WHERE, no RETURNING — is decided by `roles_delete`'s USING clause alone,
  which for a caller holding `company_users.manage` reduces to `is_system =
  false`: every custom role of every company, in one statement, with no context
  open, no reason recorded and no audit row, the `role_permissions` rows
  following by cascade. The matrix cannot see it, because every probe it makes
  carries a WHERE.

  Be exact about what that measures: it is the **policy** that grants it, proven
  in SQL. Whether a particular client will form an unfiltered statement — what
  PostgREST does with a DELETE carrying no filter — is a second question and not
  a boundary we own. A policy that answers "every company" to a caller holding no
  context is wrong whichever client asks it.

  `company_users.manage` is held by `owner` and `support`. Until now only owners
  could exist, and an owner already holds `companies.hard_delete`, so this was
  not a reach an owner did not otherwise have. `20260923110000` makes `support`
  grantable — a role whose entire design is that it touches a tenant's rows only
  inside a recorded, time-limited session — so the branch has to go before that
  role does.

  ## The fix

  3.13a's shape, character for character: the capability branch becomes
  `company_id = (SELECT public.platform_support_company_id())`, the company of an
  open **support** context and NULL in every other state. Nothing else in the
  six policies changes, and the two SELECT policies are not touched at all —
  confining reads is 3.13b's slice, not this one.

  **No legitimate path is lost.** Inside a support session
  `get_user_company_id()` answers the context's company and `is_company_admin()`
  is true (`20260917140000` :576-579), so the *first* disjunct already grants
  every write a support session makes; the new term restates it and refuses
  everything else. In a `view` context both are false and both terms are false.
  `manage-users` and the Rollen screen are unaffected: the edge function runs as
  the service role, for which RLS does not apply, and a company admin writes
  through the first disjunct as before.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump: this only narrows what a platform
  account may write, and no platform account other than an owner exists in any
  released database. A rollback restores the wider policy, which is the state
  the previous release already assumes.
*/

-- ─── roles ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS roles_insert ON public.roles;
DROP POLICY IF EXISTS roles_update ON public.roles;
DROP POLICY IF EXISTS roles_delete ON public.roles;

CREATE POLICY roles_insert ON public.roles
  FOR INSERT TO authenticated
  WITH CHECK (company_id = (SELECT public.get_user_company_id())
              AND ((SELECT public.is_company_admin())
                   OR company_id = (SELECT public.platform_support_company_id())));

CREATE POLICY roles_update ON public.roles
  FOR UPDATE TO authenticated
  USING (is_system = false
         AND ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR company_id = (SELECT public.platform_support_company_id())))
  WITH CHECK (company_id = (SELECT public.get_user_company_id())
              AND ((SELECT public.is_company_admin())
                   OR company_id = (SELECT public.platform_support_company_id())));

CREATE POLICY roles_delete ON public.roles
  FOR DELETE TO authenticated
  USING (is_system = false
         AND ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR company_id = (SELECT public.platform_support_company_id())));

-- ─── role_permissions ───────────────────────────────────────────────────────

-- Each reaches its company through the parent role, as 20260917130000 wrote it.
DROP POLICY IF EXISTS role_permissions_insert ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_update ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_delete ON public.role_permissions;

CREATE POLICY role_permissions_insert ON public.role_permissions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.roles r
                       WHERE r.id = role_permissions.role_id
                         AND r.company_id = (SELECT public.get_user_company_id())
                         AND ((SELECT public.is_company_admin())
                              OR r.company_id = (SELECT public.platform_support_company_id()))));

CREATE POLICY role_permissions_update ON public.role_permissions
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.roles r
                  WHERE r.id = role_permissions.role_id
                    AND ((r.company_id = (SELECT public.get_user_company_id())
                          AND (SELECT public.is_company_admin()))
                         OR r.company_id = (SELECT public.platform_support_company_id()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.roles r
                       WHERE r.id = role_permissions.role_id
                         AND r.company_id = (SELECT public.get_user_company_id())
                         AND ((SELECT public.is_company_admin())
                              OR r.company_id = (SELECT public.platform_support_company_id()))));

CREATE POLICY role_permissions_delete ON public.role_permissions
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.roles r
                  WHERE r.id = role_permissions.role_id
                    AND ((r.company_id = (SELECT public.get_user_company_id())
                          AND (SELECT public.is_company_admin()))
                         OR r.company_id = (SELECT public.platform_support_company_id()))));

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong text;
BEGIN
  -- 1. No write policy on either table still names a capability with no company
  --    term. The SELECT policies are deliberately excluded: the read seam is
  --    3.13b's, and roles_select names no capability anyway.
  SELECT string_agg(format('%s.%s', p.tablename, p.policyname), '; ') INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('roles', 'role_permissions')
     AND p.cmd <> 'SELECT'
     AND coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%company_users.manage%';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923110010 self-check 1: an uncompanied company_users.manage branch survives: %', v_wrong;
  END IF;

  -- 2. Every one of the six names the support-session company instead, so a
  --    later restatement that simply drops the branch is caught too.
  SELECT string_agg(v.policyname, '; ') INTO v_wrong
    FROM (VALUES
      ('roles', 'roles_insert'), ('roles', 'roles_update'), ('roles', 'roles_delete'),
      ('role_permissions', 'role_permissions_insert'),
      ('role_permissions', 'role_permissions_update'),
      ('role_permissions', 'role_permissions_delete')
    ) AS v(tablename, policyname)
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public'
                        AND p.tablename = v.tablename
                        AND p.policyname = v.policyname
                        AND coalesce(p.qual, '') || coalesce(p.with_check, '')
                            LIKE '%platform_support_company_id%');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923110010 self-check 2: missing, or no support-session term: %', v_wrong;
  END IF;

  -- 3. The company term the first disjunct rests on is still the one that
  --    answers an open context, and the support-mode helper is still the one
  --    that answers only support mode.
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.platform_support_company_id()'::regprocedure)
     !~ 'platform_context_company\(true\)'
  THEN
    RAISE EXCEPTION '20260923110010 self-check 3: platform_support_company_id no longer answers support mode alone';
  END IF;
END $$;
