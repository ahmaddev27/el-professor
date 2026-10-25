/*
  # The `viewer` system role, which version control never created

  ## The drift, measured read-only on production and staging on 25.10.2026

  `public.roles` holds four system rows. Three of them come from
  `20260302065621_create_roles_system.sql`, which inserts `admin`, `supervisor`
  and `editor`. The fourth, `viewer`, comes from nowhere in
  `supabase/migrations`: it was created by a real account through the Rollen
  screen on 26.04.2026 at 21:03:25 UTC, with `is_system = true`, and its 16
  `role_permissions` rows were written in the same second.

      name       | description | is_system | created_at                    | created_by
      admin      | Administr…  | t         | 2026-03-02 06:56:23.426612+00 | (null)
      editor     | Editor wi…  | t         | 2026-03-02 06:56:23.426612+00 | (null)
      supervisor | Superviso…  | t         | 2026-03-02 06:56:23.426612+00 | (null)
      viewer     | test        | t         | 2026-04-26 21:03:25.91616+00  | d3843a29-…

  So a database rebuilt from migrations has three system roles where production
  has four, and **five production accounts sit on a role version control does
  not create** (`user_profiles.role_id` points at it, and their legacy
  `user_profiles.role` text reads `viewer`). Staging, a copy of production,
  carries the same row with the same id and the same description; four accounts
  there.

  This is another instance of the hazard `CLAUDE.md` already records — the live
  schema was partly created outside version control. The fix is this file: an
  idempotent seed, a no-op on both live databases by construction, so a fresh
  database matches them.

  ## It is not cosmetic: the browser and the kit already assume the row

  `initialRoleId()` in `src/lib/companyRoles.ts` falls back to the system role
  **named** `viewer` when an account carries no resolvable role, so on a
  database built from migrations that fallback silently becomes "the first role
  in the list", which is `admin` sorted first by
  `systemRoles()`. `AuthContext.UserProfile.role` types the union
  `'admin' | 'supervisor' | 'editor' | 'viewer'`. And in the RLS kit,
  `tests/rls/oauth-signup.sql` names the row by its literal id twice.

  ## Why the id is a literal and not gen_random_uuid()

  Because two things already depend on this exact value, and both were written
  from a capture of production:

    * `tests/rls/oauth-signup.sql` asserts a profile's `role_id` equals
      `fdb2798f-08a7-481c-8bbb-67e15540926e` (lines 246 and 1152).
    * `tests/rls/roles-seed.sql` hand-seeded all four system rows with
      production's ids, because the kit's fixture is `--schema-only` and the
      three seeding migrations predate the fixture epoch (`20260908`), so they
      never run. This file is newer than that epoch, so it **does** run in the
      kit — before the seed. Had it minted a random id, the seed's
      `ON CONFLICT (id) DO NOTHING` would have missed and its `viewer` row
      would have hit `roles_system_name_key` instead, aborting the kit under
      `ON_ERROR_STOP`. The seed's `viewer` row is removed in the same commit,
      for the reason under "the test is not vacuous" below.

  Production and staging both hold this id; verified on both.

  ## Why the description is the word `test`

  That is production's literal value, and staging's. It is plainly an accident
  of a role created by hand in a form — the other three read "Administrator
  with full access" and so on — but `roles.description` carries no behaviour:
  nothing in `src/` branches on it, and `RoleModal` renders it read-only for a
  system role. Matching it is what makes a fresh database equal to production
  in every column this file can set, which is the whole point of the file, and
  the alternative is a column that differs for ever with nothing to notice it.

  Changing it is a one-word follow-up and the owner's call. Note that such a
  change would **not** reach production or staging: the insert below is skipped
  there, so only a fresh database would see the new wording. The self-check and
  section 9 of `tests/rls/company-roles.sql` both name the value, so a change
  has to be made on purpose in three places rather than drifting.

  `created_by` stays NULL, like the other three system rows. Production's value
  names a real account; the column has a foreign key into `auth.users`, and
  that account does not exist in a fresh database. `created_at` and `updated_at`
  take their defaults. Those three columns are the only ones that still differ
  from production after this file, and none of them is read.

  ## Why the insert is guarded twice, and why not ON CONFLICT alone

  `app_private.enforce_company_role_shape` is a **BEFORE INSERT** trigger on
  `public.roles` (`20260923120000`). A BEFORE trigger runs before the conflict
  arbiter, so an exception it raises is **not** absorbed by
  `ON CONFLICT DO NOTHING` — the statement fails and the release fails with it.
  Its `company_id IS NULL` branch refuses a system role whose name a company
  already holds. Both live databases hold zero company roles, so the branch
  passes today, but relying on that is relying on data.

  So the row is produced only when it is missing (`WHERE NOT EXISTS`, on
  `lower(btrim(name))`, the expression `roles_system_name_key` is built on). On
  production and staging the subquery is true, the SELECT yields **no row at
  all**, and therefore no trigger fires, no conflict arises and nothing is
  written. That is the no-op, and it is structural rather than conditional on a
  trigger's mood.

  `ON CONFLICT DO NOTHING` stays as the second wall, **with no inference
  clause** on purpose. Slice B replaced the old `roles_name_key` constraint with
  two partial unique **indexes**, `roles_system_name_key` and
  `roles_company_name_key`; neither is a constraint, as
  `pg_constraint` on this table confirms (only the primary key and two foreign
  keys). So `ON CONFLICT ON CONSTRAINT roles_system_name_key` — the shape the
  audit suggested — raises `42704`, "constraint … does not exist", and could
  never have applied. The inference form `ON CONFLICT (lower(btrim(name)))
  WHERE company_id IS NULL` does resolve that index, but this statement supplies
  an explicit `id` and so has **two** independent ways to conflict, the primary
  key being the other; an inference clause names one index and lets the other
  raise. The bare form covers every unique index, which is what is wanted from
  a second wall. The premise it rests on — that the partial index exists — is
  asserted directly in the self-check instead of being implied by an inference
  clause.

  The permission rows conflict on `role_permissions_role_id_page_key_key`,
  which *is* a real unique constraint, so the ordinary column form applies
  there.

  ## The page keys are read from the database, not written out here

  `public.role_page_keys()` is the authoritative list (16 keys, defined in
  `20260923120000`, which is newer than the fixture epoch and so already applied
  when this file runs). Reading it is what keeps this file from becoming a
  seventeenth place the list is written down; `src/utils/rolePageKeys.test.ts`
  pins that function against `PAGE_DEFINITIONS`, and a hand-written array here
  would sit outside that pin. Production's `viewer` holds exactly those 16 keys,
  every one `can_view = true`, none `can_edit` — verified, and asserted below.

  ## The test is not vacuous

  `tests/rls/roles-seed.sql` seeded `viewer` itself, so a kit assertion written
  today would have measured the seed and passed with this file reverted. Its
  `viewer` row and that role's branch of its permission insert are removed in
  the same commit, which leaves this migration as the only thing in the kit that
  can create the row. Section 9 of `tests/rls/company-roles.sql` is the
  assertion, and its mutation control is in the PR.

  ## Privileges, policies, triggers

  Nothing is granted, revoked or policied here: `roles` and `role_permissions`
  keep the shape `20260917130000` and `20260923110010` gave them. The two
  context triggers on both tables are inert for this file —
  `refuse_read_only_context_write` returns on its `v_uid IS NULL` branch
  because a migration carries no JWT subject, and `record_support_write` is
  gated with a `WHEN` clause on a transaction-local setting that only that
  refusal trigger ever sets.
*/

-- ─── 1. The role ────────────────────────────────────────────────────────────

INSERT INTO public.roles (id, name, description, is_system, company_id)
SELECT 'fdb2798f-08a7-481c-8bbb-67e15540926e'::uuid, 'viewer', 'test', true, NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM public.roles
    WHERE company_id IS NULL
      AND lower(btrim(name)) = 'viewer'
 )
ON CONFLICT DO NOTHING;

-- ─── 2. Its sixteen permission rows: read everywhere, write nowhere ─────────

INSERT INTO public.role_permissions (role_id, page_key, can_view, can_edit)
SELECT r.id, k, true, false
  FROM public.roles r
 CROSS JOIN unnest(public.role_page_keys()) AS k
 WHERE r.company_id IS NULL
   AND lower(btrim(r.name)) = 'viewer'
ON CONFLICT (role_id, page_key) DO NOTHING;

-- ─── 3. Self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  v_role        public.roles;
  v_count       int;
  v_keys        int := array_length(public.role_page_keys(), 1);
  v_missing     text;
  v_extra       text;
BEGIN
  -- 1. Exactly one system role named viewer, and it is a system row with no
  --    company. Counted before it is fetched, so two rows are reported as two
  --    rather than raising an unhelpful "more than one row returned".
  SELECT count(*) INTO v_count
    FROM public.roles
   WHERE company_id IS NULL AND lower(btrim(name)) = 'viewer';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'viewer seed self-check 1: % system roles named viewer, expected exactly 1', v_count;
  END IF;

  SELECT * INTO v_role
    FROM public.roles
   WHERE company_id IS NULL AND lower(btrim(name)) = 'viewer';

  IF NOT coalesce(v_role.is_system, false) THEN
    RAISE EXCEPTION
      'viewer seed self-check 1: the viewer role is not is_system — roles_update and '
      'roles_delete both require is_system = false, so the screens would offer a '
      'company administrator a role it could edit and delete';
  END IF;

  -- 2. The id two kit files name by literal. A different value does not break
  --    the product, but it breaks tests/rls/oauth-signup.sql silently in the
  --    sense that it is no longer testing what it names, so it is named here.
  IF v_role.id <> 'fdb2798f-08a7-481c-8bbb-67e15540926e'::uuid THEN
    RAISE EXCEPTION
      'viewer seed self-check 2: the viewer role is % — tests/rls/oauth-signup.sql '
      'names fdb2798f-08a7-481c-8bbb-67e15540926e by literal, twice', v_role.id;
  END IF;

  -- 3. Production's and staging's description, measured 25.10.2026. See the
  --    header: the word is an accident, matching it is the point, and changing
  --    it means changing this line and section 9 of company-roles.sql too.
  IF v_role.description IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION
      'viewer seed self-check 3: the viewer description is %, expected the literal '
      'value production and staging both hold', coalesce(quote_literal(v_role.description), 'NULL');
  END IF;

  -- 4. Every page key, each readable and none writable. Both directions, so a
  --    key added to role_page_keys() without a row here, and a row naming a key
  --    the function no longer lists, are each reported.
  SELECT count(*) INTO v_count
    FROM public.role_permissions WHERE role_id = v_role.id;

  IF v_count <> v_keys THEN
    RAISE EXCEPTION
      'viewer seed self-check 4: the viewer role has % permission rows, expected % — '
      'one per key in role_page_keys()', v_count, v_keys;
  END IF;

  SELECT string_agg(k, ', ' ORDER BY k) INTO v_missing
    FROM unnest(public.role_page_keys()) AS k
   WHERE NOT EXISTS (
     SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = v_role.id AND rp.page_key = k
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'viewer seed self-check 4: the viewer role is missing permission rows for %', v_missing;
  END IF;

  SELECT string_agg(rp.page_key, ', ' ORDER BY rp.page_key) INTO v_extra
    FROM public.role_permissions rp
   WHERE rp.role_id = v_role.id
     AND NOT (rp.page_key = ANY (public.role_page_keys()));

  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION
      'viewer seed self-check 4: the viewer role names page keys role_page_keys() does '
      'not list: %', v_extra;
  END IF;

  -- 5. Read everywhere, write nowhere. IS NOT DISTINCT FROM rather than =,
  --    because can_view and can_edit are both nullable and a NULL would make
  --    an = comparison fall through as neither true nor false.
  SELECT count(*) INTO v_count
    FROM public.role_permissions
   WHERE role_id = v_role.id
     AND NOT (can_view IS NOT DISTINCT FROM true AND can_edit IS NOT DISTINCT FROM false);

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'viewer seed self-check 5: % of the viewer role''s permission rows are not '
      '(can_view, can_edit) = (true, false)', v_count;
  END IF;

  -- 6. The premise the bare ON CONFLICT rests on, asserted directly because no
  --    inference clause names it. A partial unique index on lower(btrim(name))
  --    over the system rows is what makes "one system role per name" true, and
  --    section 1's guard is written on that same expression.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.roles'::regclass
       AND c.relname = 'roles_system_name_key'
       AND i.indisunique
       AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'viewer seed self-check 6: roles_system_name_key is not a partial unique index on '
      'public.roles — slice B''s guarantee of one system role per name is gone, and this '
      'file''s second wall has nothing to arbitrate on';
  END IF;

  RAISE NOTICE
    'viewer system role present: id %, % permission rows, read everywhere, write nowhere',
    v_role.id, v_keys;
END $selfcheck$;

COMMENT ON TABLE public.roles IS
  'Role definitions. The four system rows (company_id IS NULL) are admin, '
  'supervisor and editor from 20260302065621, and viewer from 20261025130000 — '
  'which seeds a row production had held, created by hand, since 26.04.2026.';
