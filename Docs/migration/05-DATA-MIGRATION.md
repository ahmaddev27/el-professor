# Step 2 — moving the schema and the data

Done on 2026-09-10. The VPS now serves the production schema and data at
`app.elprofessor.de` / `api.elprofessor.de`. This records what the move actually
required, because six of these were not in the plan and each one failed in a way
that pointed somewhere else.

> **Domain changed 2026-09-13** to `app.elprofessor.eu` / `api.elprofessor.eu`,
> same server, same database — nothing below moved. `app.elprofessor.de` now
> 301-redirects to `.eu` with the path preserved; `api.elprofessor.de` still
> proxies to Kong but the API answers only the `.eu` origin. What the switch
> touched: `PUBLIC_URL` and `APP_URL` in the server `.env`, two lines in
> `.env.production`, the ridy Caddyfile, and three `company_settings.logo_url`
> rows that still pointed at the hosted project from before this migration. The
> apex `elprofessor.eu` has no A record and is not served.

---

## The order that works

1. `db` up — the image initialises, and `roles.sql` sets the service-role
   passwords.
2. `auth` up — **GoTrue creates the `auth` schema**. Anything applied before
   this fails on `function auth.jwt() does not exist`.
3. Restore the production `public` schema.
4. Restore `auth` data (users, identities).
5. Restore `public` data.
6. Storage: buckets, policies, grants, then the objects.
7. Rest of the stack.

## What had to be discovered

### Production is PostgreSQL 17.6; the compose file pinned 15.8

`pg_dump` refuses to dump from a server newer than itself, so a 15.x image
cannot even take the backup this migration depends on. Pinned to
`supabase/postgres:17.6.1.170`, the Supabase build of that exact release.

Check first, on any future move: `SELECT version()`.

### The direct connection is IPv6-only

`db.<ref>.supabase.co` has an AAAA record and no A record. The VPS has global
IPv6, but **Docker bridge networks do not** — so the dump has to run with
`--network host`. Without it the failure is a plain timeout that looks like a
firewall.

### `postgres` is not a superuser in this image

`migrate.sh` creates it as one and then, in its own words, "postgres user
demoted in post-setup". `pg_dump --disable-triggers` needs superuser to touch
system triggers, so restoring as `postgres` produced:

    ERROR: permission denied: "RI_ConstraintTrigger_..." is a system trigger
    ERROR: insert or update on table "fahrtenbuch_trips" violates foreign key ...

Restore as **`supabase_admin`**. Loading `fahrtenbuch_trips` without disabled
triggers is not merely slower — it fails, and the second error names the foreign
key rather than the missing privilege.

### `--schema=public` leaves storage behind, and `--no-acl` leaves the grants behind

Two separate gaps, both silent:

- **19 RLS policies** on `storage.objects` live in the `storage` schema. Without
  them no user can read a company logo or upload a Fahrtenbuch.
- **42 grants** to `anon` / `authenticated` / `service_role` on
  `storage.buckets` and `storage.objects` are ACLs, which `--no-acl` drops.

The second one is worth knowing by heart, because storage-api reports it as

    {"statusCode":"403","message":"new row violates row-level security policy"}

while the database is actually saying

    ERROR: permission denied for table objects
    HINT: GRANT INSERT ON storage.objects TO service_role;

An hour went into the policies before the grants. `SET ROLE service_role;`
followed by the insert in `psql` gives the real error in one step.

The `public` schema needs no such fix: supabase/postgres carries default
privileges for those roles, so tables created there are granted automatically.

### A `^ERROR` grep on psql output reports success on a failed restore

psql prefixes every diagnostic with `file:line:` — `psql:/dump/data.sql:28:
ERROR: ...`. Anchoring the pattern to the start of the line matches nothing, and
a restore that dropped 13,959 rows of `fahrtenbuch_trips` reported clean. It was
caught by comparing row counts, not by reading the log.

**Compare counts on both sides.** Never take a quiet log as evidence.

```sql
SELECT table_name || '=' || (xpath('/row/c/text()', x))[1]::text
FROM (SELECT table_name,
             query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                          false, true, '') AS x
      FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE') t
ORDER BY table_name;
```

### GoTrue's schema is far behind production's, and it does not matter

Production's `auth` schema has 240 columns to our image's 144, and its last
migration is `20260625000000`. But `auth.users` is **identical on both sides —
35 columns, no difference**, and every table we lack is empty in production.
Only `users` and `identities` carry rows worth moving.

Sessions and refresh tokens were deliberately **not** moved: `JWT_SECRET` was
rotated, so every existing token is invalid regardless. Users sign in again with
the same passwords; the hashes come across in `auth.users`.

## Result

| | |
|---|---|
| tables | 51, matching production |
| RLS policies (public) | 193 |
| row counts | identical across all 51 tables |
| `auth.users` | 12 |
| storage buckets | 6 |
| storage objects | 9 of 61 — see below |

## Still outstanding

**52 files in the four private buckets** (`fahrtenbuch-files` 11,
`stundennachweise-pdfs` 40, `documents` 1). Downloading them needs the hosted
project's `service_role` key, which the public object endpoint does not require
and which we do not hold. `deploy/migrate-storage.py` takes it as
`PROD_SERVICE_KEY` and lists what it skipped rather than failing quietly.

The nine files in the public buckets — all the company logos and both document
templates — are across and serving.
