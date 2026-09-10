#!/usr/bin/env bash
#
# Full logical backup of the ridy stack.
#
# Run this BEFORE anything else is deployed to this box. It is read-only: it
# starts nothing, stops nothing, and changes nothing about the running project.
#
#   bash backup-ridy.sh                  # everything except the rebuildable map data
#   bash backup-ridy.sh --with-map-data  # include OSRM + Nominatim volumes (tens of GB)
#
# Why this exists even though the provider offers snapshots: a snapshot of a
# running VM is crash-consistent, not application-consistent — MySQL is captured
# mid-write. InnoDB usually recovers, but "usually" is not a property you want in
# a restore. A logical dump taken with --single-transaction is consistent by
# construction, and it restores onto *any* host, not just this provider.
#
# Take both. The snapshot is the fast path back; this is the one that always works.

set -euo pipefail

RIDY_DIR="${RIDY_DIR:-/root/ridy}"
OUT_ROOT="${OUT_ROOT:-/var/backups/ridy}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="$OUT_ROOT/$STAMP"
WITH_MAP_DATA=0
[[ "${1:-}" == "--with-map-data" ]] && WITH_MAP_DATA=1

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }

mkdir -p "$OUT"
# The archive will contain .env files and a database. Keep it unreadable by
# anyone but root from the moment it exists.
chmod 700 "$OUT_ROOT" "$OUT"

say "Backing up to $OUT"
df -h "$OUT_ROOT" | tail -1

# ── 1. Inventory ────────────────────────────────────────────────────────────
# Recorded first so that even a partial backup documents what was running.
say "Recording the running state"
{
  echo "# ridy backup $STAMP"
  echo "# host: $(hostname)  kernel: $(uname -r)"
  echo
  echo "## containers"
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  echo
  echo "## images"
  docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}'
  echo
  echo "## named volumes"
  docker volume ls --filter name=ridy
  echo
  echo "## networks"
  docker network ls
} > "$OUT/INVENTORY.txt" 2>&1
echo "  -> INVENTORY.txt"

# ── 2. MySQL, consistently ──────────────────────────────────────────────────
say "Dumping MySQL"
if ! docker ps --format '{{.Names}}' | grep -qx 'ridy-mysql-1'; then
  warn "ridy-mysql-1 is not running — skipping the database dump."
  warn "That makes this backup INCOMPLETE. Investigate before relying on it."
else
  # Credentials come from the container's own environment, so nothing is
  # hardcoded or guessed here.
  MYSQL_ROOT_PW="$(docker exec ridy-mysql-1 printenv MYSQL_ROOT_PASSWORD 2>/dev/null || true)"

  if [[ -z "$MYSQL_ROOT_PW" ]]; then
    warn "MYSQL_ROOT_PASSWORD is not in the container environment."
    warn "Find it in $RIDY_DIR/.env and re-run with:"
    warn "  MYSQL_ROOT_PW=... bash $0"
    MYSQL_ROOT_PW="${MYSQL_ROOT_PW_OVERRIDE:-}"
  fi

  # --single-transaction gives a consistent snapshot of InnoDB tables without
  # locking the application out. --routines/--triggers/--events are NOT default
  # and their absence is a classic silent restore failure.
  docker exec ridy-mysql-1 mysqldump \
    -uroot -p"$MYSQL_ROOT_PW" \
    --all-databases \
    --single-transaction \
    --quick \
    --routines --triggers --events \
    --default-character-set=utf8mb4 \
    2>"$OUT/mysqldump.stderr" \
    | gzip > "$OUT/mysql-all-databases.sql.gz"

  SIZE=$(du -h "$OUT/mysql-all-databases.sql.gz" | cut -f1)
  echo "  -> mysql-all-databases.sql.gz ($SIZE)"

  # A dump that ends without the closing marker is truncated. Catch it now, not
  # during a restore at 2am.
  if zcat "$OUT/mysql-all-databases.sql.gz" | tail -5 | grep -q 'Dump completed'; then
    echo "  -> verified: dump reached its end marker"
  else
    warn "Dump does NOT end with 'Dump completed' — it is truncated. Do not trust it."
    cat "$OUT/mysqldump.stderr" || true
  fi
fi

# ── 3. Project directory — compose files, .env, mounted configs ─────────────
say "Archiving $RIDY_DIR"
if [[ -d "$RIDY_DIR" ]]; then
  # This contains .env, which contains the application key and database
  # password. It is the most sensitive artifact here.
  tar czf "$OUT/ridy-project.tar.gz" -C "$(dirname "$RIDY_DIR")" "$(basename "$RIDY_DIR")"
  echo "  -> ridy-project.tar.gz ($(du -h "$OUT/ridy-project.tar.gz" | cut -f1))"
else
  warn "$RIDY_DIR not found. Set RIDY_DIR=... and re-run."
fi

# ── 4. Named volumes ────────────────────────────────────────────────────────
say "Archiving named volumes"

archive_volume() {
  local vol="$1"
  docker volume inspect "$vol" >/dev/null 2>&1 || { warn "volume $vol not found, skipping"; return; }
  # Mount the volume read-only into a throwaway alpine and tar it out. Works
  # regardless of where Docker actually stores it.
  docker run --rm \
    -v "$vol":/src:ro \
    -v "$OUT":/dst \
    alpine:3.20 \
    tar czf "/dst/volume-$vol.tar.gz" -C /src . 2>/dev/null
  echo "  -> volume-$vol.tar.gz ($(du -h "$OUT/volume-$vol.tar.gz" | cut -f1))"
}

# Caddy's data volume holds the Let's Encrypt certificates and account key.
# Losing it means re-issuing, which is usually fine but counts against rate
# limits if it happens repeatedly.
for vol in ridy_dbdata ridy_caddy_data ridy_caddy_config; do
  archive_volume "$vol"
done

if [[ $WITH_MAP_DATA -eq 1 ]]; then
  warn "Including OSRM and Nominatim data — this is large and slow."
  for vol in ridy_osrm_data ridy_nominatim_data; do
    archive_volume "$vol"
  done
else
  say "Skipping OSRM and Nominatim data volumes"
  echo "  These are derived from public OpenStreetMap extracts and can be rebuilt"
  echo "  (see osrm-build.log). Rebuilding costs hours of CPU, not data loss."
  echo "  Pass --with-map-data if you would rather have the hours back."
  {
    echo "OSRM and Nominatim volumes were deliberately NOT included."
    echo "They are rebuildable from OSM extracts. To include them:"
    echo "  bash backup-ridy.sh --with-map-data"
  } > "$OUT/MAP-DATA-EXCLUDED.txt"
fi

# ── 5. Host configuration ───────────────────────────────────────────────────
say "Archiving host configuration"
tar czf "$OUT/host-etc.tar.gz" \
  --ignore-failed-read \
  /etc/docker /etc/systemd/system /etc/cron.d /etc/cron.daily \
  /etc/ssh/sshd_config /etc/hostname /etc/hosts 2>/dev/null || true
echo "  -> host-etc.tar.gz ($(du -h "$OUT/host-etc.tar.gz" | cut -f1))"

crontab -l > "$OUT/root-crontab.txt" 2>/dev/null || echo "(no crontab)" > "$OUT/root-crontab.txt"

# ── 6. Locally built images ─────────────────────────────────────────────────
# ridy-backend, ridy-frontend and friends are built on this box, not pulled.
# If the source in $RIDY_DIR can rebuild them, the tarball above is enough. If it
# cannot, these images are the only copy that exists.
say "Locally built images"
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^ridy' > "$OUT/local-images.txt" || true
if [[ -s "$OUT/local-images.txt" ]]; then
  echo "  These exist only on this host:"
  sed 's/^/    /' "$OUT/local-images.txt"
  echo
  echo "  Not exported by default — they are large and usually rebuildable from"
  echo "  $RIDY_DIR. If you are not certain the source can rebuild them, run:"
  echo "    docker save \$(cat $OUT/local-images.txt | tr '\\n' ' ') | gzip > $OUT/local-images.tar.gz"
fi

# ── 7. Checksums and summary ────────────────────────────────────────────────
say "Checksums"
( cd "$OUT" && sha256sum ./*.gz > SHA256SUMS 2>/dev/null || true )
echo "  -> SHA256SUMS"

say "Done"
du -sh "$OUT"
ls -lh "$OUT"

cat <<EOF

Next, and this is the part people skip:

  1. COPY IT OFF THE BOX. A backup living only on the machine it protects is
     not a backup.
       rsync -avz --progress root@$(hostname -I | awk '{print $1}'):$OUT/ ./ridy-backup-$STAMP/

  2. TEST A RESTORE. An untested backup is a guess. On a scratch machine:
       zcat mysql-all-databases.sql.gz | docker exec -i <fresh-mysql> mysql -uroot -p...
     and confirm the row counts match what the live database reports.

  3. TAKE THE PROVIDER SNAPSHOT TOO. This dump restores anywhere; the snapshot
     restores fastest. They cover different failures.

The archive contains $RIDY_DIR/.env — application key, database password. Treat
it as a credential, not a file.
EOF
