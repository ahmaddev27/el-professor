# The plan system

**Status:** design only. No migration, no production code, no schema change. Written
26.10.2026 against `staging` = `main` = `62c3139`.

**Companion documents.** This is the third of three that overlap and must stay
consistent: [`billing-system.md`](billing-system.md) (the money path, invoices, VAT,
dunning) and [`per-company-modules.md`](per-company-modules.md) (the per-company
subtraction). Where this document reverses a conclusion in one of them, §13 says so by
name. Read §12 before starting any slice: three of the questions are the owner's and
one of them blocks slice 3.

---

## 0. How this was measured, and the three things the brief got wrong

Every figure below was read on **production** (`ya-mobility-db-1`, `SELECT` only,
26.10.2026) or from the file named at the line named. Nothing is inferred from a
comment, because this repository's comments have been wrong about exactly this area
before: `DriversManagement.tsx:57-59` describes the driver cap as unenforced while the
trigger enforcing it is live.

The brief I was given was right about the shape of the problem and wrong about three
mechanisms. Each correction changes a decision, so they come first.

### 0.1 `drivers_per_car_limit` on `subscription_plans` feeds nothing

The brief says `subscription_plans.drivers_per_car_limit` "feeds `enforce_driver_limit`".
It does not. The live trigger body, read from the catalogue on production:

```sql
SELECT subscription_car_limit INTO car_limit
FROM companies
WHERE id = NEW.company_id;
...
SELECT COALESCE(drivers_per_car_limit, 4) INTO dpc_limit
FROM company_settings                      -- <= company_settings, not subscription_plans
WHERE company_id = NEW.company_id;

driver_limit := car_limit * dpc_limit;
```

So the live driver cap is `companies.subscription_car_limit × company_settings.drivers_per_car_limit`
— a column each company sets for itself in Einstellungen (`SettingsPage.tsx:81,124`).
`subscription_plans.drivers_per_car_limit` is read by three screens and written by one
(`PlanManagementModal.tsx:66`), and by nothing else in the database.

**Consequence:** dropping that column takes no enforcement with it, and removing the
trigger is a separate decision from removing the column. They were coupled in the brief
and they are not coupled in the code.

### 0.2 `included_cars` is load-bearing, through one RPC

The brief's table says system B is read by nothing. For *pricing* that is right. For the
car cap it is wrong. The catalogue sweep for functions whose body names
`subscription_plans` returns exactly three:

```
app_private.platform_invoices_list_statement()
app_private.platform_subscriptions_list_statement()
public.platform_subscription_assign(p_company_id uuid, p_plan_id uuid, p_billing_day integer, p_notes text)
```

The first two are display-only read models. The third copies the plan's `included_cars`
into `companies.subscription_car_limit`
(`20260916130000_platform_write_rpcs.sql:803`), and that column is what both limit
triggers compare against — and also what prices every invoice (§0.3). So the live chain
is:

```
subscription_plans.included_cars
  --(platform_subscription_assign)-->  companies.subscription_car_limit
        --> enforce_car_limit        (refuses a car)
        --> enforce_driver_limit     (x company_settings.drivers_per_car_limit)
        --> invoice_amount_cents     (the billed car count)
```

`included_cars` therefore survives only as long as `subscription_car_limit` has
consumers, and §8 and §9 are about retiring them.

### 0.3 The billed car count is a stored number, not the fleet

This is the fact the overage requirement turns on, and the brief does not mention it.
`platform_invoice_quotes(month, year)` prices from
`20261015160000_first_month_price.sql:443-444`:

```sql
SELECT s.id AS subscription_id, s.company_id, c.name AS company_name,
       c.plan, c.subscription_car_limit AS car_limit, c.billing_cycle,
       ...
  FROM public.company_subscriptions s
  JOIN public.companies c ON c.id = s.company_id
 WHERE s.status = 'active'
```

The amount comes from `companies.plan` and `companies.subscription_car_limit`. It never
counts `public.cars`. Measured, the two diverge in both directions across the whole
estate:

| company (prefix) | plan | subscription_status | `subscription_car_limit` | active cars | active drivers | `dpc` |
|---|---|---|---|---|---|---|
| `7ecf378f` | premium | active | 5 | **5** | 8 | 4 |
| `cfdae5f5` | premium | expired | 5 | 4 | 7 | 4 |
| `bc7e0e4d` | premium | active | 5 | 4 | 14 | 4 |
| `c143d611` | premium | active | **3** | **3** | 10 | 5 |
| `ca8ea020` | advanced | active | 10 | 2 | 1 | 4 |
| `68f288da` | premium | inactive | 8 | 0 | 0 | 4 |
| 12 others | — | — | 1–5 | 0 | 0–3 | 4 |

Two things to take from that table. **Two companies sit exactly at their car limit**
(`7ecf378f` at 5 of 5, `c143d611` at 3 of 3): the next `INSERT INTO cars` raises `P0001`
today, on production. And one company is billed for 10 cars while running 2. The
billed figure is not a measurement of anything; it is a number somebody typed.

### 0.4 One more correction, to my own brief: the SQL parity `DO` block is not where the brief says

The brief locates the 42-combination SQL comparison in
`20260911120000_redeem_discount_code_rpc.sql`. That file contains no `DO` block at all.
The comparison is `20260916150000_platform_settings_price_book.sql:815-860`, and it
compares `compute_plan_price()` against a **verbatim inlined copy** of 20260911120000's
body, not against a literal expectation table. That distinction decides §6.2: because
the comparison lives in an applied migration and migrations run once
(`app_meta.schema_migrations`), it is **not a live gate on this change** and must be
reproduced rather than inherited.

---

## 1. What production says today

### 1.1 System A — two settings keys

`app_private.platform_settings` holds 13 keys. Two of them are this document's subject;
both read on production:

```json
// price_book, version 2
{
  "first_month_cents": 20000,
  "price_per_car_cents": { "basic": 2000, "premium": 7000, "advanced": 4000 },
  "fleet_discount_tiers": [ { "percent": 5, "min_cars": 6 }, { "percent": 10, "min_cars": 11 } ],
  "yearly_discount_percent": 10
}

// plan_features, version 1 — 16 keys
{ "overview":"basic", "belege":"basic", "fahrer":"basic", "fahrzeuge":"basic",
  "umsaetze":"basic", "fixkosten":"basic", "bargeldbestand":"basic",
  "werkstatt":"advanced", "abrechnung":"advanced", "notizen":"advanced",
  "rollen_nutzer":"advanced", "benachrichtigungen":"advanced",
  "gehaelter":"premium", "dokumente":"premium",
  "trinkgeld_quittung":"premium", "stundennachweis":"premium" }
```

This is what prices everything: `app_private.price_book_price(book, plan, cars, cycle, first)`
(`20261015160000:280-325`) and `calcPricing(book, plan, cars, cycle, first)`
(`src/utils/pricing.ts:104`). 18 companies are attached to it through
`companies.plan`, a `text NOT NULL DEFAULT 'basic'` column with **no CHECK constraint**
(measured — the catalogue sweep for constraints on `companies` whose definition names
`plan` returns zero rows):

| `companies.plan` | `subscription_status` | count |
|---|---|---|
| advanced | active | 5 |
| advanced | inactive | 1 |
| basic | active | 3 |
| premium | active | 5 |
| premium | expired | 2 |
| premium | inactive | 2 |

Exactly three distinct values, all three seeded. That matters for §4.3.

### 1.2 System B — one row

```
id                                    name     monthly_price  included_cars  dpc  is_active  features_json
02fd219f-8c35-46a1-8134-a8b6de4df65c  Premium  200            5              4    t          {}
```

One row, created 2026-06-07, `features_json` empty. One company holds a
`company_subscriptions` row pointing at it. `PlanManagementModal.tsx` writes this table
with a per-row `INSERT`/`UPDATE` straight from the browser (`:72,76`). Its RLS, read
from `pg_policies`:

```
subscription_plans_select | SELECT | {authenticated} | USING (true)
subscription_plans_insert | INSERT | {authenticated} | WITH CHECK (platform_can('pricing.manage'))
subscription_plans_update | UPDATE | {authenticated} | USING + WITH CHECK platform_can('pricing.manage')
subscription_plans_delete | DELETE | {authenticated} | USING (platform_can('pricing.manage'))
```

`matrix.sql:1524` already names the shape correctly: **"no tenant: a platform
catalogue"**, with SELECT open to every signed-in principal
(`matrix.sql:2161` reads `'..'` for anon and `YY` for all six others) and writes to
`pricing.manage` alone. That is the right shape for a price list, and §3 keeps it.

*(The `anon` row in `information_schema.role_table_grants` shows
`DELETE,INSERT,…,TRUNCATE,UPDATE` on this table — but it shows the identical set on
`cars`, `drivers`, `companies`, `income` and `company_modules`, so it is the Supabase
default grant on every table and not a finding about this one. RLS has no policy
`TO anon`, and PostgREST exposes no TRUNCATE verb.)*

### 1.3 The gap, stated exactly

A screen edits `monthly_price`; nothing prices from it. `billing-system.md:84` already
reached this and wrote `subscription_plans` off as "vestigial except as a foreign-key
target". **This document reverses that direction**, because the owner has chosen the
table. §13 reconciles the two.

---

## 2. What the owner decided, and what that forbids

| decision | his words | consequence |
|---|---|---|
| unify on the **table**, keeping system A's role | "بدي اقدر في الادمن ادير الخطط واسعارها والفيتشر بشكل مستقل ومنظم ويأثر على الاشتراكات" | one row per plan carries name, price and features, and prices a subscription |
| `price = cars × price_per_car` | "فش ارضيات، التسعير على الخطط التزم فيه" | **no floor, no minimum.** A 200 € floor was considered and rejected |
| prices stay 20 / 40 / 70 € per car | — | the consolidation must be **arithmetically neutral**; §6 turns this into the gate |
| no caps, cars or drivers | — | both limit triggers come out (§8) |
| plans gate price **and** features | — | the dual role is deliberate and stays |
| import is never refused; overage goes on the invoice and he confirms it | — | §9 |
| unpaid: UI blocked, background keeps running | "بيضلّ شغّال، بيسحب الداتا، بيعمل كل شي — بس ما بيبعت إيميلات" | §10 |

"Prices stay 20/40/70" is the strongest constraint in the list, and it is a gift: it
means the whole move can be made **provably price-neutral**, and §6.1 shows the 42
existing expected numbers staying byte-identical is the proof.

---

## 3. The target data model

### 3.1 `public.plans` — a new table, not a reshape of `subscription_plans`

```sql
CREATE TABLE public.plans (
  slug                 text        PRIMARY KEY
                                   CHECK (slug ~ '^[a-z][a-z0-9_]{0,31}$'),
  name                 text        NOT NULL CHECK (btrim(name) <> ''),
  rank                 smallint    NOT NULL UNIQUE CHECK (rank >= 0),
  price_per_car_cents  integer     NOT NULL CHECK (price_per_car_cents BETWEEN 0 AND 1000000),
  features             text[]      NOT NULL DEFAULT '{}',
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
```

Seven decisions in that block, each with the thing that would break if it changed.

**`slug text` is the identity, not a uuid.** Argued in full at §4.3.

**`rank smallint NOT NULL UNIQUE`.** The order `basic < advanced < premium` is currently
hard-coded as `PLAN_RANK` (`src/utils/planFeatures.ts:12`) and is load-bearing twice:
`planHasFeature` compares ranks, and `LockedFeaturePage` prints the minimum plan a
feature needs. If plans become editable rows, **the order has to become data** or the
build keeps a private opinion about rows it did not write. `UNIQUE` because two plans at
one rank makes "the minimum plan for this feature" ambiguous.

**`price_per_car_cents integer`, never `numeric` euros.** `subscription_plans.monthly_price`
is `numeric` in euros and is the reason `planPriceInput.ts` exists — a free-text euro
field that `parseFloat(text.replace(',','.'))` turned `'1.200,00'` into `1.2`
(`planPriceInput.ts:10-19`). Money is integer cents everywhere else in this codebase
(`src/utils/money.ts`), the price book is already cents, and
`billing-system.md:146` ("The amount is a float where everything else in this codebase
is cents") is a finding this table must not reproduce. The panel's input keeps
`parsePlanPriceInput`'s refusal semantics and multiplies by 100 once, at the edge.

**`features text[]`, the plan's own set.** Not `jsonb`: a `text[]` has a natural
`@>`/`<@` for the superset test §5 needs, sorts, and cannot hold a non-string. Not the
inverse map, because the inverse map is what the owner is asking to stop maintaining.

**No `included_cars`, no `drivers_per_car_limit`.** Measured in §0.1 and §0.2: with no
caps and both triggers gone, neither has a consumer. Carrying them forward would carry
the abandoned model forward with them. §8 retires their last reader.

**No `monthly_price`.** A flat per-plan price and a per-car price are two pricing models,
and keeping a column for the one the owner rejected is how a system ends up with two
again.

**No per-plan `fleet_discount_tiers` or `yearly_discount_percent`.** §11, "what I would
not build".

### 3.2 Writes: one RPC, whole catalogue, no write policy at all

```sql
public.platform_plans_save(p_plans jsonb, p_expected_version integer)
  -- pricing.manage, SECURITY DEFINER, one transaction, one audit row
```

The table carries **SELECT only** — no INSERT, UPDATE or DELETE policy and no write
grant. That is `company_modules`' shape and its reasoning transfers verbatim
(`20261025120000:51-57`): "A move between companies is refused for having no UPDATE
policy rather than by a WITH CHECK clause a later migration could restate away."

Here the reason is sharper, and it is **the single most important structural decision in
this document**:

> **The invariants in §5 are cross-row. A per-row write cannot enforce them.**

`PlanManagementModal` today does `supabase.from('subscription_plans').update(payload).eq('id', editId)`
— one row at a time. Under such a write, "the top active plan grants every known
feature" and "a higher plan's features are a superset of a lower plan's" are both
unenforceable, because each individual `UPDATE` is validated against a set that is
momentarily inconsistent. A `CHECK` constraint cannot see other rows either. So the
whole catalogue arrives as one payload, is validated as a set, and is replaced
atomically, with `p_expected_version` giving the same optimistic concurrency
`platform_settings_put` already has.

**The known cost, named rather than discovered.** A wholesale replace has exactly the
failure mode `company_role_save` has and CLAUDE.md records: a plan the build does not
know is dropped the first time anyone edits the catalogue, with a success toast. Two
things contain it here, and both are deliberate:

1. The payload is built from **what the RPC returned**, not from a client-side registry.
   `company_role_save`'s loss comes from rebuilding the payload out of
   `PAGE_DEFINITIONS`; the plan editor round-trips the rows it was given.
2. `features` entries the build does not know are **preserved, not dropped** — the
   validator tolerates unknown keys exactly as `plan_features` does today
   (`20260917120000:57-60`: "Extra keys stay valid: a database that already names a
   feature a future release will gate is how a key gets seeded before the release that
   reads it"). That workflow is load-bearing for every future gated screen and must not
   be lost in the move.

### 3.3 Reading

`app_private.plan_catalogue()` returns the active catalogue as `jsonb`, and is the one
place the rows become a value. `price_book_price` and `invoice_amount_cents` take that
value where they take `p_book -> 'price_per_car_cents'` today — **their signatures do
not change** (§6.4 explains why that matters more than it looks).

For the browser, `get_public_config()` gains the catalogue. This is not optional: the
landing page and the signup screen price plans **before anyone is signed in**
(`LandingPage.tsx:524,627`, `signup/PlanSelection.tsx:36,274`), and
`subscription_plans_select` is `TO authenticated`, so anon has never read that table and
must not start. The RPC is the door, as it is for `price_book` today, and the anon
surface is unchanged.

---

## 4. `price_book`, `plan_features` and `companies.plan`

### 4.1 `price_book` survives, minus exactly one key

`price_book` holds four things, and only one of them is per-plan:

| key | per-plan? | fate |
|---|---|---|
| `price_per_car_cents` | **yes** | moves to `plans.price_per_car_cents` |
| `fleet_discount_tiers` | no | **stays in the book** |
| `yearly_discount_percent` | no | **stays in the book** |
| `first_month_cents` | no | **stays in the book** |

So `price_book` is not deleted. It loses one key and keeps its row, its version, its
validator branch, its audit trail, its `settings.read`-for-billing special case
(`pricing.manage` to write, and billing holds `settings.read` for this key alone), and
its place in `get_public_config()`. That is a far smaller and far more reversible change
than removing the key, and it is the main reason the slice plan can make slice 1
provably neutral.

`platform_settings_problem` must be restated — the only way a key's validation may
change (`20261015160000:102`, `20260920130000`) — to make `price_per_car_cents`
**optional** in slice 1 and **forbidden** in slice 3, carrying every other branch
character for character and adding a self-check that re-states what each old branch
refuses. Both migrations that have done this before are the template.

### 4.2 `plan_features` is retired, in two steps, and the key is left behind

The map is replaced by `plans.features`. But the key is **not deleted from the table**:
slice 3 stops reading it and makes writes to it return `unknown_key`; the row stays,
unread, with its version and its history. Three reasons:

1. A rollback across slice 3 lands on a release that reads `plan_features`, and finding
   the row there is the difference between a rollback and an outage. (`price_book` and
   its `trial` sibling have the same property, and `deploy.sh`'s rollback refuses to
   cross a `SCHEMA_EPOCH` bump — §11.3 bumps it for exactly this slice, so the rollback
   is refused rather than silent. The row staying is the second wall.)
2. `app_private.platform_settings_problem`'s `plan_features` branch and
   `plan_features_missing_keys()` are the thing §5 is modelled on. Deleting them in the
   same slice that replaces them removes the reference implementation while the
   replacement is one release old.
3. The audit trail of who changed the feature map and when is in
   `platform_audit_log` keyed on the action; the setting row is what makes those rows
   legible.

`SEED_PLAN_FEATURES` in `src/lib/appConfigSeed.ts` becomes `SEED_PLANS`, and `appConfigSeed.test.ts`'s
`plan_features` assertion is re-pointed, not deleted — §6.3.

### 4.3 `companies.plan` stays `text`, and gains a foreign key

**Decision: text, with `REFERENCES public.plans(slug)`.** Both halves are deliberate.

**Why not a uuid `plan_id`.** The brief says "a foreign key is cleaner and a text column
is what 18 companies and every policy already use." The second half understates it. The
slug is not just stored in `companies.plan`; it is the *type* of a plan throughout the
system:

- `subscription_coverage.plan` is `text`, 15 production rows, and
  `app_private.recompute_company_subscription` **derives** `companies.plan` from the
  coverage period that grants access. A uuid would need a second FK on a table whose
  rows were all written by a migration, one of them `void`.
- `compute_plan_price(text, integer, text, boolean)` takes the plan as text and is
  `SECURITY DEFINER` with grants asserted by `regprocedure` cast in
  `tests/rls/pricing.sql:190` and `assertions.sql:519`, and called by **string literal**
  in `matrix.sql:3478,3484` (`compute_plan_price('basic', 5, 'monthly')`). A signature
  change breaks those casts with a hard error.
- `price_book_price` resolves the price as `p_book -> 'price_per_car_cents' ->> p_plan`
  and falls back to `'basic'` for an unknown plan — a documented behaviour with its own
  edge-case assertions.
- `Plan = 'basic' | 'advanced' | 'premium'` is a TypeScript union with an **order**
  (`PLAN_RANK`). A uuid has no order, so the union would become `string` and every
  exhaustive check over plans would silently stop being exhaustive — including
  `SEED_PRICE_BOOK`'s `Readonly<Record<Plan, number>>`, which is what makes a missing
  seed a compile error today.

The cost of staying text is that a slug cannot be renamed without rewriting history, and
a display name is therefore a separate column — which is exactly what `plans.name` is
for. That is a feature: the owner can rename "Premium" to anything without touching
18 company rows, 15 coverage rows and two SQL functions.

**Why add the FK.** Measured: `companies.plan` has **no CHECK constraint**, so
`platform_company_set_plan` can write any text and nothing objects; the three live
values happen to be right. The FK buys two things a text column lacks — a typo is
refused at write time, and a plan cannot be deleted while a company names it (`NO ACTION`,
the default; nothing should cascade). It costs nothing to add because all three existing
values match the three seeded slugs.

**Not in the first slice: `subscription_coverage.plan`.** It holds rows a migration
wrote, including a `void` one, and its values are not guaranteed to be in the active
catalogue — a company downgraded after a period was recorded would have a coverage row
naming a plan that is now `is_active = false`, which is legitimate history. An FK there
needs its own look; `is_active = false` rows remain FK-valid, so it is probably safe, but
"probably" is not a reason to put it in the slice that must be provably neutral.

---

## 5. The fail-closed feature rule — the dangerous part

The brief is right that this is the single most dangerous part of the change. Here is
what the property actually is today, in both halves, and what replaces each.

### 5.1 What exists, measured

**Write side.** `app_private.plan_features_missing_keys(p_value)`
(`20260917120000:140-155`) compares the stored map's keys against
`app_private.plan_feature_keys()` — the 16 `FeatureKey`s — and
`platform_settings_problem` returns `plan_features.missing.<first missing key>`. So
`platform_settings_put` **refuses to store an incomplete map**, and
`platform_settings_put`'s answer also carries `missing_features` so the screen can name
all of them.

**Read side.** `minPlanForFeature` (`src/utils/planFeatures.ts:19-22`):

```ts
export function minPlanForFeature(map: PlanFeatureMap, feature: FeatureKey): Plan {
  const plan: unknown = Object.prototype.hasOwnProperty.call(map, feature) ? map[feature] : undefined;
  return isPlan(plan) ? plan : 'premium';
}
```

A feature the map does not name needs **premium**. And `parsePlanFeatures` returns
`null` for a malformed map, which makes the caller keep the map already on screen rather
than fall back to the seed.

Two walls, and the brief's warning is exact: lose them and **one bad save locks every
gated screen for every customer** below premium.

### 5.2 What the row model has to reproduce, and why one invariant is not enough

The current map is a *total function* `feature → minimum plan`, and the completeness
check is what makes it total. In a row model the data is `plan → set of features`, and
"minimum plan for feature F" becomes derived:

```
minPlanFor(F) = min { rank(p) : p active, F ∈ p.features }      -- premium/locked when the set is empty
```

A naive port would check only completeness ("the union over active plans names every
known key") and would admit this catalogue:

| plan | rank | features |
|---|---|---|
| basic | 0 | …, `gehaelter` |
| advanced | 1 | … |
| premium | 2 | … |

Union is complete, every known key is named, the validator is happy — and `gehaelter`
is now available on basic and **not** on premium, because `features` is an explicit set
and premium does not name it. Today that configuration is unrepresentable: a map saying
`"gehaelter": "basic"` grants it to every plan at rank ≥ 0 automatically. The rank
model's implicit inheritance is a property of the *shape*, and moving to explicit sets
loses it silently.

So the row model needs **two** invariants, and they are only meaningful together:

> **I1 — monotonicity.** For every pair of active plans `p`, `q` with `rank(p) < rank(q)`:
> `p.features ⊆ q.features`. In SQL, `q.features @> p.features`.
>
> **I2 — completeness.** The union of `features` over active plans contains every key in
> `app_private.plan_feature_keys()`.

**I1 and I2 together are exactly `plan_features_missing_keys()` in the row model**, and
the proof is short: under I1 the union equals the top active plan's set, so I2 says the
top active plan grants every known feature — which is what "the map names every key"
guarantees today, since a named key is granted at its own rank and above. Under I1 the
derived `minPlanFor` is also well defined for every granted feature, because the set of
plans granting F is upward-closed, so its minimum is its unique lower boundary.

Neither invariant alone is sufficient, and that is the thing to state in the migration
header so a later slice does not "simplify" one away: I2 alone admits the table above;
I1 alone admits an empty catalogue.

### 5.3 The read wall is unchanged, and must stay unchanged

`minPlanForFeature` keeps answering `premium` — strictly, **the highest rank in the
catalogue, falling back to locked when the catalogue is unreadable** — for a feature no
active plan grants. The fallback matters: once plans are rows, "premium" is no longer a
guaranteed name. The reader becomes

```ts
minPlanFor(F): Plan | 'locked'    // 'locked' when no active plan grants F
```

and `can()` is false for `'locked'`. `LockedFeaturePage` already prints a minimum plan
and now has to print "not available on any plan", which is the honest message and one
the current shape cannot express.

**Keep `parsePlanCatalogue` fail-open on an unreadable answer**, as `parsePriceBook` and
`parsePlanFeatures` are: the caller keeps the catalogue already on screen. The browser is
not the boundary — `current_role_permits` and the policies are — and a restrictive
placeholder would flash a locked screen over every page load.
`per-company-modules.md` and `companyModules.ts:19-27` argue this at length and the
reasoning transfers; §11 says why the *module* rule must not be copied here in the other
direction.

### 5.4 Where the invariants are checked

In **one** function, `app_private.plan_catalogue_problem(p_plans jsonb)`, returning a
stable problem code or NULL, mirroring `platform_settings_problem`'s contract:
`plans.rank.duplicate`, `plans.monotonicity.<low>.<high>.<first missing key>`,
`plans.missing.<first missing key>`, `plans.slug`, `plans.price`. Called by
`platform_plans_save` before it writes, and by the migration's own self-check against
the seed, so a release whose seed violates its own validator fails at deploy time —
`20260917120000`'s self-check 4 is the precedent and it is worth copying literally.

**No trigger.** A row trigger cannot see the set, and a statement trigger that re-reads
the table would fire on the RPC's own intermediate states. The RPC is the only writer;
that is what makes a single check sufficient.

---

## 6. How the four parity gates survive

Three survive with their numbers **byte-identical**, which is the proof of neutrality.
One goes quiet unless it is re-pointed, and that is the real work.

### 6.1 Gate 1 — `src/utils/pricing.parity.test.ts`

Measured: four `describe` blocks, not one. The 42 numbers are a hard-coded literal
`EXPECTED` at `:43-67`, keyed `"<plan>|<cars>|<cycle>"` over
`PLANS × CARS=[1,3,5,6,10,11,25] × CYCLES`, each asserted as
`calcPricing(SEED_PRICE_BOOK, plan, cars, cycle).finalTotal`. It also pins the alien book
(`:90-121`), the first invoice (`:123-177`) and `invoiceAmountCents` (`:179-212`),
including a 168-assertion cross-check that
`invoiceAmountCents(...) === Math.round(calcPricing(...).monthlyEquivalent * 100)`.

**How it survives:** `calcPricing` keeps taking one value object as its first argument;
that object becomes

```ts
export interface PriceModel {
  readonly plans: PlanCatalogue;               // was price_per_car_cents
  readonly fleet_discount_tiers: readonly FleetDiscountTier[];
  readonly yearly_discount_percent: number;
  readonly first_month_cents?: number;
}
```

`SEED_PRICE_BOOK` becomes `SEED_PRICE_MODEL`, and **all 42 `EXPECTED` literals stay
exactly as they are**, because 20/40/70 stay. The diff on this file is the import name,
the seed name and nothing else. If a single one of the 42 moves, the slice is wrong —
that is the gate, and it is the strongest one available.

The 168-assertion cross-check is the part to watch: it couples `calcPricing` and
`invoiceAmountCents`, so the two must take the catalogue from the same place. §6.5 is
about the one place they disagree today.

### 6.2 Gate 2 — the SQL `DO` block

Measured (§0.4): it is `20260916150000:815-860`, it compares `compute_plan_price` with an
inlined verbatim copy of the old body, and the comparison is **value and text**
(`old_price::text IS DISTINCT FROM new_price::text`), so numeric *scale* is pinned too.

**It is not a gate on this change.** It lives in an applied migration, and
`app_meta.schema_migrations` means each file runs once; `deploy.sh` will never re-run it.
What *is* a live gate is the same idea in the newest pricing migration,
`20261015160000:661-739`, which prices a **literal** book and asserts absolute figures
(20 / 350 / 1231.2 / 396 / 17010, the flat 317 on an alien book, a 160-row relationship
loop over the stored book, and the invoice-cents table 20000/20000/35000/31500/10260).

**How it survives:** the new migration carries the same shape — a self-check that prices
a **literal catalogue** and asserts the same absolute numbers. Reproduced, not
inherited. And one assertion the old block has that the new one must keep: compare
**text as well as value**, or a change from `numeric` to a different scale passes
unnoticed.

### 6.3 Gate 3 — `src/lib/appConfigSeed.test.ts`. This is the one that needs work.

Measured mechanism: it reads migration files **by literal filename** and extracts
dollar-quoted JSON with `new RegExp('\\$' + tag + '\\$([\\s\\S]*?)\\$' + tag + '\\$')`:

- `:38-43` — `SEED_PRICE_BOOK` minus `first_month_cents` must equal
  `$seed_price_book$` in `20260916150000`.
- `:45-50` — `first_month_cents` from a *different* regex against
  `20261015160000:264`.
- `:52-54` — `SEED_PLAN_FEATURES` must equal `$seed_plan_features$` in `20260916150000`.

**The hazard: this gate does not break, it goes vacuous.** Seed the new catalogue in a
new migration and every assertion above still passes — it is still comparing a
TypeScript constant with an old migration's text — while measuring a seed that nothing
reads any more. A gate that passes while measuring nothing is worse than a deleted one,
because the next person reads green and infers coverage.

**How it survives:** in the same slice that seeds `public.plans`, the test is
**re-pointed**: a `$seed_plans$` block in the new migration, compared against
`SEED_PLANS`, with the `plan_features` assertion deleted and a comment naming the slice
that replaced it. The `price_book` assertion stays and narrows to the three keys the
book still carries.

`src/utils/planFeatures.test.ts:136-175` uses a related but different trick worth noting
because it is more robust: it does **not** name a migration file, it globs
`supabase/migrations/`, takes the **newest** file matching
`/FUNCTION app_private\.plan_feature_keys\(\)[\s\S]*?RETURN ARRAY\[([\s\S]*?)\];/`, and
compares. That is the pattern the new catalogue test should copy for the feature-key
list, because it cannot go stale. `src/utils/rolePageKeys.test.ts` uses the same trick
for `role_page_keys()` and is **unaffected** by this change.

### 6.4 Gate 4 — `tests/rls/pricing.sql`'s alien book

Measured mechanism, and it is the inverse of what the brief implies: `tests/rls/pricing.sql`
is the **single document of record**, and the TypeScript test reads it.
`:504-543` holds two dollar-quoted literals — `$alien_book$` (prices 1250/3300/9900,
tiers at 2/4/9, yearly 20, `first_month_cents` 31700) and `$alien_expected$` (42
numbers) — in a temp table. SQL loops them twice: once against
`app_private.price_book_price` with the book as a *value* (`:564-573`), and once against
`public.compute_plan_price` after **installing** the alien book through the real
`platform_settings_put` (`:576-589`), with the failure message *"it is not reading the
price book"*. `pricing.parity.test.ts:93-101` extracts the same two blocks by regex over
that file path.

This is the only gate that catches a formula ignoring its input, and the brief is right
to single it out.

**How it survives, and the trap:** keep the file, keep the path, and **keep the two tag
names `$alien_book$` and `$alien_expected$`**. The fixture's *shape* changes (an alien
catalogue instead of an alien `price_per_car_cents` object) and its *numbers* do not,
because the alien prices 1250/3300/9900 carry over. The trap, which the measurement made
explicit: `pricing.parity.test.ts:94` hard-codes `../../tests/rls/pricing.sql` and
`:96` fails with *"has no `$alien_book$` block"* — so renaming the tag, moving the file,
or replacing the temp-table insert with a `public.plans` insert breaks the **TypeScript**
test with a missing-fixture error rather than a price mismatch, in a different suite from
the one being edited. Both gates must be re-plumbed in one commit, and the alien fixture
must stay a dollar-quoted literal.

The second half of the install path matters too: `:576-578` installs the alien book
through `platform_settings_put`, version 2→3→4. Once the catalogue is rows, the
equivalent install is `platform_plans_save`, and the test must install through the **real
RPC**, not an `INSERT`, or it stops exercising the validator.

Also in that file and easy to miss: `:811-820` asserts that deleting the `price_book`
row makes `compute_plan_price` raise `P0002` — *"fail closed: no price book, no price"*.
The catalogue needs the same assertion: **an empty `public.plans` must raise, not return
zero.** A price of 0,00 € is a claim.

### 6.5 One divergence the four gates do not catch, and it collides with "no floor"

`app_private.price_book_price` floors the **billed** car count at 1 while looking the
tier up on the **unfloored** count (`20261015160000:293-294`):

```sql
v_tier_cars   integer := coalesce(p_car_limit, 1);
v_billed_cars integer := greatest(coalesce(p_car_limit, 1), 1);
```

`invoiceAmountCents` has the same floor (`src/utils/pricing.ts:168`, `Math.max(carLimit, 1)`).
**`calcPricing` does not** (`:108`, bare `carLimit`). No gate catches the difference,
because no TypeScript grid includes a car count below 1 — only
`tests/rls/pricing.sql:593-595` and `20260916150000:826-828` test 0, −3 and NULL, and
both are SQL-only.

This is not the floor the owner rejected. He rejected a **200 € minimum**; this is a
`greatest(cars, 1)` guard against a zero or NULL car count. Removing it would make a
0-car company's invoice 0,00 €, and measured, **twelve of eighteen companies have zero
active cars** — though `subscription_car_limit`, not the car count, is what prices them,
so none is at risk today. It is a real question with a real consequence and it is not
mine to answer: §12, question 4.

What the design *does* decide: whatever the answer, **the floor must be in one place**.
Today it is in SQL and in `invoiceAmountCents` and not in `calcPricing`, which is three
decisions pretending to be one. The catalogue slice moves it into
`app_private.price_model_price` and its TypeScript twin, and adds a car count of 0 to
both 42-combination grids so the next divergence is caught.

---

## 7. The panel screen

One screen, replacing `PlanManagementModal` (207 lines, legacy look, per-row writes,
inline styles). It lives in the `/admin` panel under `pricing.manage`, beside the
existing price-book editor in `PlatformSettingsPage`, because the fleet tiers, the
yearly discount and the first month stay in the book and an operator changing a price
should see all of it on one screen.

**Shape:** one card per plan, in `rank` order — display name, price per car, and the 16
feature keys as checkboxes grouped by the plan they are at today. Reorder by rank,
activate/deactivate, add a plan. One "Save" for the whole catalogue, which is what the
RPC takes.

Four things the screen must do that today's does not:

- **Show the derived minimum per feature**, next to the checkbox grid, computed in the
  browser by the same function the gate uses. The operator's question is "who gets
  Gehälter", and the answer is derived, not stored.
- **Enforce I1 in the UI as a convenience and never as the wall.** Ticking a feature on
  `advanced` ticks it on every higher plan, with that stated on screen. The RPC refuses
  the violation anyway; the UI exists so the operator never meets the refusal.
- **Name a refusal.** `platform_plans_save` returns a stable reason and a German
  sentence like every other platform RPC (`src/lib/platformRpc.ts` throws the sentence),
  and `plans.monotonicity.*` / `plans.missing.*` must each render as a sentence naming
  the plan and the feature. "Keine Berechtigung" for a validation failure is the
  `company_role_save` defect (CLAUDE.md: a caught `insufficient_privilege` reported as
  `not_authorized`) and must not be repeated.
- **Price preview.** The catalogue decides what 18 companies pay. The screen shows, for
  each plan, what the current estate would be billed before and after the change,
  computed from `platform_invoice_quotes`' own numbers. A price change with no preview is
  how a typo becomes an invoice.

Design-system rules apply (`src/components/ui`, zero inline styles, `NativeSelect` where
an `onChange` carries logic, `tabular-nums` on money) and the style ratchet will enforce
them. Both dictionaries get every new key.

---

## 8. The two limit triggers, and what the columns are for afterwards

Measured: `trg_enforce_car_limit` on `cars` and `trg_enforce_driver_limit` on `drivers`,
both `tgenabled = 'O'` — **enabled on production**, right now. Two companies cannot add
a car (§0.3). The owner decided both come out.

**The drop is one migration and it is genuinely small**, because nothing else reads the
triggers. What it changes:

- `cars` and `drivers` lose a `P0001` refusal. No screen depends on it succeeding; two
  screens display an allowance derived from the same numbers (`SuperAdminDashboard.tsx:1178`
  `driversAllowance(...)`, and the `DriversManagement.tsx:46` comment that already claims
  the cap is gone — a comment that becomes true).
- `companies.subscription_car_limit` keeps **one** consumer: the billed car count in
  `platform_invoice_quotes` / `invoice_amount_cents`. That is the right place for it, and
  §9 is about keeping it honest. It should be renamed in a later slice — it is not a
  limit any more, it is `billed_cars` — but renaming a column read by nine functions is
  its own slice and not this one.
- `company_settings.drivers_per_car_limit` loses its only consumer. The Einstellungen
  field goes, or stays as documentation of a number nobody enforces; the field is the
  owner's call and the column can stay either way.
- `subscription_plans.included_cars` and `.drivers_per_car_limit` lose theirs when
  `platform_subscription_assign` stops copying `included_cars`. §11.4 says why the whole
  table is then retired rather than trimmed.

**One thing not to do in this slice:** do not also drop
`companies.subscription_car_limit`. It prices every invoice. The triggers and the column
look like one feature and are two.

---

## 9. Cars beyond the plan at import time

The requirement: the import is **never refused**; the difference goes **onto the invoice**
and the owner confirms it.

### 9.1 Half of it is already delivered by §8

Nothing in the Fahrtenbuch import path looks at the car count. The import is a browser
write — `useFahrtenbuch.ts:399-417` inserts `fahrtenbuch_imports`, `:459-473` inserts
`fahrtenbuch_trips` in batches of 200 — and neither names `cars`. What refuses a car
today is `enforce_car_limit` on `cars`, and that is exactly the trigger §8 removes. So
"never refused" needs **no new code**; it needs the trigger gone.

### 9.2 The overage is derived at quote time, not recorded at import time

**Decision: measure the state, do not catch the event.** A car appears through at least
four paths — the panel, the Fahrzeuge screen, the partner fleet import
(`partner_vehicle_links`, `20261015110000`), and a support session — so an import-time
hook would miss three of them. One query at quote time catches all four and needs no new
table:

`platform_invoice_quotes(month, year)` gains three fields per company:

```
billed_cars    := companies.subscription_car_limit          -- what the amount was computed from
active_cars    := count(*) FROM cars WHERE company_id = ... AND status IS DISTINCT FROM 'inactive'
overage_cars   := greatest(active_cars - billed_cars, 0)
```

and a second amount, `amount_cents_at_active_cars`, priced from `active_cars` through the
**same** `invoice_amount_cents` — never a second formula. The panel shows both figures
and the difference; the operator confirms per company; confirming writes
`subscription_car_limit` and raises the invoice at the new count, in one transaction with
one audit row.

Three properties that make this safe, and each is a rule:

- **Nothing writes `subscription_car_limit` automatically.** It is the number that prices
  the invoice; an automatic write bills a customer with nobody confirming, which is the
  opposite of what the owner asked for.
- **The overage is never stored.** It is a difference between two live numbers. Storing
  it creates a third place a car count lives, and the estate already has two that
  disagree (§0.3).
- **The second amount comes from the same function.** `invoice_amount_cents(model, plan,
  cars, cycle, first)` takes the car count as an argument, so quoting at a different
  count is an argument change and not a second code path. A second code path here is how
  the two engines came apart in the first place.

### 9.3 What this deliberately leaves alone

A company billed for **more** cars than it runs (`ca8ea020`: 10 billed, 2 active) is
*overcharged*, and `overage_cars` is `greatest(..., 0)` so the quote says nothing about
it. Surfacing a downgrade suggestion is a commercial decision, not a defect, and it is
§12 question 5. The quote will carry `active_cars` and `billed_cars` both, so the
information is on the screen either way — the design just does not act on it.

---

## 10. Blocked at the UI, running in the background

This is the only genuinely architectural change in the document, and the measurement
turned out to make it much smaller than the brief feared.

### 10.1 RLS is not what blocks the background, and `get_active_company_id()` must not be touched

The brief's premise is that "every tenant table asks `get_active_company_id()`, so
nothing runs at all". That is true for **the customer's own requests** and false for the
background job, measured three ways:

1. The background Uber pull is `{"job":"uber_pull"}` on `notify-expiries`, whose bearer
   must *be* `SUPABASE_SERVICE_ROLE_KEY`, compared in constant time
   (`notify-expiries/index.ts:118-123`), and whose client is
   `createClient(url, serviceKey)` (`:130-137`).
2. **`service_role` bypasses RLS** — stated in the tree at
   `20260920120000_subscription_direct_write_wall.sql:46`, and corroborated by
   `refuse_read_only_context_write` returning immediately on a NULL `auth.uid()`
   (`20260917140000:683-686`), i.e. a no-op for the job.
3. What actually stops it is **two hand-written SQL predicates** inside the service-role
   RPCs: `public.uber_pull_candidates` (`20261015130000:313-317`) and
   `public.income_import_uber_system` (`:475-479`), both spelling

```sql
AND ( (c.subscription_status = 'active'
       AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > now()))
      OR (c.status = 'trial' AND c.trial_end IS NOT NULL AND c.trial_end > now()) )
```

(The `trial` branch is already dead: `20261015170000` removed `'trial'` from
`companies.status`' CHECK and patched `get_active_company_id()` to `status = 'active'`.)

**So the change is to relax two predicates, and `get_active_company_id()` is not touched
at all.** That is the whole architectural delta.

### 10.2 The precedent already exists, twice

- **`notification_candidates`** (`20261015170000:267-281`) is a background reader that
  re-states the state rules it wants in SQL and **deliberately carries no subscription
  term** — because "trial expired" is precisely a notification to a company whose access
  has lapsed. `20260924100000`'s self-check *fails a release* where it acquires one.
- **`company_modules`** (`20261025120000:143-150`) deliberately reads
  `get_user_company_id()`, the account-shell helper, with a self-check that fails the
  release if it ever reads `get_active_company_id()` (`:434-435`).

Both say the same thing: the second gate belongs in the function that wants it, named and
self-checked, not in a new helper that policies might read.

### 10.3 The split: one predicate, in `app_private`, never in a policy

```sql
app_private.company_is_collectible(p_company_id uuid) RETURNS boolean
  -- approval_status = 'approved' AND status = 'active'
  -- i.e. administratively permitted. The subscription is deliberately not read.
```

Replaces the two subscription terms in `uber_pull_candidates` and
`income_import_uber_system`. Three rules, and the third is the one that keeps it from
becoming a back door:

1. `app_private`, `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`, granted to
   nothing. Its two callers are `SECURITY DEFINER` and reach it as their owner. No API
   role can call it.
2. **It is a predicate for background functions and never a policy term.** A new
   `get_*_company_id()` helper would be the obvious shape and it is a trap:
   `tests/rls/platform-contexts.sql:929-933` derives the set of tables that must carry
   `refuse_read_only_context_write` **from the policy text matching
   `get_active_company_id`**, so a policy naming a new helper would silently escape that
   derivation and a tenant table would ship without its context trigger.
3. Therefore: a self-check that **fails the release if any policy expression names it**,
   catalogue-driven over `pg_policies`, the mirror of `company_modules`' self-check 3.

### 10.4 The precise path list

**Admitted while unpaid** — background only, `service_role` or `supabase_admin`, no
`auth.uid()`:

| path | door | writes |
|---|---|---|
| `{"job":"uber_pull"}` on `notify-expiries` | `uber_pull_candidates` → `uber_pull_claim` → `income_import_uber_system` | `public.income`, `public.uber_pull_runs` |
| TÜV / expiry notifications | `notification_candidates` — **already admitted**, no subscription term | `notification_deliveries` |
| `{"job":"abrechnung"}` | `abrechnung_schedule_candidates` → … | `abrechnung_deliveries` — **computation yes, delivery no**, §10.5 |
| audit purge, OTP housekeeping, invoice sweeps | `supabase_admin`, no API role | unaffected either way |

**Refused while unpaid** — unchanged, and deliberately so:

| path | what refuses it |
|---|---|
| every tenant table through PostgREST, for every signed-in user | `get_active_company_id()` → NULL |
| the five planning RPCs, the three Gehaltsquittung RPCs | same helper, inside the function |
| the Fahrtenbuch import | `fahrtenbuch_imports` INSERT policy (`20260917130000:427`) |
| **the interactive Uber pull button** (`uber-earnings-pull/index.ts:159-163`) | it calls `get_active_company_id()` itself and answers 403 |
| the browser | `SubscriptionGuard` → `/abo-aktivieren` (`App.tsx:142-159`) |

That last row is the line, and it is worth naming: **the customer may not pull; the
system may pull on their behalf.** The button stays refused.

### 10.5 Is the block then theatre? No — and here is the test

The brief asks me to work out where the line is, honestly. The test I apply: **does an
unpaid company gain anything it could use, or keep, by not paying?**

- It cannot **read** the collected rows. Every read of `public.income` asks
  `get_active_company_id()`, which answers NULL. The data accumulates in a vault the
  customer cannot open.
- It cannot **import**, **plan**, **export**, or **issue a document**. All refused above.
- It cannot **export the data by another door**: the Excel service only ever returns rows
  the browser sent it, and the browser cannot read them.
- What it gains is **continuity on payment** — the month is complete when they pay. That
  is the owner's stated reason and Uber's finite window is a real, non-recoverable
  constraint.

So it is not theatre: the block withholds every use of the system, and the background
withholds nothing from us. What the owner asked for in his own words — *"it stays
working, pulls the data, does everything — but doesn't send emails"* — resolves the
Abrechnung row above: admit the **computation**, suppress every **outbound message**.
That is literally what he said, and it is also the right line, because a mail is the one
background act a non-paying customer's *counterparties* (their drivers) would see.

**Two real problems the split creates, and neither is cosmetic.**

**(a) The switch becomes invisible while the data keeps arriving.** `uber_pull_schedules`'
policies ask `get_active_company_id()` (`20261015130000:217`), so an unpaid company's
administrator can neither see that the pull is on nor turn it off. We would be fetching a
customer's Uber data after they stopped paying, with no way for them to stop it. That is a
data-protection problem, not an inconvenience. **Decision: move `uber_pull_schedules`'
SELECT and the UPDATE of `enabled` to `get_user_company_id()`** — the account-shell
helper, `company_modules`' precedent and reasoning exactly — so the switch stays visible
and operable from the one screen a blocked company can reach. Everything else about the
table is unchanged. Note the dependency: `/einstellungen` is not in
`SUBSCRIPTION_ALLOWED_PATHS` (`App.tsx:142`), so the switch needs a home on
`/abo-aktivieren` or that list needs an entry — a browser question, flagged in §12.

**(b) Collection must be bounded, or it is indefinite.** A company three days late is
plainly served by collection. A company that left six months ago is being processed for a
relationship that ended, and `subscription_status` cannot tell the two apart. **Decision:
bound it** — `company_is_collectible` takes a grace window and stops N days past the
newest coverage end. That makes the split neither theatre nor indefinite. **N is the
owner's**, §12 question 2, and it has a GDPR dimension that makes it his and not mine.

---

## 11. The slice plan

Every slice targets `staging`, is independently shippable and independently revertible,
and carries its own migration self-check, `tests/rls/` file and `matrix.sql` lines —
because the RLS kit is the only gate that parses SQL.

**Numbering.** The highest timestamp on `staging` is `20261025130000_seed_viewer_system_role.sql`.
The three open branches (`work/billing-plan-reminder`, `work/deactivated-drivers-hidden`,
`work/roles-screen-honest`) carry **no** migrations — checked by diff against
`origin/staging`, 26.10.2026. So slice 1 is free to take `20261026100000`. Re-check the
union before numbering anyway; this has collided three times, and a renumber must sweep
`src/` for the filename too.

### Slice 1 — the catalogue exists and is the price. **Start here.**

The whole point of this slice is that it is **provably neutral**: it adds a table, makes
it the price source, removes nothing, and asserts in SQL that the old and new answers are
identical on all 42 combinations.

**Migration** (`20261026100000_plan_catalogue.sql`):

- `CREATE TABLE public.plans` as §3.1. RLS on, `SELECT` policy only
  (`TO authenticated USING (true)`, matching `subscription_plans`' catalogue shape), **no
  write policy, no write grant**.
- **Seed it from the live settings, not from literals** — read `price_book` and
  `plan_features` out of `app_private.platform_settings` in the migration and build the
  three rows, inverting the feature map into per-plan sets by rank. A literal seed can
  disagree with what is live; a derived one cannot. (And the inversion is where I1 comes
  from for free: inverting a `feature → min rank` map always yields monotone sets.)
- `ALTER TABLE public.companies ADD CONSTRAINT companies_plan_fkey
  FOREIGN KEY (plan) REFERENCES public.plans(slug)` — all three live values match three
  seeded slugs (§1.1), so no backfill.
- `app_private.plan_catalogue()`, `app_private.plan_catalogue_problem(jsonb)` (§5.4).
- `app_private.price_book_price` and `app_private.invoice_amount_cents` take the price per
  car from the catalogue, **signatures unchanged**, book still supplying tiers, yearly and
  first month. `compute_plan_price(text,integer,text,boolean)` untouched — which is what
  keeps `tests/rls/pricing.sql:190`, `assertions.sql:519` and `matrix.sql:3478,3484`
  from breaking on a `regprocedure` cast.
- `get_public_config()` and `get_app_config()` return the catalogue beside the book.
- **Self-check**: the seeded catalogue prices all 42 combinations identically to the
  stored `price_book`, compared as **value and text** (§6.2); the seed satisfies
  `plan_catalogue_problem`; an empty catalogue raises `P0002` as a missing book does;
  no policy names `company_is_collectible` (added here so slice 6 inherits it).

**Browser:** `PriceBook` → `PriceModel`, `SEED_PRICE_BOOK` → `SEED_PRICE_MODEL`,
`SEED_PLAN_FEATURES` → `SEED_PLANS`; `minPlanFor` derived from the catalogue with the
`'locked'` answer (§5.3). No screen changes behaviour; `PlanManagementModal` is untouched
and still edits the old table.

**Gates:** `tests/rls/plans.sql` (new) — the policy shape, no write policy, every
`plan_catalogue_problem` code, I1 and I2 each with a positive control that builds a
deliberate violation and requires it to be caught; `matrix.sql` lines for `public.plans`
(`'no tenant: a platform catalogue'`, SELECT `'..'`/`YY`, writes `RR`, no `M`);
`pricing.parity.test.ts` with **all 42 numbers unchanged** (§6.1); `appConfigSeed.test.ts`
re-pointed at `$seed_plans$` (§6.3); `tests/rls/pricing.sql`'s alien fixture becomes an
alien catalogue with identical numbers and the same two tag names (§6.4); a car count of
0 added to both grids (§6.5).

**Reversible:** drop the table and the FK. `price_book` still holds
`price_per_car_cents`, so the previous release prices exactly as before. **No
`SCHEMA_EPOCH` bump.**

### Slice 2 — the write RPC and the panel screen

`public.platform_plans_save(jsonb, integer)` (§3.2) and the screen (§7).
`PlanManagementModal` is deleted and `subscription_plans`' three write policies are
revoked, so the old table becomes read-only and genuinely vestigial.

Gates: `matrix.sql` rpc line for `platform_plans_save` (`pricing.manage`: owner and
billing `Y`, every other principal a recorded `denied`); `tests/rls/plans.sql` grows the
RPC's refusals, the stale-version path and the audit row; a render test for each refusal
sentence. Reversible: revoke the RPC, restore the modal. No epoch bump.

### Slice 3 — `plan_features` retired, `price_book` narrowed. **Needs the epoch.**

`platform_settings_problem` restated (§4.1, §4.2) to forbid `price_per_car_cents` in
`price_book` and answer `unknown_key` for `plan_features`; the `plan_features` row left
in place, unread. The key removed from the book's stored value by the migration.

**`deploy/SCHEMA_EPOCH` 3 → 4.** The previous release's `parsePriceBook` returns `null`
for a book without `price_per_car_cents`, so a rollback across this slice would have the
browser fall back to `SEED_PRICE_BOOK` — the right prices by luck, not by design. A
changed meaning is an epoch bump, and the bump makes the rollback refuse rather than
limp. The way back is the `pg_dump` snapshot `deploy.sh` takes before the migration.

Gates: a self-check re-stating what every surviving validator branch refuses, fragment by
fragment, plus the two assertions the old `plan_features` branch made; `tests/rls/pricing.sql`
section 2's seed expectations updated in the same commit.

### Slice 4 — the caps come out

Drop `trg_enforce_car_limit`, `trg_enforce_driver_limit` and both functions.
`platform_subscription_assign` stops copying `included_cars` into
`subscription_car_limit`. §8's columns lose their consumers.

Gates: `matrix.sql` — the `cars` and `drivers` `I` cells for a company at its limit move,
which the kit will report; change the expectation in the same commit and name it in the
PR. A regression test that a 6th car inserts for a company whose limit is 5.
**Watch for the inverse:** a screen that relied on the refusal to stop a user has no
replacement, and there is none to write — the owner removed the cap deliberately.
Reversible: re-create both triggers. No epoch bump (no column dropped).

### Slice 5 — overage at quote time

§9.2. `platform_invoice_quotes` gains `billed_cars`, `active_cars`, `overage_cars` and
`amount_cents_at_active_cars`; the panel shows and confirms; confirming writes
`subscription_car_limit` and raises in one transaction.

Depends on `billing-system.md`'s **Slice 1** (`platform_invoice_raise`) for the raising
half, and composes with it rather than duplicating it — §13. Gates: the quote's new
fields in `tests/rls/pricing.sql`; one audited row per confirmation.

### Slice 6 — blocked but running

§10.3: `app_private.company_is_collectible`, the two predicates relaxed,
`uber_pull_schedules`' SELECT and `enabled` UPDATE moved to `get_user_company_id()`, the
Abrechnung job's computation admitted and its delivery suppressed, the grace window from
§12 question 2.

Gates: `tests/rls/` for the new predicate — a company in each refused state, admitted or
refused as the table in §10.4 says; the policy self-check from slice 1; the derivation in
`platform-contexts.sql:929-933` must still produce the same table set, and
`uber_pull_schedules` must **lose** its `refuse_read_only_context_write` trigger when its
policies stop naming `get_active_company_id()`, or `platform-contexts.sql` section 14 and
`support-write-audit.sql` section 1 will disagree with each other. That interaction is
the one thing in this slice to get right before writing any SQL.

Reversible: restore the two predicates. No epoch bump.

### Slice 7 — `subscription_plans` dropped

Re-point `company_subscriptions.plan_id` (one production row) at `plans(slug)` as
`plan_slug text REFERENCES public.plans(slug)`, drop `subscription_plans`, drop
`included_cars`/`drivers_per_car_limit` with it. `SCHEMA_EPOCH` bump. Last, because it is
the only irreversible slice and nothing depends on it happening at all.

---

## 12. What needs the owner, and nothing below this line is mine to decide

1. **Plan names and the feature grid.** The catalogue seeds from today's map, which puts
   `gehaelter`, `dokumente`, `trinkgeld_quittung` and `stundennachweis` on premium and
   nothing on basic beyond the seven. Slice 1 preserves it exactly. If he wants a
   different split, that is slice 2's screen and not a migration — but he should see the
   grid before slice 1 freezes it as the baseline the 42 numbers are measured against.
2. **The collection grace window (§10.5b).** How many days past expiry does the Uber pull
   keep collecting? "Indefinitely" is an answer and it is the one I would not pick:
   we would be processing a former customer's data with no end date. This has a GDPR
   dimension, so it is his.
3. **The Abrechnung job while unpaid (§10.4, §10.5).** I read *"does everything but
   doesn't send emails"* as: compute, do not deliver. Confirm, because the alternative
   reading — deliver to drivers of a company that is not paying — is a decision about his
   customers' counterparties.
4. **`greatest(cars, 1)` (§6.5).** Does a company with zero billed cars pay zero, or one
   car's price? "No floor" was said about the 200 € minimum; this is a different floor
   and it currently exists in SQL and not in `calcPricing`. Either answer is fine; the
   divergence is not.
5. **Overcharged companies (§9.3).** One company is billed for 10 cars and runs 2. The
   quote will show both numbers. Should the panel suggest a downgrade, or stay silent?
6. **`company_settings.drivers_per_car_limit` (§8).** After the trigger goes, the
   Einstellungen field configures nothing. Remove the field, or keep it?
7. **Where a blocked company finds the Uber switch (§10.5a).** `/einstellungen` is not in
   `SUBSCRIPTION_ALLOWED_PATHS`. Put the switch on `/abo-aktivieren`, or admit
   `/einstellungen` to that list? (The second is wider than it sounds — that screen
   writes `company_settings`.)

A related one that is **not** in scope here and should not be answered by accident:
`billing-system.md` §12 asks whether the product is a Kleinunternehmer under §19 UStG.
Nothing in this document depends on it, and nothing here should be built in a way that
presumes an answer.

---

## 13. How this composes with the two sibling documents

**`billing-system.md` — one reversal, named.** It concluded `subscription_plans` is
"vestigial except as a foreign-key target" and that the price comes from `companies.plan`
plus the price book (`:79-86`). The owner has since chosen the table, so this document
reverses the *direction* while keeping every one of that document's findings intact:

- The price still comes from `companies.plan` — the slug — and the catalogue is where the
  per-car figure lives. `platform_invoice_quotes` keeps reading `c.plan` and
  `c.subscription_car_limit` off `companies`. **Its query does not change.**
- `invoice_amount_cents` keeps its signature, so **`billing-system.md`'s Slice 1
  (`platform_invoice_raise`) is unaffected** and can ship before, after or between these
  slices.
- `company_subscriptions.monthly_price` remains a rate that nothing prices from, and that
  document's instruction to stop displaying it anywhere stands. Slice 7 is where it
  finally goes.
- Its warning that `subscription_coverage.price_cents` is **not** a revenue record
  (`:755-762`) is untouched, and §4.3's decision not to FK `subscription_coverage.plan` in
  slice 1 is in the same spirit.

Order: `billing-system.md`'s Slice 1 and this document's Slice 1 are independent. This
document's Slice 5 **depends** on that document's Slice 1.

**`per-company-modules.md` — composes, and must not be made uniform.** Its Decision A is
that the module toggle may only **narrow**, the plan stays the commercial boundary, and
nothing in `company_modules` reads the plan — "the four gates compose as a plain AND,
with no precedence to encode and no override to store" (`20261025120000:8-12`). This
document changes what the plan *is* and not how it composes, so that AND is unaffected.

The one thing to hold onto: **plans are fail-closed and modules are fail-open, and that
asymmetry is correct.** `companyModules.ts:10-18` already argues it — absence of a module
row means ON, because copying `plan_features`' fail-closed rule would have put every
existing customer in the dark on deploy day. A later slice that "unifies" the two
readers for tidiness would break one of them. Both headers should say so.

---

## 14. What I would not build, and why

**A uuid `plan_id` foreign key.** §4.3. The slug is the plan's type throughout the
system — in `subscription_coverage.plan`, in `compute_plan_price`'s signature, in
`matrix.sql`'s string literals, and in a TypeScript union that carries an *order*. A uuid
buys referential integrity, which the FK on the text column buys more cheaply, and costs
the order.

**Per-plan fleet discount tiers or yearly discounts.** Nobody asked. It would double the
pricing surface, give `price_book_price` two places to look for a discount, and make the
42-combination grid a 42-per-plan grid. The one set in the book is enough, and the book
is staying anyway.

**`included_cars` and `drivers_per_car_limit` on the new table.** Measured:
`drivers_per_car_limit` on `subscription_plans` feeds nothing (§0.1) and `included_cars`
feeds only a copy into `subscription_car_limit` (§0.2), whose consumers §8 and §9 retire.
Carrying them across would carry the abandoned model into the table meant to replace it.

**A `monthly_price` column.** A flat per-plan price is the model the owner rejected
("فش ارضيات"). Keeping a column for it is how a system acquires two pricing models again,
and this document exists because it already did once.

**A browser that writes plan rows.** §3.2. The invariants are cross-row; per-row writes
cannot enforce them, and `CHECK` constraints cannot see other rows. The RPC is not
ceremony, it is the only place the rule can live.

**A third `get_*_company_id()` helper.** §10.3. It is the obvious shape and it is a trap:
`platform-contexts.sql:929-933` derives the context-trigger table set from policy text
matching `get_active_company_id`, so a policy naming a new helper would ship a tenant
table without its trigger. The background gate is a predicate in `app_private` that no
policy may name, with a self-check that fails the release if one does.

**Reshaping `subscription_plans` in place.** Its uuid PK is referenced, its SELECT is
`USING (true)` and its three write policies are per-row — precisely the shape that cannot
hold a cross-row invariant. A new table makes slice 1 revert by `DROP TABLE`, and leaves
the old one for `billing-system.md`'s Slice 2 to finish with.

**A migration that reads the live settings at *runtime* to build the catalogue.** Slice 1
reads them **once, at migration time**, to seed. A function that derived the catalogue
from `price_book` on every call would keep both systems alive behind one façade, which is
the thing being fixed.

**Anything in the same slice as a price change.** The 42 unchanged numbers are the proof
that the consolidation is arithmetically neutral. A price change in slice 1 destroys the
only evidence available that the move was correct. Prices move in slice 2 or later,
through the screen, one catalogue save at a time, with the preview in §7 showing what the
estate will be billed.
