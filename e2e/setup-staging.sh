#!/usr/bin/env bash
# Prepare staging for the end-to-end tests. Idempotent: run it once, and again
# whenever staging's data is refreshed from production.
#
#   cd e2e && npm run setup                          # everything
#   bash e2e/setup-staging.sh --reset-admin-password # used by tests that change it
#
# On staging only, never production, it makes sure there is:
#   - a login "e2e" in front of the staging web app, next to the owner's;
#   - a Mailpit login "e2e", so tests can read the mail staging sends;
#   - the company "E2E Test GmbH" with its admin e2e-admin@example.com,
#     approved and with an active subscription.
#
# Passwords are generated here and kept only in e2e/.env.local (gitignored)
# and, as bcrypt hashes or GoTrue's own hash, on the host. None is printed.
# Secrets reach the host in a root-only temp file, never on a command line.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/.env.local"
MODE="${1:-all}"
case "$MODE" in all|--reset-admin-password) ;; *) echo "usage: setup-staging.sh [--reset-admin-password]" >&2; exit 2 ;; esac

rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28; }
getv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
setv() {
  touch "$ENV_FILE"
  { grep -vE "^$1=" "$ENV_FILE" || true; printf '%s=%s\n' "$1" "$2"; } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}
ensure() { [ -n "$(getv "$1")" ] || setv "$1" "$2"; }

ensure E2E_BASE_URL https://app.elprofessor.eu
ensure E2E_API_URL https://api-staging.elprofessor.eu
ensure E2E_SSH_HOST elprofessor
ensure E2E_MAILPIT_URL http://127.0.0.1:18025
ensure E2E_STAGING_USER e2e
ensure E2E_STAGING_PASS "$(rand)"
ensure E2E_MAILPIT_USER e2e
ensure E2E_MAILPIT_PASS "$(rand)"
ensure E2E_ADMIN_EMAIL e2e-admin@example.com
ensure E2E_ADMIN_PASSWORD "$(rand)"
chmod 600 "$ENV_FILE" 2>/dev/null || true

[ "$(getv E2E_BASE_URL)" = https://app.elprofessor.eu ] || { echo "refusing: E2E_BASE_URL must be staging" >&2; exit 1; }
SSH_HOST="$(getv E2E_SSH_HOST)"

# Staging's anon key, for the tests that call the API the way supabase-js does.
# It ships in the web bundle and is therefore public; it is read from the host
# on every full setup, so a rotated key follows.
if [ "$MODE" = all ]; then
  anon_key="$(ssh "$SSH_HOST" "grep -E '^ANON_KEY=' /srv/PRO-staging/deploy/.env | tail -n 1 | cut -d= -f2- | tr -d '\r'")"
  [ -n "$anon_key" ] || { echo "could not read staging's ANON_KEY from the host" >&2; exit 1; }
  setv E2E_ANON_KEY "$anon_key"
  unset anon_key
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

# Hand the values to the host in a root-only file; the remote script deletes it.
secrets="$(grep -E '^E2E_' "$ENV_FILE" | tr -d '\r' | ssh "$SSH_HOST" 'umask 077; f="$(mktemp /root/e2e-setup.XXXXXX)"; cat > "$f"; echo "$f"')"

ssh "$SSH_HOST" bash -s -- "$secrets" "$MODE" <<'REMOTE'
set -euo pipefail
S="$1"; MODE="$2"
work="$(mktemp -d)"
trap 'rm -rf "$S" "$work"' EXIT
val() { grep -E "^$1=" "$S" | tail -1 | cut -d= -f2-; }

cd /srv/PRO-staging/deploy
[ "$(grep -E '^PROJECT_NAME=' .env | cut -d= -f2- | tr -d '\r')" = ya-mobility-staging ] || { echo "refusing: /srv/PRO-staging is not staging"; exit 1; }
envget() { grep -E "^$1=" .env | cut -d= -f2- | tr -d '\r'; }
psqlq() { docker compose exec -T db psql -U supabase_admin -d postgres -X -q -tA -v ON_ERROR_STOP=1 -c "$1" < /dev/null; }

IMG="$(docker inspect ridy-caddy-1 --format '{{.Image}}' 2>/dev/null || echo caddy:2-alpine)"
hash_pw() { printf '%s\n' "$1" | docker run --rm -i --pull never --network none "$IMG" caddy hash-password 2>/dev/null | tail -1; }
hash_ok() { [[ "$1" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]]; }
# Replace one user's line in a user:bcrypt file, keeping every other line.
upsert_login() {
  local file="$1" user="$2" hash="$3"
  { awk -F: -v u="$user" '$1 != u' "$file" 2>/dev/null || true; printf '%s:%s\n' "$user" "$hash"; } > "$work/login"
  install -m 600 "$work/login" "$file.new"
  mv "$file.new" "$file"
}
basic() { printf 'Authorization: Basic %s' "$(printf '%s:%s' "$1" "$2" | base64 -w0)"; }

EMAIL="$(val E2E_ADMIN_EMAIL)"
ADMIN_PW="$(val E2E_ADMIN_PASSWORD)"
# The only account this script may create or change.
[[ "$EMAIL" =~ ^e2e[a-z0-9.-]*@example\.com$ ]] || { echo "refusing: the E2E admin must be an e2e…@example.com address"; exit 1; }
ANON="$(envget ANON_KEY)"
SERVICE="$(envget SERVICE_ROLE_KEY)"
API=https://api-staging.elprofessor.eu

json_string() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'; }

set_admin_password() {
  local uid="$1"
  printf '{"password":%s,"email_confirm":true}' "$(printf '%s' "$ADMIN_PW" | json_string)" > "$work/body"
  printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SERVICE" "$SERVICE" \
    | curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PUT "$API/auth/v1/admin/users/$uid" \
        -H @- -H 'Content-Type: application/json' --data-binary @"$work/body"
}

sign_in_code() {
  printf '{"email":%s,"password":%s}' "$(printf '%s' "$EMAIL" | json_string)" "$(printf '%s' "$ADMIN_PW" | json_string)" > "$work/login.json"
  printf 'apikey: %s\n' "$ANON" \
    | curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$API/auth/v1/token?grant_type=password" \
        -H @- -H 'Content-Type: application/json' --data-binary @"$work/login.json"
}

if [ "$MODE" = --reset-admin-password ]; then
  uid="$(psqlq "SELECT id FROM auth.users WHERE email = '$EMAIL'")"
  [ -n "$uid" ] || { echo "the E2E admin does not exist yet; run setup-staging.sh without arguments"; exit 1; }
  [ "$(set_admin_password "$uid")" = 200 ] || { echo "resetting the E2E admin password failed"; exit 1; }
  echo "E2E admin password reset"
  exit 0
fi

# ── Staging web login ────────────────────────────────────────────────────────
U="$(val E2E_STAGING_USER)"; P="$(val E2E_STAGING_PASS)"
web_code() { basic "$U" "$P" | curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @- --resolve app.elprofessor.eu:443:127.0.0.1 https://app.elprofessor.eu/; }
if [ "$(web_code)" = 200 ]; then
  echo "staging login '$U': in place"
else
  h="$(hash_pw "$P")"; hash_ok "$h" || { echo "hashing failed"; exit 1; }
  upsert_login /root/el-professor-secrets/staging-web-auth "$U" "$h"
  /usr/local/sbin/el-professor-caddy-guard --reload > /dev/null
  sleep 2
  [ "$(web_code)" = 200 ] && echo "staging login '$U': added" || { echo "staging login '$U' does not work after the reload"; exit 1; }
fi

# ── Mailpit login ────────────────────────────────────────────────────────────
MU="$(val E2E_MAILPIT_USER)"; MP="$(val E2E_MAILPIT_PASS)"
mail_code() { basic "$MU" "$MP" | curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @- http://127.0.0.1:8025/api/v1/info; }
if [ "$(mail_code)" = 200 ]; then
  echo "mailpit login '$MU': in place"
else
  h="$(hash_pw "$MP")"; hash_ok "$h" || { echo "hashing failed"; exit 1; }
  upsert_login mailpit-ui-auth "$MU" "$h"
  docker compose up -d --force-recreate --no-deps mailpit < /dev/null > /dev/null 2>&1
  for i in $(seq 1 30); do [ "$(mail_code)" = 200 ] && break; sleep 1; done
  [ "$(mail_code)" = 200 ] && echo "mailpit login '$MU': added" || { echo "mailpit login '$MU' does not work"; exit 1; }
fi

# ── Test company and its admin ───────────────────────────────────────────────
uid="$(psqlq "SELECT id FROM auth.users WHERE email = '$EMAIL'")"
if [ -z "$uid" ]; then
  python3 - "$EMAIL" > "$work/signup.json" <<PY
import json, sys
print(json.dumps({
  "company_name": "E2E Test GmbH",
  "full_name": "E2E Admin",
  "email": sys.argv[1],
  "password": """$ADMIN_PW""",
  "plan": "premium",
  "billing_cycle": "monthly",
  "subscription_car_limit": 5,
}))
PY
  code="$(printf 'apikey: %s\n' "$ANON" | curl -s -o "$work/signup.out" -w '%{http_code}' --max-time 30 -X POST "$API/functions/v1/company-signup" -H @- -H 'Content-Type: application/json' --data-binary @"$work/signup.json")"
  [ "$code" = 200 ] || { echo "company-signup answered $code: $(head -c 300 "$work/signup.out")"; exit 1; }
  uid="$(psqlq "SELECT id FROM auth.users WHERE email = '$EMAIL'")"
  echo "E2E company and admin: created"
else
  [ "$(set_admin_password "$uid")" = 200 ] || { echo "updating the E2E admin password failed"; exit 1; }
  echo "E2E company and admin: in place (password synced)"
fi

# Approved, subscribed and active, so a sign-in lands in the app.
psqlq "UPDATE public.companies c
          SET approval_status = 'approved', subscription_status = 'active',
              subscription_expires_at = now() + interval '10 years'
         FROM public.user_profiles p
        WHERE p.user_id = '$uid' AND c.id = p.company_id" > /dev/null
psqlq "UPDATE public.user_profiles SET status = 'active', must_change_password = false WHERE user_id = '$uid'" > /dev/null

[ "$(sign_in_code)" = 200 ] && echo "E2E admin sign-in: works" || { echo "E2E admin cannot sign in"; exit 1; }
REMOTE

echo "Done. Values are in $ENV_FILE (not in git). Run the suite with: cd e2e && npm test"
