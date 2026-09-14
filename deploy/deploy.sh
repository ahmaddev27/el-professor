#!/usr/bin/env bash
# Deploy one environment from files CI has already placed on this host.
#
#   deploy/deploy.sh production|staging [--release-dir DIR]
#   deploy/deploy.sh <env> --activate --release-dir DIR   # rollback: no migrations
#   deploy/deploy.sh <env> --baseline                     # one-time: record existing migrations as applied
#
# CI builds the frontend and ships deploy/, supabase/functions, supabase/migrations
# and the built bundle. deploy/ci-release.sh keeps each shipment as a release
# under releases/<utc>-<sha7>/, copies it into this checkout (the bundle as
# deploy/dist.new) and runs this script, which turns it into a running release.
# It never builds, and it never reads or writes .env beyond sourcing it.
#
# --activate is the rollback path. It brings back an earlier release's code
# against the schema as it is now, so it skips migrations — safe only because
# migrations stay backward compatible. A change that is not bumps
# deploy/SCHEMA_EPOCH, and ci-release.sh refuses to roll back across it.
#
# The guards come first and they are deliberately blunt. Two stacks share this
# host and one of them holds real payroll data, so every way of pointing the
# wrong release at the wrong database is refused before anything changes.
set -euo pipefail

usage() { echo "usage: deploy.sh production|staging [--baseline | --activate] [--release-dir DIR]" >&2; exit 2; }

ENVIRONMENT="${1:-}"
shift || true
MODE=""
RELEASE_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --baseline|--activate) MODE="$1" ;;
    --release-dir) [ $# -ge 2 ] || usage; RELEASE_DIR="$2"; shift ;;
    *) usage ;;
  esac
  shift
done

case "$ENVIRONMENT" in
  production) EXPECT_PROJECT="ya-mobility";         EXPECT_DIR="/srv/PRO" ;;
  staging)    EXPECT_PROJECT="ya-mobility-staging"; EXPECT_DIR="/srv/PRO-staging" ;;
  *) usage ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$HERE"

step() { printf '\n== %s\n' "$*"; }

# ── Release record ───────────────────────────────────────────────────────────

MANIFEST=""
if [ -n "$RELEASE_DIR" ]; then
  case "$RELEASE_DIR" in
    "$EXPECT_DIR"/releases/*) ;;
    *) echo "release dir $RELEASE_DIR is not under $EXPECT_DIR/releases" >&2; exit 2 ;;
  esac
  MANIFEST="$RELEASE_DIR/manifest.env"
  [ -f "$MANIFEST" ] || { echo "no manifest.env in $RELEASE_DIR" >&2; exit 2; }
fi
[ "$MODE" != --activate ] || [ -n "$MANIFEST" ] || { echo "--activate needs --release-dir" >&2; exit 2; }

manifest_set() {
  [ -n "$MANIFEST" ] || return 0
  { grep -vE "^$1=" "$MANIFEST" || true; printf '%s=%s\n' "$1" "$2"; } > "$MANIFEST.tmp"
  mv "$MANIFEST.tmp" "$MANIFEST"
}

fail() {
  printf '\nDEPLOY REFUSED: %s\n' "$*" >&2
  # A failed release is marked so rollback never picks it. A failed rollback
  # leaves the earlier release's record as it was.
  if [ "$MODE" != --activate ]; then manifest_set STATUS failed || true; fi
  exit 1
}

# ── Guards ───────────────────────────────────────────────────────────────────

step "guard: $ENVIRONMENT"
[ "$ROOT" = "$EXPECT_DIR" ] || fail "this checkout is $ROOT, but $ENVIRONMENT lives in $EXPECT_DIR"
[ -f .env ] || fail ".env is missing in $HERE — it is provisioned once by hand, never by CI"

PROJECT_NAME="$(grep -E '^PROJECT_NAME=' .env | cut -d= -f2- | tr -d '\r')" || true
[ "$PROJECT_NAME" = "$EXPECT_PROJECT" ] \
  || fail ".env says PROJECT_NAME=$PROJECT_NAME, $ENVIRONMENT requires $EXPECT_PROJECT"

# The two stacks must never share signing keys: a staging token accepted by
# production would let anyone with a staging login act on real data.
if [ "$ENVIRONMENT" = staging ] && [ -f /srv/PRO/deploy/.env ]; then
  own="$(grep -E '^JWT_SECRET=' .env | cut -d= -f2- | sha256sum | cut -c1-16)" || true
  prod="$(grep -E '^JWT_SECRET=' /srv/PRO/deploy/.env | cut -d= -f2- | sha256sum | cut -c1-16)" || true
  [ "$own" != "$prod" ] || fail "staging and production share a JWT_SECRET"
fi

# Staging holds a copy of production data, real addresses included. It may only
# ever hand mail to the local catcher; production must never do so.
SMTP_HOST="$(grep -E '^SMTP_HOST=' .env | cut -d= -f2- | tr -d '\r')" || true
PROFILES="$(grep -E '^COMPOSE_PROFILES=' .env | cut -d= -f2- | tr -d '\r')" || true
if [ "$ENVIRONMENT" = staging ]; then
  [ "$SMTP_HOST" = mailpit ] || fail "staging SMTP_HOST is '$SMTP_HOST'; it must be mailpit so no real person is emailed"
  [ "$PROFILES" = staging ] || fail "staging needs COMPOSE_PROFILES=staging, or the mailpit service it sends to never starts"
  # Fail closed on the mailbox login. If this file is missing, Docker creates an
  # empty *directory* at the bind-mount path and Mailpit may start with no UI
  # authentication — publishing live reset links for real accounts. Every line
  # must be user:bcrypt.
  [ -f mailpit-ui-auth ] && [ -s mailpit-ui-auth ] \
    && ! grep -qvE '^[A-Za-z0-9._-]+:\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' mailpit-ui-auth \
    || fail "deploy/mailpit-ui-auth is missing or malformed; set a login with deploy/set-mailpit-password.sh"
else
  [ "$SMTP_HOST" != mailpit ] || fail "production SMTP_HOST is mailpit; production mail would be silently swallowed"
  [ -z "$PROFILES" ] || fail "production must not enable compose profiles (found COMPOSE_PROFILES=$PROFILES)"
fi

# Both stacks share the CPU with each other and with ridy, and nothing is capped.
# Staging is where load tests run, so it must yield under contention; production
# must never be the one yielding. See cpu_shares in docker-compose.yml.
CPU_SHARES="$(grep -E '^CPU_SHARES=' .env | cut -d= -f2- | tr -d '\r')" || true
if [ "$ENVIRONMENT" = staging ]; then
  [[ "$CPU_SHARES" =~ ^[0-9]+$ ]] && [ "$CPU_SHARES" -lt 1024 ] \
    || fail "staging needs CPU_SHARES below 1024 (found '${CPU_SHARES:-unset}'), or a load test there can starve production"
else
  [ -z "$CPU_SHARES" ] || { [[ "$CPU_SHARES" =~ ^[0-9]+$ ]] && [ "$CPU_SHARES" -ge 1024 ]; } \
    || fail "production CPU_SHARES is '$CPU_SHARES'; it must be unset or at least 1024"
fi

docker compose config -q || fail "docker compose config is invalid"
echo "  project $PROJECT_NAME in $ROOT${MANIFEST:+, release $(basename "$RELEASE_DIR")}"

dc() { docker compose "$@"; }
psql_db() { dc exec -T db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -q "$@"; }

# ── Migrations ───────────────────────────────────────────────────────────────

APPLIED_NOW=()
if [ "$MODE" = --activate ]; then
  step "migrations: skipped"
  echo "  activating an earlier release against the schema as it is now"
else
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
      # Ten are plenty to undo a bad release; older ones only fill the disk.
      ls -1t /var/backups/ya-mobility/pre-deploy-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f || true
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
      APPLIED_NOW+=("$v")
    done
  fi
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

# kong.yml and nginx-spa.conf are single-file bind mounts that each service reads
# once at start, so an edited file never reached a running container. Their
# hashes are service labels in docker-compose.yml: a new hash is a changed
# service definition, and compose recreates exactly the containers affected.
KONG_CONFIG_SHA="$(sha256sum kong.yml | cut -c1-16)"
NGINX_CONFIG_SHA="$(sha256sum nginx-spa.conf | cut -c1-16)"
export KONG_CONFIG_SHA NGINX_CONFIG_SHA

# web and functions bind-mount directories that were just replaced; a running
# container keeps the old inode, so both are recreated rather than restarted.
dc up -d --remove-orphans < /dev/null
dc up -d --force-recreate --no-deps web functions < /dev/null

# ── Health ───────────────────────────────────────────────────────────────────

step "health"
APP_URL="$(grep -E '^APP_URL=' .env | cut -d= -f2- | tr -d '\r')" || true
PUBLIC_URL="$(grep -E '^PUBLIC_URL=' .env | cut -d= -f2- | tr -d '\r')" || true

for i in $(seq 1 30); do
  down="$(dc ps --format '{{.Service}} {{.State}}' < /dev/null | awk '$2 != "running"' | wc -l)"
  [ "$down" -eq 0 ] && break
  sleep 2
done
dc ps --format '  {{.Service}} {{.State}}' < /dev/null
[ "$down" -eq 0 ] || fail "$down service(s) not running after deploy"

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }

# CI writes the commit into dist/version.txt. Reading it back through the public
# URL proves this exact bundle is what visitors get — a 200 on / only proved
# that something answered. The path stays reachable when the site itself sits
# behind a login.
if [ -f dist/version.txt ]; then
  bundled="$(tr -d '\r\n ' < dist/version.txt)"
  served=""
  for i in $(seq 1 10); do
    served="$(curl -s --max-time 10 "$APP_URL/version.txt" | tr -d '\r\n ')" || true
    [ "$served" = "$bundled" ] && break
    sleep 2
  done
  echo "  $APP_URL/version.txt -> ${served:0:40} (released ${bundled:0:40})"
  [ "$served" = "$bundled" ] || fail "the app does not serve the bundle that was just released"
else
  app="$(code "$APP_URL/")"
  echo "  $APP_URL/ -> $app"
  [ "$app" = 200 ] || fail "the app did not answer 200"
fi

auth="$(code "$PUBLIC_URL/auth/v1/health")"
echo "  $PUBLIC_URL/auth/v1/health -> $auth"
# GoTrue's health endpoint sits behind key-auth-free /auth/v1 and answers 200.
[ "$auth" = 200 ] || fail "auth did not answer 200"

if [ -n "$MANIFEST" ]; then
  if [ "$MODE" != --activate ]; then
    manifest_set STATUS ok
    manifest_set MIGRATIONS_APPLIED "${APPLIED_NOW[*]:-}"
  fi
  manifest_set ACTIVATED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ln -sfn "$(basename "$RELEASE_DIR")" "$EXPECT_DIR/releases/current"
fi

rm -rf dist.old
printf '\nDEPLOYED %s%s\n' "$ENVIRONMENT" "${MANIFEST:+ ($(basename "$RELEASE_DIR"))}"
