# Step 1b — back up ridy before deploying anything

The box runs a live Laravel application with a MySQL database and **no automated
backups at all**: `crontab -l` is empty, `/etc/cron.daily/` holds only Debian's
own jobs, and `~/ridy-backup.sql` is a single manual dump of unknown age.

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

## Then make it recurring

ridy has been live 18 days with no scheduled backup. That is a larger
operational risk than anything in our migration, and it is one cron job:

```bash
cat > /etc/cron.daily/ridy-backup <<'SH'
#!/bin/sh
bash /root/backup-ridy.sh >> /var/log/ridy-backup.log 2>&1
find /var/backups/ridy -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
SH
chmod +x /etc/cron.daily/ridy-backup
```

Fourteen days of retention on 792 GB free is comfortable. Add an off-box copy —
rsync to another host, or an object store — and it stops being a single point of
failure.

The same job will cover our Postgres once it is deployed.
