# Step 0, continued — what replaying the chain actually produced

Run on 2026-09-10 against the VPS stack, on an empty database. This is the
evidence [00-SCHEMA-RECOVERY.md](00-SCHEMA-RECOVERY.md) asks for, and it
changes that document's conclusion: the gap is wider than four missing tables.

---

## Result

**109 of 150 applied, 41 failed** on the first ordered pass. Bringing GoTrue up
first — see below — improved it to **113 applied, 37 failed**. It did not get
better than that, and the remainder are not ordering problems.

## The one failure that was ours, not the chain's

Five migrations failed on `function auth.jwt() does not exist`, and one on
`column "email_confirmed_at" of relation "users" does not exist`.

Those objects belong to the `auth` schema, which **GoTrue creates when it first
starts** — not the Postgres image. Applying the chain against a database where
only `db` is running means they do not exist yet.

So the load order is:

    db  →  auth (let it finish its own migrations)  →  application chain

Not a defect in the repository. Worth writing down because the error names a
missing function and says nothing about a service that has not started.

## The failures that are the chain's, and are not fixable by ordering

### `user_profiles` is the same problem as the four missing tables, disguised

`20250930122526_raspy_cliff.sql` creates it with seven columns:

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id, email, full_name,
    role, created_at, updated_at

Then the chain contradicts itself and the application:

- `20250930162316_stark_smoke.sql` and `20250930190300_shy_feather.sql` fail on
  `relation "user_profiles_id_seq" does not exist`. A sequence exists only if
  `id` is `serial`/`bigserial`. Production's `id` is therefore **not** the
  `uuid` this chain creates.
- Eight migrations fail on `operator does not exist: uuid = text` or its
  mirror. `created_by` is compared to an email in some and to a `uuid` in
  others.
- `company_id` and `is_super_admin` are read by fifteen later migrations and
  **added by none of them**. Nothing in the chain ever creates either column.

This is worth separating from the four tables in
[00-SCHEMA-RECOVERY.md](00-SCHEMA-RECOVERY.md), because it is harder to notice:
those tables have no `CREATE TABLE` at all, so replay stops immediately and
points at itself. `user_profiles` **is** created — just not with production's
columns — so replay continues for another 140 files and fails somewhere else
entirely, on `get_user_company_id() does not exist` and similar, none of which
name the actual cause.

The note in `Docs/RLS_FIX_EXPLANATION.md` that `user_profiles.id` is a `bigint`
is not obviously wrong after all. It disagrees with the chain; the chain
disagrees with itself; only production settles it.

### One defect that was genuinely fixable, and is fixed

`20250930160112_autumn_base.sql` dropped `on_auth_user_created` and then the
function it belongs to, while `20250930122526_raspy_cliff.sql` had actually
named that trigger `create_user_profile_trigger`. The drop failed on a
dependency and replay stopped at file 4 of 150. Fixed by also dropping the
name that exists — an idempotent statement, and a no-op against production.

The trigger on `auth.users` is renamed four times across the chain
(`create_user_profile_trigger` → `on_auth_user_created` →
`handle_new_user_trigger` → back), which is the shape of a schema edited live
in a dashboard rather than one built by migrations.

---

## What this means

**The chain cannot rebuild production, and no amount of repair to the chain
alone will establish that it has.** Every fix is a guess at what production
holds until it is checked against production.

So the order stands as
[00-SCHEMA-RECOVERY.md](00-SCHEMA-RECOVERY.md) has it, and the dump is not
optional:

1. `pg_dump --schema-only` from the hosted project — **blocking, and the only
   authoritative source**;
2. extend `00000000000000_baseline_schema.sql` from that dump, covering
   `user_profiles`'s real column set and types as well as the four tables it
   already carries;
3. re-run this replay until it is clean;
4. `node scripts/schema-diff.mjs schema-prod.sql schema-chain.sql` must exit
   clean before the chain is trusted for anything.

Until step 1, the VPS database is a half-built schema of no value, and the
application cannot run against it.

## Reproducing this

```bash
cd /srv/PRO/deploy
docker compose down && docker volume rm ya-mobility_db-data
docker compose up -d db auth          # auth must run before the chain
# wait for `db` to report healthy, then apply /srv/PRO/supabase/migrations
# in filename order with psql -v ON_ERROR_STOP=1, one file per invocation,
# recording each failure rather than stopping at the first.
```

Each file gets its own `psql` so one failure does not abort the rest — that is
what turns a single error message into the list above.
