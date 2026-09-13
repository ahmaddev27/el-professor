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
# request as $SSH_ORIGINAL_COMMAND. So a leaked CI secret buys "deploy a
# release", not a root shell on a host holding payroll data.
#
# It must live outside /srv/PRO*: a release writes into those trees, and a
# wrapper a release could overwrite is a wrapper a release could widen.
#
# Protocol: the client runs `release staging` or `release production` and pipes
# a gzipped tar on stdin containing dist/, deploy/, supabase/functions and
# supabase/migrations. Nothing named .env is accepted.
set -euo pipefail

refuse() { printf 'RELEASE REFUSED: %s\n' "$*" >&2; exit 1; }

case "${SSH_ORIGINAL_COMMAND:-}" in
  "release staging")    ENV=staging;    DIR=/srv/PRO-staging ;;
  "release production") ENV=production; DIR=/srv/PRO ;;
  *) refuse "unsupported command '${SSH_ORIGINAL_COMMAND:-}'" ;;
esac

[ -f "$DIR/deploy/.env" ] || refuse "$ENV is not provisioned on this host ($DIR/deploy/.env missing)"

# One release per environment at a time. A second push while the first is still
# migrating must wait its turn, not interleave with it.
exec 9>"/var/lock/el-professor-$ENV.lock"
flock -w 600 9 || refuse "another $ENV release held the lock for 10 minutes"

work="$(mktemp -d /tmp/el-professor-release-XXXXXX)"
trap 'rm -rf "$work"' EXIT

# GNU tar strips leading "/" and refuses ".." members by default, so the archive
# cannot write outside $work.
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

echo "== placing release for $ENV"
install -m 644 "$work/deploy/docker-compose.yml" "$work/deploy/kong.yml" "$work/deploy/nginx-spa.conf" "$DIR/deploy/"
install -m 750 "$work/deploy/deploy.sh" "$DIR/deploy/deploy.sh"
rm -rf "$DIR/deploy/init-db";        cp -r "$work/deploy/init-db"        "$DIR/deploy/init-db"
rm -rf "$DIR/supabase/functions";    cp -r "$work/supabase/functions"    "$DIR/supabase/functions"
rm -rf "$DIR/supabase/migrations";   cp -r "$work/supabase/migrations"   "$DIR/supabase/migrations"
rm -rf "$DIR/deploy/dist.new";       cp -r "$work/dist"                  "$DIR/deploy/dist.new"
# Files built on Windows arrive with CRLF; bash cannot run those.
sed -i 's/\r$//' "$DIR/deploy/deploy.sh"

exec bash "$DIR/deploy/deploy.sh" "$ENV"
