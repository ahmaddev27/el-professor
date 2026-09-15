#!/usr/bin/env bash
# Housekeeping for one-time codes and unfinished signups, one environment at a time.
#
#   deploy/otp-housekeeping.sh production|staging hourly   # SELECT public.otp_purge()
#   deploy/otp-housekeeping.sh production|staging daily    # SELECT public.purge_unverified_signups()
#                                                          # SELECT public.purge_abandoned_oauth_signups()
#
# Installed on the host by hand, like the release wrapper and the Caddy guard:
# the pipeline cannot schedule work on a machine another project depends on. A
# release does not replace this file either (ci-release.sh installs a fixed
# list of deploy files), so a changed copy is installed by hand too, after the
# release that carries the functions it calls. The schedule lives in
# /etc/cron.d/el-professor-otp:
#
#   17 * * * *  root /srv/PRO/deploy/otp-housekeeping.sh production hourly 2>&1 | logger -t el-professor-otp
#   47 3 * * *  root /srv/PRO/deploy/otp-housekeeping.sh production daily  2>&1 | logger -t el-professor-otp
#   23 * * * *  root /srv/PRO-staging/deploy/otp-housekeeping.sh staging hourly 2>&1 | logger -t el-professor-otp
#   53 3 * * *  root /srv/PRO-staging/deploy/otp-housekeeping.sh staging daily  2>&1 | logger -t el-professor-otp
#
# What may be deleted is decided in the database, not here
# (supabase/migrations/20260915100100_otp_rpcs.sql, 20260915100200_signup_rpcs.sql
# and 20260916100020_oauth_signup_rpcs.sql):
#
# - otp_purge() deletes codes and send events older than 24 hours, and platform
#   verifications that expired more than 24 hours ago. The send limits look back
#   one hour, so nothing they read is touched.
# - purge_unverified_signups() deletes only signups recorded in
#   app_private.pending_signups whose address was not confirmed within 24 hours,
#   together with their company. That is what the signup mail promises. Legacy
#   accounts that are unconfirmed or have no company were never recorded there,
#   and nothing this script runs can delete them.
# - purge_abandoned_oauth_signups() deletes only Google accounts recorded in
#   app_private.pending_oauth_signups more than 24 hours ago that registered no
#   company and are not platform staff.
#
# Each statement runs as supabase_admin through the db container, the way
# deploy.sh applies migrations, in its own transaction: a failure in one does
# not undo the one before it. The output is one line with the results, for the log.
set -euo pipefail

usage() { echo "usage: otp-housekeeping.sh production|staging hourly|daily" >&2; exit 2; }

ENVIRONMENT="${1:-}"
TASK="${2:-}"
case "$ENVIRONMENT" in
  production) EXPECT_PROJECT="ya-mobility";         EXPECT_DIR="/srv/PRO" ;;
  staging)    EXPECT_PROJECT="ya-mobility-staging"; EXPECT_DIR="/srv/PRO-staging" ;;
  *) usage ;;
esac
case "$TASK" in
  hourly) SQL=("SELECT public.otp_purge()") ;;
  daily)  SQL=("SELECT 'unverified_signups=' || public.purge_unverified_signups()"
               "SELECT 'oauth_signups=' || public.purge_abandoned_oauth_signups()") ;;
  *) usage ;;
esac

cd "$EXPECT_DIR/deploy"
[ -f .env ] || { echo "no .env in $EXPECT_DIR/deploy" >&2; exit 1; }

# The guard deploy.sh starts with: one environment's purge never runs against
# the other's database.
PROJECT_NAME="$(grep -E '^PROJECT_NAME=' .env | cut -d= -f2- | tr -d '\r')" || true
[ "$PROJECT_NAME" = "$EXPECT_PROJECT" ] \
  || { echo "PROJECT_NAME is '$PROJECT_NAME', $ENVIRONMENT requires $EXPECT_PROJECT" >&2; exit 1; }

# A slow run must not overlap the next one.
exec 9>"/run/lock/el-professor-otp-$ENVIRONMENT-$TASK.lock"
flock -n 9 || { echo "$ENVIRONMENT $TASK: the previous run is still active, skipped"; exit 0; }

# One -c per statement: psql runs each in its own transaction and stops at the
# first error.
PSQL_ARGS=()
for statement in "${SQL[@]}"; do PSQL_ARGS+=(-c "$statement"); done

result="$(docker compose exec -T db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -qtA "${PSQL_ARGS[@]}" < /dev/null | paste -sd ' ')"
printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ENVIRONMENT" "$TASK" "$result"
