/*
  Does the database's new answer match what the screens decide today?

  Plan 3.3 moves company and user state out of App.tsx and into
  `public.get_active_company_id()`. Before that migration reaches a real
  database, this file asks the same question of every account that exists there:
  would the helper admit exactly the users the screens admit, and refuse exactly
  the ones the screens refuse?

  Two expressions are compared, written from two different sources:

    db_allows      the WHERE clause of get_active_company_id()
                   (supabase/migrations/20260917130000_unified_tenant_policies.sql)
    screen_reason  App.tsx's gates in their own order, with
                   AuthContext.checkProfileAccess() and
                   AuthContext.isSubscriptionActive

  `mismatches` must be 0. Anything else means the migration would take access
  away from an account the app admits today, or leave it with an account the app
  refuses — either way, read the *reasons* it prints, not the rows.

  ## What this proves, and what it does not

  Both expressions are **hand-written here**, from one person's reading of
  App.tsx and of the migration, and this runs *before* the migration: it never
  calls `public.get_active_company_id()`. So a zero says the two texts agree
  with each other against real data — a cross-check of the reading against the
  population, not a test of the function. A misreading shared by both, or a
  later edit to the migration that is not mirrored here, still reports zero.
  What actually exercises the function is `tests/rls/tenant-state.sql`, which
  calls it as each principal through twelve company states and four account
  statuses.

  Two further limits, both deliberate:

  - It compares **whether** a profile is admitted, never **which** company the
    helper would return. The helper ends in `LIMIT 1` with no `ORDER BY`, so for
    an account with more than one profile row the company it picks is not
    defined by the query. No account has two today; if one ever does, this file
    would not notice.
  - `db_allows` is wrapped in `coalesce(…, false)` below. Without it a NULL
    column makes the three-valued expression NULL, and a NULL is counted by
    *none* of the six `count(*) FILTER` buckets — mismatches included — so the
    one case that matters (a profile the UI admits and the database refuses)
    would be invisible. The assertion after section 1 is what makes that
    impossible to miss: the buckets must account for every profile.

  ## How to run it

  Read-only, on staging, never on production, and never as part of a release:

      docker exec -i ya-mobility-staging-db-1 \
        psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
        < scripts/active-company-parity.sql

  Every statement runs inside `BEGIN READ ONLY`, so the server itself refuses
  any write. Nothing is created, not even a temporary view — a read-only
  transaction is allowed to create none, and the repeated CTE is the price of
  not needing one.

  ## What it prints

  Counts, grouped. No names, no addresses, no ids: staging holds real customers'
  data, and a parity check does not need to see any of it.
*/

\set ON_ERROR_STOP on
\pset pager off

BEGIN READ ONLY;

\echo
\echo '-- 1. the comparison: mismatches must be 0 --'
WITH parity AS (
  SELECT
    -- coalesce: NOT IN over a NULL status yields NULL, and a NULL row would be
    -- counted in none of the buckets below — not even `mismatches`. The helper
    -- itself refuses such a row (its WHERE drops it), so false is what it means.
    coalesce(
      (up.company_id IS NOT NULL
       AND up.status NOT IN ('inactive', 'suspended', 'deactivated')
       AND c.approval_status = 'approved'
       AND c.status = 'active'
       AND c.subscription_status = 'active'
       AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
      ), false) AS db_allows,
    CASE
      WHEN up.status IN ('inactive', 'suspended', 'deactivated')
        THEN 'user blocked (AuthContext.userStatusBlockReason)'
      WHEN up.company_id IS NULL
        THEN 'no company - no tenant screen to reach'
      WHEN c.status = 'suspended'               THEN 'company suspended (checkProfileAccess)'
      WHEN c.status = 'inactive'                THEN 'company inactive (checkProfileAccess)'
      WHEN c.status IN ('deleted', 'archived')  THEN 'company deleted (checkProfileAccess)'
      WHEN c.approval_status = 'pending'        THEN 'company pending (App gate 3)'
      WHEN c.approval_status = 'rejected'       THEN 'company rejected (App gate 3)'
      WHEN c.approval_status = 'suspended'      THEN 'company suspended (App gate 3)'
      WHEN NOT (c.subscription_status = 'active'
                AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
        THEN 'subscription inactive (SubscriptionGuard)'
      ELSE 'allowed'
    END AS screen_reason
  FROM public.user_profiles up
  LEFT JOIN public.companies c ON c.id = up.company_id
)
SELECT count(*)                                                             AS profiles,
       count(*) FILTER (WHERE db_allows AND screen_reason = 'allowed')      AS both_allow,
       count(*) FILTER (WHERE NOT db_allows AND screen_reason <> 'allowed') AS both_refuse,
       count(*) FILTER (WHERE db_allows <> (screen_reason = 'allowed'))     AS mismatches,
       count(*) FILTER (WHERE NOT db_allows AND screen_reason = 'allowed')  AS would_lose_access,
       count(*) FILTER (WHERE db_allows AND screen_reason <> 'allowed')     AS db_more_permissive
FROM parity;

\echo
\echo '-- 1b. the gate itself: the buckets must account for every profile --'
/*
  `both_allow` and `both_refuse` must together be every profile, which is the
  same statement as `mismatches = 0` — printed above, and enforced here, because
  a number nobody checks is not a gate. It also catches the failure the printed
  row cannot show: a value outside the vocabulary either side reads. The
  screen_reason CASE falls through to 'allowed' for any status it does not
  recognise, mirroring AuthContext.userStatusBlockReason(), which is fail-open;
  so an unknown status would be reported as agreement while the database
  refused the account. Both are checked, and both raise.
*/
DO $$
DECLARE
  v_profiles   bigint;
  v_agreed     bigint;
  v_unknown    text;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE p.db_allows = (p.screen_reason = 'allowed'))
    INTO v_profiles, v_agreed
    FROM (
      SELECT
        coalesce(
          (up.company_id IS NOT NULL
           AND up.status NOT IN ('inactive', 'suspended', 'deactivated')
           AND c.approval_status = 'approved'
           AND c.status = 'active'
           AND c.subscription_status = 'active'
           AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
          ), false) AS db_allows,
        CASE
          WHEN up.status IN ('inactive', 'suspended', 'deactivated') THEN 'blocked'
          WHEN up.company_id IS NULL                                 THEN 'blocked'
          WHEN c.status IN ('suspended', 'inactive', 'deleted', 'archived') THEN 'blocked'
          WHEN c.approval_status IN ('pending', 'rejected', 'suspended')    THEN 'blocked'
          WHEN NOT (c.subscription_status = 'active'
                    AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
            THEN 'blocked'
          ELSE 'allowed'
        END AS screen_reason
      FROM public.user_profiles up
      LEFT JOIN public.companies c ON c.id = up.company_id
    ) p;

  IF v_agreed <> v_profiles THEN
    RAISE EXCEPTION
      'parity: % of % profiles are classified differently by the two readings. Read section 1 and section 2 above before going further — this is the gate refusing, not a warning.',
      v_profiles - v_agreed, v_profiles;
  END IF;

  -- A value neither side has a rule for. The database refuses such an account
  -- (its WHERE drops it); the screens admit it. That disagreement is invisible
  -- to the buckets, because both texts above are written from the same list.
  SELECT string_agg(DISTINCT t.what || '=' || t.val, ', ') INTO v_unknown
    FROM (
      SELECT 'user_profiles.status' AS what, up.status AS val
        FROM public.user_profiles up
       WHERE up.status IS NULL
          OR up.status NOT IN ('active', 'inactive', 'pending_invite', 'suspended', 'deactivated')
      UNION ALL
      SELECT 'companies.status', c.status
        FROM public.companies c
       WHERE c.status IS NULL
          OR c.status NOT IN ('active', 'suspended', 'inactive', 'deleted', 'archived')
      UNION ALL
      SELECT 'companies.approval_status', c.approval_status
        FROM public.companies c
       WHERE c.approval_status IS NULL
          OR c.approval_status NOT IN ('pending', 'approved', 'rejected', 'suspended')
    ) t;

  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION
      'parity: a state neither reading has a rule for (%). The screens fail open on it and the database fails closed, so the comparison above cannot be trusted.',
      v_unknown;
  END IF;

  RAISE NOTICE 'parity: % profiles, all classified the same way by both readings', v_profiles;
END $$;

\echo
\echo '-- 2. why each refused account is refused (counts only) --'
WITH parity AS (
  SELECT up.company_id,
    CASE
      WHEN up.status IN ('inactive', 'suspended', 'deactivated')
        THEN 'user blocked (AuthContext.userStatusBlockReason)'
      WHEN up.company_id IS NULL
        THEN 'no company - no tenant screen to reach'
      WHEN c.status = 'suspended'               THEN 'company suspended (checkProfileAccess)'
      WHEN c.status = 'inactive'                THEN 'company inactive (checkProfileAccess)'
      WHEN c.status IN ('deleted', 'archived')  THEN 'company deleted (checkProfileAccess)'
      WHEN c.approval_status = 'pending'        THEN 'company pending (App gate 3)'
      WHEN c.approval_status = 'rejected'       THEN 'company rejected (App gate 3)'
      WHEN c.approval_status = 'suspended'      THEN 'company suspended (App gate 3)'
      WHEN NOT (c.subscription_status = 'active'
                AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
        THEN 'subscription inactive (SubscriptionGuard)'
      ELSE 'allowed'
    END AS screen_reason
  FROM public.user_profiles up
  LEFT JOIN public.companies c ON c.id = up.company_id
)
SELECT screen_reason, count(*) AS profiles, count(DISTINCT company_id) AS companies
FROM parity
GROUP BY screen_reason
ORDER BY profiles DESC;

\echo
\echo '-- 3. platform accounts, which App.tsx routes to /super-admin --'
SELECT count(*)                                               AS platform_accounts,
       count(*) FILTER (WHERE up.company_id IS NOT NULL)      AS with_a_company,
       count(*) FILTER (WHERE up.company_id IS NOT NULL
                          AND EXISTS (SELECT 1 FROM public.companies c
                                       WHERE c.id = up.company_id
                                         AND c.approval_status = 'approved'
                                         AND c.status = 'active'
                                         AND c.subscription_status = 'active'
                                         AND (c.subscription_expires_at IS NULL
                                              OR c.subscription_expires_at > now())))
                                                              AS would_still_reach_that_company
FROM public.user_profiles up
WHERE up.is_super_admin;

\echo
\echo '-- 4. companies by the state the database will read (counts only) --'
SELECT c.approval_status,
       c.status,
       c.subscription_status,
       (c.subscription_expires_at IS NOT NULL AND c.subscription_expires_at <= now()) AS expiry_passed,
       count(DISTINCT c.id) AS companies,
       count(up.user_id)    AS profiles
FROM public.companies c
LEFT JOIN public.user_profiles up ON up.company_id = c.id
GROUP BY 1, 2, 3, 4
ORDER BY companies DESC;

\echo
\echo '-- 5. business rows in a company the database will refuse --'
\echo '   (what 3.4 support sessions will have to cover; nobody reads these through the tables afterwards)'
WITH refused AS (
  SELECT c.id
  FROM public.companies c
  WHERE NOT (c.approval_status = 'approved'
             AND c.status = 'active'
             AND c.subscription_status = 'active'
             AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
)
SELECT 'drivers'           AS table_name, count(*) AS rows_in_refused_companies
  FROM public.drivers           WHERE company_id IN (SELECT id FROM refused)
UNION ALL
SELECT 'receipts',           count(*) FROM public.receipts          WHERE company_id IN (SELECT id FROM refused)
UNION ALL
SELECT 'salaries',           count(*) FROM public.salaries          WHERE company_id IN (SELECT id FROM refused)
UNION ALL
SELECT 'fahrtenbuch_trips',  count(*) FROM public.fahrtenbuch_trips WHERE company_id IN (SELECT id FROM refused)
ORDER BY 1;

ROLLBACK;
