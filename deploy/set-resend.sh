#!/usr/bin/env bash
# Point GoTrue's outgoing mail at Resend.
#
#   ./set-resend.sh                              # sender noreply@elprofessor.eu
#   ./set-resend.sh hallo@elprofessor.eu         # a different sender
#   ./set-resend.sh --skip-check                 # sending-only key, see below
#
# The API key is read silently and written straight into .env. It is never
# echoed, never placed in a process argument list (where `ps` would show it to
# anyone on the box), and never lands in shell history. Both places it has to
# travel — the verification request and the .env rewrite — receive it on stdin.
#
# Port 2587, not 587: this VPS provider blocks outbound 465 and 587, a common
# anti-spam default. Resend publishes 2465 and 2587 for exactly that case. 2587
# is STARTTLS; GoTrue decides on implicit TLS by checking for port 465, so 2465
# would be attempted in plaintext and fail.
#
# Nothing is changed unless the key is accepted AND the sender's domain is
# verified in Resend, because Resend refuses mail from an unverified domain and
# a half-configured mailer is harder to diagnose than a clearly unconfigured one.
set -euo pipefail
cd "$(dirname "$0")"

SKIP_CHECK=0
SENDER="noreply@elprofessor.eu"
for arg in "$@"; do
  case "$arg" in
    --skip-check) SKIP_CHECK=1 ;;
    *@*)          SENDER="$arg" ;;
    *) echo "Unknown argument: $arg"; exit 2 ;;
  esac
done
DOMAIN="${SENDER#*@}"

printf 'Resend API key (input hidden): '
IFS= read -rs KEY
echo

case "$KEY" in
  re_*) ;;
  *) echo "That does not look like a Resend key (expected re_...). Nothing changed."; exit 1 ;;
esac

if [ "$SKIP_CHECK" = 1 ]; then
  # Resend recommends a sending-only key in production, and such a key cannot
  # list domains — so the check below would reject a perfectly good key. The
  # cost of skipping it is that an unverified domain is only discovered when
  # the first message bounces; send a test straight after.
  echo "Skipping the domain check (--skip-check). Send a test email afterwards."
  STATUS=verified
else
echo "Checking the key and the sending domain with Resend…"
# printf is a shell builtin: the header reaches curl through a pipe, not argv.
RESP=$(printf 'Authorization: Bearer %s' "$KEY" | curl -s --max-time 15 -H @- https://api.resend.com/domains || true)

STATUS=$(printf '%s' "$RESP" | DOMAIN="$DOMAIN" python3 -c '
import json, os, sys
try:
    body = json.load(sys.stdin)
except Exception:
    print("unreadable"); sys.exit()
if body.get("statusCode") in (401, 403) or body.get("name") in ("validation_error", "restricted_api_key"):
    print("key-rejected"); sys.exit()
match = [d for d in body.get("data", []) if d.get("name") == os.environ["DOMAIN"]]
print(match[0].get("status", "unknown") if match else "not-added")
')

case "$STATUS" in
  verified) echo "  domain $DOMAIN: verified" ;;
  key-rejected)
    echo "  Resend rejected the key, or it is a sending-only key that cannot list domains."
    echo "  Create a key with full access for this check, or verify the domain in the"
    echo "  dashboard, then run: ./set-resend.sh --skip-check   Nothing changed."
    exit 1 ;;
  not-added)
    echo "  $DOMAIN is not added to this Resend account. Add it, publish the DNS records"
    echo "  Resend shows, wait for verification, then run this again. Nothing changed."
    exit 1 ;;
  *)
    echo "  domain $DOMAIN: $STATUS — Resend will refuse mail until it is verified."
    echo "  Nothing changed."
    exit 1 ;;
esac
fi

cp .env ".env.bak-before-resend-$(date +%Y%m%d-%H%M%S)"
chmod 600 .env.bak-before-resend-*

# Value on stdin, variable name as the only argument.
set_var() {
  printf '%s' "$2" | python3 -c '
import re, sys
name, value = sys.argv[1], sys.stdin.read()
text = open(".env").read()
line = name + "=" + value
pattern = re.compile(r"^" + re.escape(name) + r"=.*$", re.M)
if pattern.search(text):
    text = pattern.sub(lambda m: line, text)
else:
    text = text.rstrip("\n") + "\n" + line + "\n"
open(".env", "w").write(text)
' "$1"
}

set_var SMTP_HOST smtp.resend.com
set_var SMTP_PORT 2587
set_var SMTP_USER resend
set_var SMTP_PASS "$KEY"
set_var SMTP_SENDER "$SENDER"
set_var SMTP_SENDER_NAME "El-Professor"
unset KEY RESP

docker compose up -d --force-recreate auth >/dev/null 2>&1
sleep 8
echo "auth: $(docker compose ps auth --format '{{.State}}')"
echo "Done. Outgoing mail now goes through Resend as $SENDER."
