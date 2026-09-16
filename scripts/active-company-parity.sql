/*
  Does the database's new answer match what the screens decide today?

  Plan 3.3 moves company and user state out of App.tsx and into
  `public.get_active_company_id()`. Before that migration reaches a real
  database, this file asks the same question of every account that exists there:
  would the helper admit exactly the users the screens admit, and refuse exactly
  the ones the screens refuse?

  Two expressions are compared, written from two different sources:

    db_allows      the WHERE clause of get_active_company_id()
                   (supabase/migrations/20260917100000_unified_tenant_policies.sql)
    screen_reason  App.tsx's gates in their own order, with
                   AuthContext.checkProfileAccess() and
                   AuthContext.isSubscriptionActive

  `mismatches` must be 0. Anything else means the migration would take access
  away from an account the app admits today, or leave it with an account the app
  refuses — either way, read the *reasons* it prints, not the rows.

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
    (up.company_id IS NOT NULL
     AND up.status NOT IN ('inactive', 'suspended', 'deactivated')
     AND c.approval_status = 'approved'
     AND c.status IN ('active', 'trial')
     AND c.subscription_status = 'active'
     AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now())
    ) AS db_allows,
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
                                         AND c.status IN ('active', 'trial')
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
             AND c.status IN ('active', 'trial')
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
