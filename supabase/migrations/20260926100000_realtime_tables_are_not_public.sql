/*
  The Realtime image's own tables sit in `public`, and every API role could read
  and write them.

  Measured on production and on staging, 26.09.2026, before this migration:

    tenants            rls=false  policies=0  anon=DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
    extensions         rls=false  policies=0  anon=(the same seven)
    schema_migrations  rls=false  policies=0  anon=(the same seven)

  And through the public API, with the publishable anon key that ships in every
  customer's browser bundle:

    GET https://api.elprofessor.eu/rest/v1/tenants           -> 200
    GET https://api.elprofessor.eu/rest/v1/extensions        -> 200
    GET https://api.elprofessor.eu/rest/v1/schema_migrations -> 200

  `tenants` answered sixteen columns including `jwt_secret` (108 characters, the
  Realtime tenant signing secret) and `jwt_jwks`. `extensions.settings` answered
  `db_host, db_name, db_password, db_port, db_user, publication, slot_name,
  region, ssl_enforced` and the poll settings. Both were readable, and with
  INSERT/UPDATE/DELETE/TRUNCATE also writable: a caller could set
  `tenants.suspend`, move `max_concurrent_users`, overwrite the signing secret,
  or truncate the row the SPA's Realtime channels depend on
  (`src/contexts/CompanySettingsContext.tsx` opens `postgres_changes` on
  `company_settings_<id>`, so that row is live configuration for every customer).

  These are not our tables. The `supabase/realtime` image creates them in
  `public` on boot, and Supabase's DEFAULT PRIVILEGES on that schema — measured:
  `r:postgres; r:supabase_admin` among others — grant every new table to the API
  roles. That is the same default that grants EXECUTE on every new function to
  anon, which CLAUDE.md warns about for functions; nobody had checked it for
  tables.

  ## Why a REVOKE and not RLS, and not a schema move

  Realtime connects as `supabase_admin` (`deploy/docker-compose.yml`, the
  realtime service's `DB_USER`), and `supabase_admin` **owns** all three tables.
  So:

  - **RLS buys nothing.** A table's owner bypasses its policies, so enabling RLS
    on a table whose only reader is its owner adds a layer that examines nobody.
    A REVOKE refuses the caller at the privilege check, before any policy would
    have been consulted. It is the stronger of the two, not the weaker.
  - **Moving them out of `public` is a real risk.** The image expects them there
    and carries twenty-one migrations of its own against them; a move invites a
    boot failure or a silent re-creation on the next image update.
  - **The REVOKE costs Realtime nothing**, for the same reason: it runs as the
    owner, and ownership is not a grant.

  ## The half that matters more

  Revoking three tables fixes the symptom. The cause is the DEFAULT PRIVILEGE,
  so the *next* table any image creates in `public` arrives with the same grants.
  `tests/rls/assertions.sql` therefore gains a rule: a table in `public` with RLS
  disabled must hold no privilege for `anon` or `authenticated`. Measured on
  staging before this migration, exactly three tables violated it — these three
  — so the rule ships as a failure with no exemption list, and the next such
  table fails the release instead of being found by a review.

  We deliberately do not revoke `supabase_admin`'s or `postgres`'s DEFAULT
  PRIVILEGES themselves: that is a global setting on a schema the images own, and
  changing it could break a future image's own boot. The assertion catches the
  consequence, which is what we can own.
*/

/*
  Conditional, because these three exist only where the Realtime image has run.
  The RLS kit builds its database from production's --schema=public dump plus the
  migration chain, and that dump does **not** carry them — the first version of
  this migration failed there with `relation "public.tenants" does not exist`.
  So a plain REVOKE would make every kit run and every fresh environment fail on
  a table that is not theirs to have.

  That absence has a consequence worth stating rather than discovering later:
  **the kit cannot test this fix.** Its database never contains an image-created
  table, so the assertion added in tests/rls/assertions.sql finds nothing here
  and passes vacuously for these three. It earns its place against a table one of
  *our* migrations adds — which is the case we control — and the live check
  against production and staging is a host step, recorded in HANDOFF.md.
*/
DO $$
DECLARE
  t text;
  n int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'extensions', 'schema_migrations'] LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
      n := n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'revoked anon and authenticated on % of 3 Realtime tables present here', n;
END $$;

-- PostgREST reloads its schema cache on DDL through the image's pgrst_ddl_watch
-- event trigger; a REVOKE is not DDL, so tell it explicitly or the three stay
-- in its cached schema until something else changes.
NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(t.relname || ' (' || t.who || ')', ', ' ORDER BY t.relname)
    INTO v_bad
    FROM (
      SELECT c.relname, g.grantee AS who
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.role_table_grants g
          ON g.table_schema = 'public' AND g.table_name = c.relname
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND NOT c.relrowsecurity
         AND g.grantee IN ('anon', 'authenticated')
       GROUP BY c.relname, g.grantee
    ) t;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'a table in public has RLS disabled and still grants an API role: %. '
      'Either enable RLS with policies, or revoke anon and authenticated.', v_bad;
  END IF;

  RAISE NOTICE 'ok  no table in public has RLS disabled while granting anon or authenticated (% such table(s) present)',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity);
END $$;
