# Step 1a — surveying the VPS before installing anything

The box already runs another project (`ridy`, with an OSRM routing build alongside
it). Adding a second stack is normal and the hardware is generous — 32 GB RAM,
12 vCPU, 1 TB — but three things collide by default, and one of them takes the
existing site down if you get it wrong.

Run these on the server and paste the output back. Every one is read-only.

---

## 1. What is listening, and on which ports

```bash
ss -tlnp | sort -k4
```

**Why it matters.** Our stack binds Kong to `127.0.0.1:8000` and expects a
reverse proxy on `:80` / `:443`. If `ridy` already holds those ports, installing
Caddy the way `01-VPS-SETUP.md` describes will fail to bind — or worse, bind
first after a reboot and take the other project offline.

Look for: who owns `80`, `443`, `8000`, `5432`, `3000`, `4000`, `5000`, `9999`.

## 2. Is there already a reverse proxy?

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
systemctl is-active nginx caddy traefik apache2 2>/dev/null
```

**Why it matters.** There must be exactly one thing terminating TLS on this box.
If `ridy` already has nginx or Traefik, we add our two hostnames to it rather
than installing Caddy. Two proxies fighting over `:443` is the most common way
this goes wrong.

## 3. How much room is actually left

```bash
free -h
df -h /
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
```

**Why it matters.** OSRM keeps the routing graph in memory and for a
country-sized extract that can be tens of gigabytes. 32 GB total does not mean
32 GB free. Our stack needs roughly 2 GB idle, more during a Fahrtenbuch import.

If headroom is thin, the fix is memory limits on our containers so a spike in our
import cannot make the kernel OOM-kill *their* database. That is added below.

## 4. Docker networks and existing volumes

```bash
docker network ls
docker volume ls
```

**Why it matters.** Our compose file declares `name: ya-mobility`, so its
network and volumes are namespaced (`ya-mobility_db-data`). Confirm nothing
already uses that prefix.

## 5. The firewall

The provider panel shows **Firewall: Active (0)** — active with **zero
policies**. Depending on the provider that means either "everything allowed" or
"nothing allowed", and since the box is reachable it is almost certainly the
former.

```bash
ufw status verbose
iptables -S | head -30
```

**Why it matters.** If neither the provider firewall nor `ufw` is filtering, then
whatever `ridy` exposes is exposed to the internet. Before we add anything,
worth knowing whether its database is among them:

```bash
ss -tlnp | grep -E '0\.0\.0\.0:(5432|3306|27017|6379)'
```

A Postgres, MySQL, Mongo or Redis bound to `0.0.0.0` with no firewall is the
single most common way a VPS gets ransomwared. If that comes back with a hit,
say so and fix it before anything else — it outranks our migration.

## 6. Backups already in place

```bash
ls -la /var/backups/ 2>/dev/null
crontab -l 2>/dev/null
ls /etc/cron.daily/
```

**Why it matters.** So our backup job does not collide with theirs, and so we
know whether `ridy-backup.sql` in `/root` is a one-off or something scheduled.

---

## What we do with the answers

| Finding | What changes |
|---|---|
| `ridy` owns 80/443 via nginx/Traefik | We skip Caddy and add two server blocks to their proxy |
| Nothing owns 80/443 | Caddy as written in `01-VPS-SETUP.md` |
| Port 8000 taken | Set `KONG_BIND_PORT` in `deploy/.env` to something free |
| Low free memory | Keep the container memory limits; consider moving OSRM's rebuild off-peak |
| A database bound to `0.0.0.0` | Fix that first, separately from this migration |

Nothing about the existing project is modified in any case. Separate compose
project, separate network, separate Postgres container, separate volumes,
separate database credentials. The two stacks share the kernel and the disk and
nothing else.
