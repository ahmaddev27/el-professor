# Step 1a — the VPS as surveyed

Run on 2026-09-10 against `159.195.205.30`. This is the state the deployment
files in `deploy/` are now written against; re-run the commands below if the box
changes.

---

## What is already there

`ridy` — a Laravel application with a routing stack — running as ten containers
on network `ridy_default`:

| container | image | note |
|---|---|---|
| `ridy-caddy-1` | `caddy:2-alpine` | **owns :80 and :443** |
| `ridy-backend-1` | (local) | Laravel, :9000 internal |
| `ridy-scheduler-1`, `ridy-queue-1`, `ridy-reverb-1` | (local) | Laravel workers + websockets |
| `ridy-frontend-1` | (local) | :3000 internal |
| `ridy-mysql-1` | `mysql:8.0` | :3306 **internal only** |
| `ridy-osrm-1` | `osrm/osrm-backend` | 4.8 GB resident |
| `ridy-nominatim-1` | `mediagis/nominatim:4.4` | 2.3 GB, its own Postgres, internal |
| `ridy-dispatch-daemon-1` | (local) | |

## The three answers that shaped our deployment

**1. A reverse proxy already exists, and it is Caddy in a container.**

Only `:22`, `:80` and `:443` listen on `0.0.0.0`, and 80/443 belong to
`ridy-caddy-1` via `docker-proxy`. So installing Caddy or nginx on the host is
out — both would fail to bind, and after a reboot the race could take *ridy*
offline instead.

Our stack therefore **publishes no host ports at all**. It joins `ridy_default`
and the existing Caddy reverse-proxies to it by container name. The only change
to ridy is two site blocks appended to its Caddyfile —
`deploy/ridy-caddy-snippet.Caddyfile`, with validate-before-reload instructions.

**2. Memory is comfortable.**

```
Mem: 31Gi total, 9.9Gi used, 21Gi available
Disk: 1007G total, 175G used, 792G available
```

OSRM and Nominatim account for ~7 GB of the 9.9. Our stack needs roughly 2 GB
idle. The per-container limits stay anyway, so a Fahrtenbuch import cannot spike
into ridy's MySQL and get it OOM-killed.

**3. No database is exposed.**

```
ss -tlnp | grep -E '0\.0\.0\.0:(5432|3306|27017|6379)'   # no output
```

MySQL and Nominatim's Postgres are reachable only inside `ridy_default`. This
was the one finding that would have outranked the migration, and it is clean.

---

## Two things worth fixing, separate from this migration

### There is no firewall, and adding `ufw` would not do what you expect

`ufw` is not installed and `iptables -P INPUT ACCEPT` is the default policy. In
practice nothing is exposed, because nothing binds `0.0.0.0` except SSH and the
proxy — but there is no second line of defence.

The nuance that catches people: **Docker writes its own iptables rules and
bypasses `ufw` entirely.** Installing `ufw` and allowing only 22/80/443 does not
protect a port some future `docker run -p` publishes. The real protection is the
discipline of not publishing ports, which is why our compose file publishes none.

If you do want host-level filtering, it has to go in the `DOCKER-USER` chain,
not in `ufw`'s.

### `ridy` has no automated backups

```
/var/backups/       only Debian's own dpkg/apt rotations
crontab -l          empty
/etc/cron.daily/    apt-compat, dpkg, logrotate
```

`~/ridy-backup.sql` is a single manual dump. A production Laravel app with a
MySQL database has been running 18 days with no scheduled backup and no restore
test.

That is not our project, so this is a flag rather than a change — but it is a
bigger operational risk than anything in our migration, and the same cron job
that will back up our Postgres can back up their MySQL.

---

## Re-running the survey

```bash
ss -tlnp | sort -k4
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
free -h && df -h / && docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'
docker network ls
ss -tlnp | grep -E '0\.0\.0\.0:(5432|3306|27017|6379)'
crontab -l; ls /etc/cron.daily/
```

All read-only.
