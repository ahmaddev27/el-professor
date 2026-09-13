#!/usr/bin/env bash
# Publish deploy/caddy/elprofessor.caddy to the Caddy that fronts this host.
#
#   deploy/caddy/publish.sh                  # needs root ssh to the host
#   EL_PROFESSOR_SSH=root@host deploy/caddy/publish.sh
#
# That Caddy is ridy's and serves ridy's own sites too. The writing is left to
# the guard (guard.sh, installed as el-professor-caddy-guard), which validates
# ridy's Caddyfile with the new routes before touching it and reloads Caddy
# gracefully. This script adds what only a publish needs: check the sites
# afterwards, and put the previous routes back if one of them stopped
# answering. Deliberately not part of CI — the release key must not be able to
# change routing on a host another project depends on.
set -euo pipefail

HOST="${EL_PROFESSOR_SSH:-root@159.195.205.30}"
SRC="$(cd "$(dirname "$0")" && pwd)/elprofessor.caddy"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

candidate="$(tr -d '\r' < "$SRC" | ssh "$HOST" 'f="$(mktemp /tmp/elprofessor.caddy.XXXXXX)"; cat > "$f"; echo "$f"')"

ssh "$HOST" bash -s -- "$candidate" <<'REMOTE'
set -euo pipefail
cand="$1"
LIVE=/srv/caddy-sites/elprofessor.caddy
PREVIOUS=/root/el-professor-caddy-backups/elprofessor.caddy.previous
GUARD=/usr/local/sbin/el-professor-caddy-guard
trap 'rm -f "$cand"' EXIT

[ -x "$GUARD" ] || { echo "REFUSED: $GUARD is not installed" >&2; exit 1; }
if cmp -s "$cand" "$LIVE"; then echo "unchanged, nothing to publish"; exit 0; fi

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }
apply() {  # the guard defers (75) while ridy's file is being written; wait it out
  local rc
  for _ in 1 2 3 4; do
    rc=0; "$GUARD" --reload < /dev/null || rc=$?
    [ "$rc" = 75 ] || return "$rc"
    sleep 6
  done
  return 75
}

ridy_before="$(code https://reidey.de/)"
install -d -m 700 "$(dirname "$PREVIOUS")"
cp -p "$LIVE" "$PREVIOUS"
install -m 644 "$cand" "$LIVE"

rc=0; apply || rc=$?
case "$rc" in
  0) ;;
  76) cp -p "$PREVIOUS" "$LIVE"; apply || true
      echo "NOT PUBLISHED: ridy's deploy is replacing its Caddy right now; run this again in a few minutes" >&2; exit 1 ;;
  *)  cp -p "$PREVIOUS" "$LIVE"; apply || true
      echo "NOT PUBLISHED: the guard rejected the new routes (exit $rc); the previous routes are still live" >&2; exit 1 ;;
esac
sleep 3

failed=0
for url in https://elprofessor.eu/ https://api.elprofessor.eu/auth/v1/health \
           https://app.elprofessor.eu/ https://api-staging.elprofessor.eu/auth/v1/health; do
  c="$(code "$url")"; echo "  $c  $url"
  [ "$c" = 200 ] || failed=1
done
# ridy is judged against itself: broken by this publish only if it answered
# before and does not now.
ridy_after="$(code https://reidey.de/)"; echo "  $ridy_after  https://reidey.de/ (was $ridy_before)"
[ "$ridy_before" != 200 ] || [ "$ridy_after" = 200 ] || failed=1

if [ "$failed" = 1 ]; then
  cp -p "$PREVIOUS" "$LIVE"
  apply || echo "WARNING: restoring the previous routes failed, check ridy-caddy-1 now" >&2
  echo "ROLLED BACK: a site stopped answering after the reload" >&2
  exit 1
fi
echo "published"
REMOTE
