#!/usr/bin/env bash
# Set the login for the staging web app at https://app.elprofessor.eu
#
#   ssh -t root@159.195.205.30 /srv/PRO-staging/deploy/set-staging-password.sh
#
# (-t matters: without a terminal the hidden password prompts cannot read input.)
#
# Staging runs on a copy of production data — real accounts, real payroll — so
# it is not open to anyone who finds the address. The password is read twice
# without echo and hashed with bcrypt in a throwaway Caddy container. Only the
# hash is stored, in a root-only file the Caddy guard renders into staging's
# route; it never enters git, a process list or shell history, and it is never
# printed. Afterwards the script proves both halves: no credentials is refused,
# these credentials work.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run this as root."; exit 1; }

GUARD=/usr/local/sbin/el-professor-caddy-guard
SECRET=/root/el-professor-secrets/staging-web-auth
ROUTES=/srv/caddy-sites/elprofessor.caddy
[ -x "$GUARD" ] || { echo "The Caddy guard is not installed ($GUARD). Nothing changed."; exit 1; }

read -r -p "Username [admin]: " USERNAME
USERNAME="${USERNAME:-admin}"
[[ "$USERNAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Use letters, digits, dot, dash or underscore only."; exit 1; }

IFS= read -rs -p "Password (hidden, 12+ characters): " PASS; echo
[ "${#PASS}" -ge 12 ] || { echo "Too short — at least 12 characters. Nothing changed."; exit 1; }
IFS= read -rs -p "Repeat password: " PASS2; echo
[ "$PASS" = "$PASS2" ] || { echo "The two entries differ. Nothing changed."; exit 1; }
unset PASS2

# Caddy's own bcrypt, fed on stdin, in a throwaway container of the image the
# guard validates with. Nothing runs inside ridy's containers.
IMG="$(docker inspect ridy-caddy-1 --format '{{.Image}}' 2>/dev/null || echo caddy:2-alpine)"
HASH="$(printf '%s\n' "$PASS" | docker run --rm -i --pull never --network none "$IMG" caddy hash-password 2>/dev/null | tail -1)"
[[ "$HASH" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || { echo "Hashing failed. Nothing changed."; exit 1; }

install -d -m 700 "$(dirname "$SECRET")"
umask 077
# Replace this user's line and keep every other login (the end-to-end tests
# have their own).
{ awk -F: -v u="$USERNAME" '$1 != u' "$SECRET" 2>/dev/null || true; printf '%s:%s\n' "$USERNAME" "$HASH"; } > "$SECRET.new"
mv "$SECRET.new" "$SECRET"
unset HASH
echo "Logins in front of staging now: $(cut -d: -f1 "$SECRET" | paste -sd' ' -)"

"$GUARD" --reload > /dev/null \
  || { echo "The Caddy guard refused the change; see: journalctl -u el-professor-caddy-guard"; exit 1; }
sleep 2

probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve app.elprofessor.eu:443:127.0.0.1 "$@"; }
code_anon="$(probe https://app.elprofessor.eu/)"
code_auth="$(printf 'Authorization: Basic %s' "$(printf '%s:%s' "$USERNAME" "$PASS" | base64 -w0)" \
  | probe -H @- https://app.elprofessor.eu/)"
unset PASS
code_version="$(probe https://app.elprofessor.eu/version.txt)"

if ! grep -qF '__STAGING_WEB_AUTH__' "$ROUTES"; then
  echo "Login saved. Staging's published route does not ask for a login yet;"
  echo "it takes effect as soon as the protected route is published."
  exit 0
fi

echo "Without a login: $code_anon (must be 401)"
echo "With your login: $code_auth (must be 200)"
echo "/version.txt:    $code_version (must be 200 — it stays public)"
[ "$code_anon" = 401 ] && [ "$code_auth" = 200 ] && [ "$code_version" = 200 ] \
  && echo "Done. Sign in at https://app.elprofessor.eu as '$USERNAME'." \
  || { echo "Something is wrong — staging did not behave as expected."; exit 1; }
