#!/bin/bash
# Nightly logical backup of the El-Professor production database.
#
# The file keeps its ya-mobility name because the host schedules it by that name.
#
# Runs from cron.daily rather than from inside a container: our Postgres has no
# scheduler of its own, and the dump has to survive the container being
# recreated.
#
# 30 days on disk. That is the fast path back, not the backup — the dumps live
# on the same disk as the database they protect. Pull them off the box on a
# schedule the box itself cannot reach, exactly as ridy's own backups needed:
#
#   rsync -avz root@159.195.205.30:/var/backups/ya-mobility/ ./ya-backups/
set -euo pipefail

DEPLOY=/srv/PRO/deploy
DEST=/var/backups/ya-mobility
mkdir -p "$DEST"
chmod 700 "$DEST"

stamp=$(date +%F)
tmp="$DEST/.ya-$stamp.sql.gz.partial"
out="$DEST/ya-$stamp.sql.gz"

# --clean --if-exists so the dump can be replayed over a populated database.
# supabase_admin, not postgres: the image demotes postgres out of superuser and
# the dump then silently omits what it cannot read.
docker compose -f "$DEPLOY/docker-compose.yml" exec -T db \
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h localhost -U supabase_admin \
         --clean --if-exists --schema=public --schema=auth --schema=storage postgres' \
  | gzip > "$tmp"

# A truncated dump looks perfectly normal until the day it is needed, so check
# the file is a complete gzip stream before it replaces yesterday's.
gzip -t "$tmp"
mv "$tmp" "$out"
chmod 600 "$out"

find "$DEST" -name 'ya-*.sql.gz' -mtime +30 -delete
find "$DEST" -name '.ya-*.partial' -mtime +1 -delete
