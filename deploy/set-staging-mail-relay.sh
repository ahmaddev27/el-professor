#!/usr/bin/env bash
# Deliver staging's mail for real, through production's Resend account.
#
#   ssh -t root@159.195.205.30 /srv/PRO-staging/deploy/set-staging-mail-relay.sh         # relay on
#   ssh -t root@159.195.205.30 /srv/PRO-staging/deploy/set-staging-mail-relay.sh --test  # on, then one test mail
#   ssh -t root@159.195.205.30 /srv/PRO-staging/deploy/set-staging-mail-relay.sh --off   # catch only again
#
# The owner decided on 14.09.2026, after being told that staging holds real
# customers' addresses, that staging mail reaches its recipients the way
# production mail does. GoTrue still hands every message to Mailpit. Mailpit
# keeps a copy — the end-to-end tests read links and codes from it — and relays
# it to Resend. Addresses at example.com, the test accounts, are never relayed:
# they cannot be delivered, and bounces hurt the sending reputation that
# staging now shares with production (so does Resend's sending quota).
#
# The Resend key is read from production's .env and written only into a
# root-only file here. It is never printed.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(grep -E '^PROJECT_NAME=' .env | cut -d= -f2- | tr -d '\r')" = ya-mobility-staging ] \
  || { echo "This is not the staging checkout — run it from /srv/PRO-staging/deploy."; exit 1; }

MODE="${1:-on}"
case "$MODE" in on|--test|--off) ;; *) echo "usage: set-staging-mail-relay.sh [--test | --off]"; exit 2 ;; esac

set_env() {
  { grep -vE "^$1=" .env || true; printf '%s=%s\n' "$1" "$2"; } > .env.new
  chmod --reference=.env .env.new
  mv .env.new .env
}

# Whether the compose file on this host already knows about the relay. Until the
# release that adds it is deployed, the settings here wait for that release.
compose_knows_relay() { grep -q 'MP_SMTP_RELAY_CONFIG' docker-compose.yml; }

# Mailpit reads the relay file only when it starts, and compose does not notice
# a changed file behind a bind mount, so the container is always recreated.
# That drops the mail caught so far, which staging can afford.
recreate_mailpit() {
  if compose_knows_relay; then
    docker compose up -d --no-deps --force-recreate mailpit < /dev/null > /dev/null 2>&1
    sleep 4
  else
    echo "The deployed compose file has no relay settings yet; this takes effect with the next staging release."
    exit 0
  fi
}

if [ "$MODE" = --off ]; then
  set_env MAILPIT_RELAY_ALL false
  recreate_mailpit
  echo "Staging mail is caught in Mailpit again; nothing is relayed."
  exit 0
fi

PROD_ENV=/srv/PRO/deploy/.env
host="$(grep -E '^SMTP_HOST=' "$PROD_ENV" | cut -d= -f2- | tr -d '\r')" || true
key="$(grep -E '^SMTP_PASS=' "$PROD_ENV" | cut -d= -f2- | tr -d '\r')" || true
[ "$host" = smtp.resend.com ] || { echo "Production does not send through Resend; nothing changed."; exit 1; }
[[ "$key" =~ ^re_[A-Za-z0-9_]+$ ]] || { echo "Production's Resend key is missing or has an unexpected format; nothing changed."; exit 1; }

umask 077
{
  echo "# Written by set-staging-mail-relay.sh. Holds production's Resend key: never commit or print it."
  echo "host: smtp.resend.com"
  echo "port: 2587"
  echo "starttls: true"
  echo "auth: plain"
  echo "username: resend"
  printf "password: '%s'\n" "$key"
  echo "blocked-recipients: '@example\.com\$'"
} > mailpit-relay.yml.new
unset key
chmod 600 mailpit-relay.yml.new
mv mailpit-relay.yml.new mailpit-relay.yml
set_env MAILPIT_RELAY_ALL true
recreate_mailpit

# The container was just recreated, so its whole log is this start-up.
logs="$(docker compose logs mailpit 2>&1)"
grep -q 'auto-relaying all new messages' <<<"$logs" || { echo "Mailpit did not report auto-relay; check: docker compose logs mailpit"; exit 1; }
grep -q 'blocklist is active' <<<"$logs" || { echo "Mailpit did not report the example.com blocklist; check: docker compose logs mailpit"; exit 1; }
echo "Staging mail is now relayed to its real recipients through Resend (example.com excluded). Copies stay in Mailpit."

if [ "$MODE" = --test ]; then
  # Resend's own sink address: accepted and marked delivered, reaches no one.
  # No pipelines in this block: under pipefail a grep that matches nothing ends
  # the script silently, which once hid the outcome of the test.
  net=""
  for n in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(docker compose ps -q mailpit)"); do
    case "$n" in *staging*) net="$n"; break ;; esac
  done
  [ -n "$net" ] || { echo "Could not find the staging network of the mailpit container."; exit 1; }
  reply="$(docker run --rm --pull never --network "$net" alpine:latest sh -c '
    { printf "EHLO relay-test\r\n"; sleep 1; printf "MAIL FROM:<noreply-staging@elprofessor.eu>\r\n"; sleep 1;
      printf "RCPT TO:<delivered@resend.dev>\r\n"; sleep 1; printf "DATA\r\n"; sleep 1;
      printf "From: El-Professor Staging <noreply-staging@elprofessor.eu>\r\nTo: delivered@resend.dev\r\nSubject: Staging relay test\r\n\r\nRelay test from staging.\r\n.\r\n"; sleep 1;
      printf "QUIT\r\n"; } | nc mailpit 1025')" || true
  case "$reply" in
    *"Ok: queued"*) ;;
    *) echo "Mailpit did not accept the test mail. Its SMTP replies:"; echo "$reply"; exit 1 ;;
  esac
  # Mailpit logs a relay only when it fails (success is a debug line), so a quiet
  # log is the good case.
  sleep 10
  if docker compose logs --since 20s mailpit 2>&1 | grep -q 'error relaying'; then
    echo "The test mail was NOT relayed:"; docker compose logs --since 20s mailpit 2>&1 | grep 'error relaying' | tail -2
    exit 1
  fi
  echo "Test mail to delivered@resend.dev relayed without error. Resend's dashboard shows it as delivered."
fi
