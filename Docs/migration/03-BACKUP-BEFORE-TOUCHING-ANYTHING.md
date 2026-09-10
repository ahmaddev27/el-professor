# Step 1b — back up ridy before deploying anything

The box runs a live Laravel application with a MySQL database.

**Correction to an earlier version of this document:** it claimed ridy had no
automated backups, on the evidence that `crontab -l` is empty and
`/etc/cron.daily/` holds only Debian's own jobs. That was wrong — it checked the
wrong place. ridy backs up **daily at 03:00 from inside the container**, via
Laravel's scheduler in `ridy-scheduler-1`, writing to
`backend/storage/app/backups/` with seven days of retention:

```
ridy-2026-09-04_030003.sql.gz  ...  ridy-2026-09-10_030003.sql.gz
```

Host-level cron is simply not where a containerised Laravel app schedules things.

The gap that remains is real, though, and it is the one that matters more: those
dumps live on **the same disk as the database they protect**. A failed volume, a
wrong `docker compose down -v`, or a lost VM takes the backups with it. Nothing
leaves the box.

So this step is not about compensating for missing backups. It is about
compensating for a missing **off-box copy** — and, incidentally, our archive
captures their seven-day history alongside our own fresh dump.

Nothing in our migration modifies ridy. But we will append to its Caddyfile and
reload its proxy, and the honest position is that any change to a shared box is a
change to a shared box. Back it up first.

---

## Two backups, not one

They fail differently, so take both.

### 1. Provider snapshot — the fast path back

The panel showed **Exportable Snapshots: 1 left**. Take it. Restoring a snapshot
is minutes; rebuilding from a logical dump is hours.

Its limitation: a snapshot of a *running* VM is **crash-consistent, not
application-consistent**. MySQL is captured mid-write, as if the power had been
cut. InnoDB's redo log usually replays cleanly — but "usually" is not a property
you want to discover the truth about during an incident.

It is also tied to this provider. It will not restore onto a different host.

### 2. Logical backup — the one that always works

`deploy/backup-ridy.sh`. Read-only: starts nothing, stops nothing, changes
nothing.

```bash
scp deploy/backup-ridy.sh root@159.195.205.30:/root/
ssh root@159.195.205.30 'bash /root/backup-ridy.sh'
```

It produces, under `/var/backups/ridy/<timestamp>/`:

| artifact | what it is |
|---|---|
| `mysql-all-databases.sql.gz` | `mysqldump --single-transaction` — consistent without locking the app out |
| `ridy-project.tar.gz` | `/root/ridy` — compose files, `.env`, mounted configs |
| `volume-ridy_dbdata.tar.gz` | the raw MySQL data directory |
| `volume-ridy_caddy_data.tar.gz` | Let's Encrypt certificates and account key |
| `volume-ridy_caddy_config.tar.gz` | Caddy's autosaved config |
| `host-etc.tar.gz` | docker config, systemd units, cron, sshd_config |
| `INVENTORY.txt` | containers, images, volumes, networks as they were |
| `SHA256SUMS` | so you can prove the copy is intact |

Three details in it that matter more than they look:

- **`--routines --triggers --events` are not mysqldump defaults.** Leaving them
  off produces a dump that restores without error and is missing your stored
  procedures. It is a classic silent failure.
- **The dump is verified** for the `Dump completed` end marker. A truncated dump
  looks perfectly normal until you need it.
- **`ridy_caddy_data` holds the TLS certificates.** Losing it is survivable —
  Caddy re-issues — but repeated re-issuance hits Let's Encrypt rate limits.

### What it deliberately skips

`ridy_osrm_data` and `ridy_nominatim_data`. These are derived from public
OpenStreetMap extracts and are rebuildable — `osrm-build.log` in `/root` is the
record of them being built. They are also tens of gigabytes.

Skipping them costs hours of CPU to rebuild, not data. Pass `--with-map-data` if
you would rather have the hours.

### One thing it flags rather than does

`ridy-backend`, `ridy-frontend`, `ridy-scheduler`, `ridy-queue`, `ridy-reverb`
and `ridy-dispatch-daemon` are **built on this host**, not pulled from a
registry. If the source in `/root/ridy` can rebuild them, the project tarball is
enough. If it cannot — no Dockerfile, or a build that depended on something no
longer present — those images are the only copies in existence.

The script prints the command to export them and lets you decide, because
`docker save` on six images is large and usually redundant.

---

## The two steps everyone skips

**Copy it off the box.**

```bash
rsync -avz root@159.195.205.30:/var/backups/ridy/<stamp>/ ./ridy-backup-<stamp>/
```

A backup that lives only on the machine it protects is not a backup. It survives
a bad deploy and nothing else.

**Test a restore.** On a scratch machine or a throwaway container:

```bash
docker run -d --name test-mysql -e MYSQL_ROOT_PASSWORD=test mysql:8.0
zcat mysql-all-databases.sql.gz | docker exec -i test-mysql mysql -uroot -ptest
docker exec test-mysql mysql -uroot -ptest -e 'SELECT COUNT(*) FROM <db>.<table>'
```

Compare against the live count. An untested backup is a guess.

---

## Make the off-box copy recurring

ridy's own daily dump already exists. What does not exist is a copy anywhere
else. That is the job worth adding — on **your** machine or another host, not on
the VPS:

```bash
# pulls both our archive and ridy's own rotating dumps
rsync -avz --delete   root@159.195.205.30:/var/backups/ridy/ ./ridy-backups/
```

Run it on a schedule from somewhere the VPS cannot reach back into. A backup the
compromised machine can delete is not a backup against the case that matters.

Our Postgres will need the same treatment once deployed — one dump job on the
box, one pull from outside it.
