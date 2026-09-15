#!/usr/bin/env bash
# Housekeeping for one-time codes and unconfirmed signups, one environment at a time.
#
#   deploy/otp-housekeeping.sh production|staging hourly   # SELECT public.otp_purge()
#   deploy/otp-housekeeping.sh production|staging daily    # SELECT public.purge_unverified_signups()
#
# Installed on the host by hand, like the release wrapper and the Caddy guard:
# the pipeline cannot schedule work on a machine another project depends on.
# The schedule calls the copy each release ships, so a change to this file takes
# effect with the next release. Suggested root crontab:
#
#   17 * * * *  /srv/PRO/deploy/otp-housekeeping.sh production hourly 2>&1 | logger -t el-professor-otp
#   47 3 * * *  /srv/PRO/deploy/otp-housekeeping.sh production daily  2>&1 | logger -t el-professor-otp
#   23 * * * *  /srv/PRO-staging/deploy/otp-housekeeping.sh staging hourly 2>&1 | logger -t el-professor-otp
#   53 3 * * *  /srv/PRO-staging/deploy/otp-housekeeping.sh staging daily  2>&1 | logger -t el-professor-otp
#
# What may be deleted is decided in the database, not here
# (supabase/migrations/20260915100100_otp_rpcs.sql and 20260915100200_signup_rpcs.sql):
#
# - otp_purge() deletes codes and send events older than 24 hours, and platform
#   verifications that expired more than 24 hours ago. The send limits look back
#   one hour, so nothing they read is touched.
# - purge_unverified_signups() deletes only signups recorded in
#   app_private.pending_signups whose address was not confirmed within 24 hours,
#   together with their company. That is what the signup mail promises. Legacy
#   accounts that are unconfirmed or have no company were never recorded there,
#   and nothing this script runs can delete them.
#
# Both run as supabase_admin through the db container, the way deploy.sh applies
# migrations. The output is one line with the counts, for the log.
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
  hourly) SQL="SELECT public.otp_purge()" ;;
  daily)  SQL="SELECT public.purge_unverified_signups()" ;;
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

result="$(docker compose exec -T db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -qtA -c "$SQL" < /dev/null)"
printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ENVIRONMENT" "$TASK" "$result"
