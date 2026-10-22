#!/usr/bin/env bash
# Build the map data the routing container serves (the `osrm` service in
# docker-compose.yml), into the volume <project>_osrm-data.
#
#   deploy/osrm-build-data.sh --check                      what it would do, and whether this host can
#   deploy/osrm-build-data.sh                              Germany, the newest Geofabrik snapshot
#   deploy/osrm-build-data.sh --region europe/germany/nordrhein-westfalen
#   deploy/osrm-build-data.sh --date 261020                a named snapshot instead of the newest
#
# Run it by hand, from the deploy directory of the stack it is for, as root, and
# detached: it is a long job for Germany (nohup, tmux or screen; it logs to stdout).
# It is deliberately NOT part of a release. deploy.sh never calls it; when the
# `osrm` profile is on a release only checks that its result exists and was made
# by the image the release runs (osrm_data_problem in deploy.sh), so moving the
# image's pin means running this again before the release.
#
# ## Why it is not part of a release, and why it is careful
#
# This host also runs another live product (ridy). Building Germany is a job of
# tens of gigabytes of memory and all the CPU it is given for as long as it runs, and the kernel's
# answer to a host that runs out of memory is to kill whatever it likes. So the
# three build steps run in throwaway containers with a memory ceiling BELOW what
# the host has free: if the build needs more than it was given, that one
# container is killed and nothing else is touched. The ceiling is computed from
# /proc/meminfo, the CPU share is low, and the script refuses to start when the
# documented requirement does not fit unless --force says the person running it
# knows better. If this host cannot spare the memory, build somewhere that can
# and copy the volume over; the build is a pure function of the extract.
#
# ## What it costs
#
# From OSRM's own wiki (Disk and Memory Requirements, numbers for v5.26 and the
# 61 GiB planet of November 2021, car profile): pre-processing needs 415 GiB for
# extract, 220 GiB for partition and 174 GiB for customize, the generated
# datafiles need about 300 GB of disk, and "the sizes scale roughly linear with
# input data size"; serving needs about 123 GiB of RAM. The wiki does not say
# whether the pre-processing figures are memory, swap or temporary disk, so this
# script treats them as memory it may need. Scaled to Germany's 4.5 GiB extract
# that is, as estimates and not measurements: about 30 GiB at the extract's
# peak, 22 GB of disk and 9 GiB to serve. --check prints the figures for the
# extract it is about to build; the refusal below uses these, the larger ones.
# The wiki gives no times; this script prints the time each step took and the
# peak memory each tool reports, and writes both into ready.json.
#
# Measured by the CI job of the pull request that added this script, in the six
# builds whose logs were kept, on shared runners (Regierungsbezirk Dusseldorf,
# 217 MB, two CPUs, the pinned v26.9.0 image): extract 125 to 159 s and 1.05 to
# 1.09 GiB, partition 10 to 12 s and 0.26 GiB, customize 3 to 4 s and 0.22 GiB,
# 323 MB of data. The wiki's scaling put
# that extract at 1.4 GiB and 1.0 GB, so it errs high, by a quarter for memory and
# threefold for disk. Scaled by size to Germany, 22 times larger, the same runs are
# about 24 GiB, 7 GB and an hour on two CPUs. That is an extrapolation across a
# factor of 22, not a measurement, and the first real build overwrites it with one.
#
# ## What it leaves behind
#
# /data/<name>/map.osrm.*   the build ("<region>-<snapshot date>", e.g. germany-261020)
# /data/<name>/ready.json   written last: no ready.json, no build
# /data/current             a symlink to the build the service serves
#
# The service reads /data/current/map.osrm. Building a new snapshot leaves the
# previous build in place until the next one, switches the link only after the
# new build has been started once and answered, and tells you the command that
# makes the running container read it. Nothing here restarts anything.
set -euo pipefail
cd "$(dirname "$0")"

REGION="europe/germany"
SNAPSHOT_DATE=""
MODE="build"
FORCE="no"
WORK_DIR="${OSRM_WORK_DIR:-/var/tmp/osrm-build}"
BUILD_CPUS="${OSRM_BUILD_CPUS:-2}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:?--region needs a Geofabrik path such as europe/germany}"; shift 2 ;;
    --date) SNAPSHOT_DATE="${2:?--date needs YYMMDD}"; shift 2 ;;
    --check) MODE="check"; shift ;;
    --force) FORCE="yes"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done

fail() { printf 'OSRM BUILD REFUSED: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

# ── Helpers ──────────────────────────────────────────────────────────────────
# Everything between the two marker lines is also sourced on its own by
# tests/deploy/osrm.test.ts, so it may use only its arguments and standard tools.
# >>> osrm build helpers

# One of the wiki's planet figures scaled to an extract: $1 = the extract's size
# in bytes, $2 = the figure for the 61 GiB planet it was measured on.
scaled_gib() { awk -v bytes="$1" -v planet="$2" 'BEGIN { printf "%.1f", bytes / (61 * 2^30) * planet }'; }

# The newest YYMMDD snapshot of the region whose base name is $2 that the
# Geofabrik page $1 lists. Nothing when it lists none.
newest_snapshot_date() {
  # The name must start at a delimiter, or east-germany-261030 would be germany's newest.
  grep -oE "[\"'/> =]$2-[0-9]{6}\.osm\.pbf" "$1" | sed -E "s/^.$2-([0-9]{6})\.osm\.pbf$/\1/" | sort -u | tail -n 1
}

# What the build may use, from a meminfo file ($1): memory and swap that are
# free now, in GiB. Swap counts because the wiki's figures include it.
free_memory_gib() { awk '/^MemAvailable:/ { a = $2 } /^SwapFree:/ { s = $2 } END { printf "%.1f", (a + s) / 2^20 }' "$1"; }

# The ceiling for the build containers, from a meminfo file ($1): 80 % of the
# memory available now, and that plus the free swap, both in MiB. The rest of
# the host keeps the other 20 %, and a build that wants more is killed alone.
build_limits() {
  awk '/^MemAvailable:/ { a = $2 } /^SwapFree:/ { s = $2 }
       END { mem = int(a * 0.8 / 1024); printf "%d %d\n", mem, mem + int(s / 1024) }' "$1"
}

# "ok" when $2 (what the host has) covers $1 (what the build needs), else a sentence.
verdict() {
  if awk -v need="$1" -v have="$2" 'BEGIN { exit !(have + 0 >= need + 0) }'; then echo ok; else echo "needs about $1 GiB, this host has $2 GiB"; fi
}

# The region as Geofabrik writes it: lower-case words joined by slashes. It ends
# up in a URL and in a volume path, so nothing else gets through.
valid_region() { [[ "$1" =~ ^[a-z0-9-]+(/[a-z0-9-]+)*$ ]]; }

# <region base name>-<snapshot date>, the directory a build lives in.
build_name() { printf '%s-%s' "${1##*/}" "$2"; }

# MiB from a size as docker stats writes it ("1.234GiB", "512MiB", "800kB").
to_mib() {
  awk -v size="$1" 'BEGIN {
    n = size + 0
    unit = size; sub(/^[0-9.]+/, "", unit)
    if (unit == "GiB" || unit == "GB") n *= 1024
    else if (unit == "KiB" || unit == "kB" || unit == "KB") n /= 1024
    else if (unit == "B") n /= 1048576
    printf "%.0f", n
  }'
}

# <<< osrm build helpers

# ── Which stack, which image, which snapshot ─────────────────────────────────

valid_region "$REGION" || fail "--region is a Geofabrik path such as europe/germany (lower case, words joined by slashes), not '$REGION'"
[ -z "$SNAPSHOT_DATE" ] || [[ "$SNAPSHOT_DATE" =~ ^[0-9]{6}$ ]] || fail "--date is YYMMDD, not '$SNAPSHOT_DATE'"
[ -f .env ] || fail ".env is missing in $(pwd); run this from the deploy directory of the stack it is for"

PROJECT_NAME="$(grep -E '^PROJECT_NAME=' .env | cut -d= -f2- | tr -d '\r')" || true
case "$PROJECT_NAME" in
  ya-mobility|ya-mobility-staging) ;;
  *) fail ".env says PROJECT_NAME='$PROJECT_NAME'; this script builds for ya-mobility or ya-mobility-staging only" ;;
esac
VOLUME="${PROJECT_NAME}_osrm-data"

# The very image the service runs, from the compose file: the data format of a
# build belongs to the OSRM version that wrote it, so there is one line to change.
IMAGE="$(docker compose --profile osrm config --format json < /dev/null | python3 -c '
import json, sys
print(json.load(sys.stdin)["services"]["osrm"]["image"])
')" || fail "could not read the osrm service from docker-compose.yml"
case "$IMAGE" in *@sha256:*) ;; *) fail "the osrm image is not pinned by digest: $IMAGE" ;; esac

# And the very flags it runs with. The new build is tried with these, not with a
# copy of them: the first version of the compose file carried a --max-viaroute-size
# that osrm-routed refuses (a limit must be -1 or above 2), and it refuses by
# exiting without a word, which a check on other flags could not see.
mapfile -t SERVICE_CMD < <(docker compose --profile osrm config --format json < /dev/null | python3 -c '
import json, sys
print("\n".join(json.load(sys.stdin)["services"]["osrm"]["command"]))
')
{ [ "${SERVICE_CMD[0]:-}" = osrm-routed ] && [ "${SERVICE_CMD[${#SERVICE_CMD[@]}-1]}" = /data/current/map.osrm ]; } \
  || fail "the osrm command in docker-compose.yml is not 'osrm-routed <flags> /data/current/map.osrm', so a build cannot be tried with it"
SERVICE_FLAGS=("${SERVICE_CMD[@]:1:${#SERVICE_CMD[@]}-2}")

BASE="${REGION##*/}"
if [ -z "$SNAPSHOT_DATE" ]; then
  page="$(mktemp)"
  curl -fsSL --max-time 60 --retry 3 --retry-delay 5 "https://download.geofabrik.de/${REGION}.html" -o "$page" \
    || { rm -f "$page"; fail "could not read the Geofabrik page for $REGION; pass --date YYMMDD"; }
  SNAPSHOT_DATE="$(newest_snapshot_date "$page" "$BASE")"
  rm -f "$page"
  [ -n "$SNAPSHOT_DATE" ] || fail "the Geofabrik page for $REGION names no dated snapshot; pass --date YYMMDD"
fi
NAME="$(build_name "$REGION" "$SNAPSHOT_DATE")"
URL="https://download.geofabrik.de/${REGION}-${SNAPSHOT_DATE}.osm.pbf"

PBF_BYTES="$(curl -fsSIL --max-time 60 --retry 3 --retry-delay 5 "$URL" | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')" || true
[ "${PBF_BYTES:-0}" -gt 0 ] || fail "could not read the size of $URL"

# ── What it needs, what the host has ─────────────────────────────────────────

NEED_MEM_GIB="$(scaled_gib "$PBF_BYTES" 415)"
NEED_DISK_GB="$(scaled_gib "$PBF_BYTES" 300)"
HAVE_MEM_GIB="$(free_memory_gib /proc/meminfo)"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' < /dev/null)"
HAVE_DISK_GB="$(df -B1 --output=avail "$DOCKER_ROOT" | tail -n 1 | awk '{ printf "%.1f", $1 / 1e9 }')"
# The data, the extract it is built from, and the same again while a new build sits beside the old one.
DISK_WITH_ROOM_GB="$(awk -v d="$NEED_DISK_GB" -v b="$PBF_BYTES" 'BEGIN { printf "%.1f", d * 2 + b / 1e9 }')"
MEM_VERDICT="$(verdict "$NEED_MEM_GIB" "$HAVE_MEM_GIB")"
DISK_VERDICT="$(verdict "$DISK_WITH_ROOM_GB" "$HAVE_DISK_GB")"

step "plan"
cat <<PLAN
  stack        $PROJECT_NAME  (volume $VOLUME)
  image        $IMAGE
  extract      $URL  ($(awk -v b="$PBF_BYTES" 'BEGIN { printf "%.2f", b / 2^30 }') GiB)
  build        $NAME, with $BUILD_CPUS CPUs at low priority, in containers without a network
  memory       about $NEED_MEM_GIB GiB at the extract's peak (estimate from the OSRM wiki, scaled by size)
               host has $HAVE_MEM_GIB GiB free including swap: $MEM_VERDICT
  disk         about $NEED_DISK_GB GB of data; $DISK_WITH_ROOM_GB GB with the extract and room for a second build
               $DOCKER_ROOT has $HAVE_DISK_GB GB free: $DISK_VERDICT
PLAN
if [ "$MEM_VERDICT" != ok ] || [ "$DISK_VERDICT" != ok ]; then
  [ "$MODE" = check ] && exit 3
  [ "$FORCE" = yes ] || fail "this host does not have what the estimate says the build needs (above). Build elsewhere and copy the volume, pick a smaller --region, or pass --force if you know better"
  echo "  --force: going on although the estimate says it will not fit"
fi
[ "$MODE" = check ] && { echo "  --check: nothing was downloaded or built"; exit 0; }

# ── Build ────────────────────────────────────────────────────────────────────

exec 9>/var/lock/el-professor-osrm-build.lock
flock -n 9 || fail "another build holds /var/lock/el-professor-osrm-build.lock"

read -r MEM_MIB SWAP_MIB <<<"$(build_limits /proc/meminfo)"
[ "$MEM_MIB" -ge 512 ] || fail "only $MEM_MIB MiB would be left for the build after keeping 20 % for the host"
echo "  build containers: ${MEM_MIB} MiB memory, ${SWAP_MIB} MiB with swap, ${BUILD_CPUS} CPUs"

step "image"
docker pull "$IMAGE" < /dev/null

step "extract $NAME"
mkdir -p "$WORK_DIR"
PBF="$WORK_DIR/$NAME.osm.pbf"
EXPECTED_MD5="$(curl -fsSL --max-time 60 --retry 3 --retry-delay 5 "$URL.md5" | awk '{ print $1 }')" || true
[[ "$EXPECTED_MD5" =~ ^[0-9a-f]{32}$ ]] || fail "could not read the checksum $URL.md5"
curl -fL --retry 5 --retry-delay 10 -C - -o "$PBF" "$URL"
[ "$(md5sum "$PBF" | awk '{ print $1 }')" = "$EXPECTED_MD5" ] || { rm -f "$PBF"; fail "the download does not match its checksum $EXPECTED_MD5; it was removed, run again"; }
echo "  downloaded and verified $(du -h "$PBF" | cut -f1)"

# Compose adopts a volume that carries its labels and warns about one that does not.
docker volume inspect "$VOLUME" > /dev/null 2>&1 \
  || docker volume create --label "com.docker.compose.project=$PROJECT_NAME" --label "com.docker.compose.volume=osrm-data" "$VOLUME" > /dev/null

docker run --rm --network none -v "$WORK_DIR":/in:ro -v "$VOLUME":/data --entrypoint sh "$IMAGE" \
  -c 'mkdir -p "/data/$1" && cp "/in/$2" "/data/$1/map.osm.pbf"' _ "$NAME" "$NAME.osm.pbf" < /dev/null \
  || fail "could not copy the extract into the volume"

declare -A TOOK PEAK REPORTED
# The highest memory use docker stats shows for a container, sampled while it
# runs, so the next person learns what the build really took and not what the
# wiki's table says. Prints MiB, or nothing when it never saw the container.
peak_memory_mib() {
  local name="$1" peak=0 seen=no now waited=0
  while :; do
    now="$(docker stats --no-stream --format '{{.MemUsage}}' "$name" 2> /dev/null | awk '{ print $1 }')" || now=""
    if [ -n "$now" ]; then
      seen=yes
      now="$(to_mib "$now")"
      [ "$now" -le "$peak" ] || peak="$now"
    elif [ "$seen" = yes ]; then
      break
    else
      # Never saw it start: give up rather than outlive a script that failed.
      waited=$((waited + 1))
      [ "$waited" -lt 120 ] || break
    fi
    sleep 1
  done
  [ "$seen" = no ] || echo "$peak"
}

# OSRM's tools end with "RAM: peak bytes used: N". That is the tool's own figure
# and more exact than a sample once a second, so it wins when it is there.
reported_peak_mib() {
  grep -o 'RAM: peak bytes used: [0-9]*' "$1" 2> /dev/null | tail -n 1 | awk '{ printf "%.0f", $NF / 1048576 }'
}

run_stage() {
  local stage="$1" started=$SECONDS sampler status log="$WORK_DIR/stage-$1.log"
  shift
  step "$stage"
  peak_memory_mib "osrm-build-$stage" > "$WORK_DIR/peak-$stage" 2> /dev/null &
  sampler=$!
  docker run --rm --name "osrm-build-$stage" --network none --memory "${MEM_MIB}m" --memory-swap "${SWAP_MIB}m" \
      --cpus "$BUILD_CPUS" --cpu-shares 256 -v "$VOLUME":/data "$IMAGE" "$@" < /dev/null 2>&1 | tee "$log" \
    || { status=$?; kill "$sampler" 2> /dev/null || true; fail "$stage did not finish (exit $status). A kill (137) means it was given less memory than it needed; nothing else on the host was touched. The build is in /data/$NAME of $VOLUME and is not served"; }
  TOOK[$stage]=$((SECONDS - started))
  wait "$sampler" || true
  PEAK[$stage]="$(cat "$WORK_DIR/peak-$stage" 2> /dev/null || true)"
  REPORTED[$stage]="$(reported_peak_mib "$log")"
  [ -z "${REPORTED[$stage]}" ] || PEAK[$stage]="${REPORTED[$stage]}"
  echo "  $stage took ${TOOK[$stage]} s, peak memory ${PEAK[$stage]:-unknown} MiB (the tool's own figure, else sampled once a second)"
}

# --data_version osmosis stores the extract's own timestamp (osmosis_replication_timestamp in
# the PBF header). Without it osrm-extract stores nothing and no answer carries a
# data_version, which is where travel-route's source label, osrm@<month>, comes from.
run_stage extract osrm-extract -p /opt/car.lua --data_version osmosis --threads "$BUILD_CPUS" "/data/$NAME/map.osm.pbf"
run_stage partition osrm-partition --threads "$BUILD_CPUS" "/data/$NAME/map.osrm"
run_stage customize osrm-customize --threads "$BUILD_CPUS" "/data/$NAME/map.osrm"

# ── Prove it loads, as the user the service runs as, before anything points at it

step "start it once"
# The tools write as root with whatever mode they chose; the service reads as 10001.
docker run --rm --network none -v "$VOLUME":/data --entrypoint sh "$IMAGE" -c 'chmod -R a+rX "/data/$1"' _ "$NAME" < /dev/null \
  || fail "could not make the build readable"
SERVICE_USER=(--network none --read-only --tmpfs /tmp:size=16m --cap-drop ALL --user 10001:10001 -v "$VOLUME":/data:ro)

# Does it initialise at all, with the service's own flags? --trial quits after loading.
docker run --rm "${SERVICE_USER[@]}" "$IMAGE" osrm-routed --trial "${SERVICE_FLAGS[@]}" "/data/$NAME/map.osrm" < /dev/null \
  || fail "osrm-routed could not start on the new build with the service's own flags (its message is above, if it gave one: for a --max-*-size that is not -1 or above 2 it exits without a word); it is not switched in"

# And does it answer a question over HTTP, the way the service is asked?
CHECK=osrm-build-check
trap 'docker rm -f "$CHECK" > /dev/null 2>&1 || true' EXIT
docker run -d --name "$CHECK" "${SERVICE_USER[@]}" "$IMAGE" osrm-routed "${SERVICE_FLAGS[@]}" "/data/$NAME/map.osrm" \
    < /dev/null > /dev/null
ANSWERED=no
for _ in $(seq 1 90); do
  if docker exec "$CHECK" bash -c 'exec 3<>/dev/tcp/127.0.0.1/5000 && printf "GET /nearest/v1/driving/10.0,51.0 HTTP/1.0\r\n\r\n" >&3 && grep -q "\"code\"" <&3' < /dev/null 2> /dev/null; then
    ANSWERED=yes
    break
  fi
  sleep 2
done
[ "$ANSWERED" = yes ] || { docker logs "$CHECK" 2>&1 | tail -n 20 || true; fail "osrm-routed did not answer on the new build; it is not switched in"; }
docker rm -f "$CHECK" > /dev/null 2>&1 || true
trap - EXIT
echo "  osrm-routed loaded $NAME and answered"

# ── Switch it in ─────────────────────────────────────────────────────────────

step "switch $NAME in"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
READY="{\"name\":\"$NAME\",\"region\":\"$REGION\",\"snapshot\":\"$SNAPSHOT_DATE\",\"pbf_md5\":\"$EXPECTED_MD5\",\"pbf_bytes\":$PBF_BYTES,\"image\":\"$IMAGE\",\"built_at\":\"$BUILT_AT\",\"seconds\":{\"extract\":${TOOK[extract]},\"partition\":${TOOK[partition]},\"customize\":${TOOK[customize]}},\"peak_mib\":{\"extract\":${PEAK[extract]:-null},\"partition\":${PEAK[partition]:-null},\"customize\":${PEAK[customize]:-null}}}"

# One container does all of it, so the link moves in one rename and a build is
# never half switched. ready.json is written first: the guard in deploy.sh reads
# it through the link, and a link to a directory without it is not a build. The
# build before this one stays, for a way back; older ones go.
docker run --rm --network none -v "$VOLUME":/data --entrypoint sh "$IMAGE" -c '
  set -e
  cd /data
  previous="$(readlink current 2>/dev/null || true)"
  rm -f "$1/map.osm.pbf"
  printf "%s\n" "$2" > "$1/ready.json"
  chmod -R a+rX "$1"
  ln -sfn "$1" current.new
  mv -T current.new current
  for dir in */; do
    dir="${dir%/}"
    case "$dir" in
      "$1"|"$previous") ;;
      *-[0-9][0-9][0-9][0-9][0-9][0-9]) rm -rf -- "$dir" ;;
    esac
  done
' _ "$NAME" "$READY" < /dev/null || fail "could not switch the link; the build is in $VOLUME as $NAME and is not served"

rm -f "$PBF"
docker run --rm --network none -v "$VOLUME":/data:ro --entrypoint sh "$IMAGE" -c 'ls -l /data; du -sh /data/current/ 2>/dev/null || true' < /dev/null

cat <<DONE

Built $NAME: extract ${TOOK[extract]} s (peak ${PEAK[extract]:-?} MiB), partition ${TOOK[partition]} s (peak ${PEAK[partition]:-?} MiB),
customize ${TOOK[customize]} s (peak ${PEAK[customize]:-?} MiB). The same figures are in ready.json.
The service reads /data/current, which now points at it.

Next, only when you mean to:
  first time   COMPOSE_PROFILES in .env names osrm (production: osrm; staging: staging,osrm),
               then a release starts the container. deploy.sh refuses that release without this build.
  a refresh    docker compose --profile osrm up -d --force-recreate --no-deps osrm
DONE
