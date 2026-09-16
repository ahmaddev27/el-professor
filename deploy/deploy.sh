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

# ── Sign-in checks ───────────────────────────────────────────────────────────
# Everything between the two marker lines is also sourced on its own by
# tests/deploy/google-signin-guards.test.ts and run against fake .env files, so
# it may use only its arguments, fail, grep, awk, sha256sum and python3.
# >>> google-signin checks

# One value from an env file: the last line for the key, CR removed. Empty when
# the key, the line's value or the whole file is missing.
env_value() {
  { grep -E "^$2=" "$1" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | tr -d '\r'
}

# GOOGLE_SIGNIN_ENABLED is empty, true or false and nothing else. Compose hands
# it to GoTrue, which would read "TRUE" or "1" as on with signup still closed
# and autoconfirm still on; the auth entrypoint therefore stops the container
# for anything but an empty value, true or false, and this refuses the release
# before it gets that far. Switched on, it needs a Google web client id and a
# secret.
#
# Each environment has its own Google client (owner decision G3 is still open;
# the plan recommends separate clients and this takes that): a client shared
# with production would accept production's consent and tokens on a host that
# runs a copy of production's accounts. The ids are compared by hash, like
# OTP_PEPPER, from whichever side deploys. No value read here is ever printed.
google_signin_guard() {
  local env_file="$1" peer_env_file="$2" flag client_id peer_client_id
  flag="$(env_value "$env_file" GOOGLE_SIGNIN_ENABLED)"
  case "$flag" in
    ''|true|false) ;;
    *) fail "GOOGLE_SIGNIN_ENABLED must be empty, true or false; .env holds something else" ;;
  esac
  client_id="$(env_value "$env_file" GOOGLE_CLIENT_ID)"
  if [ "$flag" = true ]; then
    [[ "$client_id" =~ ^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$ ]] \
      || fail "GOOGLE_SIGNIN_ENABLED=true needs GOOGLE_CLIENT_ID, one Google web client id (<number>-<id>.apps.googleusercontent.com)"
    [ -n "$(env_value "$env_file" GOOGLE_CLIENT_SECRET)" ] \
      || fail "GOOGLE_SIGNIN_ENABLED=true needs GOOGLE_CLIENT_SECRET"
  fi
  if [ -n "$client_id" ] && [ -f "$peer_env_file" ]; then
    peer_client_id="$(env_value "$peer_env_file" GOOGLE_CLIENT_ID)"
    [ "$(printf '%s' "$client_id" | sha256sum | cut -c1-16)" != "$(printf '%s' "$peer_client_id" | sha256sum | cut -c1-16)" ] \
      || fail "staging and production share a GOOGLE_CLIENT_ID; each environment needs its own Google OAuth client"
  fi
}

# kong.yml must carry the auth-v1-closed service with the three paths and the
# request-termination plugin answering 403. Its entries are read as trimmed
# lines of that one service, comments left out, as ci-release.sh reads them:
# only a line starting with something other than blank space or # ends it.
kong_closed_block_guard() {
  local kong_file="$1" block want
  block="$(awk '
    { sub(/\r$/, "") }
    /^[^ \t#]/ { inside = 0 }
    /^  - name:/ { inside = ($3 == "auth-v1-closed") }
    inside { entry = $0; sub(/^[ \t]+/, "", entry); sub(/[ \t]+$/, "", entry); if (entry != "" && entry !~ /^#/) print entry }
  ' "$kong_file" 2>/dev/null)" || true
  for want in 'paths:' '- /auth/v1/signup' '- /auth/v1/otp' '- /auth/v1/magiclink' '- name: request-termination' 'status_code: 403'; do
    grep -qxF -- "$want" <<<"$block" \
      || fail "deploy/kong.yml has no complete auth-v1-closed block (missing '$want'); GoTrue's signup routes would stay reachable"
  done
}

# What is wrong with GoTrue's /settings answer on stdin for this switch, as one
# line; empty, and status 0, when nothing is. Google on means signup open and
# autoconfirm off, which only the auth entrypoint sets. Every other provider,
# phone, anonymous users and SAML must be off.
auth_settings_problems() {
  python3 -c '
import json, sys
on = sys.argv[1] == "true"
try:
    settings = json.load(sys.stdin)
    external = settings["external"]
    actual = {name: external[name] for name in external}
    for name in ("disable_signup", "mailer_autoconfirm", "saml_enabled"):
        actual[name] = settings[name]
except (ValueError, KeyError, TypeError):
    print("no settings answer")
    sys.exit(1)
expected = {name: False for name in external if name not in ("email", "google")}
expected.update({"google": on, "disable_signup": not on, "mailer_autoconfirm": not on, "saml_enabled": False})
wrong = ["%s=%s" % (name, str(actual.get(name)).lower()) for name in sorted(expected) if actual.get(name) is not expected[name]]
print(" ".join(wrong))
sys.exit(1 if wrong else 0)
' "$1"
}

# The kong service as compose renders it (JSON on stdin), for the throwaway Kong
# that parses kong.yml before the live one is touched: its environment goes to
# the env file $1, created with mode 600, and only its image is printed. Fails
# for an answer without a kong image or environment, or with a value docker's
# env-file format cannot carry.
kong_parse_inputs() {
  python3 -c '
import json, os, sys
try:
    kong = json.load(sys.stdin)["services"]["kong"]
    image, env = kong["image"], kong["environment"]
except (ValueError, KeyError, TypeError):
    sys.exit(1)
if not isinstance(image, str) or not image or not isinstance(env, dict) or not env:
    sys.exit(1)
lines = []
for name in sorted(env):
    value = "" if env[name] is None else str(env[name])
    if "\n" in value or "\r" in value or "=" in name:
        sys.exit(1)
    lines.append("%s=%s\n" % (name, value))
with os.fdopen(os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
    out.writelines(lines)
print(image)
' "$1"
}

# stdin to stdout with the value of every key, secret, password or token in the
# env file $1 replaced by its name, so Kong's own error can be shown in a
# release log without the API keys it was rendered with.
redact_env_values() {
  python3 -c '
import re, sys
secret_name = re.compile(r"KEY|SECRET|PASS|TOKEN")
pairs = []
with open(sys.argv[1], encoding="utf-8") as env_file:
    for line in env_file:
        name, _, value = line.rstrip("\n").partition("=")
        if secret_name.search(name) and len(value) >= 4:
            pairs.append((value, "[%s]" % name))
text = sys.stdin.read()
for value, label in sorted(pairs, key=lambda pair: len(pair[0]), reverse=True):
    text = text.replace(value, label)
sys.stdout.write(text)
' "$1"
}

# <<< google-signin checks

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

# Staging holds a copy of production data, real addresses included. Its mail
# always goes through Mailpit, which keeps a copy of every message and decides
# what leaves the host: since 14.09.2026 it relays everything but @example.com
# to Resend, so staging mail reaches real inboxes the way production's does
# (the owner's decision; deploy/set-staging-mail-relay.sh). Production must
# never send to the catcher.
SMTP_HOST="$(grep -E '^SMTP_HOST=' .env | cut -d= -f2- | tr -d '\r')" || true
PROFILES="$(grep -E '^COMPOSE_PROFILES=' .env | cut -d= -f2- | tr -d '\r')" || true
if [ "$ENVIRONMENT" = staging ]; then
  [ "$SMTP_HOST" = mailpit ] || fail "staging SMTP_HOST is '$SMTP_HOST'; it must be mailpit, which keeps a copy of every message and blocks the test addresses"
  # Mailpit reads its relay settings at start. A missing file turns into an empty
  # directory at the bind-mount path and Mailpit does not start at all. With
  # relaying on, the example.com block must be there: test accounts would
  # otherwise bounce and spend the Resend quota staging shares with production.
  [ -f mailpit-relay.yml ] || fail "deploy/mailpit-relay.yml is missing; write it with deploy/set-staging-mail-relay.sh (add --off to keep mail on the host)"
  RELAY_ALL="$(grep -E '^MAILPIT_RELAY_ALL=' .env | cut -d= -f2- | tr -d '\r')" || true
  if [ "$RELAY_ALL" = true ]; then
    grep -qE "^blocked-recipients: '@example" mailpit-relay.yml \
      || fail "staging relays all mail but deploy/mailpit-relay.yml does not block example.com; rerun deploy/set-staging-mail-relay.sh"
  fi
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

# One-time codes are stored as HMAC-SHA256(OTP_PEPPER, "<challenge>:<code>").
# Without the pepper the functions cannot issue a code, and nobody could sign
# up, reset a password or accept an invitation. Staging runs on a copy of
# production data, so a shared pepper would make a code hash taken from one
# database checkable against the other. Neither value is ever printed.
OTP_PEPPER="$(grep -E '^OTP_PEPPER=' .env | cut -d= -f2- | tr -d '\r')" || true
[ "${#OTP_PEPPER}" -ge 32 ] || fail "OTP_PEPPER is missing or shorter than 32 characters; generate one with: openssl rand -base64 48"
if [ "$ENVIRONMENT" = staging ] && [ -f /srv/PRO/deploy/.env ]; then
  prod_pepper="$(grep -E '^OTP_PEPPER=' /srv/PRO/deploy/.env | cut -d= -f2- | tr -d '\r')" || true
  [ "$(printf '%s' "$OTP_PEPPER" | sha256sum | cut -c1-16)" != "$(printf '%s' "$prod_pepper" | sha256sum | cut -c1-16)" ] \
    || fail "staging and production share an OTP_PEPPER"
  unset prod_pepper
fi
unset OTP_PEPPER

# Google sign-in (plan step 1.6). With GOOGLE_SIGNIN_ENABLED=true GoTrue opens
# its own signup, and Kong's auth-v1-closed block is then all that keeps
# /signup, /otp and /magiclink from creating accounts, so a release without the
# block is refused whatever the switch says.
if [ "$ENVIRONMENT" = staging ]; then PEER_ENV=/srv/PRO/deploy/.env; else PEER_ENV=/srv/PRO-staging/deploy/.env; fi
google_signin_guard .env "$PEER_ENV"
kong_closed_block_guard kong.yml
GOOGLE_SIGNIN="$(env_value .env GOOGLE_SIGNIN_ENABLED)"

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

# The sign-in settings as compose renders them, before anything starts: Google
# follows the switch, signup and autoconfirm are the literals the auth
# entrypoint starts from, every other way to create or attach an account is
# off, and Kong loads request-termination (without it Kong rejects kong.yml and
# crash-loops). Only names are printed.
render_problems="$(docker compose config --format json < /dev/null | python3 -c '
import json, sys
on = sys.argv[1] == "true"
services = json.load(sys.stdin).get("services", {})
env = (services.get("auth", {}) or {}).get("environment", {}) or {}
expected = {
    "GOTRUE_EXTERNAL_GOOGLE_ENABLED": "true" if on else "false",
    "GOTRUE_DISABLE_SIGNUP": "true",
    "GOTRUE_MAILER_AUTOCONFIRM": "true",
    "GOTRUE_EXTERNAL_PHONE_ENABLED": "false",
    "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED": "false",
    "GOTRUE_SAML_ENABLED": "false",
    "GOTRUE_SECURITY_MANUAL_LINKING_ENABLED": "false",
}
problems = [name for name in sorted(expected) if str(env.get(name)).lower() != expected[name]]
problems += [name for name in sorted(env) if name.startswith("GOTRUE_EXTERNAL_") and name.endswith("_ENABLED")
             and name not in expected and str(env[name]).lower() != "false"]
plugins = str(((services.get("kong", {}) or {}).get("environment", {}) or {}).get("KONG_PLUGINS", ""))
if "request-termination" not in plugins.split(","):
    problems.append("KONG_PLUGINS")
print(" ".join(problems))
' "$GOOGLE_SIGNIN")" || fail "could not render docker-compose.yml to check the sign-in settings"
[ -z "$render_problems" ] || fail "docker-compose.yml does not render the sign-in settings this release relies on: $render_problems"

# kong.yml as the new Kong will load it, parsed first by a throwaway copy of the
# compose kong service: its image, its environment (KONG_PLUGINS included) and
# its rendering of the file, with no network and nothing mounted but kong.yml.
# A file Kong rejects would otherwise show only after the live gateway had been
# recreated with it, with Kong crash-looping and the whole API down, the way
# deploy/caddy/guard.sh validates a Caddyfile before it writes one. Kong's own
# message is printed with the API keys replaced by their names.
kong_check="$(mktemp -d)"
kong_image="$(docker compose config --format json < /dev/null | kong_parse_inputs "$kong_check/kong.env")" \
  || { rm -rf "$kong_check"; fail "could not read the kong service from docker-compose.yml to parse kong.yml; nothing has been changed"; }
kong_parse_status=0
docker run --rm --network none --cpus 1 --memory 512m --env-file "$kong_check/kong.env" \
    -v "$HERE/kong.yml":/home/kong/kong.template.yml:ro --entrypoint bash "$kong_image" \
    -c 'eval "echo \"$(cat /home/kong/kong.template.yml)\"" > /home/kong/kong.yml && kong config parse /home/kong/kong.yml' \
    < /dev/null > "$kong_check/parse.log" 2>&1 || kong_parse_status=$?
if [ "$kong_parse_status" -ne 0 ]; then
  kong_parse_error="$(redact_env_values "$kong_check/kong.env" < "$kong_check/parse.log" | grep -vE '^[[:space:]]*$|Run with --v' | tail -n 8)" || true
  rm -rf "$kong_check"
  fail "$kong_image refuses deploy/kong.yml with this release's KONG_PLUGINS (exit $kong_parse_status). Nothing has been changed; the running Kong keeps its current config.
$kong_parse_error"
fi
rm -rf "$kong_check"
echo "  deploy/kong.yml parses in $kong_image with this release's KONG_PLUGINS"

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

# kong.yml and nginx-spa.conf are single-file bind mounts that each service reads
# once at start, so an edited file never reached a running container. Their
# hashes are service labels in docker-compose.yml: a new hash is a changed
# service definition, and compose recreates exactly the containers affected.
KONG_CONFIG_SHA="$(sha256sum kong.yml | cut -c1-16)"
NGINX_CONFIG_SHA="$(sha256sum nginx-spa.conf | cut -c1-16)"
export KONG_CONFIG_SHA NGINX_CONFIG_SHA

# The routes GoTrue would create an account on once its signup is open. Only
# Kong's request-termination plugin answers them with this message: the
# auth-v1-closed service points at a dead port, so a lost plugin answers 502
# and a lost route reaches GoTrue, and neither says this.
CLOSED_ROUTES="/auth/v1/signup /auth/v1/otp /auth/v1/magiclink"
CLOSED_MESSAGE="This route is closed by the gateway"

# Asked inside the kong container, of its own port: proves the gateway alone,
# without GoTrue and without Caddy in front of it. kong:2.8.1 ships no curl, so
# the request goes over bash's /dev/tcp, as HTTP/1.0 so that Kong closes the
# connection after answering. Kong needs a few seconds after a recreate before
# it answers at all.
probe_closed_routes() {
  local path answer status i
  for path in $CLOSED_ROUTES; do
    answer=""
    status=""
    for i in $(seq 1 30); do
      answer="$(dc exec -T kong bash -c '
        exec 3<>/dev/tcp/127.0.0.1/8000 || exit 1
        printf "POST %s HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}" "$1" >&3
        while IFS= read -r -t 5 line || [ -n "$line" ]; do printf "%s\n" "$line"; line=""; done <&3
      ' probe "$path" < /dev/null 2>/dev/null)" || true
      status="$(printf '%s\n' "$answer" | head -n 1 | cut -d' ' -f2)"
      [ "$status" = 403 ] && grep -qF "$CLOSED_MESSAGE" <<<"$answer" && break
      sleep 2
    done
    echo "  kong $path -> ${status:-no answer}"
    { [ "$status" = 403 ] && grep -qF "$CLOSED_MESSAGE" <<<"$answer"; } || return 1
  done
}

# Kong first, and seen answering 403 on all three routes before GoTrue can be
# recreated with its signup open. The guards have already parsed kong.yml in a
# throwaway Kong, so what can still fail here is the gateway itself. A failure
# stops the release with Kong recreated on this release's kong.yml, and with the
# bundle, GoTrue and every other service as they were.
dc up -d --no-deps kong < /dev/null \
  || fail "docker compose could not recreate Kong with this release's kong.yml. The bundle, GoTrue and every other service are unchanged; Kong may be stopped or still on its previous container (see the compose output above). Restore it by deploying a working release: a fix forward, or a revert of this change"
probe_closed_routes \
  || fail "Kong now runs this release's kong.yml but does not answer 403 on GoTrue's signup routes, and may not answer at all, so the API may be down. The bundle, GoTrue and every other service are unchanged. Restore Kong by deploying a working release: a fix forward, or a revert of this change"

if [ -d dist.new ]; then
  [ -f dist.new/index.html ] || fail "dist.new has no index.html — refusing to publish an empty bundle"
  rm -rf dist.old
  [ -d dist ] && mv dist dist.old
  mv dist.new dist
  echo "  bundle swapped"
fi

# Then GoTrue and everything else. web and functions bind-mount directories that
# were just replaced; a running container keeps the old inode, so both are
# recreated rather than restarted.
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

# ── The edge-function probe's verdict ────────────────────────────────────────
# Everything between the two marker lines is also sourced on its own by
# tests/deploy/functions-health.test.ts, so it may use only its arguments.
# >>> functions health checks

# What one answer to POST /functions/v1/otp-request with the body `{}` proves.
# Prints nothing when the edge runtime served it, otherwise one line naming what
# answered instead.
#
# The body decides, not the status. Only `"reason":"invalid_request"` is the
# *function's* own answer: parseOtpRequest produces it inside the user worker,
# which means Kong reached the runtime, main/index.ts accepted the key, found the
# directory and booted the worker. A status alone cannot say that — 400 is also
# what a gateway says to a request it dislikes.
#
# 502 is read as the gateway's here because otp-request never returns one. Do not
# point this at otp-verify without revisiting that: sessionFailed() answers 502
# from inside the function.
#
# Whether an answer means Kong answered but could not reach the runtime behind
# it. Exactly the statuses functions_probe_problem blames on the gateway, and the
# only ones a `kong reload` can do anything about — the test pins the two lists
# to each other. "No answer at all" is deliberately not one of them: nothing
# answered, so the gateway may itself be down and a reload would be aimed at the
# wrong thing.
functions_probe_is_stale_upstream() {
  case "$1" in 502|503|504) return 0 ;; *) return 1 ;; esac
}

functions_probe_problem() {
  local status="$1" body="$2"
  case "$status" in
    400)
      case "$body" in
        *'"reason":"invalid_request"'*) ;;
        *) echo "HTTP 400, but not the function's own invalid_request answer" ;;
      esac ;;
    502|503|504) echo "HTTP $status from the gateway — Kong did not reach the edge runtime" ;;
    401) echo "HTTP 401 — the router refused the key, so ANON_KEY in .env is not this stack's" ;;
    404) echo "HTTP 404 — the router knows no such function, or it has no FUNCTION_ENV entry" ;;
    000|'') echo "no answer at all" ;;
    *) echo "HTTP $status, not the function's own answer" ;;
  esac
}
# <<< functions health checks

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

# GoTrue's own account of its sign-in settings, through Caddy and Kong as the app
# reads it. It is the only place the entrypoint's signup and autoconfirm show,
# so it is what proves GoTrue took the switch; a GoTrue that does not answer
# fails here too.
auth_problems="no settings answer"
for i in $(seq 1 15); do
  auth_problems="$(curl -s --max-time 10 "$PUBLIC_URL/auth/v1/settings" | auth_settings_problems "$GOOGLE_SIGNIN")" && break
  sleep 2
done
echo "  $PUBLIC_URL/auth/v1/settings -> ${auth_problems:-as .env says (Google sign-in ${GOOGLE_SIGNIN:-false})}"
[ -z "$auth_problems" ] || fail "GoTrue's settings do not match GOOGLE_SIGNIN_ENABLED: $auth_problems"

# And the closed routes from outside: nothing in front of Kong may route
# around the block.
for path in $CLOSED_ROUTES; do
  closed="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$PUBLIC_URL$path")" || true
  echo "  $PUBLIC_URL$path -> $closed"
  [ "$closed" = 403 ] || fail "$PUBLIC_URL$path answered '$closed' instead of 403"
done

# And the edge functions, end to end: Caddy, Kong, the runtime, a user worker.
# Nothing checked them until now, so a broken router, an unreachable runtime or
# an otp-request with no FUNCTION_ENV entry shipped silently and a customer found
# it. Read it for exactly what it is: one route and one function. Another
# function whose FUNCTION_ENV entry is missing still answers 404 from
# main/index.ts, and this probe says nothing at all about it.
#
# It is also the one check this release needs most, because this release is what
# breaks the route. `web` and `functions` are force-recreated together above, so
# Docker frees both addresses and hands them back in either order — the two
# regularly swap. Kong is not recreated unless kong.yml changed, so it keeps the
# address it resolved for `functions` until that record expires (Docker's
# embedded DNS serves a 600 s TTL). While the cache is stale Kong dials the
# address `web` now holds, nginx refuses port 9000, and every POST to
# /functions/v1/* is answered 502 in ~130 ms. Measured on staging 16.09.2026:
# three such episodes in 21 h, each 19-78 s after a release finished, and none at
# any other time — but nothing called the route in between, so those numbers
# bound when a 502 was *seen*, not how long the window lasts. Its tail is
# unmeasured, and the TTL above is the only thing that bounds it. For a customer
# that window is "Passwort vergessen" showing "Ein unerwarteter Fehler ist
# aufgetreten"; for the e2e suite it was four red merges in a row.
#
# So the release does not finish while that route is dead. `{}` is refused by
# parseOtpRequest before any database, mail or rate-limit work, so each probe
# costs one worker boot and nothing else — no code is sent and no budget spent.
# The anon key goes on the command line and so into the host's process table.
# That is the deliberate exception to this file's habit, not an oversight: it is
# the publishable key, the same bytes nginx serves inside the bundle two steps
# above, and the alternatives are a temp file holding it or a heredoc inside a
# command substitution in the one script whose parse errors take a site down.
#
# Waiting the window out is explicitly not the plan, and the budget below does
# not cover the TTL. A record refreshed seconds before the release still has
# ~590 s on it — longer than a release may sit here — and grading a self-healing
# window as a failed release is expensive in its own right: fail marks the
# manifest failed, so a later rollback will not pick this release; it leaves
# releases/current on the previous sha, so the host reports the wrong thing as
# live; and it blocks the next production promotion, which requires status=ok.
# All for a stack that is by then already live and correct. So the first answer
# that says Kong could not reach the runtime buys one `kong reload` instead, and
# the budget then only has to cover that reload and a worker boot.
#
# The pauses grow, 3 s to 15 s, the shape e2e/lib/warmup.ts settled on: a probe
# that does reach the runtime makes main/index.ts create another 256 MB worker,
# and a fixed short cadence is the one thing that file measured going badly. The
# bound is wall-clock rather than a count of tries, because a single try can
# itself take --max-time; the true worst case is this budget plus one of those,
# so about 270 s inside a 25-minute job. 30 s is warmup.ts's timeout, and the
# Caddy site in front of this allows 300 s.
FN_PROBE_BUDGET=240

# The probe names one function, and --activate brings back an older tree against
# today's deploy.sh: otp-request only arrived on 15.09.2026, so a rollback far
# enough back would probe a function the release does not ship, meet 404 until
# the budget ran out, and fail the rollback for a reason that has nothing to do
# with the gateway. Only the five newest clean releases are kept and all of them
# have it, so this is a guard against a shape, not against a case seen.
if [ ! -f "$ROOT/supabase/functions/otp-request/index.ts" ]; then
  echo "  $PUBLIC_URL/functions/v1/otp-request -> not probed: this release ships no otp-request"
else
  fn_anon_key="$(env_value .env ANON_KEY)"
  [ -n "$fn_anon_key" ] || fail "ANON_KEY is missing from .env, so the edge functions cannot be probed"

  # curl writes the body, then a newline, then the status, so the last line is the
  # status and everything before it is the body. The separator is held in a
  # variable because $'\n' inside a "${...}" expansion opens a quote bash never
  # closes, and the whole script stops parsing.
  fn_nl=$'\n'
  fn_problem="no answer at all"
  fn_reload=""
  fn_pause=0
  fn_deadline=$(( SECONDS + FN_PROBE_BUDGET ))
  while :; do
    fn_answer="$(curl -s --max-time 30 -X POST "$PUBLIC_URL/functions/v1/otp-request" \
      -H "apikey: $fn_anon_key" -H 'Content-Type: application/json' \
      -d '{}' -w '\n%{http_code}')" || true
    fn_status="${fn_answer##*"$fn_nl"}"
    fn_problem="$(functions_probe_problem "$fn_status" "${fn_answer%"$fn_nl"*}")"
    if [ -z "$fn_problem" ]; then break; fi
    if [ "$SECONDS" -ge "$fn_deadline" ]; then break; fi
    # Once, and only after an answer that says Kong could not reach the runtime,
    # so this is not in the gateway's path on a release that is fine. A reload
    # re-reads /home/kong/kong.yml — the file the entrypoint rendered before Kong
    # started, so the same bytes this Kong already accepted, that a throwaway
    # Kong parsed further up, and that answered 403 on the closed routes a minute
    # ago. Its new nginx workers start with an empty DNS cache, which is the
    # whole point; no connection is dropped and no container is recreated. It is
    # the one-liner the failure message below has always told an operator to run.
    #
    # It is also the only thing in a release that changes the live gateway's
    # state, and it stays unexercised until a release actually lands in the
    # window. Hence three guards: never on a healthy release, never twice, and
    # never fatal — if it fails, the loop goes back to waiting, which is exactly
    # where this check stood without it.
    if [ -z "$fn_reload" ] && functions_probe_is_stale_upstream "$fn_status"; then
      if dc exec -T kong kong reload < /dev/null > /dev/null 2>&1; then fn_reload=reloaded; else fn_reload=refused; fi
      echo "  kong reload after $fn_problem: $fn_reload"
    fi
    fn_pause=$(( fn_pause < 15 ? fn_pause + 3 : 15 ))
    sleep "$fn_pause"
  done
  unset fn_anon_key

  # Not spelled inline: an apostrophe inside ${x:-...} opens a quote bash never
  # closes, and the whole script stops parsing.
  fn_served="served by the function itself"
  echo "  $PUBLIC_URL/functions/v1/otp-request -> ${fn_problem:-$fn_served}${fn_reload:+ (kong reload: $fn_reload)}"

  # A rollback reaches this line with the site already broken, so the message
  # must not read like a successful release that lost one route.
  fn_context="The bundle is live and every other service answered, so this is the functions service alone."
  [ "$MODE" != --activate ] || fn_context="This is a rollback: the files of $(basename "$RELEASE_DIR") are in place, Kong, the bundle and every other service were recreated from them and answered, and only this route did not. That release's own record is untouched, so it can be activated again."
  case "$fn_reload" in
    reloaded) fn_next="Kong was reloaded once and the route still did not come up, so a stale DNS cache is not what is left." ;;
    refused)  fn_next="The reload this step tried was refused, so run 'docker compose exec kong kong reload' from this directory by hand. If the answer is a 502, Kong is still dialling the address 'functions' held before this release, and that record expires on its own within 600 s." ;;
    *)        fn_next="Kong was not reloaded: no answer here was a 502, 503 or 504, so the gateway's DNS cache is not what is wrong. If nothing answered at all, look at Caddy and Kong before the functions service." ;;
  esac
  [ -z "$fn_problem" ] || fail "the edge functions do not answer through $PUBLIC_URL: $fn_problem. $fn_context $fn_next"
fi

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
