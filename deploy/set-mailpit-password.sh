#!/usr/bin/env bash
# Set the login for staging's Mailpit inbox at https://mail-staging.elprofessor.eu
#
#   ssh root@159.195.205.30 /srv/PRO-staging/deploy/set-mailpit-password.sh
#
# Mailpit needs a login even though staging itself is open: the mail it catches
# carries live password-reset and invite links for real accounts, so anyone who
# can read it can take over any staging login.
#
# The password is read twice without echo, hashed with bcrypt, and only the
# hash is written. It reaches the hashing tool on stdin, so it never appears in
# a process list or in shell history, and it is never printed. Afterwards the
# script proves both halves: no credentials is refused, these credentials work.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(grep -E '^PROJECT_NAME=' .env | cut -d= -f2- | tr -d '\r')" = ya-mobility-staging ] \
  || { echo "This is not the staging checkout — run it from /srv/PRO-staging/deploy."; exit 1; }

read -r -p "Username [admin]: " USERNAME
USERNAME="${USERNAME:-admin}"
[[ "$USERNAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Use letters, digits, dot, dash or underscore only."; exit 1; }

IFS= read -rs -p "Password (hidden, 12+ characters): " PASS; echo
[ "${#PASS}" -ge 12 ] || { echo "Too short — at least 12 characters. Nothing changed."; exit 1; }
IFS= read -rs -p "Repeat password: " PASS2; echo
[ "$PASS" = "$PASS2" ] || { echo "The two entries differ. Nothing changed."; exit 1; }
unset PASS2

# bcrypt from Caddy's own implementation, fed on stdin, in a throwaway container
# of the image the Caddy guard validates with. Nothing runs inside ridy's
# containers.
IMG="$(docker inspect ridy-caddy-1 --format '{{.Image}}' 2>/dev/null || echo caddy:2-alpine)"
HASH="$(printf '%s\n' "$PASS" | docker run --rm -i --pull never --network none "$IMG" caddy hash-password 2>/dev/null | tail -1)"
[[ "$HASH" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || { echo "Hashing failed. Nothing changed."; exit 1; }

umask 077
printf '%s:%s\n' "$USERNAME" "$HASH" > mailpit-ui-auth.new
chmod 600 mailpit-ui-auth.new
mv mailpit-ui-auth.new mailpit-ui-auth
unset HASH

docker compose up -d --force-recreate --no-deps mailpit < /dev/null >/dev/null 2>&1
for i in $(seq 1 20); do
  [ "$(docker compose ps mailpit --format '{{.State}}' < /dev/null)" = running ] && break
  sleep 1
done
sleep 2

code_anon="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8025/api/v1/info)"
code_auth="$(printf 'Authorization: Basic %s' "$(printf '%s:%s' "$USERNAME" "$PASS" | base64 -w0)" \
  | curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @- http://127.0.0.1:8025/api/v1/info)"
unset PASS

echo "Without a login: $code_anon (must be 401)"
echo "With your login: $code_auth (must be 200)"
[ "$code_anon" = 401 ] && [ "$code_auth" = 200 ] \
  && echo "Done. Sign in at https://mail-staging.elprofessor.eu as '$USERNAME'." \
  || { echo "Something is wrong — the inbox did not behave as expected."; exit 1; }
