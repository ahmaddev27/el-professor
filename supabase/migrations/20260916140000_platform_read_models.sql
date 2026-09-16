/*
  # Platform read models, part one (plan 3.6b, section 3.D)

  Builds on 20260916110000 and 20260916110010 (plan 3.1): the staff table, the
  capability matrix, platform_can() and app_private.audit_write().

  ## What was missing

  Platform staff had no audited way to read across companies. The super admin
  dashboard reads companies, profiles, drivers and cars straight from the
  tables, through policies built on is_user_super_admin(), and nothing records
  what it read.

  ## What this adds

  Five functions staff call with supabase-js `rpc` (a POST):

  - `platform_companies_list`  companies.read  status, approval, plan, the
                                subscription and its expiry, the trial, open
                                and overdue invoices, the last payment, and
                                counts of users, active drivers and active
                                vehicles
  - `platform_vehicles_list`   business.read   reduced columns, see below
  - `platform_drivers_list`    business.read   reduced columns, see below
  - `platform_users_list`      business.read   last sign-in and email
                                confirmation from auth.users
  - `platform_audit_list`      audit.read for the whole log; any active staff
                                role reads its own rows

  Every one of them:

  - is SECURITY DEFINER, pins its search_path, and is executable by
    `authenticated` alone (anon and the service role have no auth.uid() to
    answer for);
  - validates its arguments first and raises 22023 with a fixed message on a
    broken contract, before anything is read or recorded;
  - asks `platform_can(capability)`. A refusal is a return value,
    `{"ok": false, "reason": "not_authorized"}`, never an exception, so the
    `denied` row it writes for platform staff is kept. A signed-in account
    without a staff role gets the same answer and no row, exactly as
    platform_audit_record() writes nothing for it: otherwise any company user
    could fill the append-only log;
  - writes one audit row per call, category `read`, action
    `platform_read.<function>`, in the same transaction as the read, through
    `app_private.platform_read_record()`. When that row cannot be written the
    call raises and returns nothing. So the functions are VOLATILE, and a GET
    (a read-only transaction in PostgREST) fails instead of reading unrecorded;
  - pages with a hard maximum: `p_limit` 1..100 (default 50) and, for the
    directories, `p_offset` 0..10000. The audit list pages with a keyset cursor
    on (occurred_at, id) instead of an offset, because the log only grows.

  ## The decisions taken here, the conservative reading of each

  - D1 (record reads per session or per call): **per call**, as the 3.6b task
    states. The row records the request (filters, sort, page) and how many rows
    came back, never the data itself.
  - D3 (who reads the whole audit log): **`audit.read` only**, which today is
    the owner. Every other active staff role reads the rows it is the actor of.
  - Page size: a hard maximum of 100, and an offset ceiling of 10000. Neither is
    in the plan; both are the smallest limits that serve a directory screen.
  - The users directory leaves out every account with a `platform_staff` row, a
    disabled one included. It lists company users; staff are the team page's
    (3.12). Open for the owner.

  Each is marked again at the line that enforces it.

  ## Columns, for the owner's data protection review

  Vehicles:  id, company_id, company_name, kennzeichen, status,
             tuev_gueltig_bis, letzte_hu, created_at.
             Left out: created_by, updated_at.
  Drivers:   id, company_id, company_name, name, status, driver_usage_type,
             created_at.
             Left out: user_id, personalnummer, gender, salary_ratio,
             employment_type, every planning_* figure (target salary, hourly
             rate, min and max salary, priority), target and maximum monthly
             hours, weekdays, work windows and shift times, and the
             availability flags.
  Users:     user_id, email, full_name, company_id, company_name, role,
             role_name, status, created_at, invited_at, activated_at,
             email_confirmed_at, last_sign_in_at.
             Left out: metadata, must_change_password, the profile's bigint id,
             and everything else in auth.users. Accounts with a platform_staff
             row, a disabled one included, are not listed: the directory is
             for company users, and the team page (3.12) is where staff are
             managed (a conservative reading, open for the owner).
  Companies: id, name, slug, status, approval_status, plan, billing_cycle,
             subscription_car_limit, subscription_status,
             subscription_started_at, subscription_expires_at,
             subscription_duration_type, trial_start, trial_end, trial_state,
             created_at, archived_at, deleted_at, open_invoice_count,
             overdue_invoice_count, last_payment_at, user_count,
             active_driver_count, active_vehicle_count.
             Left out: contact and address fields, the legal name, the logo,
             referral and discount fields, approval notes and the rejection
             reason. No money figure is returned, so no rounding rule applies.

  ## How the company figures follow the existing system

  - trial_state: 'running' when status is 'trial' and trial_end lies ahead,
    'expired' when status is 'trial' and trial_end has passed, otherwise null.
    SuperAdminDashboard.tsx counts trials the same way.
  - open_invoice_count: invoices with status 'open' (SubscriptionBillingPage).
  - overdue_invoice_count: status 'open' whose due date has passed, compared
    the way the billing page does (`new Date(due_date) < now`, a UTC midnight),
    plus status 'overdue', which the invoice badge and PDF show as overdue.
    Nothing writes that status today.
  - last_payment_at: the latest paid_at of a 'paid' invoice. Activation codes
    and manual subscription edits are not payments here; plan 3.F brings them
    into one coverage model.
  - user_count: every profile of the company without a platform_staff row.
  - active_driver_count, active_vehicle_count: rows whose status IS DISTINCT
    FROM 'inactive', the rule enforce_driver_limit and enforce_car_limit count
    against the subscription.

  The figures are computed set-based for the page's companies only: one grouped
  query per table, restricted to the page's ids, never a per-company subquery
  over a whole table. They read neither fahrtenbuch_trips nor receipts.
  tests/rls/platform-readmodels.sql EXPLAINs the statements on seeded data.

  ## Why the SQL sits in app_private.*_statement()

  Each list's single SQL statement is returned by a function and run with
  EXECUTE … USING. The public function and the tests then run exactly the same
  text, so the test can EXPLAIN ANALYZE what production runs, and each call is
  planned with its own parameter values.

  ## platform_audit_record

  `platform_read.` is a namespace only the database writes, so
  platform_audit_record() refuses it from now on, next to platform_staff.,
  legacy. and auth. (CLAUDE.md: a new database-written namespace goes on that
  list in the same migration). Nothing else in that function changes.

  ## Index

  `idx_subscription_invoices_company_status` (company_id, status) INCLUDE
  (due_date, paid_at) serves every invoice figure of the companies list from
  one index.

  ## Compatibility

  Expand-only: new functions and one index. platform_audit_record keeps its
  signature and grants; the previous release sends it no platform_read.
  action. No SCHEMA_EPOCH bump.
*/

-- ─── Index ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_subscription_invoices_company_status
  ON public.subscription_invoices (company_id, status) INCLUDE (due_date, paid_at);

-- ─── Argument helpers ───────────────────────────────────────────────────────

-- The page size of every read model: 50 when not given, at most 100.
CREATE OR REPLACE FUNCTION app_private.platform_read_limit(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_default CONSTANT integer := 50;
  c_max     CONSTANT integer := 100;
BEGIN
  IF p_limit IS NULL THEN
    RETURN c_default;
  END IF;
  IF p_limit < 1 OR p_limit > c_max THEN
    RAISE EXCEPTION 'platform read model: invalid arguments' USING ERRCODE = '22023';
  END IF;
  RETURN p_limit;
END;
$$;

-- The offset of the directory lists: 0 when not given, at most 10000. Deeper
-- pages are a filter's job, and an unbounded offset makes every call sort the
-- whole table only to throw it away.
CREATE OR REPLACE FUNCTION app_private.platform_read_offset(p_offset integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max CONSTANT integer := 10000;
BEGIN
  IF p_offset IS NULL THEN
    RETURN 0;
  END IF;
  IF p_offset < 0 OR p_offset > c_max THEN
    RAISE EXCEPTION 'platform read model: invalid arguments' USING ERRCODE = '22023';
  END IF;
  RETURN p_offset;
END;
$$;

-- A status, plan, category or sort key: lower-case letters, digits and
-- underscores. Empty means not given. The value itself is compared with the
-- column, so a value no row carries finds nothing rather than raising.
CREATE OR REPLACE FUNCTION app_private.platform_read_token(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_value text := nullif(btrim(p_value), '');
BEGIN
  IF v_value IS NOT NULL AND v_value !~ '^[a-z][a-z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'platform read model: invalid arguments' USING ERRCODE = '22023';
  END IF;
  RETURN v_value;
END;
$$;

-- A free-text search as the caller typed it, trimmed; empty means not given.
CREATE OR REPLACE FUNCTION app_private.platform_read_search(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_length CONSTANT integer := 100;
  v_value text := nullif(btrim(p_value), '');
BEGIN
  IF v_value IS NOT NULL AND length(v_value) > c_max_length THEN
    RAISE EXCEPTION 'platform read model: invalid arguments' USING ERRCODE = '22023';
  END IF;
  RETURN v_value;
END;
$$;

-- The ILIKE pattern for "contains", with LIKE's own characters taken
-- literally: a search for "100%" must not match everything.
CREATE OR REPLACE FUNCTION app_private.platform_read_like(p_search text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_search IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
END;
$$;

-- ─── Recording ──────────────────────────────────────────────────────────────

-- Writes the read row of one read-model call and returns its id. An account
-- without an active staff role gets no row (NULL), like platform_audit_record.
-- An 'ok' row that cannot be written is never silently skipped: audit_write
-- raises, and so does this function when it has no staff role to record the
-- read for, which rolls back the call and everything it read.
CREATE OR REPLACE FUNCTION app_private.platform_read_record(
  p_action      text,
  p_outcome     text,
  p_company_id  uuid,
  p_target_type text,
  p_details     jsonb
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF app_private.platform_staff_role_of(auth.uid()) IS NULL THEN
    IF p_outcome = 'ok' THEN
      RAISE EXCEPTION 'platform read model: a read without a staff role cannot be recorded' USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
  END IF;

  -- Named notation, not positional: audit_write takes eleven arguments, eight
  -- of them defaulted, and the details belong in p_after. Counted out by hand
  -- they landed in p_actor_user_id, which is a uuid, so every call raised
  -- 42883 at run time — a plpgsql function call is resolved when it runs.
  v_id := app_private.audit_write(
            p_category    => 'read',
            p_action      => p_action,
            p_outcome     => p_outcome,
            p_company_id  => p_company_id,
            p_target_type => p_target_type,
            p_after       => p_details);
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'platform read model: the audit row was not written' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_id;
END;
$$;

-- ─── Statements ─────────────────────────────────────────────────────────────

-- $1 search pattern, $2 approval_status, $3 status, $4 plan,
-- $5 subscription_status, $6 trial state ('running'|'expired'|'none'),
-- $7 overdue only, $8 sort, $9 limit, $10 offset.
-- Returns one jsonb value: {"total": n, "items": [...]}.
CREATE OR REPLACE FUNCTION app_private.platform_companies_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT t.*
    FROM (SELECT c.id, c.name, c.slug, c.status, c.approval_status, c.plan, c.billing_cycle,
                 c.subscription_car_limit, c.subscription_status, c.subscription_started_at,
                 c.subscription_expires_at, c.subscription_duration_type,
                 c.trial_start, c.trial_end, c.created_at, c.archived_at, c.deleted_at,
                 CASE WHEN c.status = 'trial' AND c.trial_end >  now() THEN 'running'
                      WHEN c.status = 'trial' AND c.trial_end <= now() THEN 'expired'
                 END AS trial_state
            FROM public.companies c
           WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.slug ILIKE $1)
             AND ($2::text IS NULL OR c.approval_status = $2)
             AND ($3::text IS NULL OR c.status = $3)
             AND ($4::text IS NULL OR c.plan = $4)
             AND ($5::text IS NULL OR c.subscription_status = $5)
             AND (NOT $7::boolean
                  OR c.id IN (SELECT i.company_id
                                FROM public.subscription_invoices i
                               WHERE i.status = 'overdue'
                                  OR (i.status = 'open' AND (i.due_date::timestamp AT TIME ZONE 'UTC') < now())))) t
   WHERE $6::text IS NULL OR coalesce(t.trial_state, 'none') = $6
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $8::text = 'name_asc'                     THEN lower(f.name) END ASC  NULLS LAST,
           CASE WHEN $8::text = 'name_desc'                    THEN lower(f.name) END DESC NULLS LAST,
           CASE WHEN $8::text = 'created_at_asc'               THEN f.created_at END ASC  NULLS LAST,
           CASE WHEN $8::text = 'created_at_desc'              THEN f.created_at END DESC NULLS LAST,
           CASE WHEN $8::text = 'subscription_expires_at_asc'  THEN f.subscription_expires_at END ASC  NULLS LAST,
           CASE WHEN $8::text = 'subscription_expires_at_desc' THEN f.subscription_expires_at END DESC NULLS LAST,
           CASE WHEN $8::text = 'trial_end_asc'                THEN f.trial_end END ASC  NULLS LAST,
           CASE WHEN $8::text = 'trial_end_desc'               THEN f.trial_end END DESC NULLS LAST,
           f.id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $9::integer OFFSET $10::integer
),
invoice_figures AS (
  SELECT i.company_id,
         count(*) FILTER (WHERE i.status = 'open') AS open_invoices,
         count(*) FILTER (WHERE i.status = 'overdue'
                             OR (i.status = 'open' AND (i.due_date::timestamp AT TIME ZONE 'UTC') < now())) AS overdue_invoices,
         max(i.paid_at) FILTER (WHERE i.status = 'paid') AS last_payment_at
    FROM public.subscription_invoices i
   WHERE i.company_id IN (SELECT p.id FROM page p)
   GROUP BY i.company_id
),
user_counts AS (
  SELECT up.company_id, count(*) AS users
    FROM public.user_profiles up
   WHERE up.company_id IN (SELECT p.id FROM page p)
     AND NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = up.user_id)
   GROUP BY up.company_id
),
driver_counts AS (
  SELECT d.company_id, count(*) AS drivers
    FROM public.drivers d
   WHERE d.company_id IN (SELECT p.id FROM page p)
     AND d.status IS DISTINCT FROM 'inactive'
   GROUP BY d.company_id
),
vehicle_counts AS (
  SELECT v.company_id, count(*) AS vehicles
    FROM public.cars v
   WHERE v.company_id IN (SELECT p.id FROM page p)
     AND v.status IS DISTINCT FROM 'inactive'
   GROUP BY v.company_id
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id',                         p.id,
             'name',                       p.name,
             'slug',                       p.slug,
             'status',                     p.status,
             'approval_status',            p.approval_status,
             'plan',                       p.plan,
             'billing_cycle',              p.billing_cycle,
             'subscription_car_limit',     p.subscription_car_limit,
             'subscription_status',        p.subscription_status,
             'subscription_started_at',    p.subscription_started_at,
             'subscription_expires_at',    p.subscription_expires_at,
             'subscription_duration_type', p.subscription_duration_type,
             'trial_start',                p.trial_start,
             'trial_end',                  p.trial_end,
             'trial_state',                p.trial_state,
             'created_at',                 p.created_at,
             'archived_at',                p.archived_at,
             'deleted_at',                 p.deleted_at,
             'open_invoice_count',         coalesce(fi.open_invoices, 0),
             'overdue_invoice_count',      coalesce(fi.overdue_invoices, 0),
             'last_payment_at',            fi.last_payment_at,
             'user_count',                 coalesce(uc.users, 0),
             'active_driver_count',        coalesce(dc.drivers, 0),
             'active_vehicle_count',       coalesce(vc.vehicles, 0)
           ) ORDER BY p.ord)
      FROM page p
      LEFT JOIN invoice_figures fi ON fi.company_id = p.id
      LEFT JOIN user_counts     uc ON uc.company_id = p.id
      LEFT JOIN driver_counts   dc ON dc.company_id = p.id
      LEFT JOIN vehicle_counts  vc ON vc.company_id = p.id
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

-- $1 company_id, $2 search pattern (Kennzeichen), $3 status, $4 sort,
-- $5 limit, $6 offset.
CREATE OR REPLACE FUNCTION app_private.platform_vehicles_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT v.id, v.company_id, c.name AS company_name, v.kennzeichen, v.status,
         v.tuev_gueltig_bis, v.letzte_hu, v.created_at
    FROM public.cars v
    LEFT JOIN public.companies c ON c.id = v.company_id
   WHERE ($1::uuid IS NULL OR v.company_id = $1)
     AND ($2::text IS NULL OR v.kennzeichen ILIKE $2)
     AND ($3::text IS NULL OR v.status = $3)
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $4::text = 'kennzeichen_asc'      THEN f.kennzeichen END ASC  NULLS LAST,
           CASE WHEN $4::text = 'kennzeichen_desc'     THEN f.kennzeichen END DESC NULLS LAST,
           CASE WHEN $4::text = 'created_at_asc'       THEN f.created_at END ASC  NULLS LAST,
           CASE WHEN $4::text = 'created_at_desc'      THEN f.created_at END DESC NULLS LAST,
           CASE WHEN $4::text = 'tuev_gueltig_bis_asc' THEN f.tuev_gueltig_bis END ASC NULLS LAST,
           CASE WHEN $4::text = 'company_name_asc'     THEN lower(f.company_name) END ASC NULLS LAST,
           f.id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $5::integer OFFSET $6::integer
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id',               p.id,
             'company_id',       p.company_id,
             'company_name',     p.company_name,
             'kennzeichen',      p.kennzeichen,
             'status',           p.status,
             'tuev_gueltig_bis', p.tuev_gueltig_bis,
             'letzte_hu',        p.letzte_hu,
             'created_at',       p.created_at
           ) ORDER BY p.ord)
      FROM page p
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

-- $1 company_id, $2 search pattern (name), $3 status, $4 sort, $5 limit,
-- $6 offset.
CREATE OR REPLACE FUNCTION app_private.platform_drivers_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT d.id, d.company_id, c.name AS company_name, d.name, d.status,
         d.driver_usage_type, d.created_at
    FROM public.drivers d
    LEFT JOIN public.companies c ON c.id = d.company_id
   WHERE ($1::uuid IS NULL OR d.company_id = $1)
     AND ($2::text IS NULL OR d.name ILIKE $2)
     AND ($3::text IS NULL OR d.status = $3)
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $4::text = 'name_asc'         THEN lower(f.name) END ASC  NULLS LAST,
           CASE WHEN $4::text = 'name_desc'        THEN lower(f.name) END DESC NULLS LAST,
           CASE WHEN $4::text = 'created_at_asc'   THEN f.created_at END ASC  NULLS LAST,
           CASE WHEN $4::text = 'created_at_desc'  THEN f.created_at END DESC NULLS LAST,
           CASE WHEN $4::text = 'company_name_asc' THEN lower(f.company_name) END ASC NULLS LAST,
           f.id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $5::integer OFFSET $6::integer
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id',                p.id,
             'company_id',        p.company_id,
             'company_name',      p.company_name,
             'name',              p.name,
             'status',            p.status,
             'driver_usage_type', p.driver_usage_type,
             'created_at',        p.created_at
           ) ORDER BY p.ord)
      FROM page p
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

-- $1 company_id, $2 search pattern (email or full name), $3 status, $4 sort,
-- $5 limit, $6 offset. Accounts with a platform_staff row are not listed.
CREATE OR REPLACE FUNCTION app_private.platform_users_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT up.user_id, up.email, up.full_name, up.company_id, c.name AS company_name,
         up.role, r.name AS role_name, up.status, up.created_at, up.invited_at, up.activated_at,
         au.email_confirmed_at, au.last_sign_in_at
    FROM public.user_profiles up
    LEFT JOIN public.companies c ON c.id = up.company_id
    LEFT JOIN public.roles r ON r.id = up.role_id
    LEFT JOIN auth.users au ON au.id = up.user_id
   WHERE NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = up.user_id)
     AND ($1::uuid IS NULL OR up.company_id = $1)
     AND ($2::text IS NULL OR up.email ILIKE $2 OR up.full_name ILIKE $2)
     AND ($3::text IS NULL OR up.status = $3)
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $4::text = 'created_at_desc'      THEN f.created_at END DESC NULLS LAST,
           CASE WHEN $4::text = 'created_at_asc'       THEN f.created_at END ASC  NULLS LAST,
           CASE WHEN $4::text = 'email_asc'            THEN lower(f.email) END ASC  NULLS LAST,
           CASE WHEN $4::text = 'email_desc'           THEN lower(f.email) END DESC NULLS LAST,
           CASE WHEN $4::text = 'full_name_asc'        THEN lower(f.full_name) END ASC NULLS LAST,
           CASE WHEN $4::text = 'last_sign_in_at_desc' THEN f.last_sign_in_at END DESC NULLS LAST,
           CASE WHEN $4::text = 'company_name_asc'     THEN lower(f.company_name) END ASC NULLS LAST,
           f.user_id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $5::integer OFFSET $6::integer
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id',            p.user_id,
             'email',              p.email,
             'full_name',          p.full_name,
             'company_id',         p.company_id,
             'company_name',       p.company_name,
             'role',               p.role,
             'role_name',          p.role_name,
             'status',             p.status,
             'created_at',         p.created_at,
             'invited_at',         p.invited_at,
             'activated_at',       p.activated_at,
             'email_confirmed_at', p.email_confirmed_at,
             'last_sign_in_at',    p.last_sign_in_at
           ) ORDER BY p.ord)
      FROM page p
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

-- $1 actor_user_id, $2 company_id, $3 category, $4 action prefix, $5 outcome,
-- $6 from (inclusive), $7 to (exclusive), $8 cursor occurred_at, $9 cursor id,
-- $10 rows to fetch (the page size plus one, to learn whether more follow).
-- Returns a jsonb array, newest first.
CREATE OR REPLACE FUNCTION app_private.platform_audit_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
SELECT coalesce(jsonb_agg(jsonb_build_object(
         'id',            r.id,
         'occurred_at',   r.occurred_at,
         'actor_user_id', r.actor_user_id,
         'actor_email',   au.email,
         'actor_role',    r.actor_role,
         'session_id',    r.session_id,
         'company_id',    r.company_id,
         'company_name',  c.name,
         'category',      r.category,
         'action',        r.action,
         'outcome',       r.outcome,
         'target_type',   r.target_type,
         'target_id',     r.target_id,
         'before_value',  r.before_value,
         'after_value',   r.after_value
       ) ORDER BY r.occurred_at DESC, r.id DESC), '[]'::jsonb)
  FROM (SELECT l.*
          FROM app_private.platform_audit_log l
         WHERE ($1::uuid IS NULL OR l.actor_user_id = $1)
           AND ($2::uuid IS NULL OR l.company_id = $2)
           AND ($3::text IS NULL OR l.category = $3)
           AND ($4::text IS NULL OR left(l.action, length($4)) = $4)
           AND ($5::text IS NULL OR l.outcome = $5)
           AND ($6::timestamptz IS NULL OR l.occurred_at >= $6)
           AND ($7::timestamptz IS NULL OR l.occurred_at <  $7)
           AND ($8::timestamptz IS NULL OR (l.occurred_at, l.id) < ($8, $9::bigint))
         ORDER BY l.occurred_at DESC, l.id DESC
         LIMIT $10::integer) r
  LEFT JOIN auth.users au ON au.id = r.actor_user_id
  LEFT JOIN public.companies c ON c.id = r.company_id
$sql$;
END;
$fn$;

-- ─── platform_companies_list ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_companies_list(
  p_search              text    DEFAULT NULL,
  p_approval_status     text    DEFAULT NULL,
  p_status              text    DEFAULT NULL,
  p_plan                text    DEFAULT NULL,
  p_subscription_status text    DEFAULT NULL,
  p_trial               text    DEFAULT NULL,
  p_overdue_only        boolean DEFAULT false,
  p_sort                text    DEFAULT 'created_at_desc',
  p_limit               integer DEFAULT 50,
  p_offset              integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text   := 'platform_read.companies_list';
  c_sorts  CONSTANT text[] := ARRAY['created_at_desc', 'created_at_asc', 'name_asc', 'name_desc',
                                    'subscription_expires_at_asc', 'subscription_expires_at_desc',
                                    'trial_end_asc', 'trial_end_desc'];
  c_trials CONSTANT text[] := ARRAY['running', 'expired', 'none'];
  v_search       text;
  v_approval     text;
  v_status       text;
  v_plan         text;
  v_subscription text;
  v_trial        text;
  v_overdue_only boolean := coalesce(p_overdue_only, false);
  v_sort         text;
  v_limit        integer;
  v_offset       integer;
  v_request      jsonb;
  v_page         jsonb;
BEGIN
  -- 1. The argument contract. Nothing has been read, so nothing is recorded.
  v_search       := app_private.platform_read_search(p_search);
  v_approval     := app_private.platform_read_token(p_approval_status);
  v_status       := app_private.platform_read_token(p_status);
  v_plan         := app_private.platform_read_token(p_plan);
  v_subscription := app_private.platform_read_token(p_subscription_status);
  v_trial        := app_private.platform_read_token(p_trial);
  v_sort         := coalesce(app_private.platform_read_token(p_sort), 'created_at_desc');
  v_limit        := app_private.platform_read_limit(p_limit);
  v_offset       := app_private.platform_read_offset(p_offset);

  -- The NULL test is written out: `v_trial NOT IN (…)` is NULL when no trial
  -- filter was given, and an IF on NULL falls through without raising — the
  -- shape of the guards 20260915130000 had to fix.
  IF v_sort <> ALL (c_sorts)
     OR (v_trial IS NOT NULL AND v_trial <> ALL (c_trials))
  THEN
    RAISE EXCEPTION 'platform_companies_list: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'search', v_search, 'approval_status', v_approval, 'status', v_status, 'plan', v_plan,
    'subscription_status', v_subscription, 'trial', v_trial,
    'overdue_only', CASE WHEN v_overdue_only THEN true END,
    'sort', v_sort, 'limit', v_limit, 'offset', v_offset));

  -- 2. Authorization. A refusal is an answer, so its row is kept.
  IF NOT coalesce(public.platform_can('companies.read'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', NULL, 'company',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- 3. The read, then its row, in this transaction.
  EXECUTE app_private.platform_companies_list_statement() INTO v_page
    USING app_private.platform_read_like(v_search), v_approval, v_status, v_plan, v_subscription,
          v_trial, v_overdue_only, v_sort, v_limit, v_offset;

  PERFORM app_private.platform_read_record(c_action, 'ok', NULL, 'company',
    jsonb_build_object('request', v_request,
                       'returned', jsonb_array_length(v_page -> 'items'),
                       'total', v_page -> 'total'));

  RETURN jsonb_build_object('ok', true, 'total', v_page -> 'total', 'limit', v_limit,
                            'offset', v_offset, 'items', v_page -> 'items');
END;
$$;

-- ─── platform_vehicles_list ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_vehicles_list(
  p_company_id uuid    DEFAULT NULL,
  p_search     text    DEFAULT NULL,
  p_status     text    DEFAULT NULL,
  p_sort       text    DEFAULT 'kennzeichen_asc',
  p_limit      integer DEFAULT 50,
  p_offset     integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text   := 'platform_read.vehicles_list';
  c_sorts  CONSTANT text[] := ARRAY['kennzeichen_asc', 'kennzeichen_desc', 'created_at_asc', 'created_at_desc',
                                    'tuev_gueltig_bis_asc', 'company_name_asc'];
  v_search  text;
  v_status  text;
  v_sort    text;
  v_limit   integer;
  v_offset  integer;
  v_request jsonb;
  v_page    jsonb;
BEGIN
  v_search := app_private.platform_read_search(p_search);
  v_status := app_private.platform_read_token(p_status);
  v_sort   := coalesce(app_private.platform_read_token(p_sort), 'kennzeichen_asc');
  v_limit  := app_private.platform_read_limit(p_limit);
  v_offset := app_private.platform_read_offset(p_offset);

  IF v_sort <> ALL (c_sorts) THEN
    RAISE EXCEPTION 'platform_vehicles_list: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'company_id', p_company_id, 'search', v_search, 'status', v_status,
    'sort', v_sort, 'limit', v_limit, 'offset', v_offset));

  IF NOT coalesce(public.platform_can('business.read'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', p_company_id, 'vehicle',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  EXECUTE app_private.platform_vehicles_list_statement() INTO v_page
    USING p_company_id, app_private.platform_read_like(v_search), v_status, v_sort, v_limit, v_offset;

  PERFORM app_private.platform_read_record(c_action, 'ok', p_company_id, 'vehicle',
    jsonb_build_object('request', v_request,
                       'returned', jsonb_array_length(v_page -> 'items'),
                       'total', v_page -> 'total'));

  RETURN jsonb_build_object('ok', true, 'total', v_page -> 'total', 'limit', v_limit,
                            'offset', v_offset, 'items', v_page -> 'items');
END;
$$;

-- ─── platform_drivers_list ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_drivers_list(
  p_company_id uuid    DEFAULT NULL,
  p_search     text    DEFAULT NULL,
  p_status     text    DEFAULT NULL,
  p_sort       text    DEFAULT 'name_asc',
  p_limit      integer DEFAULT 50,
  p_offset     integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text   := 'platform_read.drivers_list';
  c_sorts  CONSTANT text[] := ARRAY['name_asc', 'name_desc', 'created_at_asc', 'created_at_desc', 'company_name_asc'];
  v_search  text;
  v_status  text;
  v_sort    text;
  v_limit   integer;
  v_offset  integer;
  v_request jsonb;
  v_page    jsonb;
BEGIN
  v_search := app_private.platform_read_search(p_search);
  v_status := app_private.platform_read_token(p_status);
  v_sort   := coalesce(app_private.platform_read_token(p_sort), 'name_asc');
  v_limit  := app_private.platform_read_limit(p_limit);
  v_offset := app_private.platform_read_offset(p_offset);

  IF v_sort <> ALL (c_sorts) THEN
    RAISE EXCEPTION 'platform_drivers_list: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'company_id', p_company_id, 'search', v_search, 'status', v_status,
    'sort', v_sort, 'limit', v_limit, 'offset', v_offset));

  IF NOT coalesce(public.platform_can('business.read'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', p_company_id, 'driver',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  EXECUTE app_private.platform_drivers_list_statement() INTO v_page
    USING p_company_id, app_private.platform_read_like(v_search), v_status, v_sort, v_limit, v_offset;

  PERFORM app_private.platform_read_record(c_action, 'ok', p_company_id, 'driver',
    jsonb_build_object('request', v_request,
                       'returned', jsonb_array_length(v_page -> 'items'),
                       'total', v_page -> 'total'));

  RETURN jsonb_build_object('ok', true, 'total', v_page -> 'total', 'limit', v_limit,
                            'offset', v_offset, 'items', v_page -> 'items');
END;
$$;

-- ─── platform_users_list ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_users_list(
  p_company_id uuid    DEFAULT NULL,
  p_search     text    DEFAULT NULL,
  p_status     text    DEFAULT NULL,
  p_sort       text    DEFAULT 'created_at_desc',
  p_limit      integer DEFAULT 50,
  p_offset     integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text   := 'platform_read.users_list';
  c_sorts  CONSTANT text[] := ARRAY['created_at_desc', 'created_at_asc', 'email_asc', 'email_desc',
                                    'full_name_asc', 'last_sign_in_at_desc', 'company_name_asc'];
  v_search  text;
  v_status  text;
  v_sort    text;
  v_limit   integer;
  v_offset  integer;
  v_request jsonb;
  v_page    jsonb;
BEGIN
  v_search := app_private.platform_read_search(p_search);
  v_status := app_private.platform_read_token(p_status);
  v_sort   := coalesce(app_private.platform_read_token(p_sort), 'created_at_desc');
  v_limit  := app_private.platform_read_limit(p_limit);
  v_offset := app_private.platform_read_offset(p_offset);

  IF v_sort <> ALL (c_sorts) THEN
    RAISE EXCEPTION 'platform_users_list: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'company_id', p_company_id, 'search', v_search, 'status', v_status,
    'sort', v_sort, 'limit', v_limit, 'offset', v_offset));

  IF NOT coalesce(public.platform_can('business.read'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', p_company_id, 'user',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  EXECUTE app_private.platform_users_list_statement() INTO v_page
    USING p_company_id, app_private.platform_read_like(v_search), v_status, v_sort, v_limit, v_offset;

  PERFORM app_private.platform_read_record(c_action, 'ok', p_company_id, 'user',
    jsonb_build_object('request', v_request,
                       'returned', jsonb_array_length(v_page -> 'items'),
                       'total', v_page -> 'total'));

  RETURN jsonb_build_object('ok', true, 'total', v_page -> 'total', 'limit', v_limit,
                            'offset', v_offset, 'items', v_page -> 'items');
END;
$$;

-- ─── platform_audit_list ────────────────────────────────────────────────────

-- audit.read reads every row (open decision D3: owners only). Any other active
-- staff role reads the rows it is the actor of; naming another actor is a
-- refusal. Newest first, paged by the (occurred_at, id) of the last row seen:
-- pass both or neither.
CREATE OR REPLACE FUNCTION public.platform_audit_list(
  p_actor_user_id      uuid        DEFAULT NULL,
  p_company_id         uuid        DEFAULT NULL,
  p_category           text        DEFAULT NULL,
  p_action_prefix      text        DEFAULT NULL,
  p_outcome            text        DEFAULT NULL,
  p_from               timestamptz DEFAULT NULL,
  p_to                 timestamptz DEFAULT NULL,
  p_before_occurred_at timestamptz DEFAULT NULL,
  p_before_id          bigint      DEFAULT NULL,
  p_limit              integer     DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_read.audit_list';
  v_uid      uuid := auth.uid();
  v_category text;
  v_prefix   text := nullif(btrim(p_action_prefix), '');
  v_outcome  text;
  v_limit    integer;
  v_scope    text;
  v_actor    uuid;
  v_request  jsonb;
  v_items    jsonb;
  v_last     jsonb;
  v_cursor   jsonb;
BEGIN
  v_category := app_private.platform_read_token(p_category);
  v_outcome  := app_private.platform_read_token(p_outcome);
  v_limit    := app_private.platform_read_limit(p_limit);

  IF (p_before_occurred_at IS NULL) <> (p_before_id IS NULL)
     OR (v_prefix IS NOT NULL AND (length(v_prefix) > 100
                                   OR v_prefix !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]*)*$'))
  THEN
    RAISE EXCEPTION 'platform_audit_list: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'actor_user_id', p_actor_user_id, 'company_id', p_company_id, 'category', v_category,
    'action_prefix', v_prefix, 'outcome', v_outcome, 'from', p_from, 'to', p_to,
    'before_occurred_at', p_before_occurred_at, 'before_id', p_before_id, 'limit', v_limit));

  IF coalesce(public.platform_can('audit.read'), false) THEN
    v_scope := 'all';
    v_actor := p_actor_user_id;
  ELSIF public.platform_staff_role() IS NOT NULL
        AND (p_actor_user_id IS NULL OR p_actor_user_id = v_uid) THEN
    v_scope := 'own';
    v_actor := v_uid;
  ELSE
    PERFORM app_private.platform_read_record(c_action, 'denied', p_company_id, 'platform_audit_log',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  EXECUTE app_private.platform_audit_list_statement() INTO v_items
    USING v_actor, p_company_id, v_category, v_prefix, v_outcome, p_from, p_to,
          p_before_occurred_at, p_before_id, v_limit + 1;

  IF jsonb_array_length(v_items) > v_limit THEN
    v_items  := v_items - v_limit;
    v_last   := v_items -> (v_limit - 1);
    v_cursor := jsonb_build_object('before_occurred_at', v_last -> 'occurred_at',
                                   'before_id',          v_last -> 'id');
  END IF;

  PERFORM app_private.platform_read_record(c_action, 'ok', p_company_id, 'platform_audit_log',
    jsonb_build_object('request', v_request, 'scope', v_scope,
                       'returned', jsonb_array_length(v_items)));

  RETURN jsonb_build_object('ok', true, 'scope', v_scope, 'limit', v_limit,
                            'next_cursor', v_cursor, 'items', v_items);
END;
$$;

-- ─── platform_audit_record: platform_read. belongs to the database ──────────

-- Unchanged from 20260916110000 except the reserved namespaces, which now
-- include platform_read. (the rows the read models above write).
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
     OR p_action ~ '^(platform_staff|legacy|auth|platform_read)(\.|$)'
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

-- ─── Ownership and privileges ───────────────────────────────────────────────

-- Each SECURITY DEFINER function here reaches app_private, which only its
-- owner or a superuser can (see 20260916110010, "Ownership"). The new ones
-- already belong to the migration role; platform_audit_record is redefined,
-- and CREATE OR REPLACE keeps whatever owner it had.
ALTER FUNCTION public.platform_companies_list(text, text, text, text, text, text, boolean, text, integer, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_vehicles_list(uuid, text, text, text, integer, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_drivers_list(uuid, text, text, text, integer, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_users_list(uuid, text, text, text, integer, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_audit_list(uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz, bigint, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.platform_read_limit(integer)                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_read_offset(integer)                        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_read_token(text)                            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_read_search(text)                           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_read_like(text)                             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_read_record(text, text, uuid, text, jsonb)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_companies_list_statement()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_vehicles_list_statement()                   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_drivers_list_statement()                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_users_list_statement()                      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_audit_list_statement()                      FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.platform_companies_list(text, text, text, text, text, text, boolean, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_companies_list(text, text, text, text, text, text, boolean, text, integer, integer)
  TO authenticated;

REVOKE ALL ON FUNCTION public.platform_vehicles_list(uuid, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_vehicles_list(uuid, text, text, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.platform_drivers_list(uuid, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_drivers_list(uuid, text, text, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.platform_users_list(uuid, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_users_list(uuid, text, text, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.platform_audit_list(uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz, bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_audit_list(uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz, bigint, integer)
  TO authenticated;

-- Restated so this file's self-check does not depend on 20260916110000's grants.
REVOKE ALL ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_audit_record(text, text, text, uuid, text, text, jsonb, jsonb)
  TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_wrong  text;
  v_gotrue boolean;
BEGIN
  -- 1. Every function here: SECURITY DEFINER where it should be, VOLATILE where
  --    it writes the log, a pinned search_path, an owner that can reach
  --    app_private, and exactly the stated EXECUTE grants.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN v.volatile AND (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) <> 'v'
                 THEN 'must be VOLATILE: it writes the audit log'
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN v.definer AND NOT EXISTS (
                      SELECT 1
                        FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'anon must not hold EXECUTE'
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'service_role must not hold EXECUTE'
             END AS problem
        FROM (VALUES
          -- signature                                                                                               definer volatile authn
          ('public.platform_companies_list(text,text,text,text,text,text,boolean,text,integer,integer)',               true,  true,  true),
          ('public.platform_vehicles_list(uuid,text,text,text,integer,integer)',                                       true,  true,  true),
          ('public.platform_drivers_list(uuid,text,text,text,integer,integer)',                                        true,  true,  true),
          ('public.platform_users_list(uuid,text,text,text,integer,integer)',                                          true,  true,  true),
          ('public.platform_audit_list(uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,bigint,integer)',  true,  true,  true),
          ('public.platform_audit_record(text,text,text,uuid,text,text,jsonb,jsonb)',                                  true,  true,  true),
          ('app_private.platform_read_record(text,text,uuid,text,jsonb)',                                              false, true,  false),
          ('app_private.platform_read_limit(integer)',                                                                 false, false, false),
          ('app_private.platform_read_offset(integer)',                                                                false, false, false),
          ('app_private.platform_read_token(text)',                                                                    false, false, false),
          ('app_private.platform_read_search(text)',                                                                   false, false, false),
          ('app_private.platform_read_like(text)',                                                                     false, false, false),
          ('app_private.platform_companies_list_statement()',                                                          false, false, false),
          ('app_private.platform_vehicles_list_statement()',                                                           false, false, false),
          ('app_private.platform_drivers_list_statement()',                                                            false, false, false),
          ('app_private.platform_users_list_statement()',                                                              false, false, false),
          ('app_private.platform_audit_list_statement()',                                                              false, false, false)
        ) AS v(sig, definer, volatile, authn)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916140000 self-check: %', v_wrong;
  END IF;

  -- 2. Each read model asks platform_can with a capability the matrix knows,
  --    records through platform_read_record, and runs its own statement.
  SELECT string_agg(v.fn, ', ') INTO v_wrong
    FROM (VALUES
      ('platform_companies_list', 'companies.read'),
      ('platform_vehicles_list',  'business.read'),
      ('platform_drivers_list',   'business.read'),
      ('platform_users_list',     'business.read'),
      ('platform_audit_list',     'audit.read')
    ) AS v(fn, capability)
   WHERE NOT EXISTS (SELECT 1 FROM app_private.platform_capability_matrix() m WHERE m.capability = v.capability)
      OR NOT EXISTS (SELECT 1
                       FROM pg_proc p
                      WHERE p.pronamespace = 'public'::regnamespace
                        AND p.proname = v.fn
                        AND p.prosrc LIKE '%public.platform_can(''' || v.capability || ''')%'
                        AND p.prosrc LIKE '%app_private.platform_read_record(%'
                        AND p.prosrc LIKE '%app_private.' || v.fn || '_statement()%');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916140000 self-check: a read model does not check, record or run what it should: %', v_wrong;
  END IF;

  -- 3. No read model reads trips or receipts.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_wrong
    FROM pg_proc p
   WHERE p.pronamespace IN ('public'::regnamespace, 'app_private'::regnamespace)
     AND p.proname ~ '^platform_(companies|vehicles|drivers|users|audit)_list(_statement)?$'
     AND p.prosrc ~ '(fahrtenbuch_trips|receipts)';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916140000 self-check: a read model reads trips or receipts: %', v_wrong;
  END IF;

  -- 4. platform_audit_record refuses the namespace the read models write.
  BEGIN
    PERFORM public.platform_audit_record('read', 'platform_read.companies_list', 'ok');
    RAISE EXCEPTION '20260916140000 self-check: platform_audit_record accepts platform_read.' USING ERRCODE = 'P0001';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- 5. Every statement plans against the real schema. The users statement reads
  --    GoTrue's columns, which a database without GoTrue (the RLS kit) lacks.
  EXECUTE 'EXPLAIN ' || app_private.platform_companies_list_statement()
    USING NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, false,
          'created_at_desc'::text, 50, 0;
  EXECUTE 'EXPLAIN ' || app_private.platform_vehicles_list_statement()
    USING NULL::uuid, NULL::text, NULL::text, 'kennzeichen_asc'::text, 50, 0;
  EXECUTE 'EXPLAIN ' || app_private.platform_drivers_list_statement()
    USING NULL::uuid, NULL::text, NULL::text, 'name_asc'::text, 50, 0;
  EXECUTE 'EXPLAIN ' || app_private.platform_audit_list_statement()
    USING NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz,
          NULL::timestamptz, NULL::bigint, 51;

  SELECT count(*) = 2 INTO v_gotrue
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass('auth.users')
     AND a.attname IN ('email_confirmed_at', 'last_sign_in_at')
     AND NOT a.attisdropped;

  IF v_gotrue THEN
    EXECUTE 'EXPLAIN ' || app_private.platform_users_list_statement()
      USING NULL::uuid, NULL::text, NULL::text, 'created_at_desc'::text, 50, 0;
  ELSE
    RAISE NOTICE '20260916140000 self-check: auth.users has no GoTrue columns here; the users statement was not planned';
  END IF;

  -- 6. The index the invoice figures read.
  IF to_regclass('public.idx_subscription_invoices_company_status') IS NULL THEN
    RAISE EXCEPTION '20260916140000 self-check: idx_subscription_invoices_company_status is missing';
  END IF;
END $$;
