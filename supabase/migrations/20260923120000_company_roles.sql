/*
  # Slice B — a company's own roles become real

  Owner's approval, 23.09.2026.

  ## What is already true, and is not changed here

  `roles` carries `company_id` (NULL for a system role) and `is_system`.
  `20260917130000` gave both tables the account-shell policy shape: a company
  admin creates, updates and deletes **its own** roles (`is_system = false`,
  `company_id = get_user_company_id()`) and edits only its own roles'
  permissions; the system rows are readable by everyone and writable by nobody.
  `20260917140000` pinned `roles.company_id` and `role_permissions.role_id`
  against an UPDATE that would re-point them, and put both tables on
  `refuse_read_only_context_write`, so `20260920110000` audits every row a
  support session writes here. None of that is touched.

  Measured on production, 23.09.2026: `roles` holds four rows, all
  `company_id IS NULL` and `is_system = true` (admin, editor, supervisor,
  viewer), `role_permissions` 64 rows for them, and **no company has ever
  created a role of its own** — all 29 accounts sit on one of the four.

  ## What was missing, and what this file adds

  ### 1. `roles_name_key UNIQUE (name)` is global

  Two companies could not both call a role `Disponent`. That single constraint
  made "a company creates its own roles" unusable the moment a second company
  tried, and it is why the feature was never exercised. It is replaced by two
  partial unique indexes: one over the system rows, which keeps the old
  guarantee exactly where it mattered, and one per company, case-insensitive.

  ### 2. Relaxing it alone would be a privilege escalation

  `sync_user_profile_role` (20260302065621) copies `roles.name` into
  `user_profiles.role` on every write. That text is read as an authority in
  three places: `is_company_admin()` (`up.role = 'admin'`), which gates
  `company_settings`, `notification_settings`, the roles writes and deleting an
  import or a trip; `AuthContext.isAdmin`, which decides whether App.tsx
  registers the Benutzer, Rollen and Einstellungen routes at all; and
  `activation-code-mail.ts`, which picks a company's admins as the recipients
  of an activation code.

  So with per-company names allowed, a company admin could create a role named
  `admin` with no permissions at all, assign it to a viewer, and that viewer
  would be a company administrator — granted by a name, not by a permission
  row. The global unique constraint was the only thing standing in the way of
  that, and it is exactly what section 1 removes.

  `enforce_company_role_shape` is what replaces it: a company role may not take
  a name a system role holds (compared case- and whitespace-insensitively,
  because relying on `'Admin' <> 'admin'` puts a security boundary on one
  `lower()` away from flipping), may not be created with `is_system = true`,
  and may not flip `is_system` later. The reverse is checked too — a system
  role may not take a name a company already uses — so the invariant holds
  whichever side is written.

  ### 3. Nothing stopped a profile pointing at another company's role

  `enforce_user_profile_privilege_guard` decides **who** may change `role` and
  `role_id`; it says nothing about **what** `role_id` may be set to. A company
  admin could therefore point one of its own profiles at another company's role
  uuid — and `current_role_permits()` would read that foreign role's permission
  rows. RLS could not catch it: `roles_select` hides the row from the caller,
  but a `WITH CHECK` on `user_profiles` cannot reach into another table, and
  the foreign key only asks that the role exist.

  `enforce_user_profile_role_scope` is a second trigger rather than a restating
  of the privilege guard, deliberately: that function is the boundary of four
  other rules, and a rule that is *added* is safer as a row of its own than as
  a re-typed copy of a body the migration does not otherwise need to change.
  It is unguarded — the service role and GoTrue reach it too — because a
  service-role write pointing at a foreign role is precisely the mistake worth
  catching, and every sanctioned writer already resolves the role within the
  profile's own company (`signup_insert_company` writes the *system* admin
  role, `manage-users` scopes its lookup to the caller's company).

  ### 4. The screens wrote a role in two statements

  `RolesManagement.handleSaveRole` inserted the role, then inserted its
  permission rows; editing deleted every permission row and re-inserted. A
  failure between the two left a role with no permissions — that is, every
  holder locked out of every page — with no error anyone could act on.
  `company_role_save` does both in one transaction, and `company_role_delete`
  answers how many accounts still hold a role instead of the foreign key's
  `23503`.

  Both are **SECURITY INVOKER**: RLS already says the right thing here, so the
  policies stay the boundary and the two functions add only atomicity, argument
  validation and a stable reason. A SECURITY DEFINER pair would have to
  re-implement `is_company_admin()`, the company term and the `is_system` test,
  and would be the third copy of each.

  ## Compatibility — no SCHEMA_EPOCH bump

  Nothing is dropped that the previous release reads, nothing is renamed and no
  signature changes. Section 1 *widens* a uniqueness constraint, which the
  previous release cannot notice. The two new triggers refuse only writes the
  previous release never made: it could not create a company role named `admin`
  (the global constraint refused it) and nothing in it ever wrote a foreign
  `role_id`. The two new functions are additive; a rolled-back release simply
  goes back to its own two-statement save.

  The one state a rollback would leave behind is a company role whose name
  collides with another company's. The previous release reads roles through
  `roles_select`, which is already scoped per company, and resolves a text role
  with the same company term (`current_role_permits`, `manage-users.roleIdFor`),
  so it reads such a row correctly. That is why this is not an epoch matter.

  ## Ownership, and why the two helpers are in `public`

  Every function here is `SET search_path` and schema-qualified.

  `role_page_keys()` and `role_name_is_system_reserved()` are in **`public`**,
  not in `app_private`, and that is not a style choice. Both are read from two
  places that run as the **caller**: `enforce_company_role_shape`, a
  SECURITY INVOKER trigger fired by whoever writes `roles`, and
  `company_role_save`, which is SECURITY INVOKER by design. `authenticated`
  holds no USAGE on `app_private` and no EXECUTE on anything in it — that is
  the rule, asserted on every release by `20260919120000`'s self-check — so a
  call from either place is refused with `42501 permission denied`. Measured in
  a throwaway PostgreSQL 16 before this file was corrected: a company admin's
  plain `INSERT INTO roles` died on the trigger, and `company_role_save`
  answered `{"ok": false, "reason": "not_authorized"}`, because `42501` is
  `insufficient_privilege` and the function's own handler caught it. The
  feature would have been dead on arrival, and the message would have blamed
  the administrator's role.

  Neither function is security state. One returns a constant list of sixteen
  page keys; the other answers whether a **system** role carries a name, and
  every system role is readable by every signed-in caller through
  `roles_select` (`company_id IS NULL OR …`), so a SECURITY INVOKER function in
  `public` gives exactly the answer a definer would. They are revoked from
  PUBLIC and anon and granted to `authenticated` and `service_role`, the two
  roles that write `roles` and so fire the trigger.

  Self-check 9 is the rule rather than the instance: no function the trigger or
  either RPC reaches may name `app_private`.
*/

-- ─── 1. Two companies may hold a role of the same name ──────────────────────

/*
  `roles_name_key` was `UNIQUE (name)` across every company. Replaced by:

    * `roles_system_name_key`  — one system role per name, which is the whole
      content the old constraint ever carried in practice, since every row that
      existed was a system row.
    * `roles_company_name_key` — one name per company, case-insensitive, so a
      company cannot end up with `Disponent` and `disponent` side by side and
      no way to tell them apart on screen.

  `CREATE UNIQUE INDEX` rather than `ADD CONSTRAINT`: a partial index is the
  only form that can carry the `WHERE`, and the whole file runs in one
  transaction, so a database that already held a duplicate fails the release
  here rather than halfway through.
*/
ALTER TABLE public.roles DROP CONSTRAINT IF EXISTS roles_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS roles_system_name_key
  ON public.roles (lower(btrim(name)))
  WHERE company_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS roles_company_name_key
  ON public.roles (company_id, lower(btrim(name)))
  WHERE company_id IS NOT NULL;

COMMENT ON INDEX public.roles_system_name_key IS
  'One system role per name. What roles_name_key (UNIQUE (name), global) '
  'actually carried, now that a company may hold a name of its own.';

COMMENT ON INDEX public.roles_company_name_key IS
  'One role name per company, case- and whitespace-insensitive.';

/*
  The count of profiles on a role, and the foreign key check that runs on every
  role delete, both scanned `user_profiles` whole. One row per company's roles
  screen is cheap today and will not stay cheap.
*/
CREATE INDEX IF NOT EXISTS idx_user_profiles_role_id
  ON public.user_profiles (role_id)
  WHERE role_id IS NOT NULL;

-- ─── 2. A company role is not a system role, and never borrows its name ─────

/*
  Whether a system role already holds this name. Compared on
  `lower(btrim(...))`, the same expression the two indexes above are built on,
  so "the name is free" and "the name is allowed" can never disagree.

  STABLE and NULL-safe: a NULL or blank name is not reserved (the RPC and the
  NOT NULL column refuse it for their own reasons), never an error.

  In `public` and SECURITY INVOKER, for the reason in the header: both callers
  run as the caller, and `authenticated` cannot reach `app_private`. Under RLS
  the answer is the same for everyone — `roles_select` shows every system role
  to every signed-in caller — so a definer would add nothing but reach.
*/
CREATE OR REPLACE FUNCTION public.role_name_is_system_reserved(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.roles r
     WHERE r.company_id IS NULL
       AND lower(btrim(r.name)) = lower(btrim(p_name))
  );
$$;

COMMENT ON FUNCTION public.role_name_is_system_reserved(text) IS
  'Does a system role (company_id IS NULL) already hold this name? Compared on '
  'lower(btrim(...)), the expression roles_system_name_key is built on.';

/*
  The shape rule for a role row.

  A company role must not be named after a system role. `user_profiles.role`
  is a copy of `roles.name` (sync_user_profile_role), and that text is read as
  an authority by is_company_admin(), by AuthContext.isAdmin and by the
  activation-code mail's recipient list. Before this file a global
  `UNIQUE (name)` made the collision impossible; section 1 removed it, so the
  rule has to be stated.

  A company role must also not be `is_system`. `roles_insert` has no term for
  it, while `roles_update` and `roles_delete` both require `is_system = false`
  — so a company admin could create a row it could then neither edit nor
  delete, and which the screens would draw as one of the untouchable
  templates.

  And `is_system` is pinned: a role does not change kind. `company_id` is
  already pinned by `pin_roles_company_id` (20260917140000); this is the same
  instrument for the other column that decides which rules a row lives under.

  The reverse case is checked too. Only a migration creates a system role, but
  a migration that added one whose name a company had already taken would make
  every such company's role an escalation retroactively, which is a failure
  worth having loudly at release time.
*/
CREATE OR REPLACE FUNCTION app_private.enforce_company_role_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND coalesce(NEW.is_system, false) IS DISTINCT FROM coalesce(OLD.is_system, false) THEN
    RAISE EXCEPTION
      'roles.is_system is fixed when the row is written — a role does not change kind.'
      USING ERRCODE = 'P0001', HINT = 'role_kind_is_fixed';
  END IF;

  IF NEW.company_id IS NOT NULL THEN
    IF coalesce(NEW.is_system, false) THEN
      RAISE EXCEPTION
        'A company role cannot be a system role.'
        USING ERRCODE = 'P0001', HINT = 'company_role_not_system';
    END IF;

    IF public.role_name_is_system_reserved(NEW.name) THEN
      RAISE EXCEPTION
        'The role name "%" is reserved: a system role already carries it, and '
        'user_profiles.role is read as an authority under that name.', btrim(NEW.name)
        USING ERRCODE = 'P0001', HINT = 'role_name_reserved';
    END IF;
  ELSE
    -- A system role, which only a migration writes. Refuse a name a company
    -- has already taken rather than turn that company's role into a grant.
    IF EXISTS (SELECT 1 FROM public.roles r
                WHERE r.company_id IS NOT NULL
                  AND r.id IS DISTINCT FROM NEW.id
                  AND lower(btrim(r.name)) = lower(btrim(NEW.name))) THEN
      RAISE EXCEPTION
        'A company already holds the role name "%" — creating a system role of '
        'that name would grant it that authority.', btrim(NEW.name)
        USING ERRCODE = 'P0001', HINT = 'role_name_held_by_company';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.enforce_company_role_shape() IS
  'A company role is never is_system and never borrows a system role''s name '
  '(which user_profiles.role would copy, and is_company_admin() would read as '
  'an authority); is_system never changes; and a system role never takes a '
  'name a company already holds.';

DROP TRIGGER IF EXISTS enforce_company_role_shape ON public.roles;
CREATE TRIGGER enforce_company_role_shape
  BEFORE INSERT OR UPDATE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_company_role_shape();

-- ─── 3. A profile names a role of its own company, or a system role ─────────

/*
  `role_id` may point at a system role (`company_id IS NULL`) or at a role of
  the profile's own company. Nothing else.

  Written as "the role exists and is in scope", never as "the role is out of
  scope", so a `role_id` naming a row that does not exist is refused here as
  well as by the foreign key, and no comparison can come back NULL and fall
  through. A NULL `role_id` is the legacy text-role state and is left alone;
  `current_role_permits()` resolves it by name with the same company term.

  Unguarded on purpose — the service role and GoTrue reach this too. Every
  sanctioned writer already stays in scope: `signup_insert_company` writes the
  system `admin` role, `oauth_signup_discard` writes NULL, and `manage-users`
  resolves a name against the caller's own company plus the system rows. A
  writer that does not is the defect this exists to name.

  Ordering: `sync_role_trigger` (BEFORE, sorts first by name) copies
  `roles.name` into NEW.role. It touches neither column read here, so the two
  are independent; the name sorts after it anyway, next to the privilege
  guard.
*/
CREATE OR REPLACE FUNCTION app_private.enforce_user_profile_role_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.role_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.roles r
        WHERE r.id = NEW.role_id
          AND (r.company_id IS NULL OR r.company_id = NEW.company_id)
     ) THEN
    RAISE EXCEPTION
      'Not allowed: a profile may name a role of its own company or a system '
      'role, and this role is neither.'
      USING ERRCODE = '42501', HINT = 'role_out_of_scope';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.enforce_user_profile_role_scope() IS
  'user_profiles.role_id names a system role or a role of the profile''s own '
  'company. The privilege guard decides who may change the role; this decides '
  'what it may be changed to.';

DROP TRIGGER IF EXISTS user_profiles_role_scope_guard ON public.user_profiles;
CREATE TRIGGER user_profiles_role_scope_guard
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION app_private.enforce_user_profile_role_scope();

-- ─── 4. The page keys a permission row may name ─────────────────────────────

/*
  The sixteen `page_key`s the application knows, which is `PAGE_DEFINITIONS` in
  `src/types/role.ts`. Kept here for the same reason `plan_feature_keys()` is
  kept in the database (20260917120000): a permission row naming a key no
  screen asks about grants nothing and is invisible on the screen that wrote
  it, so a typo would read as "this area is simply not permitted".

  `src/utils/rolePageKeys.test.ts` reads the newest migration that defines this
  list and fails when it and PAGE_DEFINITIONS differ, so the two move together.
  A screen added later adds its key here in the same migration that seeds it.

  In `public` rather than beside `plan_feature_keys()` in `app_private`, because
  its one reader is SECURITY INVOKER; see the header. The list is a constant and
  says nothing a signed-in caller cannot already read off its own roles screen.
*/
CREATE OR REPLACE FUNCTION public.role_page_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT ARRAY[
    'overview', 'drivers', 'income', 'receipts', 'fixed-costs', 'salaries',
    'cash-balance', 'statistics', 'documents', 'accounting', 'users', 'cars',
    'werkstatt', 'notes', 'roles', 'settings'
  ]::text[];
$$;

COMMENT ON FUNCTION public.role_page_keys() IS
  'The page_keys a role_permissions row may name — PAGE_DEFINITIONS in '
  'src/types/role.ts. Pinned against it by src/utils/rolePageKeys.test.ts.';

-- ─── 5. One transaction per role ────────────────────────────────────────────

/*
  Create or replace a company role together with its permission rows.

  SECURITY INVOKER: `roles_insert|update` and `role_permissions_*`
  (20260917130000) already carry the company term, the administrator gate and
  the `is_system = false` test, and they stay the boundary. What this adds is
  the one thing a client cannot: **atomicity**. The screen used to insert the
  role and then its permission rows, and on an edit to delete every permission
  row and re-insert — a failure in between left a role with no permissions,
  which is every holder locked out of every page with nothing on screen to say
  so.

  `p_permissions` is `[{"page_key": text, "can_view": bool, "can_edit": bool}]`.
  A key outside `role_page_keys()` is refused, a repeated key is refused, and
  `can_edit` without `can_view` is refused — the same rule RoleModal enforces
  in the form, stated where it cannot be bypassed. Rows with neither flag are
  dropped rather than stored: absent and "explicitly nothing" mean the same to
  `current_role_permits()`, and not storing them keeps a role's rows a list of
  what it may do.

  Refusals are return values (`{"ok": false, "reason": …}`) so the screen can
  name them; only a broken argument contract raises. `unique_violation` and
  `insufficient_privilege` are caught by their SQLSTATE and mapped — a caught
  exception rolls back to the function's own savepoint, so a refusal never
  leaves half a role behind. Nothing broader is caught, and in particular
  `refuse_read_only_context_write` (P0001, HINT `support_session_required`)
  travels out unchanged: a view context's refusal is the same sentence here as
  on a direct write, and `contextRefusalMessage()` in the browser already
  says it.
*/
CREATE OR REPLACE FUNCTION public.company_role_save(
  p_name        text,
  p_description text,
  p_permissions jsonb,
  p_role_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_company    uuid;
  v_name       text := btrim(coalesce(p_name, ''));
  v_role_id    uuid := p_role_id;
  v_keys       text[] := public.role_page_keys();
  v_rows       int;
  v_entry      jsonb;
  v_seen       text[] := ARRAY[]::text[];
  v_page       text;
  v_view       boolean;
  v_edit       boolean;
BEGIN
  IF p_permissions IS NULL OR jsonb_typeof(p_permissions) <> 'array' THEN
    RAISE EXCEPTION 'company_role_save: p_permissions must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_company := public.get_user_company_id();
  IF v_company IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_company');
  END IF;

  IF v_name = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'name_required');
  END IF;
  IF length(v_name) > 60 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'name_too_long');
  END IF;
  IF public.role_name_is_system_reserved(v_name) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'name_reserved');
  END IF;

  -- Validate every entry before writing anything, so a bad key in the middle
  -- of the list cannot leave the first half stored.
  FOR v_entry IN SELECT jsonb_array_elements(p_permissions) LOOP
    IF jsonb_typeof(v_entry) <> 'object' THEN
      RAISE EXCEPTION 'company_role_save: each permission must be an object'
        USING ERRCODE = '22023';
    END IF;
    v_page := v_entry ->> 'page_key';
    IF v_page IS NULL OR NOT (v_page = ANY (v_keys)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unknown_page_key',
                                'page_key', v_page);
    END IF;
    IF v_page = ANY (v_seen) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_page_key',
                                'page_key', v_page);
    END IF;
    v_seen := v_seen || v_page;

    /*
      jsonb comparison rather than a cast: `(x ->> 'can_view')::boolean` raises
      22P02 on anything that is not a boolean word, and an argument this
      function cannot read must be a stated refusal, not a cast error.

      `IS NOT DISTINCT FROM` and not `=`, and that is the whole guard. An entry
      that simply leaves `can_view` out — `{"page_key": "drivers", "can_edit":
      true}`, which the screen never sends but a direct PostgREST call may —
      makes `v_entry -> 'can_view'` SQL NULL, so `= 'true'::jsonb` is NULL,
      `v_edit AND NOT v_view` is NULL, `IF NULL THEN` does not fire, and the
      rule below fails **open**: the row is stored with can_edit true and
      can_view NULL (the column is nullable), which is exactly the state
      "bearbeiten ohne ansehen" exists to prevent. The RLS kit caught it.
    */
    v_view := (v_entry -> 'can_view') IS NOT DISTINCT FROM 'true'::jsonb;
    v_edit := (v_entry -> 'can_edit') IS NOT DISTINCT FROM 'true'::jsonb;
    IF v_edit AND NOT v_view THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'edit_without_view',
                                'page_key', v_page);
    END IF;
  END LOOP;

  IF v_role_id IS NOT NULL THEN
    -- The role must be this company's own and not a template. Read through
    -- RLS: a role of another company is simply not visible, and answers
    -- `not_found` rather than telling the caller it exists.
    IF NOT EXISTS (SELECT 1 FROM public.roles r
                    WHERE r.id = v_role_id AND r.company_id = v_company) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;
    IF EXISTS (SELECT 1 FROM public.roles r
                WHERE r.id = v_role_id AND coalesce(r.is_system, false)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'system_role');
    END IF;

    UPDATE public.roles
       SET name = v_name, description = coalesce(btrim(p_description), '')
     WHERE id = v_role_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      -- roles_update refused it: the caller is not an administrator of this
      -- company, or is inside a read-only support context.
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;

    DELETE FROM public.role_permissions WHERE role_id = v_role_id;
  ELSE
    INSERT INTO public.roles (name, description, is_system, created_by, company_id)
    VALUES (v_name, coalesce(btrim(p_description), ''), false, v_uid, v_company)
    RETURNING id INTO v_role_id;
  END IF;

  -- `IS NOT DISTINCT FROM` again, for the same reason as the loop above and
  -- one more: `can_view` and `can_edit` are nullable, so a `=` against an
  -- absent key would store NULL rather than false, and a NULL that reads as
  -- "not permitted" in one query and as unknown in the next is not a
  -- permission row anyone can reason about.
  INSERT INTO public.role_permissions (role_id, page_key, can_view, can_edit)
  SELECT v_role_id,
         entry ->> 'page_key',
         (entry -> 'can_view') IS NOT DISTINCT FROM 'true'::jsonb,
         (entry -> 'can_edit') IS NOT DISTINCT FROM 'true'::jsonb
    FROM jsonb_array_elements(p_permissions) AS entry
   WHERE (entry -> 'can_view') IS NOT DISTINCT FROM 'true'::jsonb
      OR (entry -> 'can_edit') IS NOT DISTINCT FROM 'true'::jsonb;

  RETURN jsonb_build_object('ok', true, 'role_id', v_role_id);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'name_taken');
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
END;
$$;

COMMENT ON FUNCTION public.company_role_save(text, text, jsonb, uuid) IS
  'Create or replace one of the caller''s company''s own roles together with '
  'its permission rows, in one transaction. SECURITY INVOKER: the policies of '
  '20260917130000 stay the boundary. Refusals are return values.';

/*
  Delete one of the company's own roles, or say how many accounts still hold
  it.

  The count is what the foreign key `user_profiles_role_id_fkey` would
  otherwise turn into a bare `23503` on the screen. It is read through RLS, so
  it counts the profiles the caller can see — which is its own company's
  (`user_profiles_select`), and since section 3 a company role cannot be held
  anywhere else, that is all of them.

  The foreign key stays the wall: the count is taken first for the message, and
  `foreign_key_violation` is mapped to the same reason for the case where an
  account is assigned between the two statements.
*/
CREATE OR REPLACE FUNCTION public.company_role_delete(p_role_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_company  uuid;
  v_is_system boolean;
  v_assigned int;
  v_rows     int;
BEGIN
  IF p_role_id IS NULL THEN
    RAISE EXCEPTION 'company_role_delete: p_role_id is required'
      USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_company := public.get_user_company_id();
  IF v_company IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_company');
  END IF;

  SELECT coalesce(r.is_system, false) INTO v_is_system
    FROM public.roles r
   WHERE r.id = p_role_id AND r.company_id IS NOT DISTINCT FROM v_company;

  IF NOT FOUND THEN
    -- Either no such role, or one this caller cannot see. A system role is
    -- visible but is not this company's, so it lands here too — and is named,
    -- because the screen draws it and can say why.
    IF EXISTS (SELECT 1 FROM public.roles r
                WHERE r.id = p_role_id AND r.company_id IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'system_role');
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_is_system THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'system_role');
  END IF;

  SELECT count(*) INTO v_assigned
    FROM public.user_profiles up
   WHERE up.role_id = p_role_id;

  IF v_assigned > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'assigned',
                              'assigned_count', v_assigned);
  END IF;

  DELETE FROM public.roles WHERE id = p_role_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  RETURN jsonb_build_object('ok', true);
EXCEPTION
  WHEN foreign_key_violation THEN
    -- An account was pointed at the role between the count and the delete.
    RETURN jsonb_build_object('ok', false, 'reason', 'assigned',
                              'assigned_count', greatest(v_assigned, 1));
  WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
END;
$$;

COMMENT ON FUNCTION public.company_role_delete(uuid) IS
  'Delete one of the caller''s company''s own roles, or answer how many '
  'accounts still hold it. SECURITY INVOKER; the foreign key stays the wall.';

-- ─── 6. Grants ──────────────────────────────────────────────────────────────

/*
  Supabase's default privileges grant EXECUTE on every new `public` function to
  PUBLIC, anon, authenticated and service_role, so the REVOKE names all of
  them before the one GRANT that is meant. Both functions are SECURITY
  INVOKER, so anon would reach nothing through them — the revoke is the second
  wall, and the self-check asks for it.

  The two helpers are revoked the same way and then granted to `authenticated`
  **and `service_role`**: both are read by `enforce_company_role_shape`, which
  is SECURITY INVOKER and fires for whoever writes `roles` — a company
  administrator through PostgREST, and an edge function holding the service
  key. A role that may write the table and may not read the helper cannot write
  it at all; that is the defect the header describes, and the grant is what
  closes it. anon holds neither, and `roles_insert` is `TO authenticated`
  anyway, so anon never reaches the trigger.

  The two trigger functions themselves stay revoked from everyone. A trigger's
  EXECUTE is checked when the trigger is created, not when it fires, so no
  caller needs it.
*/
REVOKE ALL ON FUNCTION public.company_role_save(text, text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.company_role_delete(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.company_role_save(text, text, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_role_delete(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.role_page_keys()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.role_name_is_system_reserved(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.role_page_keys()                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.role_name_is_system_reserved(text)   TO authenticated, service_role;

REVOKE ALL ON FUNCTION app_private.enforce_company_role_shape()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.enforce_user_profile_role_scope()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 7. Self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  v_missing  text;
  v_count    int;
  v_orphans  int;
  v_fn       text;
  v_body     text;
  v_refused  boolean;
  v_probe    boolean;
BEGIN
  -- 1. The global name constraint is gone and the two partial indexes are in.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.roles'::regclass AND conname = 'roles_name_key') THEN
    RAISE EXCEPTION 'slice B self-check 1: roles_name_key is still there — a company still cannot name its own role';
  END IF;
  FOREACH v_missing IN ARRAY ARRAY['roles_system_name_key', 'roles_company_name_key', 'idx_user_profiles_role_id'] LOOP
    IF to_regclass('public.' || v_missing) IS NULL THEN
      RAISE EXCEPTION 'slice B self-check 1: index % is missing', v_missing;
    END IF;
  END LOOP;

  -- 2. Both triggers are installed on the right tables and events.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.roles'::regclass
                    AND tgname = 'enforce_company_role_shape' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'slice B self-check 2: enforce_company_role_shape is not on public.roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.user_profiles'::regclass
                    AND tgname = 'user_profiles_role_scope_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'slice B self-check 2: user_profiles_role_scope_guard is not on public.user_profiles';
  END IF;

  -- 3. The rule of section 2, exercised rather than read. A company role named
  --    after a system one is the escalation this file exists to refuse.
  --
  --    The probe names a company that does not exist, so the only two ways out
  --    are the shape trigger (BEFORE INSERT, which runs first) and the foreign
  --    key (an AFTER constraint trigger, which runs only if the shape trigger
  --    let the row through). Reaching the foreign key *is* the failure.
  --
  --    `v_refused` rather than a RAISE inside the block: a RAISE here would be
  --    P0001 too, and the handler below would swallow the very failure it is
  --    meant to report.
  SELECT EXISTS (SELECT 1 FROM public.roles WHERE company_id IS NULL AND name = 'admin')
    INTO v_probe;
  IF NOT v_probe THEN
    RAISE NOTICE 'slice B self-check 3: no system role named admin here — the reserved-name rule is untested in this database';
  ELSE
    v_refused := false;
    BEGIN
      INSERT INTO public.roles (name, is_system, company_id)
      VALUES ('admin', false, '00000000-0000-0000-0000-000000000000');
    EXCEPTION
      WHEN foreign_key_violation THEN v_refused := false;
      WHEN sqlstate 'P0001'        THEN v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'slice B self-check 3: a company role named "admin" was not refused by enforce_company_role_shape';
    END IF;
  END IF;

  -- 4. `is_system` on a company role is refused too. Same shape, same reason.
  v_refused := false;
  BEGIN
    INSERT INTO public.roles (name, is_system, company_id)
    VALUES ('slice-b-selfcheck-' || gen_random_uuid()::text, true,
            '00000000-0000-0000-0000-000000000000');
  EXCEPTION
    WHEN foreign_key_violation THEN v_refused := false;
    WHEN sqlstate 'P0001'        THEN v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'slice B self-check 4: a company role with is_system = true was not refused';
  END IF;

  -- 5. The four rules the privilege guard already carried are still in its
  --    body. This file adds a trigger beside it and must not have replaced it.
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_user_profile_privilege_guard';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'slice B self-check 5: enforce_user_profile_privilege_guard is gone';
  END IF;
  FOREACH v_missing IN ARRAY ARRAY[
    'cannot change user_id',
    'cannot modify is_super_admin',
    'cannot change company assignment',
    'cannot change role assignment',
    'cannot change account status'
  ] LOOP
    IF position(v_missing IN v_body) = 0 THEN
      RAISE EXCEPTION 'slice B self-check 5: the privilege guard no longer refuses "%"', v_missing;
    END IF;
  END LOOP;

  -- 6. The two RPCs exist, are SECURITY INVOKER, carry a pinned search_path,
  --    and anon holds EXECUTE on neither.
  FOR v_fn IN SELECT unnest(ARRAY['company_role_save', 'company_role_delete']) LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn
       AND NOT p.prosecdef
       AND p.proconfig::text LIKE '%search_path=%';
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'slice B self-check 6: %() is not exactly one SECURITY INVOKER function with a pinned search_path', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.company_role_save(text, text, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.company_role_delete(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'slice B self-check 6: anon can execute a company-roles RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.company_role_save(text, text, jsonb, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.company_role_delete(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'slice B self-check 6: authenticated cannot execute a company-roles RPC';
  END IF;

  --    …and the two helpers the trigger and the RPC read as the caller. anon
  --    holds neither; authenticated and service_role hold both, because a role
  --    that may write `roles` fires the trigger and the trigger reads them.
  FOREACH v_missing IN ARRAY ARRAY[
    'public.role_page_keys()',
    'public.role_name_is_system_reserved(text)'
  ] LOOP
    IF has_function_privilege('anon', v_missing, 'EXECUTE') THEN
      RAISE EXCEPTION 'slice B self-check 6: anon can execute %', v_missing;
    END IF;
    FOREACH v_fn IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
      IF NOT has_function_privilege(v_fn, v_missing, 'EXECUTE') THEN
        RAISE EXCEPTION
          'slice B self-check 6: % cannot execute % — it writes roles, so it fires enforce_company_role_shape, which reads it', v_fn, v_missing;
      END IF;
    END LOOP;
  END LOOP;

  -- 7. Sixteen page keys, and no duplicate among them.
  SELECT cardinality(public.role_page_keys()) INTO v_count;
  IF v_count <> 16 THEN
    RAISE EXCEPTION 'slice B self-check 7: role_page_keys() holds % keys, expected 16', v_count;
  END IF;
  SELECT count(DISTINCT k) INTO v_count FROM unnest(public.role_page_keys()) AS k;
  IF v_count <> 16 THEN
    RAISE EXCEPTION 'slice B self-check 7: role_page_keys() repeats a key';
  END IF;

  -- 8. The existing data. Nothing is repaired here — a profile silently moved
  --    onto another role is a payroll-adjacent surprise — but a database that
  --    already holds one is named, because the trigger above only sees new
  --    writes.
  SELECT count(*) INTO v_orphans
    FROM public.user_profiles up
    JOIN public.roles r ON r.id = up.role_id
   WHERE r.company_id IS NOT NULL
     AND r.company_id IS DISTINCT FROM up.company_id;
  IF v_orphans > 0 THEN
    RAISE WARNING 'slice B self-check 8: % existing profile(s) name a role of another company — not repaired, see the header', v_orphans;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.roles r
   WHERE r.company_id IS NOT NULL
     AND public.role_name_is_system_reserved(r.name);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'slice B self-check 8: % company role(s) already carry a system role''s name', v_count;
  END IF;

  /*
    9. Nothing on a caller's own path may reach `app_private`.

    The rule, not the instance. `enforce_company_role_shape`,
    `enforce_user_profile_role_scope` and the two RPCs all run as the caller,
    and `authenticated` holds no USAGE on `app_private` and no EXECUTE on
    anything in it. A call from any of them is `42501 permission denied` — and
    in `company_role_save` that is `insufficient_privilege`, which its own
    handler catches and reports as `not_authorized`, so the feature fails
    silently and blames the administrator's role. This file shipped that way
    once; the check is what stops it coming back, in this body or in a later
    restatement.

    `public.` is checked as well as the bare name, so a call written either way
    is caught. A *reference in a comment* would trip it too, which is the right
    side to err on.
  */
  FOREACH v_fn IN ARRAY ARRAY[
    'public.company_role_save',
    'public.company_role_delete',
    'app_private.enforce_company_role_shape',
    'app_private.enforce_user_profile_role_scope',
    'public.role_page_keys',
    'public.role_name_is_system_reserved'
  ] LOOP
    SELECT string_agg(p.prosrc, E'\n') INTO v_body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = split_part(v_fn, '.', 1)
       AND p.proname = split_part(v_fn, '.', 2)
       AND NOT p.prosecdef;
    IF v_body IS NULL THEN
      RAISE EXCEPTION 'slice B self-check 9: %() is missing, or is no longer SECURITY INVOKER', v_fn;
    END IF;
    IF position('app_private.' IN v_body) > 0 THEN
      RAISE EXCEPTION
        'slice B self-check 9: %() runs as the caller and names app_private — authenticated cannot reach it, so the write fails as "not_authorized"', v_fn;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count FROM public.roles WHERE company_id IS NULL;
  RAISE NOTICE 'slice B: % system role(s), % company role(s)',
    v_count, (SELECT count(*) FROM public.roles WHERE company_id IS NOT NULL);
END $selfcheck$;
