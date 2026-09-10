# Step 1 — stand the stack up on the VPS

Everything here is in `deploy/`. Do **not** start until
[Step 0](00-SCHEMA-RECOVERY.md) exits clean — a stack built on a schema you
cannot reproduce is a stack you cannot rebuild after an incident.

---

## What is being replaced, and what is not

| Hosted Supabase | On your VPS | App code change |
|---|---|---|
| PostgreSQL | `supabase/postgres` | none |
| PostgREST (`.from()`, 298 calls) | `postgrest/postgrest` | none |
| Auth | `supabase/gotrue` | none |
| Storage (2 buckets) | `supabase/storage-api` | none |
| Realtime (`postgres_changes`) | `supabase/realtime` | none |
| API gateway | `kong` | none |
| Edge Functions (7) | see Step 3 | none yet |

The client keeps talking to `@supabase/supabase-js`. Only `VITE_SUPABASE_URL`
and `VITE_SUPABASE_ANON_KEY` change. That is the whole point of this path: the
410 RLS policies keep doing the tenant isolation, in the database, where they
already work.

---

## Prerequisites

- A VPS with 4 GB RAM minimum. Postgres, Realtime (BEAM) and Kong together sit
  around 2 GB idle; the Fahrtenbuch import spikes Postgres.
- Docker Engine and the compose plugin.
- Two DNS A records pointed at the box: `api.your-domain.de` and
  `app.your-domain.de`.
- An SMTP account. Not optional — see below.

---

## 1. Firewall first

```bash
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Postgres is never published: `docker-compose.yml` uses `expose`, not `ports`,
and Kong is bound to `127.0.0.1`. Reach the database through
`docker compose exec db psql -U postgres` or an SSH tunnel.

## 2. Secrets

```bash
cd deploy
cp .env.example .env
```

Fill in every value. The generator commands are in the file's header comments.
`ANON_KEY` and `SERVICE_ROLE_KEY` are JWTs signed with `JWT_SECRET` — if you
regenerate `JWT_SECRET` later you must regenerate both, and rebuild the
frontend.

`SERVICE_ROLE_KEY` bypasses every RLS policy. It belongs on the server only.
If it ever reaches the browser bundle, tenant isolation is gone.

## 3. Bring the stack up

```bash
docker compose up -d
docker compose ps
docker compose logs -f db
```

On first boot Postgres runs everything in `supabase/migrations/` in filename
order. **This is the moment Step 0 pays off** — if the baseline migration is
missing, the chain fails on the first `ALTER TABLE companies` and the database
comes up half-built.

Verify:

```bash
docker compose exec db psql -U postgres -c '\dt public.*'
docker compose exec db psql -U postgres -c \
  "SELECT count(*) FROM pg_policies WHERE schemaname='public';"
```

The policy count should be in the hundreds. A low number means RLS did not come
across and **every tenant can read every other tenant**.

## 4. Move the data

Schema is already in place from step 3, so restore data only:

```bash
pg_dump --data-only --no-owner --no-acl \
  --schema=public --schema=auth "$PROD_URL" > data.sql

docker compose exec -T db psql -U postgres < data.sql
```

`--schema=auth` is not optional. `auth.users` holds the accounts; without it
every user is locked out and password hashes are gone. Check afterwards:

```bash
docker compose exec db psql -U postgres -c 'SELECT count(*) FROM auth.users;'
```

Storage objects are files, not rows. Download the two buckets from the old
project and drop them into the `storage-data` volume, then confirm a logo and a
Fahrtenbuch file open in the app.

## 5. TLS and the SPA

**This box already runs another project.** Survey it first —
[02-COEXISTENCE-CHECK.md](02-COEXISTENCE-CHECK.md) — because there must be
exactly one thing terminating TLS on a host.

- **If nginx / Traefik / Caddy is already running:** do not install a second
  proxy. Add two server blocks to what is there;
  `deploy/nginx-site.conf.example` is ready for that case.
- **If nothing owns :80 and :443:** use the Caddyfile below.



```bash
apt install caddy
cp Caddyfile /etc/caddy/Caddyfile   # edit both domain names first
systemctl reload caddy
```

Build and deploy the frontend:

```bash
# on your machine
VITE_SUPABASE_URL=https://api.your-domain.de \
VITE_SUPABASE_ANON_KEY=<ANON_KEY> \
VITE_APP_URL=https://app.your-domain.de \
npm run build

rsync -av --delete dist/ root@vps:/srv/ya-mobility/dist/
```

The build gate runs the typecheck ratchet and the tests first. If it refuses,
fix that before shipping rather than reaching for `build:novalidate`.

## 6. Google sign-in

Add `https://api.your-domain.de/auth/v1/callback` to the authorised redirect
URIs in the Google Cloud console, then set `GOOGLE_ENABLED=true` and restart
`auth`. Until then the "Mit Google anmelden" button fails with an opaque error.

---

## Verify before cutting over

Work through these against the new stack while the old project is still live:

- [ ] Sign in with email and password
- [ ] Password reset — **the email actually arrives**, and the link lands on
      `app.your-domain.de/auth/callback`
- [ ] Google sign-in, if enabled
- [ ] A company user sees only their own drivers, receipts and trips
- [ ] A super admin reaches `/super-admin`; a company user redirected away
- [ ] Company logo loads (Storage read)
- [ ] Settings save, and the change appears in another tab without reload
      (Realtime)
- [ ] Import a Fahrtenbuch, apply a plan, finalize, download the XLSX and a
      Stundennachweis PDF — end to end
- [ ] **The five unapplied security migrations from 2026-09-08 are present.**
      This stack is the first place they can be tested:
      `SELECT proname FROM pg_proc WHERE proname='is_company_admin';`

## Backups — before cutover, not after

```bash
# /etc/cron.daily/ya-mobility-backup
docker compose -f /srv/ya-mobility/deploy/docker-compose.yml \
  exec -T db pg_dump -U postgres --clean --if-exists \
  | gzip > /var/backups/ya-$(date +%F).sql.gz
find /var/backups -name 'ya-*.sql.gz' -mtime +30 -delete
```

Copy them off the box. A backup that lives only on the machine it protects is
not a backup.

**Restore-test one before you cut over.** An untested backup is a guess, and
this database holds statutory payroll records.

---

## What you are taking on

Honest accounting, because this is the real cost of the move:

- **Upgrades.** These images get CVEs. Nobody patches them for you.
- **Backups and restore drills.** Monthly at minimum.
- **Monitoring.** Disk filling silently is the classic way a Postgres box dies.
- **SMTP reputation.** Reset emails landing in spam is indistinguishable from
  the feature being broken.
- **Uptime.** A hosted outage was somebody else's night. Now it is yours.

None of that is a reason not to do it. It is a reason to do steps 4 and the
backup section properly rather than last.

---

## Next

- **Step 2** — cutover: DNS, freeze window, rollback plan.
- **Step 3** — the 7 edge functions. Three of them
  (`apply-discount-code`, `extract-receipt`, `validate-discount-code`) still
  carry the authorization holes from the audit. Port them with the fixes, not
  as-is, and commit `supabase/config.toml` so `verify_jwt` lives in git rather
  than in a dashboard nobody can diff.
