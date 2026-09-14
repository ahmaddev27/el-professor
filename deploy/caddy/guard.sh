#!/usr/bin/env bash
# Keep El-Professor's routes in the Caddy that fronts this host.
#
#   el-professor-caddy-guard            # what systemd runs
#   el-professor-caddy-guard --reload   # also make Caddy load the result (publish.sh)
#
# Exit 0 in sync, 1 refused or failed, 75 deferred (try again in a few
# seconds), 76 written but Caddy cannot load it until ridy recreates it.
#
# Installed at /usr/local/sbin/el-professor-caddy-guard. systemd runs it on
# every change to ridy's Caddyfile (el-professor-caddy-guard.path) and once a
# minute as a fallback (el-professor-caddy-guard.timer).
#
# Why it exists: ridy owns ports 80 and 443, so our sites are served from a
# section appended to ridy's Caddyfile. That file is tracked in ridy's git, and
# ridy's deploy runs `git reset --hard` and then recreates its Caddy, which
# drops our section and takes production and staging offline. ridy itself is
# off limits — no commits, no restarts — so the section is put back from here.
#
# What it will never do, because ridy must never be affected:
#   - write a file Caddy would reject: the complete result is validated first,
#     in a throwaway container of ridy's own Caddy image with no network;
#   - change any of ridy's lines: it only appends, or replaces the text between
#     its own two markers;
#   - write by rename: ridy's container bind-mounts that one file by inode, so
#     a renamed file would silently stop being the one Caddy reads;
#   - restart or recreate a container. Caddy is reloaded gracefully, and only
#     when our sites are not being served (or with --reload).
set -euo pipefail

RIDY_CADDYFILE="${RIDY_CADDYFILE:-/root/ridy/docker/Caddyfile}"
SITES_FILE="${SITES_FILE:-/srv/caddy-sites/elprofessor.caddy}"
CADDY="${CADDY:-ridy-caddy-1}"
PROBE_HOST="${PROBE_HOST:-elprofessor.eu}"
BEGIN='# >>> el-professor routes: managed by el-professor-caddy-guard, edit deploy/caddy/elprofessor.caddy in the El-Professor repo >>>'
END='# <<< el-professor routes <<<'

FORCE_RELOAD=0
[ "${1:-}" = --reload ] && FORCE_RELOAD=1

# Under systemd a <N> prefix sets the journal priority; the unit keeps only
# notice and above, so a run that changes nothing leaves no trace.
if [ -n "${INVOCATION_ID:-}" ]; then note() { printf '<5>%s\n' "$*"; }; err() { printf '<3>%s\n' "$*"; }
else note() { printf '%s\n' "$*"; }; err() { printf 'ERROR: %s\n' "$*" >&2; }
fi

exec 9> /run/el-professor-caddy-guard.lock
flock -w 60 9 || { err "another run still holds the lock"; exit 1; }

[ -f "$RIDY_CADDYFILE" ] || { note "no $RIDY_CADDYFILE, nothing to guard"; exit 0; }
[ -s "$SITES_FILE" ] || { err "$SITES_FILE is missing or empty"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Staging's login. The routes file carries a marker line where the basic_auth
# block belongs; the hash comes from a root-only file on this host, so it never
# enters git. A missing or malformed file renders a 503 in its place: staging
# is locked rather than open, and production's routes are still written.
STAGING_AUTH_FILE="${STAGING_AUTH_FILE:-/root/el-professor-secrets/staging-web-auth}"
# Not an @-name on purpose: Caddy reads "@anything" as a named matcher and
# accepts it, which would leave staging open if the marker ever went unrendered.
# An unknown directive name fails validation instead.
MARKER='__STAGING_WEB_AUTH__'
auth_re='^([A-Za-z0-9._-]+):(\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53})$'
auth_line="$(head -n 1 "$STAGING_AUTH_FILE" 2>/dev/null | tr -d '\r' || true)"
if [[ "$auth_line" =~ $auth_re ]]; then
  auth_block="$(printf 'basic_auth {\n\t%s %s\n}' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")"
  staging_state="behind its login"
else
  auth_block='respond "Staging ist gesperrt: kein Zugang eingerichtet." 503'
  staging_state="locked, no valid $STAGING_AUTH_FILE"
fi
unset auth_line
AUTH_BLOCK="$auth_block" MARKER="$MARKER" awk '
  index($0, ENVIRON["MARKER"]) {
    match($0, /^[ \t]*/)
    indent = substr($0, 1, RLENGTH)
    n = split(ENVIRON["AUTH_BLOCK"], lines, "\n")
    for (i = 1; i <= n; i++) print indent lines[i]
    next
  }
  { print }
' "$SITES_FILE" > "$work/sites"
unset auth_block
if grep -qF "$MARKER" "$work/sites"; then
  err "the staging login marker survived rendering; nothing was written"
  exit 1
fi

# ridy's lines alone: our section removed, trailing blank lines trimmed so
# repeated runs converge on one byte-identical file.
awk -v b="$BEGIN" -v e="$END" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  skip { next }
  { line[++n] = $0 }
  /[^[:space:]]/ { last = n }
  END { for (i = 1; i <= last; i++) print line[i] }
' "$RIDY_CADDYFILE" > "$work/desired"
{
  printf '\n%s\n' "$BEGIN"
  sed -e '$a\' "$work/sites"
  printf '%s\n' "$END"
} >> "$work/desired"

if ! cmp -s "$work/desired" "$RIDY_CADDYFILE"; then
  # Never race a writer. git rewrites this file during ridy's deploy, and an
  # append landing mid-write would corrupt ridy's own config; a file touched
  # in the last few seconds is left to the next run.
  if [ "$(( $(date +%s) - $(stat -c %Y "$RIDY_CADDYFILE") ))" -lt 5 ]; then
    note "$RIDY_CADDYFILE changed moments ago, leaving it to the next run"
    exit 75
  fi

  img="$(docker inspect "$CADDY" --format '{{.Image}}' 2>/dev/null || true)"
  if ! docker run --rm --pull never --network none \
         -v "$work/desired":/etc/caddy/Caddyfile:ro "${img:-caddy:2-alpine}" \
         caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$work/validate.log" 2>&1; then
    err "refused: ridy's Caddyfile with our routes does not validate, nothing was written"
    grep -oE '"error":"[^"]*"|Error: .*' "$work/validate.log" | tail -2 | while read -r l; do err "$l"; done
    exit 1
  fi

  # Written in place. When ridy's file is a prefix of the result (the usual
  # case right after its deploy) only the new tail is appended, so the file
  # is never even momentarily shorter than ridy's own content.
  size="$(stat -c %s "$RIDY_CADDYFILE")"
  if cmp -s -n "$size" "$work/desired" "$RIDY_CADDYFILE"; then
    tail -c +"$((size + 1))" "$work/desired" >> "$RIDY_CADDYFILE"
    note "appended El-Professor routes to $RIDY_CADDYFILE (staging: $staging_state)"
  else
    cat "$work/desired" > "$RIDY_CADDYFILE"
    note "rewrote the El-Professor section of $RIDY_CADDYFILE (staging: $staging_state)"
  fi
fi

# A Caddy that does not know our hostname fails the TLS handshake (000). Any
# HTTP status means the routes are loaded; a 502 is our own stack, which a
# reload cannot fix. The probe goes straight to the local port, so a DNS
# hiccup is never mistaken for missing routes.
reload="$FORCE_RELOAD"
if [ "$reload" = 0 ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -I --max-time 10 \
            --resolve "$PROBE_HOST:443:127.0.0.1" "https://$PROBE_HOST/" || true)"
  [ "$code" = 000 ] && reload=1
fi
[ "$reload" = 1 ] || exit 0

if [ "$(docker inspect -f '{{.State.Running}}' "$CADDY" 2>/dev/null || true)" != true ]; then
  note "$CADDY is not running, next run will check again"
  exit 75
fi
# Right after ridy's git reset and before its deploy recreates Caddy, the
# running container still reads the replaced file. It is serving our routes
# from that copy, and picks up the restored file when it is recreated.
if ! docker exec "$CADDY" grep -qxF "$BEGIN" /etc/caddy/Caddyfile; then
  note "$CADDY still reads its previous Caddyfile, it will load ours when ridy recreates it"
  exit 76
fi
if docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile > "$work/reload.log" 2>&1; then
  note "reloaded $CADDY gracefully"
else
  err "caddy reload failed"
  tail -2 "$work/reload.log" | while read -r l; do err "$l"; done
  exit 1
fi
