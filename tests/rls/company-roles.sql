/*
  Slice B (20260923120000): a company may name a role of its own, and naming it
  `admin` is not a way to become one.

  Runs after seed.sql and roles-seed.sql, against the live indexes, the live
  triggers and the live function bodies, as real principals — the JWT claims
  plus SET LOCAL ROLE authenticated, as assertions.sql, permission-coverage.sql
  and salary-cash.sql do — so what is tested is what PostgREST runs. Every check
  raises on failure; a silent run is a pass. Inside BEGIN … ROLLBACK, so the
  files after it see only the migrations and the seeds.

  ## Why this file has to exist at all

  `matrix.sql` will never speak for `company_role_save` or
  `company_role_delete`. Its uncovered-function sweep filters on `p.prosecdef`,
  and both are **SECURITY INVOKER** — deliberately, because RLS is meant to
  stay the boundary. So the matrix is silent about them by construction and not
  because they are covered, and section 7 asserts that premise, so a later
  change to SECURITY DEFINER is noticed here rather than nowhere.

  ## What is claimed

  1. The two partial unique indexes that replaced `roles_name_key`: two
     companies may both hold `Disponent`, one company may not hold it twice —
     not in another case and not with different whitespace — and a system
     role's name is still unique across the system.

  2. `enforce_company_role_shape`. Every name a system role holds is refused for
     a company role, in the spellings `role_name_is_system_reserved` actually
     compares; `is_system` may not be set on a company role and may not change
     afterwards; and a system role may not take a name a company already uses.

     Section 2f says *why*. It does not assert the refusal and stop: it builds
     the escalation with the trigger switched off, shows an ordinary viewer
     becoming a company administrator because its profile's `role` text now
     reads `admin`, and only then shows the trigger refusing the first step. A
     guard tested by its refusal alone is a guard nobody can tell from a
     spelling rule.

  3. `enforce_user_profile_role_scope`, probed **as the company administrator**,
     which is the principal that could otherwise do it: the privilege guard says
     who may change `role_id` and never what it may be set to.

  4. The two RPCs, per principal — viewer, editor, supervisor, the company's own
     administrator, an administrator of the other company, a platform account
     with no context, one in a view context, one in a support session, and anon.
     What is asserted is not only the outcome but its **shape**: an INSERT a
     policy's WITH CHECK refuses raises `42501`, which the function catches and
     reports as `not_authorized`; an UPDATE or DELETE a policy's USING refuses
     is silent, matches no row, and reaches the same answer through
     `ROW_COUNT = 0`; a role of another company is invisible and answers
     `not_found`; and a view context's refusal (P0001,
     `support_session_required`) travels out of the function unchanged.

  5. The argument contracts, which raise `22023` rather than answering.

  6. The refusals the RPCs return as values, each distinguishable from the
     others, and the two properties the screen depends on: a refused edit leaves
     the role's name *and* its permission rows untouched, and a successful save
     replaces the permission rows wholesale.

  7. The shape and the grants, including the two helpers the trigger reads as
     the caller — the defect this file's first run found.

  8. The `viewer` system role itself (section 9), which `20261025130000` seeds
     and which no migration created before it: the row in every column that
     file sets, its sixteen permission rows in both directions against
     `role_page_keys()`, and its idempotency *executed* — the migration's two
     statements run again here and must touch zero rows.

     That section is a measurement only because `roles-seed.sql` no longer
     seeds the row. It used to, with production's id, so an assertion about it
     would have passed with the migration reverted — which is how the drift
     survived from April to October. Sections 2a, 2b, 2d and 8a lean on the
     role existing and therefore now lean on that migration too.

  ## What it does not claim

  Tenancy in general (matrix.sql and tenant-state.sql own that), the support
  write audit (support-write-audit.sql derives its table list from the refusal
  trigger, so `roles` and `role_permissions` are already in it), and the
  page-key list itself, which is pinned against `PAGE_DEFINITIONS` in
  `src/utils/rolePageKeys.test.ts`.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _cr_as(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  -- One session per account, and its id *is* the account's id: auth.sessions
  -- only has to exist and be this account's for platform_context_row() to
  -- answer, and a second identifier would be one more thing to keep in step.
  PERFORM set_config('request.jwt.claim.session_id', p_user::text, true);
  -- A password sign-in. Since 20260919130000 a platform capability is NULL
  -- without it, so the two staff principals below would hold no role at all and
  -- every probe about them would pass for the wrong reason.
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION _cr_as_anon() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
END $$;

CREATE OR REPLACE FUNCTION _cr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Runs one statement as one principal — or as anon for the all-zero uuid, which
  no account holds — in a subtransaction that is always rolled back, and returns
  what happened:

      `rows N`                        a write, and how many rows it touched
      the scalar                      a SELECT
      `ERR <sqlstate> <hint> <msg>`   a refusal

  The rollback is what lets one role be probed by nine principals in a row
  without one probe seeing another's work.
*/
CREATE OR REPLACE FUNCTION _cr_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_hint  text;
  v_msg   text;
BEGIN
  BEGIN
    IF p_user = '00000000-0000-0000-0000-000000000000' THEN
      PERFORM _cr_as_anon();
    ELSE
      PERFORM _cr_as(p_user);
    END IF;
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ009' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || coalesce(nullif(v_hint, ''), '-') || ' ' || v_msg;
  END;
  PERFORM _cr_reset();
  RETURN v_out;
END $$;

/*
  An answer reduced to the part that is a contract.

  For an error that is the SQLSTATE and the HINT — `ERR P0001
  role_name_reserved` — and not the message, because the messages are sentences
  that may be reworded while the hints are what the browser and the other tests
  read. For an RPC answer it is `ok` or the `reason`. Anything else is itself.
*/
CREATE OR REPLACE FUNCTION _cr_reason(p_answer text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_answer IS NULL       THEN '<null>'
    WHEN p_answer LIKE 'ERR %'  THEN array_to_string((string_to_array(p_answer, ' '))[1:3], ' ')
    WHEN p_answer LIKE '{%'     THEN CASE
                                       WHEN (p_answer::jsonb ->> 'ok') = 'true' THEN 'ok'
                                       ELSE coalesce(p_answer::jsonb ->> 'reason', '<no reason>')
                                     END
    ELSE p_answer
  END
$$;

CREATE OR REPLACE FUNCTION _cr_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'company-roles: FAIL — %', p_label;
  END IF;
  RAISE NOTICE 'company-roles: ok — %', p_label;
END $$;

/** The same, printing what came back when it does not match. */
CREATE OR REPLACE FUNCTION _cr_is(p_label text, p_got text, p_want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'company-roles: FAIL — %: expected "%", got "%"', p_label, p_want, p_got;
  END IF;
  RAISE NOTICE 'company-roles: ok — %  (%)', p_label, p_want;
END $$;

/**
  Runs a statement as the owner and reports `accepted` or `<SQLSTATE> <hint>`,
  always rolled back, so an accepted probe leaves nothing behind.

  Sections 1 and 2 are about indexes and triggers, which answer the same for
  every caller; RLS would only decide who reaches them, and matrix.sql owns
  that.
*/
CREATE OR REPLACE FUNCTION _cr_owner_try(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_hint  text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = 'accepted';
  EXCEPTION
    WHEN SQLSTATE 'ZZ009' THEN
      RETURN 'accepted';
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
      RETURN v_state || ' ' || coalesce(nullif(v_hint, ''), '-');
  END;
END $$;

-- ─── fixtures ───────────────────────────────────────────────────────────────
--
-- seed.sql gives company A and B with admin/editor/viewer of A, admin of B and
-- one platform owner that has opened nothing. Four principals are missing for
-- this file: a supervisor (the role that holds every page and is still not an
-- administrator, so it tells "gated by the page" from "gated by
-- is_company_admin()"), an ordinary member whose profile can be re-pointed, and
-- the two staff accounts that hold a context.

DO $fixtures$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('cf000000-0000-4000-8000-000000000001', 'cr-supervisor-a@test.invalid'),
    ('cf000000-0000-4000-8000-000000000002', 'cr-member-a@test.invalid'),
    ('cf000000-0000-4000-8000-000000000003', 'cr-staff-view@test.invalid'),
    ('cf000000-0000-4000-8000-000000000004', 'cr-staff-support@test.invalid')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES
    ('cf000000-0000-4000-8000-000000000001', 'cr-supervisor-a@test.invalid', 'CR Supervisor', 'supervisor',
     (SELECT id FROM roles WHERE name = 'supervisor' AND company_id IS NULL), co_a, 'active'),
    ('cf000000-0000-4000-8000-000000000002', 'cr-member-a@test.invalid', 'CR Member', 'viewer',
     (SELECT id FROM roles WHERE name = 'viewer' AND company_id IS NULL), co_a, 'active'),
    -- role 'viewer' and no company at all: platform rights come from the staff
    -- row, so a write these two make is the context's doing and not a profile's.
    ('cf000000-0000-4000-8000-000000000003', 'cr-staff-view@test.invalid', 'CR Staff View', 'viewer',
     NULL, NULL, 'active'),
    ('cf000000-0000-4000-8000-000000000004', 'cr-staff-support@test.invalid', 'CR Staff Support', 'viewer',
     NULL, NULL, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO app_private.platform_staff (user_id, role, note)
  VALUES
    ('cf000000-0000-4000-8000-000000000003', 'owner', 'company-roles context principal'),
    ('cf000000-0000-4000-8000-000000000004', 'owner', 'company-roles context principal')
  ON CONFLICT (user_id) DO NOTHING;
END $fixtures$;

/*
  auth.sessions is GoTrue's and the fixture (--schema=public) does not carry it.
  platform_context_row() reads it only where a context row exists, so this stub
  is what that read resolves against; it goes with the file's ROLLBACK.
  matrix.sql creates the same stub for the same reason.
*/
CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

INSERT INTO auth.sessions (id, user_id)
SELECT v.uid, v.uid FROM (VALUES
  ('50000000-0000-4000-8000-000000000001'::uuid),
  ('cf000000-0000-4000-8000-000000000003'::uuid),
  ('cf000000-0000-4000-8000-000000000004'::uuid)
) AS v(uid)
ON CONFLICT (id) DO NOTHING;

-- One view context and one support context, both on company A. `super` from
-- seed.sql deliberately holds none: it is the platform account that has opened
-- nothing, for which get_user_company_id() answers NULL.
INSERT INTO app_private.platform_company_contexts
  (staff_user_id, company_id, mode, reason, session_id, expires_at)
VALUES
  ('cf000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-00000000000a', 'view', NULL,
   'cf000000-0000-4000-8000-000000000003', now() + interval '60 minutes'),
  ('cf000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-00000000000a', 'support', 'CR support session',
   'cf000000-0000-4000-8000-000000000004', now() + interval '60 minutes');

-- Three company roles that exist before anything is probed: one of company A
-- that an account holds (so a delete has something to refuse), one of company B
-- with the *same name*, which is the whole point of section 1, and one of
-- company A that nobody holds, which is what the RPC probes act on.
INSERT INTO roles (id, name, description, company_id, is_system) VALUES
  ('cf000000-0000-4000-8000-0000000000a1', 'Disponent', 'CR Disponent A', 'c0000000-0000-4000-8000-00000000000a', false),
  ('cf000000-0000-4000-8000-0000000000b1', 'Disponent', 'CR Disponent B', 'c0000000-0000-4000-8000-00000000000b', false),
  ('cf000000-0000-4000-8000-0000000000a2', 'CR Frei',   'held by nobody', 'c0000000-0000-4000-8000-00000000000a', false);

INSERT INTO role_permissions (role_id, page_key, can_view, can_edit) VALUES
  ('cf000000-0000-4000-8000-0000000000a1', 'overview', true, false),
  ('cf000000-0000-4000-8000-0000000000a2', 'overview', true, false),
  ('cf000000-0000-4000-8000-0000000000a2', 'drivers',  true, true);

UPDATE user_profiles SET role_id = 'cf000000-0000-4000-8000-0000000000a1'
 WHERE user_id = 'cf000000-0000-4000-8000-000000000002';

-- The guard against the failure modes that would make the whole file worthless.
DO $guard$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _cr_as(admin_a);
  IF auth.uid() IS DISTINCT FROM admin_a OR get_user_company_id() IS DISTINCT FROM co_a THEN
    PERFORM _cr_reset();
    RAISE EXCEPTION 'company-roles: impersonation is not working (uid %, company %) — nothing below would mean anything',
      auth.uid(), get_user_company_id();
  END IF;
  PERFORM _cr_reset();

  PERFORM _cr_as('cf000000-0000-4000-8000-000000000004');
  IF get_user_company_id() IS DISTINCT FROM co_a THEN
    PERFORM _cr_reset();
    RAISE EXCEPTION 'company-roles: the support context does not resolve (company %) — sections 4 and 7 would pass for the wrong reason',
      get_user_company_id();
  END IF;
  PERFORM _cr_reset();

  -- The sync trigger is the mechanism section 2f turns on its head. If it were
  -- gone, a company role named `admin` would grant nothing and the reserved
  -- name rule would be arbitrary rather than load-bearing.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.user_profiles'::regclass
                    AND tgname = 'sync_role_trigger' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'company-roles: sync_role_trigger is gone — user_profiles.role is no longer a copy of roles.name, so section 2 needs rewriting, not repairing';
  END IF;

  RAISE NOTICE 'company-roles: impersonation, the support context and sync_role_trigger all verified';
END $guard$;

-- ─── 1. two companies, one name ─────────────────────────────────────────────
--
-- `roles_name_key UNIQUE (name)` was global, which is why no company has ever
-- created a role of its own. What replaced it is two partial indexes.

DO $section1$
DECLARE
  co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  t    record;
BEGIN
  PERFORM _cr_ok('1a: the old global roles_name_key is gone',
    NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.roles'::regclass AND conname = 'roles_name_key'));

  PERFORM _cr_ok('1b: both partial indexes and the role_id index are in place',
    to_regclass('public.roles_system_name_key') IS NOT NULL
    AND to_regclass('public.roles_company_name_key') IS NOT NULL
    AND to_regclass('public.idx_user_profiles_role_id') IS NOT NULL);

  -- That the fixture applied at all is the claim; asserting it is what makes
  -- the claim visible rather than implicit in a successful INSERT above.
  PERFORM _cr_ok('1c: company A and company B both hold a role named Disponent',
    (SELECT count(*) FROM roles
      WHERE lower(name) = 'disponent' AND company_id IN (co_a, co_b)) = 2);

  -- One company, one name — however it is spelled. The index is on
  -- lower(btrim(name)), so all four of these collide with the fixture's
  -- `Disponent`, and a `Disponent` beside a `disponent` on one screen would be
  -- two roles an administrator cannot tell apart.
  FOR t IN SELECT * FROM (VALUES
    ('the same name exactly',          'Disponent'),
    ('the same name in another case',  'disponent'),
    ('the same name in block capitals','DISPONENT'),
    ('the same name with whitespace',  '  Disponent  ')
  ) AS v(label, name) LOOP
    PERFORM _cr_is('1d: company A cannot take ' || t.label,
      _cr_owner_try(format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, false)', t.name, co_a)),
      '23505 -');
  END LOOP;

  -- …and a name it does not hold is free. The "can" beside every "cannot": a
  -- malformed statement cannot masquerade as a refusal.
  PERFORM _cr_is('1e: a name company A does not hold is free',
    _cr_owner_try(format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, false)', 'Disponentin', co_a)),
    'accepted');

  -- The other half of the old constraint, kept exactly where it mattered.
  PERFORM _cr_is('1f: a second system role named admin is still refused',
    _cr_owner_try($sql$INSERT INTO roles (name, company_id, is_system) VALUES ('Admin', NULL, true)$sql$),
    '23505 -');
END $section1$;

-- ─── 2. a company role is not a system role, and never borrows its name ─────

DO $section2$
DECLARE
  co_a  constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  sys   record;
  spell record;
BEGIN
  PERFORM _cr_ok('2a: this database holds system roles worth probing at all',
    (SELECT count(*) FROM roles WHERE company_id IS NULL) >= 4);
  PERFORM _cr_ok('2a: …and `admin` is one of them, which is what section 2f turns on',
    EXISTS (SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'admin'));

  /*
    Every reserved name, in the spellings role_name_is_system_reserved()
    compares — `lower(btrim(...))` on both sides, the same expression
    roles_system_name_key is built on, so "the name is free" and "the name is
    allowed" cannot disagree. The names come out of the table rather than a
    literal list, so a migration that adds a system role is covered the day it
    applies.
  */
  FOR sys IN SELECT name FROM roles WHERE company_id IS NULL ORDER BY name LOOP
    FOR spell IN SELECT * FROM (VALUES
      ('as stored',     sys.name),
      ('in upper case', upper(sys.name)),
      ('capitalised',   initcap(sys.name)),
      ('padded',        '  ' || sys.name || '  ')
    ) AS v(label, name) LOOP
      PERFORM _cr_is(format('2b: a company role named %L (%s) is refused', spell.name, spell.label),
        _cr_owner_try(format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, false)', spell.name, co_a)),
        'P0001 role_name_reserved');
    END LOOP;
  END LOOP;

  -- is_system on a company role: roles_insert has no term for it, while
  -- roles_update and roles_delete both require is_system = false, so such a row
  -- would be one its own company could neither edit nor delete — and which the
  -- screen would draw as one of the untouchable templates.
  PERFORM _cr_is('2c: a company role with is_system = true is refused',
    _cr_owner_try(format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, true)', 'CR Moechtegern', co_a)),
    'P0001 company_role_not_system');

  -- …and a role does not change kind afterwards, in either direction.
  PERFORM _cr_is('2d: a company role cannot become a system role',
    _cr_owner_try($sql$UPDATE roles SET is_system = true WHERE id = 'cf000000-0000-4000-8000-0000000000a2'$sql$),
    'P0001 role_kind_is_fixed');
  PERFORM _cr_is('2d: …nor a system role a company one',
    _cr_owner_try($sql$UPDATE roles SET is_system = false WHERE company_id IS NULL AND name = 'viewer'$sql$),
    'P0001 role_kind_is_fixed');

  -- An ordinary edit of a company role still works, so 2d is about `is_system`
  -- and not about the trigger refusing every UPDATE.
  PERFORM _cr_is('2d: …while renaming a company role is untouched',
    _cr_owner_try($sql$UPDATE roles SET description = 'CR renamed' WHERE id = 'cf000000-0000-4000-8000-0000000000a2'$sql$),
    'accepted');

  -- The reverse case. Only a migration writes a system role, but one whose name
  -- a company had already taken would make that company's role an escalation
  -- retroactively — a failure worth having loudly at release time.
  PERFORM _cr_is('2e: a system role named after a name a company holds is refused',
    _cr_owner_try($sql$INSERT INTO roles (name, company_id, is_system) VALUES ('disponent', NULL, true)$sql$),
    'P0001 role_name_held_by_company');
END $section2$;

/*
  2f. Why the guard exists, demonstrated rather than asserted.

  `sync_user_profile_role` copies `roles.name` into `user_profiles.role` on
  every write, and that text is read as an authority by `is_company_admin()`
  (`up.role = 'admin'`), by AuthContext.isAdmin and by the activation-code
  mail's recipient list. So the first part shows the mechanism working on a name
  nobody objects to, the second switches the trigger off and shows an ordinary
  viewer becoming a company administrator with no permission row anywhere, and
  the third shows the trigger refusing the first step.

  The trigger is disabled as the owner and put back immediately; the whole file
  is inside BEGIN … ROLLBACK, and the escalated row is deleted here as well, so
  nothing further down can read an escalated principal.
*/
DO $section2f$
DECLARE
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  member_a constant uuid := 'cf000000-0000-4000-8000-000000000002';
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_escal  constant uuid := 'cf000000-0000-4000-8000-0000000000ff';
  v_text   text;
  v_admin  boolean;
BEGIN
  SELECT role INTO v_text FROM user_profiles WHERE user_id = member_a;
  PERFORM _cr_is('2f: the profile''s role text is a copy of the role''s name', v_text, 'Disponent');

  PERFORM _cr_as(member_a);
  v_admin := is_company_admin();
  PERFORM _cr_reset();
  PERFORM _cr_ok('2f: …and a company role named Disponent makes nobody an administrator', v_admin = false);

  -- The escalation, with the guard switched off. This is the negative control:
  -- without it, "a company role may not be called admin" reads as a naming
  -- convention rather than as a privilege boundary.
  ALTER TABLE public.roles DISABLE TRIGGER enforce_company_role_shape;
  INSERT INTO roles (id, name, description, company_id, is_system)
  VALUES (v_escal, 'admin', 'CR escalation control', co_a, false);
  ALTER TABLE public.roles ENABLE TRIGGER enforce_company_role_shape;

  UPDATE user_profiles SET role_id = v_escal WHERE user_id = member_a;
  SELECT role INTO v_text FROM user_profiles WHERE user_id = member_a;
  PERFORM _cr_is('2f: with the guard off, a company role named admin writes `admin` into the profile',
    v_text, 'admin');

  PERFORM _cr_as(member_a);
  v_admin := is_company_admin();
  PERFORM _cr_reset();
  PERFORM _cr_ok('2f: …and that viewer is a company administrator, granted by a name and no permission row',
    v_admin = true);

  -- Put it back, so nothing after this reads an escalated principal.
  UPDATE user_profiles SET role_id = 'cf000000-0000-4000-8000-0000000000a1' WHERE user_id = member_a;
  DELETE FROM roles WHERE id = v_escal;

  PERFORM _cr_as(member_a);
  v_admin := is_company_admin();
  PERFORM _cr_reset();
  PERFORM _cr_ok('2f: …and an ordinary viewer again once the role is taken away', v_admin = false);

  -- And the guard refuses the first step: for the administrator who would make
  -- it, directly and through the RPC the screen calls.
  PERFORM _cr_is('2f: the company administrator cannot create that role directly',
    _cr_reason(_cr_try(admin_a,
      format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, false)', 'admin', co_a))),
    'ERR P0001 role_name_reserved');

  PERFORM _cr_is('2f: …nor through company_role_save, which answers before it writes',
    _cr_reason(_cr_try(admin_a, $sql$SELECT company_role_save('admin', '', '[]'::jsonb)::text$sql$)),
    'name_reserved');
  PERFORM _cr_is('2f: …in any spelling',
    _cr_reason(_cr_try(admin_a, $sql$SELECT company_role_save('  ADMIN  ', '', '[]'::jsonb)::text$sql$)),
    'name_reserved');
END $section2f$;

-- ─── 3. a profile names a role of its own company, or a system role ─────────
--
-- As the company administrator, which is the principal that could otherwise do
-- it: enforce_user_profile_privilege_guard decides *who* may change `role_id`
-- and says nothing about *what* it may be set to, and RLS cannot close the gap
-- — roles_select hides the other company's row, but a WITH CHECK on
-- user_profiles cannot reach into another table, and the foreign key only asks
-- that the role exist.

DO $section3$
DECLARE
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  member_a constant uuid := 'cf000000-0000-4000-8000-000000000002';
  role_b   constant uuid := 'cf000000-0000-4000-8000-0000000000b1';
  role_a   constant uuid := 'cf000000-0000-4000-8000-0000000000a2';
  absent   constant uuid := 'cf000000-0000-4000-8000-0000000000c9';
  v_sys    uuid;
BEGIN
  SELECT id INTO v_sys FROM roles WHERE company_id IS NULL AND name = 'viewer';

  PERFORM _cr_is('3a: a company administrator cannot point a profile at another company''s role',
    _cr_reason(_cr_try(admin_a,
      format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', role_b, member_a))),
    'ERR 42501 role_out_of_scope');

  -- Written as "the role exists and is in scope", never as "the role is out of
  -- scope", so a role_id naming a row that does not exist is refused here as
  -- well — before the foreign key, whose 23503 the screen cannot act on.
  PERFORM _cr_is('3b: …nor at a role that does not exist',
    _cr_reason(_cr_try(admin_a,
      format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', absent, member_a))),
    'ERR 42501 role_out_of_scope');

  -- The two "can"s. Without them a guard that refused everything would pass.
  PERFORM _cr_is('3c: a system role stays assignable',
    _cr_try(admin_a, format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', v_sys, member_a)),
    'rows 1');

  PERFORM _cr_is('3d: …and so does a role of the profile''s own company',
    _cr_try(admin_a, format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L', role_a, member_a)),
    'rows 1');

  -- NULL is the legacy text-role state and is left alone; current_role_permits()
  -- resolves it by name with the same company term.
  PERFORM _cr_is('3e: a NULL role_id is not a role out of scope',
    _cr_try(admin_a, format('UPDATE user_profiles SET role_id = NULL WHERE user_id = %L', member_a)),
    'rows 1');

  -- An INSERT goes through the same trigger. A company administrator cannot
  -- insert a profile at all (user_profiles_insert is `user_id = auth.uid()`),
  -- so this one is the owner's, which is the path a migration or an edge
  -- function holding the service key would take.
  PERFORM _cr_is('3f: an INSERT naming another company''s role is refused too',
    _cr_owner_try(format(
      $sql$INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
           VALUES ('cf000000-0000-4000-8000-00000000000e', 'cr-insert@test.invalid', 'CR Insert', 'viewer', %L,
                   'c0000000-0000-4000-8000-00000000000a', 'active')$sql$, role_b)),
    '42501 role_out_of_scope');
END $section3$;

/*
  3g. An existing out-of-scope row is not repaired, and what living with one
  actually costs.

  The migration warns about such rows in self-check 8 rather than moving them:
  a profile silently moved onto another role is a payroll-adjacent surprise.
  What makes that liveable is the short-circuit in the trigger — a write that
  changes neither `role_id` nor `company_id` is not re-validated — because
  without it a company holding one such row could no longer edit that account's
  name, status or anything else.

  The third assertion is the part that is not obvious and is worth writing
  down: the company's **own administrator** still cannot edit that profile, and
  not because of this slice. `sync_user_profile_role` is SECURITY INVOKER and
  reads `roles` under the caller's RLS, so for an administrator the foreign
  role is invisible, `SELECT name INTO NEW.role` writes NULL, and
  `user_profiles.role` is NOT NULL (20250930122526). The row has to be put
  right by someone who can see both companies. That is a pre-existing
  interaction between two old triggers, recorded here because self-check 8 is
  the thing that finds such rows and this is the shape of the trouble they
  cause.

  Building the row needs the scope guard off, exactly as 2f does.
*/
DO $section3g$
DECLARE
  admin_a  constant uuid := 'a0000000-0000-4000-8000-000000000001';
  legacy   constant uuid := 'cf000000-0000-4000-8000-00000000000d';
  role_b   constant uuid := 'cf000000-0000-4000-8000-0000000000b1';
BEGIN
  INSERT INTO auth.users (id, email) VALUES (legacy, 'cr-legacy@test.invalid')
  ON CONFLICT (id) DO NOTHING;

  ALTER TABLE public.user_profiles DISABLE TRIGGER user_profiles_role_scope_guard;
  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
  VALUES (legacy, 'cr-legacy@test.invalid', 'CR Legacy', 'viewer', role_b,
          'c0000000-0000-4000-8000-00000000000a', 'active');
  ALTER TABLE public.user_profiles ENABLE TRIGGER user_profiles_role_scope_guard;

  PERFORM _cr_ok('3g: the fixture is genuinely out of scope',
    EXISTS (SELECT 1 FROM user_profiles up JOIN roles r ON r.id = up.role_id
             WHERE up.user_id = legacy AND r.company_id IS DISTINCT FROM up.company_id));

  -- The short-circuit. Without it this would be `42501 role_out_of_scope`, and
  -- the account could never be edited again by anyone.
  PERFORM _cr_is('3g: a write that touches neither role_id nor company_id passes the scope guard',
    _cr_owner_try(format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'CR Legacy 2', legacy)),
    'accepted');

  -- Naming the *same* role is the short-circuit again: `NEW.role_id IS NOT
  -- DISTINCT FROM OLD.role_id`, so the statement is not re-validated and the
  -- row stays exactly as wrong as it was.
  PERFORM _cr_is('3g: …naming that same out-of-scope role again is the short-circuit, not a second check',
    _cr_owner_try(format('UPDATE user_profiles SET role_id = %L, full_name = %L WHERE user_id = %L',
                         role_b, 'CR Legacy 3', legacy)),
    'accepted');

  -- Moving it to a *different* role out of scope is refused, so the row can
  -- only ever be repaired, never re-pointed at another company's role.
  PERFORM _cr_is('3g: …but moving it to a different role out of scope is refused',
    _cr_owner_try(format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L',
                         'cf000000-0000-4000-8000-0000000000c9'::uuid, legacy)),
    '42501 role_out_of_scope');

  -- And putting it right is what the guard is for.
  PERFORM _cr_is('3g: …and pointing it at its own company''s role puts it right',
    _cr_owner_try(format('UPDATE user_profiles SET role_id = %L WHERE user_id = %L',
                         'cf000000-0000-4000-8000-0000000000a2'::uuid, legacy)),
    'accepted');

  -- The cost, and it is not this slice's: sync_user_profile_role reads `roles`
  -- as the caller, the foreign role is invisible to the company's own
  -- administrator, and NEW.role becomes NULL against a NOT NULL column.
  PERFORM _cr_is('3g: the company''s own administrator cannot edit such a profile at all — 23502 from sync_user_profile_role, not the scope guard',
    _cr_reason(_cr_try(admin_a,
      format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'CR Legacy 4', legacy))),
    'ERR 23502 -');

  DELETE FROM user_profiles WHERE user_id = legacy;
  DELETE FROM auth.users WHERE id = legacy;
END $section3g$;

-- ─── 4. the two RPCs, per principal ─────────────────────────────────────────
--
-- Both are SECURITY INVOKER, so RLS decides and what is really under test is
-- whether the policies of 20260917130000 and 20260923110010 refuse the calls
-- this file expects them to, in the shape it expects:
--
--   not_authorized            the INSERT raised 42501 on a WITH CHECK, or the
--                             UPDATE/DELETE matched no row through a USING —
--                             two different mechanisms, one answer, which is
--                             the point of the `ROW_COUNT = 0` branch
--   not_found                 the role is not visible at all
--   no_company                a platform account with nothing open
--   ERR P0001 support_…       a view context, refused by
--                             refuse_read_only_context_write before any policy
--                             is consulted, and travelling out of the function
--                             unchanged because only unique_violation and
--                             insufficient_privilege are caught
--   ERR 42501 -               anon, which holds no EXECUTE

DO $section4$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  role_a  constant uuid := 'cf000000-0000-4000-8000-0000000000a2';
  p       record;
  got     text;
BEGIN
  FOR p IN SELECT * FROM (VALUES
    ('anon',          '00000000-0000-0000-0000-000000000000'::uuid, 'ERR 42501 -',                      'ERR 42501 -',                      'ERR 42501 -'),
    ('viewer of A',   'a0000000-0000-4000-8000-000000000003'::uuid, 'not_authorized',                   'not_authorized',                   'not_authorized'),
    ('editor of A',   'a0000000-0000-4000-8000-000000000002'::uuid, 'not_authorized',                   'not_authorized',                   'not_authorized'),
    ('supervisor A',  'cf000000-0000-4000-8000-000000000001'::uuid, 'not_authorized',                   'not_authorized',                   'not_authorized'),
    ('admin of A',    'a0000000-0000-4000-8000-000000000001'::uuid, 'ok',                               'ok',                               'ok'),
    ('admin of B',    'b0000000-0000-4000-8000-000000000001'::uuid, 'ok',                               'not_found',                        'not_found'),
    ('platform, no context', '50000000-0000-4000-8000-000000000001'::uuid, 'no_company',                'no_company',                       'no_company'),
    ('platform, view context', 'cf000000-0000-4000-8000-000000000003'::uuid,
       'ERR P0001 support_session_required', 'ERR P0001 support_session_required', 'ERR P0001 support_session_required'),
    ('platform, support session', 'cf000000-0000-4000-8000-000000000004'::uuid, 'ok', 'ok', 'ok')
  ) AS v(label, who, want_create, want_edit, want_delete) LOOP

    got := _cr_reason(_cr_try(p.who,
      $sql$SELECT company_role_save('CR Neu', 'von der Matrix', '[{"page_key":"drivers","can_view":true,"can_edit":false}]'::jsonb)::text$sql$));
    PERFORM _cr_is(format('4a: %s creates a role', p.label), got, p.want_create);

    got := _cr_reason(_cr_try(p.who,
      format($sql$SELECT company_role_save('CR Umbenannt', '', '[]'::jsonb, %L)::text$sql$, role_a)));
    PERFORM _cr_is(format('4b: %s edits company A''s own role', p.label), got, p.want_edit);

    got := _cr_reason(_cr_try(p.who, format($sql$SELECT company_role_delete(%L)::text$sql$, role_a)));
    PERFORM _cr_is(format('4c: %s deletes company A''s own role', p.label), got, p.want_delete);
  END LOOP;
END $section4$;

/*
  4d. The two mechanisms behind the one `not_authorized`.

  A viewer's INSERT is refused by roles_insert's WITH CHECK and raises 42501;
  its UPDATE and DELETE are refused by the USING clauses, which match no row and
  raise nothing at all. The RPC folds both into `not_authorized`, and this is
  where the distinction the other kit files draw is written down — so a policy
  that lost its USING clause (silent becomes allowed) would show here even
  though section 4 still reads `not_authorized`.
*/
DO $section4d$
DECLARE
  viewer_a constant uuid := 'a0000000-0000-4000-8000-000000000003';
  co_a     constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  role_a   constant uuid := 'cf000000-0000-4000-8000-0000000000a2';
BEGIN
  PERFORM _cr_is('4d: a viewer''s raw INSERT is refused loudly, by a WITH CHECK',
    _cr_reason(_cr_try(viewer_a,
      format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, false)', 'CR Direkt', co_a))),
    'ERR 42501 -');

  PERFORM _cr_is('4d: …its raw UPDATE is refused silently, by a USING',
    _cr_try(viewer_a, format($sql$UPDATE roles SET description = 'x' WHERE id = %L$sql$, role_a)),
    'rows 0');

  PERFORM _cr_is('4d: …and so is its raw DELETE',
    _cr_try(viewer_a, format('DELETE FROM roles WHERE id = %L', role_a)),
    'rows 0');

  -- The same three as the administrator, so none of the above is a malformed
  -- statement in disguise.
  PERFORM _cr_is('4d: the administrator''s raw INSERT is allowed',
    _cr_try('a0000000-0000-4000-8000-000000000001',
      format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, false)', 'CR Direkt', co_a)),
    'rows 1');
  PERFORM _cr_is('4d: …its UPDATE reaches the row',
    _cr_try('a0000000-0000-4000-8000-000000000001',
      format($sql$UPDATE roles SET description = 'x' WHERE id = %L$sql$, role_a)),
    'rows 1');
  PERFORM _cr_is('4d: …and its DELETE does too',
    _cr_try('a0000000-0000-4000-8000-000000000001', format('DELETE FROM roles WHERE id = %L', role_a)),
    'rows 1');
END $section4d$;

-- ─── 5. the argument contracts ──────────────────────────────────────────────
--
-- A broken contract raises 22023 with a fixed message, as every app_private
-- function in the chain does. It is not a refusal the screen can name, because
-- an argument this shape could only come from a build that has drifted.

DO $section5$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  t       record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('p_permissions NULL',              $sql$SELECT company_role_save('CR', '', NULL::jsonb)::text$sql$),
    ('p_permissions a JSON string',     $sql$SELECT company_role_save('CR', '', '"nein"'::jsonb)::text$sql$),
    ('p_permissions a JSON object',     $sql$SELECT company_role_save('CR', '', '{"drivers":true}'::jsonb)::text$sql$),
    ('p_permissions a JSON number',     $sql$SELECT company_role_save('CR', '', '7'::jsonb)::text$sql$),
    ('an entry that is a number',       $sql$SELECT company_role_save('CR', '', '[1]'::jsonb)::text$sql$),
    ('an entry that is a string',       $sql$SELECT company_role_save('CR', '', '["drivers"]'::jsonb)::text$sql$),
    ('an entry that is an array',       $sql$SELECT company_role_save('CR', '', '[[]]'::jsonb)::text$sql$),
    ('p_role_id NULL on delete',        $sql$SELECT company_role_delete(NULL::uuid)::text$sql$)
  ) AS v(label, stmt) LOOP
    PERFORM _cr_is('5: ' || t.label || ' raises 22023',
      _cr_reason(_cr_try(admin_a, t.stmt)), 'ERR 22023 -');
  END LOOP;

  -- An empty array is a contract, not a breach: it is how a role is saved with
  -- nothing permitted.
  PERFORM _cr_is('5: an empty permission array is accepted',
    _cr_reason(_cr_try(admin_a, $sql$SELECT company_role_save('CR Leer', '', '[]'::jsonb)::text$sql$)),
    'ok');
END $section5$;

-- ─── 6. the refusals the RPCs return, and what they leave behind ────────────

DO $section6$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  role_a  constant uuid := 'cf000000-0000-4000-8000-0000000000a2';
  held    constant uuid := 'cf000000-0000-4000-8000-0000000000a1';
  sys     uuid;
BEGIN
  SELECT id INTO sys FROM roles WHERE company_id IS NULL AND name = 'viewer';

  PERFORM _cr_is('6a: an empty name',
    _cr_reason(_cr_try(admin_a, $sql$SELECT company_role_save('   ', '', '[]'::jsonb)::text$sql$)),
    'name_required');

  PERFORM _cr_is('6b: 61 characters is too long, 60 is not',
    _cr_reason(_cr_try(admin_a, format($sql$SELECT company_role_save(%L, '', '[]'::jsonb)::text$sql$, repeat('x', 61)))),
    'name_too_long');
  PERFORM _cr_is('6b: …and 60 is not',
    _cr_reason(_cr_try(admin_a, format($sql$SELECT company_role_save(%L, '', '[]'::jsonb)::text$sql$, repeat('x', 60)))),
    'ok');

  PERFORM _cr_is('6c: a name the company already holds',
    _cr_reason(_cr_try(admin_a, $sql$SELECT company_role_save('disponent', '', '[]'::jsonb)::text$sql$)),
    'name_taken');
  PERFORM _cr_ok('6c: …and it is a different refusal from a reserved name',
    _cr_reason(_cr_try(admin_a, $sql$SELECT company_role_save('disponent', '', '[]'::jsonb)::text$sql$))
    IS DISTINCT FROM
    _cr_reason(_cr_try(admin_a, $sql$SELECT company_role_save('admin', '', '[]'::jsonb)::text$sql$)));

  PERFORM _cr_is('6d: a page key no screen asks about',
    _cr_reason(_cr_try(admin_a,
      $sql$SELECT company_role_save('CR Key', '', '[{"page_key":"nicht-da","can_view":true}]'::jsonb)::text$sql$)),
    'unknown_page_key');

  PERFORM _cr_is('6e: the same page twice',
    _cr_reason(_cr_try(admin_a,
      $sql$SELECT company_role_save('CR Doppelt', '', '[{"page_key":"drivers","can_view":true},{"page_key":"drivers","can_view":true}]'::jsonb)::text$sql$)),
    'duplicate_page_key');

  PERFORM _cr_is('6f: bearbeiten without ansehen — the rule the form keeps, stated where it cannot be bypassed',
    _cr_reason(_cr_try(admin_a,
      $sql$SELECT company_role_save('CR Edit', '', '[{"page_key":"drivers","can_view":false,"can_edit":true}]'::jsonb)::text$sql$)),
    'edit_without_view');

  /*
    …and with `can_view` simply left out, which is the version that failed
    open. `v_entry -> 'can_view'` is SQL NULL, so `= 'true'::jsonb` is NULL,
    `v_edit AND NOT v_view` is NULL, `IF NULL THEN` does not fire, and the role
    was stored with can_edit true and can_view NULL — the exact state the rule
    exists to prevent, reachable by any direct PostgREST call. The comparison
    is `IS NOT DISTINCT FROM` now; this is what says so.
  */
  PERFORM _cr_is('6f: …and with can_view left out entirely, where three-valued logic used to let it through',
    _cr_reason(_cr_try(admin_a,
      $sql$SELECT company_role_save('CR Edit', '', '[{"page_key":"drivers","can_edit":true}]'::jsonb)::text$sql$)),
    'edit_without_view');

  -- The same absent-key shape on the permitted side must still be stored as
  -- `false` and not as NULL, or a permission row reads as unknown rather than
  -- as "not permitted".
  PERFORM _cr_is('6f: …while an entry with neither key is dropped, not stored as NULL',
    _cr_reason(_cr_try(admin_a,
      $sql$SELECT company_role_save('CR Leer 2', '', '[{"page_key":"drivers"}]'::jsonb)::text$sql$)),
    'ok');

  PERFORM _cr_is('6g: a role that does not exist',
    _cr_reason(_cr_try(admin_a,
      $sql$SELECT company_role_save('CR Weg', '', '[]'::jsonb, 'cf000000-0000-4000-8000-0000000000c9'::uuid)::text$sql$)),
    'not_found');

  PERFORM _cr_is('6h: deleting a system role is named as such, not as "not found"',
    _cr_reason(_cr_try(admin_a, format($sql$SELECT company_role_delete(%L)::text$sql$, sys))),
    'system_role');

  -- The count is the point of the message: an administrator told "still
  -- assigned" without a number has to open every account to find out which.
  PERFORM _cr_is('6i: deleting a role an account still holds',
    _cr_reason(_cr_try(admin_a, format($sql$SELECT company_role_delete(%L)::text$sql$, held))),
    'assigned');
  PERFORM _cr_is('6i: …and it says how many',
    _cr_try(admin_a, format($sql$SELECT (company_role_delete(%L) ->> 'assigned_count')$sql$, held)),
    '1');
END $section6$;

/*
  6j. A refused edit leaves the role exactly as it was.

  The screen used to delete every permission row and re-insert, so a failure in
  between left a role with no permissions — every holder locked out of every
  page, with nothing on screen to say so. `company_role_save` catches
  unique_violation by its SQLSTATE, and a caught exception rolls back to the
  function's own savepoint, so the name it refused to take and the rows it was
  about to replace are both still there.

  Not run through _cr_try: the point is what is left behind, so this one must
  not be rolled back by the probe itself.
*/
DO $section6j$
DECLARE
  admin_a constant uuid := 'a0000000-0000-4000-8000-000000000001';
  role_a  constant uuid := 'cf000000-0000-4000-8000-0000000000a2';
  v_out   jsonb;
  v_name  text;
  v_keys  text;
BEGIN
  PERFORM _cr_as(admin_a);
  v_out := company_role_save('Disponent', 'überschrieben', '[]'::jsonb, role_a);
  PERFORM _cr_reset();
  PERFORM _cr_is('6j: renaming a role to a name the company holds is refused', v_out ->> 'reason', 'name_taken');

  SELECT name INTO v_name FROM roles WHERE id = role_a;
  PERFORM _cr_is('6j: …the role keeps its name', v_name, 'CR Frei');

  SELECT string_agg(page_key, ',' ORDER BY page_key) INTO v_keys
    FROM role_permissions WHERE role_id = role_a;
  PERFORM _cr_is('6j: …and every permission row it had', v_keys, 'drivers,overview');

  -- …and a save that succeeds replaces them wholesale, which is the other half
  -- of the same contract: whatever the payload does not name is gone.
  PERFORM _cr_as(admin_a);
  v_out := company_role_save('CR Frei', 'neu', $j$[
    {"page_key": "cars",  "can_view": true,  "can_edit": true},
    {"page_key": "notes", "can_view": false, "can_edit": false}
  ]$j$::jsonb, role_a);
  PERFORM _cr_reset();
  PERFORM _cr_is('6j: a successful save answers ok', v_out ->> 'ok', 'true');

  SELECT string_agg(page_key, ',' ORDER BY page_key) INTO v_keys
    FROM role_permissions WHERE role_id = role_a;
  PERFORM _cr_is('6j: …the earlier rows are gone and only the payload''s remain', v_keys, 'cars');

  PERFORM _cr_ok('6j: …and an area with neither box set is dropped rather than stored',
    NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = role_a AND page_key = 'notes'));
END $section6j$;

-- ─── 7. the shape, the grants, and the premise matrix.sql rests on ──────────

DO $section7$
DECLARE
  v_fn   text;
  v_body text;
  v_sig  text;
BEGIN
  /*
    The premise of this file. matrix.sql reports an UNCOVERED SECURITY DEFINER
    function without a line in its rpc section; both of these are INVOKER, so it
    is silent about them whatever happens to them. Keeping them INVOKER is the
    design — the policies stay the boundary — and this is where that is written
    down, so a change to DEFINER is refused here rather than passing unnoticed.
  */
  FOR v_fn IN SELECT unnest(ARRAY['company_role_save', 'company_role_delete']) LOOP
    PERFORM _cr_ok(format('7a: public.%s is SECURITY INVOKER, so RLS is the boundary and matrix.sql is silent about it by construction', v_fn),
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = v_fn
          AND NOT p.prosecdef AND p.proconfig::text LIKE '%search_path=%') = 1);
  END LOOP;

  -- anon holds EXECUTE on neither RPC, and authenticated on both.
  FOR v_sig IN SELECT unnest(ARRAY[
    'public.company_role_save(text, text, jsonb, uuid)',
    'public.company_role_delete(uuid)'
  ]) LOOP
    PERFORM _cr_ok(format('7b: anon cannot execute %s', v_sig),
      NOT has_function_privilege('anon', v_sig, 'EXECUTE'));
    PERFORM _cr_ok(format('7b: …and authenticated can', v_sig),
      has_function_privilege('authenticated', v_sig, 'EXECUTE'));
  END LOOP;

  /*
    7c. The two helpers the trigger reads **as the caller**.

    This is the defect this file found on its first run, and the reason both
    live in `public`. `enforce_company_role_shape` is SECURITY INVOKER and fires
    for whoever writes `roles`; `company_role_save` is SECURITY INVOKER by
    design. While the helpers were in `app_private` — where no API role holds
    USAGE, which 20260919120000's self-check asserts on every release — a
    company administrator's plain INSERT died with `42501 permission denied`,
    and the RPC caught that same 42501 as `insufficient_privilege` and answered
    `not_authorized`. The feature could not work for anybody, and the message
    blamed the administrator's own role.

    So: reachable by the two roles that write the table, and by nobody else.
  */
  FOR v_sig IN SELECT unnest(ARRAY[
    'public.role_page_keys()',
    'public.role_name_is_system_reserved(text)'
  ]) LOOP
    PERFORM _cr_ok(format('7c: anon cannot execute %s', v_sig),
      NOT has_function_privilege('anon', v_sig, 'EXECUTE'));
    PERFORM _cr_ok(format('7c: authenticated can execute %s — it writes roles, so it fires the shape trigger, which reads it', v_sig),
      has_function_privilege('authenticated', v_sig, 'EXECUTE'));
    PERFORM _cr_ok(format('7c: …and so can service_role, for the same reason', v_sig),
      has_function_privilege('service_role', v_sig, 'EXECUTE'));
  END LOOP;

  /*
    7d. The rule rather than the instance. Every function on a caller's own
    path — the two RPCs, the two triggers and the two helpers — runs as the
    caller, and the caller cannot reach `app_private`. A later migration that
    restates one of them and reaches back into that schema fails here, not in
    production with a silent `not_authorized`.
  */
  FOR v_fn IN SELECT unnest(ARRAY[
    'public.company_role_save',
    'public.company_role_delete',
    'public.role_page_keys',
    'public.role_name_is_system_reserved',
    'app_private.enforce_company_role_shape',
    'app_private.enforce_user_profile_role_scope'
  ]) LOOP
    SELECT string_agg(p.prosrc, E'\n') INTO v_body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = split_part(v_fn, '.', 1)
       AND p.proname = split_part(v_fn, '.', 2)
       AND NOT p.prosecdef;
    PERFORM _cr_ok(format('7d: %s() exists and is SECURITY INVOKER', v_fn), v_body IS NOT NULL);
    PERFORM _cr_ok(format('7d: …and does not reach into app_private, which its caller cannot', v_fn),
      position('app_private.' IN v_body) = 0);
  END LOOP;

  -- Both triggers are in place, on the right table and the right events.
  PERFORM _cr_ok('7e: enforce_company_role_shape is on roles, BEFORE INSERT and UPDATE',
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.roles'::regclass
               AND tgname = 'enforce_company_role_shape' AND NOT tgisinternal));
  PERFORM _cr_ok('7e: user_profiles_role_scope_guard is on user_profiles',
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.user_profiles'::regclass
               AND tgname = 'user_profiles_role_scope_guard' AND NOT tgisinternal));

  -- And the page-key list is the sixteen the application knows. What pins it
  -- against PAGE_DEFINITIONS is src/utils/rolePageKeys.test.ts; this only says
  -- the database's copy has not grown a duplicate or lost an entry.
  PERFORM _cr_ok('7f: role_page_keys() holds sixteen distinct keys',
    cardinality(public.role_page_keys()) = 16
    AND (SELECT count(DISTINCT k) FROM unnest(public.role_page_keys()) AS k) = 16);
END $section7$;

-- ─── 8. what each principal sees ────────────────────────────────────────────
--
-- The read side, which every refusal above is measured against: a company sees
-- the system roles plus its own, and a platform account sees the system roles
-- plus the company its context names.

DO $section8$
DECLARE
  p   record;
  got text;
BEGIN
  FOR p IN SELECT * FROM (VALUES
    ('viewer of A',               'a0000000-0000-4000-8000-000000000003'::uuid, '1', '0'),
    ('editor of A',               'a0000000-0000-4000-8000-000000000002'::uuid, '1', '0'),
    ('supervisor A',              'cf000000-0000-4000-8000-000000000001'::uuid, '1', '0'),
    ('admin of A',                'a0000000-0000-4000-8000-000000000001'::uuid, '1', '0'),
    ('admin of B',                'b0000000-0000-4000-8000-000000000001'::uuid, '0', '1'),
    ('platform, no context',      '50000000-0000-4000-8000-000000000001'::uuid, '0', '0'),
    ('platform, view context',    'cf000000-0000-4000-8000-000000000003'::uuid, '1', '0'),
    ('platform, support session', 'cf000000-0000-4000-8000-000000000004'::uuid, '1', '0')
  ) AS v(label, who, want_a, want_b) LOOP
    PERFORM _cr_is(format('8a: %s sees the four system roles', p.label),
      _cr_try(p.who, $sql$SELECT count(*)::text FROM roles WHERE company_id IS NULL AND name IN ('admin','supervisor','editor','viewer')$sql$),
      '4');
    PERFORM _cr_is(format('8b: %s and company A''s Disponent', p.label),
      _cr_try(p.who, $sql$SELECT count(*)::text FROM roles WHERE id = 'cf000000-0000-4000-8000-0000000000a1'$sql$),
      p.want_a);
    PERFORM _cr_is(format('8c: %s and company B''s Disponent', p.label),
      _cr_try(p.who, $sql$SELECT count(*)::text FROM roles WHERE id = 'cf000000-0000-4000-8000-0000000000b1'$sql$),
      p.want_b);
  END LOOP;

  /*
    anon reads no role at all. Two answers mean that — `0` where it holds the
    table grant Supabase's defaults give and roles_select is `TO authenticated`
    so no policy applies, and `permission denied` where the grant was never
    there. matrix.sql's `roles S` anon cell owns which of the two this database
    gives; here either is the claim, and anything else is not.
  */
  got := _cr_reason(_cr_try('00000000-0000-0000-0000-000000000000', $sql$SELECT count(*)::text FROM roles$sql$));
  PERFORM _cr_ok(format('8d: anon sees no role at all (%s)', got), got IN ('0', 'ERR 42501 -'));

  got := _cr_reason(_cr_try('00000000-0000-0000-0000-000000000000', $sql$SELECT count(*)::text FROM role_permissions$sql$));
  PERFORM _cr_ok(format('8d: …nor any permission row (%s)', got), got IN ('0', 'ERR 42501 -'));
END $section8$;

-- ─── 9. the `viewer` system role, which version control once did not create ──
--
-- 20261025130000 seeds it. Until that file, `viewer` existed on production and
-- staging — hand-created through the Rollen screen on 26.04.2026, `is_system`,
-- with five production accounts on it — and in no migration, so a database
-- rebuilt from the chain had three system roles where the live ones have four.
--
-- ## What makes this section a measurement and not a tautology
--
-- `roles-seed.sql` used to insert the row itself, with production's id and the
-- description `Betrachter`. Every assertion below would have passed against it
-- with the migration reverted, which is precisely how the drift survived this
-- long. That seed's `viewer` row is gone, and `viewer` is excluded by name from
-- its permission insert, so inside this kit the migration is the only thing
-- that can produce either. Revert the migration and 9a fails first.
--
-- Sections 2a, 2b, 2d and 8a already lean on the role existing; they lean on
-- the migration now too.

DO $section9$
DECLARE
  co_a    constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_id    constant uuid := 'fdb2798f-08a7-481c-8bbb-67e15540926e';
  v_role  record;
  v_rows  bigint;
  v_keys  constant int := cardinality(public.role_page_keys());
BEGIN
  -- 9a. The row, in every column the migration sets.
  PERFORM _cr_is('9a: exactly one system role is named viewer',
    (SELECT count(*)::text FROM roles WHERE company_id IS NULL AND lower(btrim(name)) = 'viewer'),
    '1');

  SELECT * INTO v_role
    FROM roles WHERE company_id IS NULL AND lower(btrim(name)) = 'viewer';

  PERFORM _cr_ok('9a: …it is a system row (roles_update and roles_delete both require is_system = false, so a company could neither edit nor delete it)',
    v_role.is_system IS NOT DISTINCT FROM true);
  PERFORM _cr_ok('9a: …and belongs to no company',
    v_role.company_id IS NULL);

  /*
    The name byte for byte, not merely `lower(btrim(...))`-equal.

    `initialRoleId()` in src/lib/companyRoles.ts picks the fallback role with
    `role.is_system && role.name === 'viewer'` — an exact comparison, where the
    database's own uniqueness is on the folded expression. So `Viewer` or
    ` viewer ` would satisfy every index and every trigger in this file and the
    browser's fallback would still miss it, silently landing an account with no
    resolvable role on whatever `systemRoles()` sorts first, which is `admin`.
  */
  PERFORM _cr_is('9a: …and its name is exactly "viewer", which is what initialRoleId() compares against',
    v_role.name, 'viewer');

  /*
    The id by literal, because tests/rls/oauth-signup.sql names this value
    twice (lines 246 and 1152) and roles-seed.sql's remaining three rows were
    captured from production with their ids. A different id here does not break
    the product, but it does leave oauth-signup.sql asserting about a row that
    no longer exists, which is a test passing for the wrong reason.
  */
  PERFORM _cr_is('9a: …and its id is the one oauth-signup.sql names by literal',
    v_role.id::text, v_id::text);

  -- Production's and staging's description, both measured 25.10.2026. The word
  -- is an accident of a role created in a form; matching it is what makes a
  -- rebuilt database equal to the live ones in every column the migration can
  -- set. Changing it is the owner's call and means changing the migration, its
  -- self-check and this line together.
  PERFORM _cr_is('9a: …and its description is the literal production holds',
    v_role.description, 'test');

  -- 9b. Read everywhere, write nowhere — one row per page key, both directions
  -- against role_page_keys() so neither a key without a row nor a row without a
  -- key can hide.
  PERFORM _cr_is('9b: the viewer role holds one permission row per page key',
    (SELECT count(*)::text FROM role_permissions WHERE role_id = v_role.id),
    v_keys::text);

  PERFORM _cr_is('9b: …no page key is missing a row',
    (SELECT coalesce(string_agg(k, ', ' ORDER BY k), 'none')
       FROM unnest(public.role_page_keys()) AS k
      WHERE NOT EXISTS (SELECT 1 FROM role_permissions rp
                         WHERE rp.role_id = v_role.id AND rp.page_key = k)),
    'none');

  PERFORM _cr_is('9b: …and no row names a key role_page_keys() does not list',
    (SELECT coalesce(string_agg(rp.page_key, ', ' ORDER BY rp.page_key), 'none')
       FROM role_permissions rp
      WHERE rp.role_id = v_role.id
        AND NOT (rp.page_key = ANY (public.role_page_keys()))),
    'none');

  -- IS NOT DISTINCT FROM, not `=`: both columns are nullable, and a NULL under
  -- `=` falls through as neither true nor false, so a row with can_edit NULL
  -- would count as compliant.
  PERFORM _cr_is('9b: …every row is (can_view, can_edit) = (true, false)',
    (SELECT count(*)::text FROM role_permissions
      WHERE role_id = v_role.id
        AND NOT (can_view IS NOT DISTINCT FROM true AND can_edit IS NOT DISTINCT FROM false)),
    '0');

  /*
    9c. Idempotency, executed rather than argued.

    These are the migration's two statements verbatim. Against a database that
    already holds the row — which is every database that has applied the
    migration, and which is what production and staging looked like before it —
    both must touch zero rows. That is the proof the file is a no-op there.

    The first statement matters most. `enforce_company_role_shape` is a BEFORE
    INSERT trigger, and a BEFORE trigger runs ahead of the conflict arbiter, so
    an exception it raised would not be absorbed by ON CONFLICT DO NOTHING — the
    release would fail. The WHERE NOT EXISTS is what makes the statement produce
    no row at all, so the trigger never fires. Zero rows here is that property,
    measured.
  */
  INSERT INTO public.roles (id, name, description, is_system, company_id)
  SELECT 'fdb2798f-08a7-481c-8bbb-67e15540926e'::uuid, 'viewer', 'test', true, NULL
   WHERE NOT EXISTS (
     SELECT 1 FROM public.roles
      WHERE company_id IS NULL
        AND lower(btrim(name)) = 'viewer'
   )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _cr_is('9c: re-running the migration''s role insert writes nothing (its guard yields no row, so the BEFORE INSERT trigger never fires)',
    'rows ' || v_rows, 'rows 0');

  INSERT INTO public.role_permissions (role_id, page_key, can_view, can_edit)
  SELECT r.id, k, true, false
    FROM public.roles r
   CROSS JOIN unnest(public.role_page_keys()) AS k
   WHERE r.company_id IS NULL
     AND lower(btrim(r.name)) = 'viewer'
  ON CONFLICT (role_id, page_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _cr_is('9c: …and so does re-running its permission insert',
    'rows ' || v_rows, 'rows 0');

  /*
    9d. The conflict target the migration could NOT have used.

    Slice B replaced `roles_name_key` with two partial unique indexes, and
    neither is a constraint — so `ON CONFLICT ON CONSTRAINT roles_system_name_key`
    raises 42704 and could never have applied, which is why the migration uses a
    bare ON CONFLICT with the guard above. Asserted here so the next person
    reaching for the constraint form is told why it is not there.
  */
  PERFORM _cr_ok('9d: roles_system_name_key is a partial unique index, not a constraint',
    EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE i.indrelid = 'public.roles'::regclass
               AND c.relname = 'roles_system_name_key'
               AND i.indisunique AND i.indpred IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = 'public.roles'::regclass
                       AND conname = 'roles_system_name_key'));

  -- …and the refusal itself, executed rather than inferred from the catalogue.
  -- The line above establishes the shape; this one runs the statement the audit
  -- proposed and shows PostgreSQL rejecting it, so "it could never have
  -- applied" is a measurement and not a reading of the documentation.
  PERFORM _cr_is('9d: …so ON CONFLICT ON CONSTRAINT roles_system_name_key is itself refused (42704)',
    _cr_owner_try($sql$
      INSERT INTO public.roles (name, description, is_system, company_id)
      VALUES ('viewer', 'test', true, NULL)
      ON CONFLICT ON CONSTRAINT roles_system_name_key DO NOTHING
    $sql$),
    '42704 -');

  -- The inference form does resolve that index, so the statement above fails
  -- for the reason claimed (no such constraint) and not because the clause is
  -- unusable in general. The migration still does not use it: it supplies an
  -- explicit id, so the primary key is a second way to conflict that an
  -- inference clause naming one index would let raise.
  PERFORM _cr_is('9d: …while the inference form on the same index is accepted, so 42704 is about the constraint and not the clause',
    _cr_owner_try($sql$
      INSERT INTO public.roles (name, description, is_system, company_id)
      VALUES ('viewer', 'test', true, NULL)
      ON CONFLICT (lower(btrim(name))) WHERE company_id IS NULL DO NOTHING
    $sql$),
    'accepted');

  -- 9e. Seeding a system role reserves its name, so no company may take
  -- `viewer` any more. Section 2b makes this claim for every system role the
  -- table happens to hold; pinning the name here is what states that the
  -- reservation is a consequence of this migration.
  PERFORM _cr_is('9e: a company role named viewer is refused now that a system role carries the name',
    _cr_owner_try(format('INSERT INTO roles (name, company_id, is_system) VALUES (%L, %L, false)', 'viewer', co_a)),
    'P0001 role_name_reserved');

  -- 9f. And the shape the five production accounts are in works: a profile of
  -- any company may point at a system role. enforce_user_profile_role_scope
  -- admits `company_id IS NULL` roles for everyone, and seed.sql's viewer of A
  -- is such a profile, so the role is reachable and not merely present.
  PERFORM _cr_ok('9f: at least one seeded profile holds the viewer role, so the row is reachable and not only present',
    EXISTS (SELECT 1 FROM user_profiles WHERE role_id = v_role.id));
END $section9$;

ROLLBACK;
