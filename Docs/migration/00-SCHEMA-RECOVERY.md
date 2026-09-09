# Step 0 — make the schema reproducible

**Blocking.** Nothing else in the VPS move can start until this is done, on either
path (self-hosted stack or a rewritten backend). You cannot migrate a schema you
cannot rebuild.

---

## The problem

`supabase/migrations/` has 149 files, and four tables appear in them **only** as
`ALTER TABLE`:

| table | `.from()` calls in the app | RLS policies |
|---|---|---|
| `companies` | 28 | yes |
| `drivers` | 23 | yes |
| `receipts` | 8 | yes |
| `saved_stundennachweise` | 8 | added 2026-09-08 |

There is no `CREATE TABLE` for any of them anywhere in the chain. Run the chain
against an empty database and it fails on the first `ALTER TABLE companies`.

Somebody created these by hand in the Supabase dashboard early on. Everything
since has been layered on top of a foundation that was never committed.

---

## Why this cannot be reconstructed by reading the repo

The evidence in the repo is asymmetric.

**Recoverable exactly** — every column added by `ALTER TABLE ... ADD COLUMN`
carries its full definition. For `companies` that is 26 columns
(`trial_start`, `plan`, `approval_status`, `subscription_status`, …), for
`drivers` 27, for `receipts` 5, for `saved_stundennachweise` 16.

**Not recoverable** — the *original* columns. The app proves they exist, because
it selects them, but a `.select('id, name, slug, city')` says nothing about type,
nullability, default, or uniqueness.

That gap is not cosmetic. `receipts.income`, `receipts.expense` and
`receipts.balance` hold money. Rebuilding them as `float` instead of
`numeric(10,2)` produces rounding drift that reaches a Stundennachweis and then
the Steuerberater — the exact failure this project has been hardening against.
A guessed `CREATE TABLE` would look right and be wrong.

So the authoritative source is production itself, not this repository.

---

## Procedure

### 1. Dump the live schema

```bash
# Connection string from the Supabase dashboard → Project Settings → Database.
export PROD_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres'

pg_dump --schema-only --no-owner --no-acl --schema=public "$PROD_URL" \
  > schema-prod.sql
```

Schema only — no data, nothing sensitive beyond structure. Keep it out of git
(`*.sql` dumps are gitignored below).

### 2. Build a database from the chain alone

```bash
createdb chain_check
for f in supabase/migrations/*.sql; do
  echo "-- $f"
  psql -v ON_ERROR_STOP=1 -q chain_check -f "$f" || break
done
```

It will fail. **The first failure is the answer to "what is missing".** Note the
table, then continue past it to collect the rest.

### 3. Compare

```bash
pg_dump --schema-only --no-owner --no-acl --schema=public chain_check \
  > schema-chain.sql

node scripts/schema-diff.mjs schema-prod.sql schema-chain.sql
```

The script reports missing tables with their full column definitions, column
drift on tables both sides have, and missing constraints and indexes.

### 4. Write the baseline migration

Take the `CREATE TABLE` blocks the diff prints for the four missing tables and
commit them as `supabase/migrations/00000000000000_baseline_schema.sql` —
timestamped to sort **first**, so the existing chain layers on top as it always
expected to.

Guard every statement so the migration is a no-op against the existing
production database:

```sql
CREATE TABLE IF NOT EXISTS public.companies ( ... );
```

The columns that later `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements add
must **not** be in the baseline — let the chain add them, so ordering stays
truthful.

### 5. Prove it

Repeat steps 2–3. `schema-diff.mjs` must exit clean. That is the definition of
done for Step 0.

---

## Things the code already proves — verify these appear in the dump

These are load-bearing and worth checking explicitly, because losing one during
the move would be silent:

- **`saved_stundennachweise` has `UNIQUE (company_id, driver_id, month, year)`.**
  Proven by `MonatsplanungStundennachweisPreview.tsx:1716`:
  `.upsert(rows, { onConflict: 'company_id,driver_id,month,year' })`. Without the
  constraint that upsert silently becomes an insert and duplicates statutory
  records.
- **`companies.slug` is expected unique.** `company-signup/index.ts` looks up an
  existing slug and appends a random suffix before inserting.
- **`company_settings` has `UNIQUE (company_id)`** — added by
  `20260627142447`, and `CompanySettingsContext.updateSettings` upserts on it.
- **`drivers.id`, `companies.id`, `receipts.id` are `uuid`.** Proven by the
  inbound foreign keys (`assigned_driver_id uuid REFERENCES drivers(id)`, etc.).
- **Money columns must be `numeric`, never float.** `receipts.income/expense/
  balance`, `salaries.*`, `income.amount`, `drivers.planning_min_salary` and
  `planning_max_salary` (the latter two are `numeric(10,2)` in the chain, so the
  originals almost certainly match).
- **`fahrtenbuch_trips` immutability trigger and audit RPC exist** — these are in
  the chain and must survive; see `20260605082340` and `20260605082427`.

---

## After Step 0

The chain becomes the single source of truth for the schema, which means:

- a VPS database can be built from scratch and verified;
- staging can be recreated at will, so the five unapplied security migrations
  can finally be tested;
- the root-level ad-hoc `*.sql` fix scripts can be deleted, since anything they
  did is either already in the chain or shows up as drift in the diff.

Run `node scripts/schema-diff.mjs` again after any schema change. It is cheap and
it is the only thing that keeps the chain honest.
