# Per-company sidebar modules

> **Three corrections found while slice 1 was built against this document
> (25.10.2026). They are recorded here rather than silently fixed, because each
> one would have produced a defect if implemented literally.**
>
> 1. **Section 6 lists the module keys as sidebar paths.** `module_key`'s CHECK is
>    `^[a-z][a-z0-9_]{0,59}$` — **no hyphen** — so `company-planner` cannot be
>    stored. The key is `company_planner`. Self-check 9 of
>    `20261025120000` now fails a release where any listed key would not satisfy
>    the column's own CHECK, so the two halves cannot drift apart again.
> 2. **The registry assertion "no `pageKey` belongs to a locked module" is wrong
>    and must not be implemented.** `users`, `roles` and `settings` **do** own
>    their pages. Had they declared none, slice 3's rule (*a page is closed when
>    no enabled module maps to it*) would have closed those three **permanently
>    for every company**. The honest form is: **no page claimed by a locked module
>    can ever be closed** — a locked module can never be off, so its pages are
>    always claimed.
> 3. **Checklist step 4 reads as if `FEATURE_LABEL_KEYS` were complete.** It is
>    `Partial<Record<FeatureKey, TranslationKey>>` with **nine** of sixteen
>    entries. The complete list is `SEED_PLAN_FEATURES`, which is complete by
>    construction — and the check that matters is that a feature is **named in the
>    seeded plan map**, because `minPlanForFeature()` answers premium for a
>    feature the map does not name.
>
> Also: `SUBSCRIPTION_ALLOWED_PATHS` is at `App.tsx:141`, not 142. Both deadlocks
> the document names were verified independently during slice 1, and the registry
> test reads them out of `App.tsx` so their reasons fail loudly if either moves.



**Status:** design, for the owner's approval. No code, no migration, no PR.
**Date:** 25.10.2026
**Scope:** a platform operator turns a sidebar module on or off **for one company**.

---

## 0. What the owner asked, and what he has already decided

The original request (in his words): in the platform panel, let the operator hide
and show any sidebar module per company — *"كل اشي بالسايد بار حرفياً"*, literally
everything in the sidebar — and where the company's plan does not permit the
feature, let the operator switch it on anyway **with a warning**.

Two of those points were put back to him and he decided them himself. Both
decisions are recorded here as the premises of this design, not as options:

**Decision A — the toggle may only ever narrow.**
> *"لا تعاند الخطة من ناحية التشغيل فقط، اما الاغلاق اه اغلق"*

| plan | toggle | result |
|---|---|---|
| allows | on | **on** |
| allows | off | **off** — the toggle wins |
| forbids | on | **off** — the plan wins; the toggle cannot override it |
| forbids | off | **off** |

This **withdraws** the "warn him and let him switch it on anyway" half of the
original request. The warning that was asked for is therefore no longer a warning
*before an override*; at most it is an **explanation of why a toggle has no
effect**. Section 4 designs it that way.

**Decision B — "off" means off at every wall, including the data.**
> *"اطفي كل اشي، المسار والاستعلام وكل اشي، واخفي السايدبار"*

Link hidden, route closed, and the queries closed in the database. Section 5 takes
this seriously and separates it into **writes** and **reads**, because the two cost
completely different things and only one of them is reversible-looking to the
customer. The read half is the one place in this document where I recommend
**against** what he said, with the cost of both answers laid out so he can overrule
me with the consequence visible. Everything else follows his decisions.

**Out of scope entirely:** the driver-delete question (*"الحذف استنى لسا مااخدت
قرار"*). It is not touched anywhere in this design.

### What Decision A buys us

It is worth saying plainly, because it is the opposite of a compromise: his
decision makes the system **simpler**, not harder. "Narrow only" means the four
gates compose as a plain **AND** —

```
module is visible  ⟺  environment shows it
                    ∧  the plan allows it
                    ∧  the operator has not switched it off
                    ∧  the account's role may view it
```

— with no precedence to encode, no override flag, no "who wins" branch, and no
state in which the pricing tiers mean nothing. Had the toggle been allowed to
widen, the plan would have stopped being a boundary and `plan_features` would have
become advisory: every support conversation would then begin with "what is this
customer *actually* entitled to", a question nothing in the system could answer.
The AND is the whole design.

---

## 1. What exists today — verified, not assumed

Every line below was read in the working tree at `5368ada` (branch `staging`).
Where my brief or the surrounding documentation was imprecise, the correction is
marked **▲**.

### The sidebar

`src/components/Sidebar.tsx` holds two module-level tables. Each entry carries a
`feature: FeatureKey`, and `renderNavItem` begins:

```ts
const allowed = can(item.feature);
if (!allowed) return null;
```

`NAV_ITEMS` — 15 entries, plus `/monatsplan` conditionally:

| # | path | `feature` |
|---|---|---|
| 1 | `/overview` | `overview` |
| 2 | `/belege` | `belege` |
| 3 | `/fahrer` | `fahrer` |
| 4 | `/cars` | `fahrzeuge` |
| 5 | `/umsaetze` | `umsaetze` |
| 6 | `/fixkosten` | `fixkosten` |
| 7 | `/bargeldbestand` | `bargeldbestand` |
| 8 | `/werkstatt` | `werkstatt` |
| 9 | `/abrechnung` | `abrechnung` |
| 10 | `/notes` | `notizen` |
| 11 | `/benachrichtigungen` | `benachrichtigungen` |
| 12 | `/salaries` | `gehaelter` |
| 13 | `/dokumente` | `dokumente` |
| 14 | `/fahrtenbuch` | `dokumente` |
| 15 | `/company-planner` | `dokumente` |
| 16 | `/monatsplan` | `dokumente` — listed only where `monthlyPlanInNav()` says so |

`ADMIN_ITEMS` — 6 entries, drawn only for `isSupportAdmin || isViewingAsCompany`:

| # | path | `feature` |
|---|---|---|
| 17 | `/users` | `rollen_nutzer` |
| 18 | `/roles` | `rollen_nutzer` |
| 19 | `/datenimport` (`FLEET_IMPORT_PATH`) | `overview` |
| 20 | `/datensicherung` | `overview` |
| 21 | `/billing` | `overview` |
| 22 | `/settings` | `overview` |

**▲ `feature: 'overview'` on entries 19–22 is not a feature — it is this file's
spelling for "on every plan".** `overview` is `basic`, the lowest rank, so
`can()` is true for every plan. Four sidebar entries are therefore *ungated by the
plan today*, by design and with the reason written at the call site. This matters
in section 6: they are exactly the entries I recommend locking.

### The plan

`PlanContext.tsx` declares **16** `FeatureKey`s and nothing else gates. The map
`FeatureKey → minimum Plan` is the `plan_features` row of
`app_private.platform_settings`, read via `useAppConfig().planFeatures`, with
`SEED_PLAN_FEATURES` (`src/lib/appConfigSeed.ts`) standing in until the answer
arrives. `minPlanForFeature()` in `src/utils/planFeatures.ts` returns **premium**
for a feature the map does not name — fail-closed, deliberately.

`planAllows()` in `src/utils/planState.ts` is the whole gate:

```ts
if (isSuperAdmin) return true;
if (planState.status === 'archived' || planState.status === 'deleted') return false;
if (!planState.isActive && feature !== 'overview') return false;
return planHasFeature(planFeatures, effectivePlanOf(planState), feature);
```

`PlanProvider` reads the company row keyed on **`effectiveCompanyId`** (the
support-session company), not on the account's membership. That is load-bearing
for section 2.

**▲ There is no trial.** `20261015170000` removed it; `effectivePlanOf()` is now
`planState.plan` and nothing lifts it.

### The route gate

`PlanGate` (App.tsx:106) renders `LockedFeaturePage` when `can(feature)` is false.

**▲ It does not wrap every sidebar route.** Seven routes a sidebar entry points at
carry **no `PlanGate` at all**:

`/overview`, `/belege`, `/fahrer`, `/cars`, `/umsaetze`, `/fixkosten`,
`/bargeldbestand`, `/datenimport`

and three more are `CompanyAdminRoute` only, with no plan term:

`/billing`, `/settings`, `/datensicherung`

The comment at `/datensicherung` states the reason and it is sound: a gate at
`basic` and no gate are behaviourally identical, and a new `FeatureKey` the stored
map does not name would read as *premium* and lock everyone. **Consequence for this
design:** a module gate at the route is not a one-line addition to an existing
`PlanGate` for ten of the twenty-two entries — those routes have no gate to extend
and need one introduced. Slice 2 accounts for this.

`src/components/navVisibility.ts` hides **links only** (`monthlyPlanInNav`,
`tripAnalysisLinkShown`) and says so in its own header: the route stays registered,
so `/monatsplan` is reachable by address in every environment.

### The permission system

`role_permissions (role_id, page_key, can_view, can_edit)`, per company.
`PAGE_DEFINITIONS` in `src/types/role.ts` holds **16** page keys; the database's
copy is `public.role_page_keys()` and `src/utils/rolePageKeys.test.ts` fails the
build when the two differ.

In RLS the gate is `(SELECT public.current_role_permits('<page>', true))`, placed in
the `USING` **and** `WITH CHECK` of every write command of the gated tables
(`20260917130000` section 2, extended to 23 more tables by `20260923130000`).

**▲ Three vocabularies, no bijection.** `FeatureKey` (16), `page_key` (16) and the
sidebar paths (22) are three different lists:

- Six sidebar entries share one `FeatureKey` (`dokumente`), and one more route
  (`/stundennachweis`, `/fahrtenanalyse`) shares it without a sidebar entry.
- `page_key` has two entries no sidebar entry owns: `statistics`, `accounting`.
- `page_key` `documents` is the write gate of **24 tables**.
- `notification_settings` is gated by `is_company_admin()`, not by a page at all.

A module registry therefore cannot be derived from any one of them. Section 3
makes the mapping explicit and declared.

### The platform write idiom

`src/lib/platformRpc.ts` exports `callPlatformRpc(fn, args)`, which throws a
`PlatformRpcError(germanSentence, stableReason)` on `{success: false}` and treats
an unrecognisable answer as failure. Server side, every write is:

```
app_private.platform_rpc_authorize(capability, 'write', action, company, type, id)
  → app_private.platform_rpc_response('denied')          -- writes its own denied row
→ validate arguments → app_private.platform_rpc_finish(..., before, after)
```

`public.platform_company_set_plan` (`20260919150000`:1446) is the cleanest template.

### Capabilities

`app_private.platform_capability_matrix()` — **32 pairs, 14 capabilities, four
roles**, last replaced by `20261015150000`. Its self-check 1 fails on any count
other than 32/14/14, and self-check 3 fails if **any cell other than the two it
decided** moves. `tests/rls/platform-authority.sql` restates the matrix
independently. Since `20261015150000`, `companies.lifecycle` is **owner + support**
and `audit.read` is all four roles.

### Settings

`platform_settings_put(key, value, expected_version)` — `settings.manage` (owner
only) for every key but `price_book`, per-key validation, stale-version refusal,
audited, inside a 120-rows-per-minute-per-actor budget shared with reads. Adding a
key means restating `app_private.platform_settings_problem` **carrying every
existing branch character for character** (last restated by `20261015160000`).
Values are bounded at 16384 bytes, except `legal.privacy` at 32000, because
`audit_write` refuses a before/after value above 32768.

`feature_flags` is platform-wide; `FLAG_DEFINITIONS` in `src/lib/featureFlags.ts`
is the registry of flags **this build knows** and the settings screen draws one
switch per entry — never a name an operator typed. Its header states the contract:
an unnamed flag is **off**, which is the same state as present-and-off, so seeding
one early accomplishes nothing.

### The hazard this design must not reproduce

`src/lib/writeOutcome.ts`, first paragraph, verbatim premise: a page gate sits in
the policy's `USING` clause, so for a refused caller the row is simply **not in the
statement's scope** — PostgREST answers **200, no error, zero rows changed**, and a
screen that reads only `error` shows a green success toast over an unchanged row.
`deleteChecked` / `updateChecked` exist for exactly this. The mirror for reads is
worse and has no helper: a SELECT a policy hides returns **an empty list**, and an
empty Belege list and a total of 0,00 € are *claims*. Section 5 is built around
this.

---

## 2. Where the per-company state lives

### Recommended: a new table, `public.company_modules`

```
company_modules
  company_id   uuid      NOT NULL  REFERENCES companies(id) ON DELETE CASCADE
  module_key   text      NOT NULL  CHECK (module_key ~ '^[a-z][a-z0-9_]{0,59}$')
  enabled      boolean   NOT NULL
  note         text                -- why, for the operator; bounded
  set_by       uuid                -- the operator; NULL for a row written with no session
  set_at       timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (company_id, module_key)
```

**Absence of a row means the module is on.** The table stores *decisions to
subtract*, so no decision means no subtraction. A row with `enabled = true` is a
deliberate record of "this was switched off and switched back on", which is worth
keeping for the audit trail; the gate reads `enabled IS NOT FALSE`.

**Privileges and policies — the `subscription_coverage` / `notification_deliveries`
shape, which is "no write policy at all":**

```sql
ALTER TABLE public.company_modules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.company_modules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.company_modules TO authenticated;

CREATE POLICY company_modules_select ON public.company_modules
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id())
         OR (SELECT public.platform_can('companies.read')));
```

Three things in that are deliberate:

1. **No INSERT, UPDATE or DELETE policy exists.** A move between companies is
   refused for having no UPDATE policy at all, rather than by a `WITH CHECK`
   clause that a later migration could restate away. The only writer is the
   SECURITY DEFINER RPC of section 3.
2. **`get_user_company_id()`, not `get_active_company_id()`.** The account-shell
   helper. A suspended or unsubscribed company must still read its own module
   rows, or the page explaining the suspension, `/abo-aktivieren` and `/billing`
   would render against an unreadable table. This is `subscription_coverage`'s
   reasoning (`20260919150000`:292-305) and its self-check asserts the same choice.
3. **No `refuse_read_only_context_write` trigger, and that is not an omission.**
   Section 14 of `tests/rls/platform-contexts.sql` requires that trigger on every
   table whose policies name `get_active_company_id()`. A table on the shell
   helper must *not* carry it — `20260919150000`:1776-1781 asserts its absence for
   `subscription_coverage`. Adding one here would fail the kit. The table needs no
   support-write audit either, because no support session can write it: there is
   no write policy, and the RPC is a platform act audited by `platform_rpc_finish`.

### Rejected: a key in `app_private.platform_settings`

Three independent reasons, each sufficient:

1. **It would disclose every customer's configuration to every customer.**
   `get_app_config()` returns `app_private.platform_setting_value('plan_features')`
   and `('feature_flags')` as **whole documents** to every signed-in browser. A
   per-company map stored the same way would ship, to each company's browser, the
   list of every other company's id and which modules each has switched off.
   That is a disclosure, not an inconvenience.
2. **It does not fit in the value.** Settings values are bounded at 16384 bytes,
   because `audit_write` refuses a before/after above 32768 and a write records
   both. At roughly 30 bytes per `{company_uuid: {module: bool}}` pair, 19
   companies × 16 toggleable modules is already ~12 KB. The bound is reached at a
   few dozen customers, and the failure mode is that **a save starts being
   refused** — on a growing customer base, which is precisely when nobody is
   looking for a size limit.
3. **One optimistic version for every company.** `platform_settings_put` refuses a
   stale `expected_version`, and `settingsEditorKit.tsx` deliberately never retries
   with the newer one — it discards the operator's unsaved form and shows the other
   person's values. Two operators configuring two *different* customers would
   collide and one would lose their work, with a correct-looking "version
   conflict" message that names nothing they did.

A fourth, smaller reason: `settings.manage` is owner-only, which would make every
module toggle an owner's act. Section 3 argues it should be support's too.

### Rejected: a `jsonb` column on `companies`

- `companies_update` is `platform_can('companies.lifecycle')` with no further
  term, so a jsonb column there is writable by a direct PostgREST `PATCH` **with
  no audit row**. Closing that means another `refuse_direct_subscription_write`-
  style trigger — a wall the five subscription columns needed and that a table
  with no write policy does not need at all.
- No per-module `set_by` / `set_at` / `note`, and the audit row's before/after
  would carry the whole blob on every single toggle.
- `companies` is already the table whose derived columns have a guard trigger and
  a catalogue reader (`app_private.subscription_column_writes()`). Adding another
  hand-written column to it invites the same machinery a second time.

---

## 3. The module registry, and who may write the state

### The registry: `src/lib/companyModules.ts`

One module per **sidebar entry**, because that is the thing the owner pointed at
and the thing an operator recognises. `FLAG_DEFINITIONS`' shape, for the reason
`featureFlags.ts` gives for copying `PAGE_DEFINITIONS`: the operator is choosing
among things the build does something with, so the list lives in code and the
words are translation keys.

```ts
export const MODULE_DEFINITIONS = [
  {
    key: 'belege',                    // stored in company_modules.module_key
    labelKey: 'nav.belege',           // the same key the sidebar renders
    descriptionKey: 'admin.modules.belege.desc',
    feature: 'belege',                // the FeatureKey the plan gate asks
    routes: ['/belege'],              // what slice 2 closes
    pageKeys: ['receipts'],           // what slice 3 closes
    lockable: true,                   // false ⇒ no checkbox, never toggleable
  },
  // …
] as const;
```

Four declared columns rather than four derivations, because none of the three
existing vocabularies can produce the others (section 1 ▲). A test in the shape of
`rolePageKeys.test.ts` / `featureFlagCallSites.test.ts` keeps it honest:

- every `feature` is a real `FeatureKey`;
- every `route` is registered in `App.tsx`;
- every `pageKey` is in `PAGE_DEFINITIONS`;
- every sidebar entry in `NAV_ITEMS` / `ADMIN_ITEMS` appears exactly once;
- no module appears twice, and no `pageKey` belongs to a locked module.

**This is the answer to "what must a developer do when adding a module so none of
the four gates is forgotten":** add one entry here, and the test names whichever of
the four columns is missing. The checklist is in section 7.

### The one judgement call in the registry: shared page keys

Six sidebar entries map to `FeatureKey` `dokumente` and `pageKey` `documents`,
which gates 24 tables. The link and the route are per entry; the tables are not.
So the write wall is defined on the **page**, not on the module:

```
page is closed for a company  ⟺  no enabled module maps to that page
```

Turning off `/monatsplan` alone closes **no table** — correct, because `/dokumente`
still needs those same tables. Turning off all six closes the 24. This falls out of
the data model rather than being a special case, and it means a module's row in the
panel can honestly say whether switching it off closes data or only hides a screen.
Section 5 lists which modules are which.

### Who may write it: `companies.lifecycle`, and **no new capability**

Recommended: the RPC asks `platform_can('companies.lifecycle')` — **owner and
support** since `20261015150000`.

Reasoning:

- It is already the capability that decides what a company may do at all: suspend,
  reactivate, archive, restore. Switching off one module is a smaller act of
  exactly that kind, on exactly that object.
- Support holds it, which matches the owner's 15.10.2026 decision that support may
  approve companies. A module toggle is a support act in practice — it is what
  someone does while a customer is on the phone.
- `billing.manage` would be wrong: this is not money, and it would hand the
  billing role a capability over what a customer can *use*.
- **A new `modules.manage` capability costs a migration that replaces
  `platform_capability_matrix()`** — taking it from 32 pairs to 36 — **and a
  restatement of `tests/rls/platform-authority.sql`**, and `20261015150000`'s
  self-check 1 and 3 fail on any count change or cell movement, so that file has
  to be re-derived too. That is a slice of its own for no behaviour anyone has
  asked for. YAGNI. If the owner later wants to sell modules à la carte through
  billing, that is a one-cell matrix change with its own slice and its own
  decision.

### The RPC

```sql
public.platform_company_set_module(
  p_company_id uuid,
  p_module_key text,
  p_enabled    boolean,
  p_note       text DEFAULT NULL
) RETURNS jsonb        -- {success, reason, error}
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
```

Body, in `platform_company_set_plan`'s order:

1. `app_private.platform_rpc_authorize('companies.lifecycle', 'write',
   'company.set_module', p_company_id, 'company_module',
   p_company_id || ':' || p_module_key)` → on false, `platform_rpc_response('denied')`.
2. Validate: company id present; `p_enabled` not null; `p_module_key` matches the
   key pattern **and is one of `app_private.company_module_keys()`** — the
   database's copy of the registry, the `role_page_keys()` idiom, so a key the
   product does not have cannot be stored; `p_note` within its bound. Anything
   else → `platform_rpc_finish(..., 'invalid', ...)`.
3. **Refuse a locked module** with its own stable reason `module_locked`. The lock
   list lives in `app_private.company_module_locked_keys()` so the browser is not
   the only thing enforcing section 6. A deadlock the panel can create by accident
   must be impossible at the database, not merely absent from the screen.
4. `SELECT * FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE` →
   `not_found` if absent. The lock is what makes the read-modify-write of the
   module row and the audit row one atomic decision.
5. `INSERT … ON CONFLICT (company_id, module_key) DO UPDATE` returning the row,
   with `set_by = auth.uid()`, `set_at = now()`.
6. `platform_rpc_finish('write', 'company.set_module', NULL, p_company_id,
   'company_module', <id>, before, after)` where before/after are
   `{"module_key": …, "enabled": …, "note": …}`.

**Grants:** `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role` then
`GRANT EXECUTE TO authenticated` — the shape every platform RPC uses; the service
role has no `auth.uid()` to answer for.

**The audit row looks like this** (one per call, by `audit_write`):

| field | value |
|---|---|
| `category` | `write` |
| `action` | `company.set_module` |
| `outcome` | `ok` \| `denied` \| `invalid` \| `not_found` \| `module_locked` → recorded as `error` |
| `company_id` | the company |
| `target_type` | `company_module` |
| `target_id` | `<company_id>:<module_key>` |
| `before_value` | `{"module_key":"werkstatt","enabled":true,"note":null}` or `null` when no row existed |
| `after_value` | `{"module_key":"werkstatt","enabled":false,"note":"Kunde nutzt es nicht"}` |
| `actor_user_id`, `actor_role` | the operator and their staff role, looked up, never passed |

`platform_audit_record` — the **edge functions'** door — needs no change and must
not get one: its allow-list already refuses an action it does not name, which is
stricter than a reserved namespace. The RPC writes through `audit_write` directly,
as every `platform_*` RPC does.

### Rejected: a wholesale `platform_company_set_modules(company, jsonb)`

A single call saving every toggle at once is tempting for the panel and is the
wrong shape here, for a reason this codebase has already paid for once.
`company_role_save` replaces a role's permission rows wholesale from a payload
built out of `PAGE_DEFINITIONS`, and CLAUDE.md records the consequence: **a stored
`page_key` this build does not know is dropped the first time anyone edits that
role, with a success toast.** A wholesale module save has the identical failure —
an older build, or a rolled-back release, would silently delete the rows for
modules it does not know, re-enabling them, with a green toast. One module per
call makes each audit row one decision, makes each act individually reversible, and
cannot drop what it did not send.

The cost is honest and small: an operator flipping five toggles makes five calls.
The panel saves per row rather than per form (section 4), so that is also the
interaction people expect from a list of switches.

---

## 4. The panel screen

### One company at a time, inside `CompanyDetail`

The new editor is a card in `CompanyDetail` on `/admin/companies` — the existing
full-page per-company view that already holds the lifecycle menu, the users table
and the danger zone. A company is already chosen there by clicking a table row.

**Not a matrix across companies.** Nineteen companies × sixteen toggleable modules
is 300+ checkboxes with nowhere to show the per-cell plan state, and a misclick
lands on the wrong customer. One company at a time also keeps one audit row per
decision and gives the plan line (below) somewhere to live.

### Layout

```
┌─ Module ────────────────────────────────────────────────────────────────┐
│  Tarif: Advanced · 7 Fahrzeuge                  [ Alle Module anzeigen ]│
│  Ein Modul, das hier aus ist, ist für diese Firma aus — Link, Seite     │
│  und Daten. Der Tarif entscheidet weiterhin, was überhaupt möglich ist. │
│                                                                         │
│  ☑  Belege                 belege          Aktiv                        │
│  ☑  Fahrer                 fahrer          Aktiv                        │
│  ☐  Werkstatt              werkstatt       Vom Betreiber deaktiviert     │
│  ☑  Gehälter               gehaelter       Ohne Wirkung — der Tarif      │
│                                            (Advanced) enthält dieses     │
│                                            Modul nicht. Ab Premium.      │
│  ☑  Dokumente              dokumente       Aktiv · schließt Daten        │
│  —   Abonnement            billing         Immer aktiv — ohne diese      │
│                                            Seite kann die Firma nicht    │
│                                            bezahlen.                     │
└─────────────────────────────────────────────────────────────────────────┘
```

Per row: the **same `t(labelKey)` the sidebar renders** (so the operator and the
customer are looking at the same word), the raw key in a `<code>` (it is what the
audit row says), a checkbox, and one state line. A locked module has **no
checkbox** and its one-sentence reason in place of it.

### The four state lines, which are Decision A made visible

| plan | toggle | line |
|---|---|---|
| allows | on | **Aktiv** |
| allows | off | **Vom Betreiber deaktiviert** |
| forbids | on | **Ohne Wirkung — der Tarif (<Plan>) enthält dieses Modul nicht. Ab <Mindesttarif>.** |
| forbids | off | **Nicht im Tarif** |

The third line is the whole of what remains of the requested warning, and its
wording is chosen with care. It does **not** say "are you sure" and it does not
offer an override, because there is none. It says the toggle is *inert*, names the
plan the company is on, and names the plan that would include the module — read
from the live `plan_features` map through `minPlanFor(feature)`, so the panel and
`LockedFeaturePage` can never quote different plans. An operator who wants the
customer to have it now knows exactly which lever to pull: the plan, on the
dashboard row beside this one.

A toggle in that state is still **saved**, deliberately. An operator switching on a
module ahead of an upgrade should be able to, and the row then takes effect the
moment the plan moves — no second visit, nothing to remember. That is the only
reason `enabled = true` rows are stored at all.

Modules whose page key is shared (section 3) carry **· schließt Daten** or
**· nur Ansicht** on the Aktiv line, so the operator can see before clicking whether
switching this one off closes tables or only hides a screen.

### Saving

Per row, on change, through `callPlatformRpc('platform_company_set_module', …)` —
the pattern every panel screen uses: `await`, toast, then **re-read, never an
optimistic local mutation**. A refusal arrives as `PlatformRpcError` whose
`.message` is already the German sentence the database wrote; `module_locked` and
`denied` are shown as-is.

There is **no** `expected_version` here and that is correct: the row is one
boolean for one module of one company, two operators cannot meaningfully conflict
on it, and the last writer's intent is the one to keep. The `FOR NO KEY UPDATE` on
the company row serialises concurrent calls; the audit log keeps both decisions.

### What the customer sees

Nothing new, and that is the point: a module switched off is simply not in the
sidebar, exactly as a module the plan does not include is not in the sidebar today.
A customer who reaches a closed route by address gets a page (slice 2) that says
the module is not active for their company and names support as the way back — **not
`LockedFeaturePage`**, because the plan is not the reason and telling a Premium
customer to upgrade would be false.

---

## 5. Which wall, and the cost of the one I recommend against

Four walls exist. The owner asked for all of them ("the route and the query and
everything"). They are not equivalent, and the fourth is different in kind.

| wall | where | what it costs to build | what it leaves open |
|---|---|---|---|
| **A — the link** | `Sidebar.renderNavItem`, one condition | one line | everything: the route answers, the data answers. Cosmetic alone. |
| **B — the route** | a `ModuleGate` beside `PlanGate` | ten routes have no gate to extend (section 1 ▲) | a crafted PostgREST call. Exactly as strong as the plan gate is today. |
| **C — writes** | `current_role_permits()`, **one function body** | one migration, one kit file | reads. Nothing new can be created, nothing produced. |
| **D — reads** | **every** SELECT policy, 36+ tables | a large migration, an epoch bump, and every reading screen retaught | — |

### Recommended: A + B + C. And C is far cheaper than it looks.

`current_role_permits(page, need_edit)` is the single chokepoint for the write
policies of **33 tables** and for the eight SECURITY DEFINER RPCs that ask it
themselves (the five planning RPCs since `20260923130000`, the three
Gehaltsquittung RPCs). One term added to one function body closes writes for a
module's pages everywhere at once — no policy rewrite, no table list to keep in
step, and nothing for a future table to forget, because a new table that copies the
standard shape inherits the term by calling the same function.

**And it is not on the hot path, which I expected it to be and it is not.** The
policies embed the gate as `(SELECT public.current_role_permits('<page>', true))`
— the wrapped form, built by the `v_gate_w` / `v_gate_d` `format()` calls in
`20260917130000` section 2's catalogue loop. PostgreSQL evaluates a wrapped
subquery with no outer reference as an **InitPlan: once per statement, not once
per row.** So the extra lookup costs one read per statement even on a Fahrtenbuch
import that writes thousands of trips. That expectation must still be **measured**
on the import path before the slice ships — this repository's own record is that a
reading of the optimiser has been wrong three times in both directions — but the
wrapping is the reason to expect it to be cheap.

The gap to state plainly: **`is_company_admin()` is not page-keyed**, so wall C
does not reach the four things gated by an administrator instead of a page —
`notification_settings` writes, `company_settings` writes, and deleting a
Fahrtenbuch import or trip. Those need either their own term or an explicit
decision to leave them. I recommend leaving them: they are administrator acts on
the company's own shell, and all four belong to modules I recommend locking anyway
(section 6), except the import/trip delete, which belongs to `documents` and whose
*creation* is already closed by wall C — a company that cannot import cannot
accumulate anything new to delete.

### Recommended against: wall D, closing reads. Here is the cost.

The owner said "the query too", so the default reading of his instruction is that
reads close as well. I am not going to implement that silently, because I believe
it is the wrong trade and because three of its four costs are invisible until a
customer is on the phone.

**1. A company's existing rows become unreadable, and from the customer's side
that is indistinguishable from data loss.** This is not a figure of speech. The
codebase's own rule, written in `writeOutcome.ts` and in CLAUDE.md, is that **an
empty list and a total of 0,00 € are claims.** A SELECT a policy hides returns an
empty array with a 200 — there is no error for a screen to notice and no helper
equivalent to `deleteChecked` for reads. So on the day a module is switched off,
Belege shows "no receipts", Bargeldbestand shows a till of 0,00 €, and the
Abrechnung shows a driver owing nothing. Every one of those is a false statement
about the customer's money, produced by our own gate.

**2. It would make us the reason a customer cannot produce a statutory record.**
The `documents` module is the Fahrtenbuch chain: imports, trips, the assignment
audit, the five planning tables, the six `historical_*` tables and their three
children, and the saved Stundennachweise — **24 tables**. Those are German payroll
and compliance records that go to a Steuerberater and are subject to retention
obligations that do not pause because a subscription module was switched off.
Closing reads on `documents` does not close one screen; it closes the payroll
pipeline *and the archive of everything it ever produced*.

**3. It buys no security, because there is no attacker.** RLS exists here to stop
company A reading company B. A module toggle is company A reading **company A's
own rows**. Closing it is a commercial act wearing a confidentiality costume. Wall
C already achieves the commercial goal completely: the module cannot be *used*,
no new rows appear, no document is produced, nothing is computed. Wall D adds
nothing to that except the appearance of deletion.

**4. It costs an epoch bump and a rollback cliff.** Per-module read closing cannot
be done in one function: SELECT policies are
`company_id = (SELECT get_active_company_id()) OR (SELECT platform_reads_company_data())`
with **no role term at all** — 3.3's shape has none and slice C deliberately did
not invent one — and `get_active_company_id()` takes no page argument, so it cannot
answer per module. So wall D means rewriting 36+ SELECT policies, which changes the
meaning of every business table and therefore requires `deploy/SCHEMA_EPOCH` to go
from 3 to 4. **A rollback cannot cross an epoch.** The way back from a bad release
would be the pre-migration `pg_dump`, not a rollback — on the release that changes
how every tenant table is read.

**If he overrules me, this is the minimum safe form,** and it is its own slice with
its own approval, never a rider on wall C:

- Reads close for the module's own screens, but **the export path stays open** — a
  company must always be able to get its own statutory records out. That is an
  explicit carve-out, written down, with the retention reason beside it.
- **Every reading screen is retaught before any policy changes**, not after: the
  module state is read first, and a closed module renders an explicit "not active
  for your company" state. No screen may reach the point of rendering a figure.
  Until that is done for *all* of them, the policy change makes the product state
  false numbers.
- `documents` is excluded from read-closing regardless, on reason 2.
- A kit file proves per table that a closed read **refuses or renders a refusal**,
  never an empty success.

### Does turning a module back on restore everything exactly?

**Yes, exactly, and it is a property of the design rather than luck.** The toggle
writes one row in `company_modules` and nothing else. It deletes no tenant row,
rewrites no column, runs no cleanup, and triggers no cascade. Walls A, B and C are
all **predicates** evaluated at read time over that one row. So `on → off → on` is
the identity, and the state after it is bit-for-bit what it was before — including
the Gehaltsquittung and invoice counters, which are gapless per company and year
and draw a number only at issue, so a quiet month creates no gap.

The one sentence that matters most in this document is therefore a prohibition:

> **Nothing in this feature may ever delete, archive, anonymise or "clean up"
> tenant data when a module is switched off.** The moment a disable step touches a
> row, the toggle stops being reversible, and a commercial switch becomes a
> destructive one. If such a step is ever wanted, it is a different feature with a
> different name and the owner's separate decision.

The registry test should carry that as an assertion in spirit, and the RPC's
self-check can carry it literally: `platform_company_set_module` must name no table
but `company_modules` and `companies`.

---

## 6. Which sidebar items must never be toggleable

Six of the twenty-two. Two of them are **deadlocks**, not policy preferences, and
those two are the ones I would refuse to make toggleable even if asked.

| # | entry | `lockable` | why |
|---|---|---|---|
| 1 | **`/billing`** (Abonnement) | **never** | **Deadlock.** `SubscriptionGuard` *forces* a company whose subscription is inactive onto `/abo-aktivieren`, `/aktivierung` or `/billing` and lets nothing else through. Switch `/billing` off and the forced destination is itself closed: the company is locked in a loop with no reachable page, and **cannot pay** — which also means it can never leave the state. Unrecoverable from the customer's side. |
| 2 | **`/overview`** | **never** | **Deadlock.** `<Route path="*" element={<Navigate to="/overview" replace />} />` and the authenticated index redirect both land there. Switch it off and *every* unknown or closed path redirects to a closed page. Also the one feature `planAllows()` exempts from the inactive-subscription check, so it is the product's floor. |
| 3 | `/users` (Benutzer) | never | It is the only way to add or **remove** an employee's account. Off = a company cannot revoke a departing employee's access. We would be causing a security regression in our customer's business to enforce a billing preference. |
| 4 | `/roles` (Rollen) | never | Same family: `company_role_save` is how a company *narrows* its own staff's rights. Off = a company cannot reduce access. |
| 5 | `/settings` (Einstellungen) | never | Holds the **Bundesland**, which selects the holiday table that the Lohnart and premium computation depend on, and the legal master data printed on every invoice and Stundennachweis. Off = a company cannot correct its own legal name on a statutory document, and cannot fix a wrong holiday calendar that is mis-paying its drivers. |
| 6 | `/datensicherung` (Datensicherung) | **recommended never** | It is the customer's way to get **their own data** out. Switching it off alongside other modules is the combination that turns a commercial toggle into hostage-taking. It is also deliberately *not* plan-gated today precisely so a Basic customer can reach the backup they were sold (`LandingPage.tsx:543`). |

Note what entries 1–6 have in common and that it is not a coincidence: **four of
the six carry `feature: 'overview'`** — `/overview` in `NAV_ITEMS`, and `/billing`,
`/settings`, `/datensicherung` in `ADMIN_ITEMS` — which is this file's spelling for
"on every plan", not a feature at all. The product has already decided, with the
reason written at the call site, that these are not things to be sold. The module
toggle should not be what reverses that decision by accident. (The fourth
`ADMIN_ITEMS` entry carrying that spelling, `/datenimport`, is genuinely a feature
and stays toggleable.)

The remaining **sixteen are toggleable**: `/belege`, `/fahrer`, `/cars`,
`/umsaetze`, `/fixkosten`, `/bargeldbestand`, `/werkstatt`, `/abrechnung`,
`/notes`, `/benachrichtigungen`, `/salaries`, `/dokumente`, `/fahrtenbuch`,
`/company-planner`, `/monatsplan`, `/datenimport`.

**Which of those close data (wall C) and which only hide a screen:**

| module | page key | closes writes on |
|---|---|---|
| `belege` | `receipts` | `receipts` |
| `umsaetze` | `income` | `income` |
| `fahrer` | `drivers` | `drivers` |
| `cars` | `cars` | `cars`, `car_driver_assignments` |
| `fixkosten` | `fixed-costs` | `fixed_costs` |
| `bargeldbestand` | `cash-balance` | `cash_transactions` |
| `werkstatt` | `werkstatt` | `werkstatt_checks` |
| `notes` | `notes` | `driver_notes` |
| `salaries` | `salaries` | `salaries`, `salary_payments`, and the three Gehaltsquittung RPCs |
| `dokumente` + `fahrtenbuch` + `company-planner` + `monatsplan` | `documents` (**shared**) | **24 tables** — closes only when **all four** are off (section 3) |
| `abrechnung` | `accounting` — **no table names it** | nothing. The Abrechnung RPCs are SECURITY INVOKER over `income` / `receipts` / `cash_transactions`, so this module is **link + route only**. |
| `benachrichtigungen` | none — `notification_settings` is `is_company_admin()` | nothing. Link + route only unless given its own term. |
| `datenimport` | partner import tables | to be confirmed in slice 3's own survey. |

The `documents` group is the one place where an operator's expectation and the
mechanism diverge, and the panel row says so (**· schließt Daten**).

---

## 7. The four gates: one table

Every gate must say yes. Any one saying no hides the module. There is no override
anywhere, which is Decision A.

```
visible(module, company, account) =
      environmentShows(module)          -- navVisibility, per build
   ∧  planAllows(company, feature)      -- plan_features × the company's plan
   ∧  moduleEnabled(company, module)    -- company_modules, NEW
   ∧  roleCanView(account, pageKeys)    -- role_permissions
```

| # | gate | scope | source of truth | gates link | gates route | gates writes | gates reads |
|---|---|---|---|---|---|---|---|
| 1 | **Environment** | per build / env | `src/components/navVisibility.ts` | ✔ | ✘ (by design) | ✘ | ✘ |
| 2 | **Plan** | per company | `plan_features` × `companies.plan` | ✔ | ✔ (`PlanGate`) | ✘ | ✘ |
| 3 | **Module** (new) | per company | `public.company_modules` | ✔ | ✔ (`ModuleGate`) | ✔ (`current_role_permits`) | ✘ (recommended) |
| 4 | **Role** | per account | `role_permissions` | ✘ today | ✘ | ✔ | ✘ (never, by 3.3's shape) |

### Message precedence — the only place order matters

A user denied by more than one gate must be told **one** thing, and it must be the
true one. In order:

1. **Role** — "your role does not include this page." Shown first because it is
   about *this person*, and telling a viewer to upgrade the company's plan sends
   them to their administrator for the wrong reason.
2. **Plan** — `LockedFeaturePage`, naming `minPlanFor(feature)`. Before the module,
   because the plan is the outer boundary: if the plan forbids it, the module row
   is inert and saying "support switched this off" would be false.
3. **Module** — `ModuleOffPage`: "this module is not active for your company",
   naming support as the way back. **Never** `LockedFeaturePage` — a Premium
   customer told to upgrade is being lied to.
4. **Environment** — no message exists and none should: the route stays open on
   purpose so the feature can be used and tested while unadvertised.

### Adding a new module: the checklist the registry test enforces

1. Add the entry to `NAV_ITEMS` / `ADMIN_ITEMS` with its `feature`.
2. Add a `MODULE_DEFINITIONS` entry with `feature`, `routes`, `pageKeys`, `lockable`.
3. Add the key to `app_private.company_module_keys()` in a migration — the
   `role_page_keys()` idiom, so the database can refuse a key the product does not
   have.
4. If the route needs a plan gate, extend `FeatureKey`, `SEED_PLAN_FEATURES`,
   `FEATURE_LABEL_KEYS` **and seed `plan_features` in a migration** — or it reads
   as premium for everyone.
5. Both dictionaries: `src/i18n/de.ts` (canonical) and `src/i18n/en.ts`.
6. If it owns a page key exclusively, add its tables to the kit's coverage.

Steps 1, 2, 3 and 5 are checked by tests; 4 and 6 are checked by the existing
`planFeatures.test.ts` / `rolePageKeys.test.ts` and the RLS kit.

---

## 8. Fail-closed or fail-open

Two different questions, and they have different answers.

**A row that is absent → the module is ON.** The table stores decisions to
*subtract*; no row means no decision means no subtraction. This is `useFlag`'s
logic read correctly rather than copied: for a flag, absent and off are the same
state, so absence means off. For a subtraction, absent and "not subtracted" are the
same state, so absence means **on**. Copying `plan_features`' fail-closed rule here
would mean a company with no rows at all had every module switched off — i.e. every
existing customer dark on deploy day.

**The map cannot be read at all → the module SHOWS.** Fail-open, matching the two
places that already answer this question in `src/`:

- `UNRESOLVED_PLAN_STATE` (`planState.ts`) is deliberately permissive, with its
  reason written out: a restrictive placeholder "would flash `LockedFeaturePage`
  over every screen on every page load."
- `AppConfigContext` keeps the last good answer on failure and never falls back to
  the seed, let alone to something stricter.

And it is **safe because wall C is in the database**: a module shown after a failed
read can still write nothing it was not already allowed to write. The browser is
not the boundary.

**The one honest caveat, and it couples two slices.** That argument depends on
wall C existing. Between slice 2 and slice 3 the browser *is* the only module wall,
and a failed read would then hand out a module for free until the next successful
load. I still recommend fail-open through that window, for consistency: the plan
gate has exactly the same exposure today and always will — `planAllows()` has no
RLS term anywhere and `UNRESOLVED_PLAN_STATE` is permissive — so a module gate that
behaved differently from the plan gate beside it would be the odd one out, and
two gates with opposite failure modes is the kind of thing nobody remembers
correctly a year later. If the owner prefers fail-closed for that window, it is one
line and it should flip back when slice 3 lands; I would rather not have a
behaviour that changes between releases.

---

## 9. Slice plan

Each slice is independently shippable, independently reversible, and leaves the
product correct if the next one never ships. Every PR targets **`staging`** and
carries `PROGRESS.md` (Arabic), `HANDOFF.md`, the `README.md` status quote and the
numbered table in `el-professor-plan.html`.

### Slice 1 — the state, the RPC, the panel, and the link **← the first slice**

The smallest slice that is honestly useful. It cannot be smaller: nothing can be
gated without the per-company state, and the state cannot be written without the
table and the RPC.

- **Migration** (`2026xxxx_company_modules.sql`): the table; `ENABLE ROW LEVEL
  SECURITY`; `REVOKE ALL` then `GRANT SELECT TO authenticated`; the one SELECT
  policy on `get_user_company_id() OR platform_can('companies.read')`; **no write
  policy**; `app_private.company_module_keys()` and
  `app_private.company_module_locked_keys()`; `public.platform_company_set_module`
  on `companies.lifecycle`.
- **`DO` self-check** that fails the release on any of: a non-SELECT policy or any
  client INSERT/UPDATE/DELETE privilege; `anon` holding SELECT or EXECUTE; the RPC
  not SECURITY DEFINER or without a pinned `search_path`; the RPC naming any table
  but `company_modules` and `companies` (the section 5 prohibition, as a
  catalogue check); a `refuse_read_only_context_write` trigger present on the
  table (it must be absent — the policy names the shell helper); the locked-key
  list not containing the six of section 6.
- **`tests/rls/company-modules.sql`**: the seven principals × SELECT/INSERT/
  UPDATE/DELETE/move on the table; the RPC refused for `billing` and `read_only`
  and allowed for `owner` and `support`; `module_locked` for each of the six;
  an unknown key refused; the audit row's category, action, target and before/after;
  and an owner control on every probe so a refusal is never a malformed statement.
  Plus the table and RPC lines in `tests/rls/matrix.sql`.
- **`src/lib/companyModules.ts`**: `MODULE_DEFINITIONS`, `parseCompanyModules`,
  and the pure `moduleVisible(env, plan, modules, role, module)` — tested without a
  renderer, the way `planState.ts` and `adminGate.ts` are.
- **Browser**: a `CompanyModulesCard` in `CompanyDetail`; the module term added to
  `Sidebar.renderNavItem`'s existing single condition; the per-company map read
  where `PlanContext` already reads the company row, keyed on
  **`effectiveCompanyId`** — not through `AppConfigContext`, which keys on the
  account and would serve the wrong company's modules inside a support session.
- **i18n**: both dictionaries, through `scripts/i18n-merge.mjs`.

**Reversible:** revert the PR. The table may stay; an empty table gates nothing,
because absence means on.

### Slice 2 — the route

`ModuleGate` beside `PlanGate`, wrapping every toggleable module's routes —
**including the ten that have no gate today** (section 1 ▲) — and a `ModuleOffPage`
with its own sentence, never `LockedFeaturePage`. Message precedence per section 7.

**Reversible** independently of 1 and 3.

### Slice 3 — writes

One term in `current_role_permits()`, after the role answer:
`AND NOT app_private.company_module_page_closed(<company>, p_page)`. Carries the
whole existing body character for character, plus a self-check restating the
fragments that must survive (the legacy-`role` fallback, the support-session
branch, the fail-closed `v_uid IS NULL` return). Extends
`tests/rls/permission-coverage.sql`; **measures** the Fahrtenbuch import path
before and after, and records the figure rather than asserting the InitPlan
reasoning.

States in its header the gap it does not close: `is_company_admin()` is not
page-keyed, so `notification_settings`, `company_settings` and the import/trip
delete are untouched — with section 6's reason for leaving them.

**Reversible:** a migration restating the previous body. Worth noting that this is
a `CREATE OR REPLACE`, so "revert" is a forward migration, not a rollback —
which is exactly why it is its own slice and not folded into slice 1.

### Slice 4 — reads: **approved by the owner on 27.10.2026, and in progress**

Section 5 is the argument and the minimum safe form. The owner overruled the
recommendation — *"اقفل كل اشي لو الموديول مقفول"* — and accepted the epoch bump
and the rollback cliff, so the minimum safe form is what governs: retrain every
reading screen **first**, then the policies, then the kit, with `documents`
excluded regardless and the export path kept open.

**4a — the measurement (`src/lib/moduleReadScope.test.ts`, 27.10.2026).** 32
cross-module read crossings, pinned as a gate. Not one of the 16 modules could
close reads, and two blockers were structural: `overview`, which is
`lockable: false` and reads five toggleable modules' tables; and the
Stundennachweis, which reads `drivers` and `driver_notes`.

**4b — the Overview, per panel (`src/utils/overviewModuleScope.ts`,
27.10.2026).** Its 20 figure-bearing panels declare the modules their numbers
come from, and a panel whose module is off states that rather than rendering a
figure. All five of its crossings are cleared; the blocking count went 32 → 27.

**4c — THE SECOND BLOCKER, found in 4b and still open.** `src/utils/backup.ts`
reads `from(table)` with the name taken from `BACKUP_TABLES`, so no scan over
`from('<literal>')` can see it. That list is **49 tables and contains every one
of the 11 the gate reaches**; its module is `datensicherung`, `lockable: false`,
which this document calls the company's own way to get its own data out. A
closed read answers 200 with no rows, which `createBackup` records as
`status: 'complete', rows: 0` — so the customer downloads an archive marked
complete, with no INCOMPLETE marker in its filename, that is missing every row
of every switched-off module.

**And this section's own carve-out cannot be implemented where the gate lives.**
"The export path stays open" needs a policy to tell a backup from a screen, and
it is the same role, the same token and the same PostgREST request. So the two
possible answers are both the owner's:

- the backup reports a switched-off module's tables as `skipped`,
  `complete: false`, INCOMPLETE in the filename — honest, and the company loses
  the ability to export that data while the module is off; or
- reads stay open and the wall stays at A + B + C.

Until one is chosen **no SELECT policy may gain a module term**, and section 7 of
`moduleReadScope.test.ts` is the gate: it fails on that combination alone, so
either answer passes and only the truncated-archive release fails.

---

## 10. What I would not build, and why

1. **Wall D — closing reads.** Section 5. An empty list is a claim about a
   customer's money; `documents` is a statutory archive under a retention
   obligation; and closing a company's read of its *own* rows buys no security
   because there is no second party. Wall C already achieves the commercial goal
   in full. Plus an epoch bump and a rollback cliff. **This is the one place I am
   recommending against what the owner said, and it is his call to overrule.**
2. **A new `modules.manage` capability.** `platform_capability_matrix()` would go
   32 → 36 pairs, `20261015150000`'s self-checks 1 and 3 fail on any count change
   or cell movement, and `tests/rls/platform-authority.sql` has to be restated.
   `companies.lifecycle` already means "what this company may do", and support
   already holds it. One matrix cell, later, if billing should sell modules.
3. **A wholesale `set_modules(company, jsonb)` RPC.** `company_role_save`'s
   documented failure: a key the build does not know is dropped on save, with a
   success toast. An older build or a rolled-back release would silently
   re-enable modules.
4. **Storing the map in `platform_settings`.** It would ship every customer's
   configuration to every customer's browser; it exceeds the 16384-byte value
   bound at a few dozen customers and then starts refusing saves; and one
   optimistic version across all companies makes two operators on two different
   customers collide.
5. **A `jsonb` column on `companies`.** Directly `PATCH`-able by any
   `companies.lifecycle` holder with no audit row, needing a
   `refuse_direct_subscription_write`-style trigger that a table with no write
   policy does not need at all.
6. **A matrix screen across all companies.** 300+ checkboxes, nowhere to show the
   per-cell plan state, and a misclick lands on another customer.
7. **A `FeatureKey` per sidebar entry.** Each one needs a migration seeding
   `plan_features`, and a key the stored map does not name reads as **premium** —
   so a build that shipped ahead of its migration would lock the feature for
   everyone. The existing code says this three times at three call sites; the
   module registry is the right place for finer granularity.
8. **Making any of the six locked entries toggleable "with a warning".**
   `/billing` and `/overview` are deadlocks: the first makes payment impossible
   and therefore makes the state permanent, the second closes the target of every
   fallback redirect. A warning does not fix a deadlock, and the refusal lives in
   the database (`module_locked`) rather than only in the screen.
9. **Any cleanup, archival or anonymisation on disable.** Section 5's prohibition.
   It is what makes `on → off → on` exactly restorable.
10. **The driver-delete question.** The owner has not decided it
    (*"الحذف استنى لسا مااخدت قرار"*). Nothing here touches it.

---

## 11. Open questions for the owner

1. **Wall D (reads).** He said "the query too". Section 5 recommends writes-only
   and gives the cost of both. **This is the one decision that changes the shape of
   the work** — writes-only is one function body; reads is an epoch bump and every
   reading screen.
2. **`/datensicherung`** — I recommend locking it (the customer's way to get their
   own data out). It is the one of the six whose lock is a judgement rather than a
   deadlock, so it is his to overrule.
3. **The `documents` group.** Four sidebar entries share the page key, so switching
   one off hides a screen and switching all four off closes 24 tables. Is the
   per-entry link granularity what he wants, or should the four be one module?
4. **`abrechnung` and `benachrichtigungen`** can be hidden but not closed (no page
   key owns their tables). Acceptable, or should they get a term of their own?
