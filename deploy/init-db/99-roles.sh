#!/bin/bash
# Give the Supabase service roles a password.
#
# supabase/postgres creates authenticator, supabase_auth_admin,
# supabase_storage_admin and supabase_admin, but leaves every one of them
# without a password. PostgREST, GoTrue and storage-api all authenticate as
# those roles using POSTGRES_PASSWORD, so without this the whole stack looks
# like it started and then crash-loops on
#
#   FATAL: password authentication failed for user "authenticator"
#
# with nothing in `docker compose ps` but `Restarting (1)`. The database itself
# reports `healthy` throughout, which is what makes it confusing: the failure is
# in three other containers.
#
# Runs on FIRST boot only, like everything in /docker-entrypoint-initdb.d. On a
# volume that is already initialised it does nothing — apply the same statements
# by hand instead (see Docs/migration/01-VPS-SETUP.md).
#
# The password goes in as a psql variable and is interpolated with :'pw', which
# quotes and escapes it. Pasting it into the SQL text would break on any
# password containing a quote, and would put it in the server log.

set -euo pipefail

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname postgres \
     -v pw="$POSTGRES_PASSWORD" <<'EOSQL'
ALTER ROLE authenticator          WITH LOGIN PASSWORD :'pw';
ALTER ROLE supabase_auth_admin    WITH LOGIN PASSWORD :'pw';
ALTER ROLE supabase_storage_admin WITH LOGIN PASSWORD :'pw';
ALTER ROLE supabase_admin         WITH LOGIN PASSWORD :'pw';
EOSQL

echo "99-roles.sh: password set on the four Supabase service roles"
