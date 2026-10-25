#!/usr/bin/env bash
# The only thing the GitHub Actions deploy key can do on this host.
#
# Installed once, by hand, OUTSIDE the deploy directory:
#
#   install -o root -g root -m 755 deploy/ci-release.sh /usr/local/sbin/el-professor-release
#
# and bound to the key in /root/.ssh/authorized_keys:
#
#   command="/usr/local/sbin/el-professor-release",restrict ssh-ed25519 AAAA… github-actions-el-professor
#
# `restrict` turns off port, agent and X11 forwarding and the pty. `command=`
# ignores whatever the client asked to run and runs this instead, exposing the
# request as $SSH_ORIGINAL_COMMAND. So a leaked CI secret buys "deploy, roll back
# or read the status of a release", not a root shell on a host holding payroll
# data.
#
# It must live outside /srv/PRO*: a release writes into those trees, and a
# wrapper a release could overwrite is a wrapper a release could widen.
#
# Protocol:
#   release <env> [<sha>]  a gzipped tar on stdin with dist/, deploy/ (the
#                          compose, Kong and nginx files, init-db and, since the
#                          Excel export service, export-service/),
#                          supabase/functions and supabase/migrations. Nothing
#                          named .env is accepted. The sha is optional only so an
#                          older workflow keeps working during a change-over.
#   rollback <env>         bring back the newest earlier release that deployed
#                          cleanly — code only, the database stays as it is.
#   status <env>           one line: what the environment runs right now.
#
# Every release is kept as releases/<utc>-<sha7>/ with a manifest.env, and
# releases/current points at the live one. That record is what rollback and the
# production job's "is main what staging runs" check rely on.
set -euo pipefail

refuse() { printf 'RELEASE REFUSED: %s\n' "$*" >&2; exit 1; }

read -r VERB ENV SHA EXTRA <<<"${SSH_ORIGINAL_COMMAND:-}"
[ -z "$EXTRA" ] || refuse "unsupported command '${SSH_ORIGINAL_COMMAND:-}'"

case "$ENV" in
  staging)    DIR=/srv/PRO-staging ;;
  production) DIR=/srv/PRO ;;
  *) refuse "unsupported command '${SSH_ORIGINAL_COMMAND:-}'" ;;
esac

case "$VERB" in
  release)
    [ -z "$SHA" ] || [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || refuse "release takes a full 40-character commit sha"
    SHA="${SHA:-unknown}"
    ;;
  rollback|status)
    [ -z "$SHA" ] || refuse "unsupported command '${SSH_ORIGINAL_COMMAND:-}'"
    ;;
  *) refuse "unsupported command '${SSH_ORIGINAL_COMMAND:-}'" ;;
esac

[ -f "$DIR/deploy/.env" ] || refuse "$ENV is not provisioned on this host ($DIR/deploy/.env missing)"

RELEASES="$DIR/releases"
NAME_RE='^[0-9]{8}T[0-9]{6}Z-[0-9a-z]+$'

mget() { grep -E "^$2=" "$RELEASES/$1/manifest.env" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
mset() {
  local f="$RELEASES/$1/manifest.env"
  { grep -vE "^$2=" "$f" || true; printf '%s=%s\n' "$2" "$3"; } > "$f.tmp"
  mv "$f.tmp" "$f"
}
release_names() { ls -1 "$RELEASES" 2>/dev/null | grep -E "$NAME_RE" | sort || true; }
current_name() { readlink "$RELEASES/current" 2>/dev/null || true; }

# ── status: read-only, no lock ───────────────────────────────────────────────
if [ "$VERB" = status ]; then
  cur="$(current_name)"
  if [ -n "$cur" ] && [ -f "$RELEASES/$cur/manifest.env" ]; then
    printf 'sha=%s status=%s activated_at=%s release=%s\n' \
      "$(mget "$cur" SHA)" "$(mget "$cur" STATUS)" "$(mget "$cur" ACTIVATED_AT)" "$cur"
  else
    echo "sha=unknown status=unknown activated_at= release="
  fi
  exit 0
fi

# One release or rollback per environment at a time. A second push while the
# first is still migrating must wait its turn, not interleave with it.
exec 9>"/var/lock/el-professor-$ENV.lock"
flock -w 600 9 || refuse "another $ENV release held the lock for 10 minutes"

# Copy a stored release into the live checkout; deploy.sh swaps dist.new in.
# A rollback keeps the current deploy.sh, so the newest guards judge old code.
install_release() {
  local src="$RELEASES/$1" keep_deploy_sh="${2:-}"
  install -m 644 "$src/deploy/docker-compose.yml" "$src/deploy/kong.yml" "$src/deploy/nginx-spa.conf" "$DIR/deploy/"
  if [ "$keep_deploy_sh" != keep-deploy-sh ]; then
    install -m 750 "$src/deploy/deploy.sh" "$DIR/deploy/deploy.sh"
    # Files built on Windows arrive with CRLF; bash cannot run those.
    sed -i 's/\r$//' "$DIR/deploy/deploy.sh"
  fi
  rm -rf "$DIR/deploy/init-db";      cp -r "$src/deploy/init-db"      "$DIR/deploy/init-db"
  # The export service is built on this host from these files. An earlier
  # release that predates it has no such directory, and a rollback onto it must
  # not fail here: compose removes the service as an orphan instead.
  rm -rf "$DIR/deploy/export-service"
  if [ -d "$src/deploy/export-service" ]; then cp -r "$src/deploy/export-service" "$DIR/deploy/export-service"; fi
  # A single-file bind mount whose hash is a compose label, so it travels
  # like kong.yml - and the remove comes first, so a rollback onto a release
  # from before it does not leave the newer config behind for old code.
  rm -f "$DIR/deploy/geocoder-gateway.conf"
  if [ -f "$src/deploy/geocoder-gateway.conf" ]; then install -m 644 "$src/deploy/geocoder-gateway.conf" "$DIR/deploy/"; fi
  rm -rf "$DIR/supabase/functions";  cp -r "$src/supabase/functions"  "$DIR/supabase/functions"
  rm -rf "$DIR/supabase/migrations"; cp -r "$src/supabase/migrations" "$DIR/supabase/migrations"
  rm -rf "$DIR/deploy/dist.new";     cp -r "$src/dist"                "$DIR/deploy/dist.new"
}

# Keep the live release and the five newest that deployed cleanly.
prune_releases() {
  local cur keep d
  cur="$(current_name)"
  keep="$(for d in $(release_names); do [ "$(mget "$d" STATUS)" = ok ] && echo "$d"; done | tail -5)" || true
  for d in $(release_names); do
    [ "$d" = "$cur" ] && continue
    printf '%s\n' "$keep" | grep -qxF "$d" && continue
    rm -rf "${RELEASES:?}/$d"
  done
}

# The parts of the stack a code rollback must never change: the database
# service; the auth settings that close signup, limit login attempts and decide
# which identity providers may create or attach an account, together with the
# auth entrypoint that derives signup from the Google switch; and Kong's plugin
# list with the block that answers 403 on GoTrue's account-creating routes
# (deploy/kong.yml, auth-v1-closed). Of the GOTRUE_EXTERNAL_* settings only the
# names and the *_ENABLED values are compared: client ids and redirect URIs
# differ per environment, and the client secret must never reach this output.
compose_fingerprint() {
  docker compose --project-directory "$DIR/deploy" --env-file "$DIR/deploy/.env" -f "$1" \
      config --format json 2>/dev/null \
    | python3 -c '
import json, re, sys
services = json.load(sys.stdin).get("services", {})
auth = services.get("auth", {}) or {}
env = auth.get("environment", {}) or {}
kong_env = (services.get("kong", {}) or {}).get("environment", {}) or {}

def guarded(name):
    return (name in ("GOTRUE_DISABLE_SIGNUP", "GOTRUE_MAILER_AUTOCONFIRM", "GOTRUE_SAML_ENABLED",
                     "GOTRUE_SECURITY_MANUAL_LINKING_ENABLED")
            or name.startswith("GOTRUE_RATE_LIMIT") or name.startswith("GOTRUE_EXTERNAL_"))

def shown(name):
    if name.startswith("GOTRUE_EXTERNAL_") and not name.endswith("_ENABLED"):
        return "(name only)"
    return env[name]

# The auth-v1-closed service of kong.yml, one stripped line per entry, comments
# left out: a release without the block yields an empty list. A comment in
# column 0 does not end the block, exactly as in deploy.sh kong_closed_block_guard.
def closed_routes(path):
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return None
    block, inside = [], False
    for line in lines:
        if re.match(r"^[^\s#]", line):
            inside = False
        service = re.match(r"^  - name:\s*(\S+)\s*$", line)
        if service:
            inside = service.group(1) == "auth-v1-closed"
        entry = line.strip()
        if inside and entry and not entry.startswith("#"):
            block.append(entry)
    return block

print(json.dumps({
    "db": services.get("db"),
    "auth": {name: shown(name) for name in sorted(env) if guarded(name)},
    "auth_entrypoint": auth.get("entrypoint"),
    "kong_plugins": kong_env.get("KONG_PLUGINS"),
    "kong_closed_routes": closed_routes(sys.argv[1]),
}, sort_keys=True))' "$(dirname "$1")/kong.yml"
}

# ── release ──────────────────────────────────────────────────────────────────
if [ "$VERB" = release ]; then
  work="$(mktemp -d /tmp/el-professor-release-XXXXXX)"
  trap 'rm -rf "$work"' EXIT

  # GNU tar strips leading "/" and refuses ".." members by default, so the
  # archive cannot write outside $work.
  tar -xz -C "$work" --no-same-owner

  for need in dist/index.html deploy/docker-compose.yml deploy/deploy.sh deploy/kong.yml \
              deploy/nginx-spa.conf deploy/init-db/roles.sql; do
    [ -f "$work/$need" ] || refuse "archive is missing $need"
  done
  [ -d "$work/supabase/functions" ] && [ -d "$work/supabase/migrations" ] \
    || refuse "archive is missing supabase/functions or supabase/migrations"

  # The environment's secrets are provisioned once on the host and never shipped.
  # An archive carrying an .env is either a mistake or an attempt to replace them.
  found_env="$(find "$work" \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' -print -quit)"
  [ -z "$found_env" ] || refuse "archive contains ${found_env#"$work"/}; environment files are never deployed"

  mkdir -p "$RELEASES"
  name="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}"
  rel="$RELEASES/$name"
  mkdir -p "$rel/deploy" "$rel/supabase"
  cp -r "$work/dist" "$rel/dist"
  cp "$work/deploy/docker-compose.yml" "$work/deploy/deploy.sh" "$work/deploy/kong.yml" \
     "$work/deploy/nginx-spa.conf" "$rel/deploy/"
  cp -r "$work/deploy/init-db" "$rel/deploy/init-db"
  # Optional, so an archive from before the export service is still accepted.
  if [ -d "$work/deploy/export-service" ]; then cp -r "$work/deploy/export-service" "$rel/deploy/export-service"; fi
  # The geocoder gateway's config travels the same way and for the same
  # reason: an archive from before it carries none, and deploy.sh tolerates
  # that while COMPOSE_PROFILES does not name geocoder.
  if [ -f "$work/deploy/geocoder-gateway.conf" ]; then cp "$work/deploy/geocoder-gateway.conf" "$rel/deploy/"; fi
  cp -r "$work/supabase/functions" "$work/supabase/migrations" "$rel/supabase/"
  epoch=1
  if [ -f "$work/deploy/SCHEMA_EPOCH" ]; then
    epoch="$(tr -dc '0-9' < "$work/deploy/SCHEMA_EPOCH")"
    [ -n "$epoch" ] || refuse "deploy/SCHEMA_EPOCH holds no number"
    cp "$work/deploy/SCHEMA_EPOCH" "$rel/deploy/"
  fi
  printf 'SHA=%s\nENV=%s\nCREATED_AT=%s\nSCHEMA_EPOCH=%s\nSTATUS=pending\n' \
    "$SHA" "$ENV" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$epoch" > "$rel/manifest.env"

  # The archive now lives on as the release; the extracted copy is spent.
  rm -rf "$work"
  trap - EXIT

  echo "== placing release $name for $ENV"
  install_release "$name"
  rc=0
  bash "$DIR/deploy/deploy.sh" "$ENV" --release-dir "$rel" || rc=$?
  if [ "$rc" != 0 ]; then
    echo "   release $name did not complete. $DIR holds its files and releases/current still names $(current_name); whatever deploy.sh changed before it stopped stays changed, and its last message says what. Deploy a fix forward to restore $ENV" >&2
  fi
  prune_releases
  exit "$rc"
fi

# ── rollback ─────────────────────────────────────────────────────────────────
cur="$(current_name)"
[ -n "$cur" ] && [ -f "$RELEASES/$cur/manifest.env" ] \
  || refuse "$ENV has no recorded current release, so there is nothing to roll back from"

target=""
for d in $(release_names | sort -r); do
  [[ "$d" < "$cur" ]] || continue
  [ "$(mget "$d" STATUS)" = ok ] || continue
  target="$d"
  break
done
[ -n "$target" ] || refuse "no earlier release of $ENV deployed cleanly; nothing to roll back to"

cur_epoch="$(mget "$cur" SCHEMA_EPOCH)"
tgt_epoch="$(mget "$target" SCHEMA_EPOCH)"
[ "${tgt_epoch:-1}" -ge "${cur_epoch:-1}" ] \
  || refuse "$target predates a schema change marked incompatible (SCHEMA_EPOCH ${tgt_epoch:-1} < ${cur_epoch:-1}); restore the database snapshot by hand instead"

now_fp="$(compose_fingerprint "$DIR/deploy/docker-compose.yml")"
old_fp="$(compose_fingerprint "$RELEASES/$target/deploy/docker-compose.yml")"
[ -n "$now_fp" ] && [ -n "$old_fp" ] || refuse "could not read the compose configuration of $cur or $target"
[ "$now_fp" = "$old_fp" ] \
  || refuse "$target would change the database service, the auth settings (signup, autoconfirm, login limits, identity-provider switches), the auth entrypoint, or Kong's plugin list or auth-v1-closed block; deploy a fix forward instead"

echo "== rolling $ENV back: $cur -> $target"
echo "   migrations $cur applied stay applied: $(mget "$cur" MIGRATIONS_APPLIED)"
if [ "$ENV" = production ]; then
  echo "   newest pre-deploy snapshot: $(ls -1t /var/backups/ya-mobility/pre-deploy-*.sql.gz 2>/dev/null | head -1 || true)"
fi

install_release "$target" keep-deploy-sh
rc=0
bash "$DIR/deploy/deploy.sh" "$ENV" --activate --release-dir "$RELEASES/$target" || rc=$?
if [ "$rc" = 0 ]; then
  mset "$cur" STATUS rolled_back
else
  echo "   the rollback did not come up healthy. $DIR holds the files of $target, and whatever deploy.sh recreated before it stopped runs them (Kong first; its last message says how far it got). Run the Deploy workflow for $ENV to put the newest release back" >&2
fi
exit "$rc"
