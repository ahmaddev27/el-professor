/*
  Passwords for the Supabase service roles.

  ## Where this file has to live, and why

  Mounted at /etc/postgresql.schema.sql. supabase/postgres runs its own
  `migrate.sh` during initialisation, and the last thing that script does is:

      postinit="/etc/postgresql.schema.sql"
      if [ -e "$postinit" ]; then ... psql -U supabase_admin -f "$postinit"

  under the comment "run any post migration script to update role passwords".
  It is the slot this file is for, and it is the only one that runs *after*
  migrations/ — which is where `authenticator`, `supabase_auth_admin` and
  `supabase_storage_admin` are created.

  Placement is the entire point. An earlier version of this lived at
  /docker-entrypoint-initdb.d/99-roles.sh. The standard postgres entrypoint
  globs that directory and digits sort before letters, so it ran before
  `migrate.sh` — when none of these roles existed. It failed, aborted the whole
  initialisation, and left a database holding initdb's base and no Supabase
  schema at all. `db` reported `healthy` throughout; the symptom surfaced as
  three other containers crash-looping.

  `init-scripts/` is not an alternative: migrate.sh runs it before migrations
  too.

  ## Why the file is needed at all

  The image creates these roles without a password, while PostgREST, GoTrue and
  storage-api all authenticate as them using POSTGRES_PASSWORD. Without this,
  all three crash-loop on

      FATAL: password authentication failed for user "authenticator"

  ## Why the password is read rather than written

  psql pulls it from the environment and :'pgpass' quotes it, so a password
  containing a quote cannot break the statement, and the literal never appears
  in this file or in the server log.

  Only these three roles need it. supabase_admin gets its password from initdb
  and again from migrate.sh; pgbouncer and supabase_functions_admin, which
  Supabase's own roles.sql also sets, do not exist in this image — and
  ON_ERROR_STOP would abort initialisation on the first missing one.
*/

\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator          WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin    WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
