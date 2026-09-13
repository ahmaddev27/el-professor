#!/usr/bin/env bash
# Deploy one environment from files CI has already placed on this host.
#
#   deploy/deploy.sh production
#   deploy/deploy.sh staging
#   deploy/deploy.sh <env> --baseline   # one-time: record existing migrations as applied
#
# CI builds the frontend and ships deploy/, supabase/functions, supabase/migrations
# and the built bundle as deploy/dist.new. This script turns that into a running
# release. It never builds, and it never reads or writes .env beyond sourcing it.
#
# The guards come first and they are deliberately blunt. Two stacks share this
# host and one of them holds real payroll data, so every way of pointing the
# wrong release at the wrong database is refused before anything changes.
set -euo pipefail

ENVIRONMENT="${1:-}"
MODE="${2:-}"

case "$ENVIRONMENT" in
  production) EXPECT_PROJECT="ya-mobility";         EXPECT_DIR="/srv/PRO" ;;
  staging)    EXPECT_PROJECT="ya-mobility-staging"; EXPECT_DIR="/srv/PRO-staging" ;;
  *) echo "usage: deploy.sh production|staging [--baseline]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$HERE"

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nDEPLOY REFUSED: %s\n' "$*" >&2; exit 1; }

# ── Guards ───────────────────────────────────────────────────────────────────

step "guard: $ENVIRONMENT"
[ "$ROOT" = "$EXPECT_DIR" ] || fail "this checkout is $ROOT, but $ENVIRONMENT lives in $EXPECT_DIR"
[ -f .env ] || fail ".env is missing in $HERE — it is provisioned once by hand, never by CI"

PROJECT_NAME="$(grep -E '^PROJECT_NAME=' .env | cut -d= -f2- | tr -d '\r')"
[ "$PROJECT_NAME" = "$EXPECT_PROJECT" ] \
  || fail ".env says PROJECT_NAME=$PROJECT_NAME, $ENVIRONMENT requires $EXPECT_PROJECT"

# The two stacks must never share signing keys: a staging token accepted by
# production would let anyone with a staging login act on real data.
if [ "$ENVIRONMENT" = staging ] && [ -f /srv/PRO/deploy/.env ]; then
  own="$(grep -E '^JWT_SECRET=' .env | cut -d= -f2- | sha256sum | cut -c1-16)"
  prod="$(grep -E '^JWT_SECRET=' /srv/PRO/deploy/.env | cut -d= -f2- | sha256sum | cut -c1-16)"
  [ "$own" != "$prod" ] || fail "staging and production share a JWT_SECRET"
fi

# Staging holds a copy of production data, real addresses included. It may only
# ever hand mail to the local catcher; production must never do so.
SMTP_HOST="$(grep -E '^SMTP_HOST=' .env | cut -d= -f2- | tr -d '\r')"
PROFILES="$(grep -E '^COMPOSE_PROFILES=' .env | cut -d= -f2- | tr -d '\r')"
if [ "$ENVIRONMENT" = staging ]; then
  [ "$SMTP_HOST" = mailpit ] || fail "staging SMTP_HOST is '$SMTP_HOST'; it must be mailpit so no real person is emailed"
  [ "$PROFILES" = staging ] || fail "staging needs COMPOSE_PROFILES=staging, or the mailpit service it sends to never starts"
else
  [ "$SMTP_HOST" != mailpit ] || fail "production SMTP_HOST is mailpit; production mail would be silently swallowed"
  [ -z "$PROFILES" ] || fail "production must not enable compose profiles (found COMPOSE_PROFILES=$PROFILES)"
fi

docker compose config -q || fail "docker compose config is invalid"
echo "  project $PROJECT_NAME in $ROOT"

dc() { docker compose "$@"; }
psql_db() { dc exec -T db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -q "$@"; }

# ── Migrations ───────────────────────────────────────────────────────────────

step "migrations"
psql_db <<'SQL'
CREATE SCHEMA IF NOT EXISTS app_meta;
REVOKE ALL ON SCHEMA app_meta FROM PUBLIC;
CREATE TABLE IF NOT EXISTS app_meta.schema_migrations (
  version    text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied="$(psql_db -tA -c 'SELECT version FROM app_meta.schema_migrations' < /dev/null)"
populated="$(psql_db -tA -c "SELECT to_regclass('public.companies') IS NOT NULL" < /dev/null)"

mapfile -t files < <(ls "$ROOT"/supabase/migrations/*.sql 2>/dev/null | sort)
[ "${#files[@]}" -gt 0 ] || fail "no migration files were shipped"

if [ "$MODE" = "--baseline" ]; then
  # Recording every shipped migration as applied is only true for a database
  # that already has them — which is why this is a flag a person types, never
  # something the pipeline decides.
  [ -z "$applied" ] || fail "--baseline refused: the ledger already has entries"
  for f in "${files[@]}"; do
    v="$(basename "$f" .sql)"
    printf "INSERT INTO app_meta.schema_migrations(version) VALUES ('%s') ON CONFLICT DO NOTHING;\n" "$v"
  done | psql_db
  echo "  baseline: recorded ${#files[@]} migrations as already applied"
  exit 0
fi

if [ -z "$applied" ] && [ "$populated" = "t" ]; then
  fail "the migration ledger is empty but the database already has tables. Applying \
every migration onto live data would re-run the whole chain. Run once, by hand: deploy.sh $ENVIRONMENT --baseline"
fi

pending=()
for f in "${files[@]}"; do
  v="$(basename "$f" .sql)"
  grep -qxF "$v" <<<"$applied" || pending+=("$f")
done

if [ "${#pending[@]}" -eq 0 ]; then
  echo "  nothing pending"
else
  if [ "$ENVIRONMENT" = production ]; then
    mkdir -p /var/backups/ya-mobility
    snap="/var/backups/ya-mobility/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
    dc exec -T db pg_dump -U supabase_admin -d postgres < /dev/null | gzip > "$snap"
    chmod 600 "$snap"
    echo "  snapshot before migrating: $snap ($(du -h "$snap" | cut -f1))"
  fi
  for f in "${pending[@]}"; do
    v="$(basename "$f" .sql)"
    echo "  applying $v"
    # The migration and its ledger row commit together or not at all, so a
    # failure can never leave a migration applied but unrecorded. None of the
    # shipped files contain their own COMMIT or CONCURRENTLY, which is what
    # makes wrapping them safe.
    { cat "$f"; printf "\nINSERT INTO app_meta.schema_migrations(version) VALUES ('%s');\n" "$v"; } \
      | psql_db --single-transaction \
      || fail "migration $v failed and was rolled back; nothing after it was applied"
  done
fi

# ── Release ──────────────────────────────────────────────────────────────────

step "release"
if [ -d dist.new ]; then
  [ -f dist.new/index.html ] || fail "dist.new has no index.html — refusing to publish an empty bundle"
  rm -rf dist.old
  [ -d dist ] && mv dist dist.old
  mv dist.new dist
  echo "  bundle swapped"
fi

# web and functions bind-mount directories that were just replaced; a running
# container keeps the old inode, so both are recreated rather than restarted.
dc up -d --remove-orphans < /dev/null
dc up -d --force-recreate --no-deps web functions < /dev/null

# ── Health ───────────────────────────────────────────────────────────────────

step "health"
APP_URL="$(grep -E '^APP_URL=' .env | cut -d= -f2- | tr -d '\r')"
PUBLIC_URL="$(grep -E '^PUBLIC_URL=' .env | cut -d= -f2- | tr -d '\r')"

for i in $(seq 1 30); do
  down="$(dc ps --format '{{.Service}} {{.State}}' < /dev/null | awk '$2 != "running"' | wc -l)"
  [ "$down" -eq 0 ] && break
  sleep 2
done
dc ps --format '  {{.Service}} {{.State}}' < /dev/null
[ "$down" -eq 0 ] || fail "$down service(s) not running after deploy"

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }
app="$(code "$APP_URL/")"
auth="$(code "$PUBLIC_URL/auth/v1/health")"
echo "  $APP_URL -> $app"
echo "  $PUBLIC_URL/auth/v1/health -> $auth"
[ "$app" = 200 ] || fail "the app did not answer 200"
# GoTrue's health endpoint sits behind key-auth-free /auth/v1 and answers 200.
[ "$auth" = 200 ] || fail "auth did not answer 200"

rm -rf dist.old
printf '\nDEPLOYED %s\n' "$ENVIRONMENT"
