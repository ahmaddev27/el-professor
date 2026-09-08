# Remediation plan

Derived from [FINDINGS.md](FINDINGS.md) — 71 adversarially-verified findings — plus four
defects verified directly during the pre-audit sweep.

---

## The three facts that shape this plan

**1. No critical finding survived verification.**
Nineteen findings were rated critical by their reviewer; none survived the three-lens
panel. Every proposed catastrophic path was stopped by something real — usually an RLS
policy, a DB constraint, or unreachable code. That is a genuine signal about the system:
its worst-case defences hold. It does not mean the system is safe. Thirty high findings
stand, and eleven of them put wrong numbers on statutory documents.

**2. There is no safety net, so no fix can currently be verified.**
`npm run build` is `vite build` alone — no typecheck. The project compiles cleanly while
carrying **376 TypeScript errors**, six of which are undefined identifiers that crash at
runtime. There is no test suite of any kind. Eleven payroll-math defects cannot be
responsibly repaired in a codebase where nothing can tell you whether the repair changed a
number it should not have.

**3. Nobody has checked the payroll rules against the law.**
The app contains **four** independent night/Sunday/holiday premium tables and **four**
independent German-holiday tables. Every premium finding in the audit has the form
*"module A disagrees with module B"*. Not one establishes which module is legally correct.
Converging them without an external source of truth risks standardising on a wrong rate —
turning a partial error into a uniform one.

This is why Phase 0 exists and why Phase 3 is gated behind it.

---

## Phase 0 — Make correctness verifiable

Nothing else is safe until this is done. Two tracks run in parallel; one is not a coding
task.

### 0a — Restore the type safety net · `fix/safety-net`

The 376 errors are not uniform. Triage first:

| Class | Count | Meaning |
|---|---|---|
| TS2304 | 6 | **undefined identifier — crashes at runtime** |
| TS2774 | 11 | **condition always true — a permission check that never fires** |
| TS2367 | 7 | **comparison that can never be true — a dead branch** |
| TS2345 / TS2339 / TS2322 | 140 | type mismatches, some real |
| TS6133 | 182 | unused locals — noise |

Fix the 24 errors in the top three classes; they are defects, not style. Then add a
`typecheck` script, gate it in CI, and baseline the remainder so the count can only fall.

Two are already confirmed and specific:

- `UserManagement.tsx:1152` references `showPassword` / `setShowPassword`, which are
  declared nowhere. The admin password-reset modal throws `ReferenceError` on render.
- `FixedCostsManagement.tsx` uses `canEdit` and `canDelete` — which `AuthContext` exports
  as **functions** `(createdBy?) => boolean` — as bare booleans in eight places. A function
  object is always truthy, so the "Keine Berechtigung" warning never renders and Edit and
  Delete buttons are shown to every role including `viewer`. This is finding **H5** made
  concrete: the client-side gate is not merely bypassable, here it is simply absent.

### 0b — Characterization tests for the money paths · `fix/safety-net`

Before changing a single premium calculation, lock in current behaviour:

- Feed each of the four premium engines a fixed set of driver-months — including a
  cross-midnight shift, a Sunday-into-Monday shift, a shift on a holiday that falls on a
  Sunday, and a pure-night shift — and record what each currently returns.
- These are **golden-master** tests. They are not asserting correctness; they are asserting
  *"this is what it did before I touched it"*. That is exactly the tool needed to change
  eleven interacting calculations without silent collateral damage.

### 0c — Establish the legal ground truth · **not a coding task**

Obtain, from the Steuerberater or §3b EStG directly, the authoritative answer to:

- The night window and its rate boundaries (20:00–06:00 at 25%, 00:00–04:00 at 40%).
- Whether Sunday and holiday premiums cumulate when a holiday falls on a Sunday.
- Which Bundesland's holiday calendar applies, and whether Ostersonntag and
  Buß- und Bettag count.
- Whether Grundlohn is owed for night hours in addition to the surcharge — finding **H16**
  and **H17** say the historical engine pays the surcharge with no base wage, which would
  be a plain underpayment.

**Phase 3 cannot start until this answer exists.** Write it into
`Docs/audit/PAYROLL-RULES.md` as the single referenced source, and cite it in every commit
that changes a rate.

---

## Phase 1 — Stop irreversible data loss · `fix/data-loss-guards`

These need no malice. A legitimate user clicking a legitimate button destroys records of a
closed payroll month. Cheapest fixes in the plan, highest regret if deferred.

| # | Defect | Fix |
|---|---|---|
| H2 / M14 | "Plan endgültig löschen" hard-DELETEs an applied run, bypassing `delete_or_archive_monthly_planning_run`, cascading away the finalization record and manual-exception audit | Route the button through the archive RPC; block deletion of runs that have a finalization |
| H7 | Deleting a Fahrtenbuch import cascade-destroys every trip, planning run, finalization and Ausgleichsstunden row of a finalized month | Add a DB-level guard refusing deletion when a finalization exists; change cascade to RESTRICT |
| L4 | A migration titled "harden_security_definer_functions" **re-opened** direct client UPDATE on the append-only `fahrtenbuch_trips` | Drop that UPDATE policy; the `reassign_fahrtenbuch_trip` RPC exists precisely to be the only door |
| — | The `fahrtenbuch_assignment_audit` table — documented as permanent proof — is `ON DELETE CASCADE` from the trips it audits | Detach the cascade; an audit trail that dies with its subject is not an audit trail |
| H30 / M27 | Import inserts trips in 200-row batches with no rollback; a mid-loop failure leaves a `confirmed` import whose `row_count` lies | Wrap in a transactional RPC, or mark the import `failed` and refuse to plan against it |
| Critic 3 | `historical_wh_saved_plans` is saved by DELETE-then-INSERT with no error check on the delete and no transaction | Make it an upsert, or a transactional RPC |
| Critic 3 | Super-admin company hard-delete relies on an unverified `// CASCADE delete handles all related rows` comment; orphans storage objects and auth users | Verify the cascade actually covers every table; handle storage and auth users explicitly |

---

## Phase 2 — Authorization and tenant isolation · `fix/authz-tenant-isolation`

The pattern across these findings is consistent: **restrictions live in React, not in the
database.** Any authenticated user can open the browser console and issue a `supabase-js`
call that bypasses every UI gate.

Ordered by exposure:

1. **H3 — privilege escalation at signup.** A self-registered user can set
   `role='admin'` on their own profile via `signUp` `user_metadata`. This satisfies both
   the client `isAdmin` gate and the *only* authorization check in the `manage-users` edge
   function. Fix the `handle_new_user` trigger to ignore client-supplied role metadata.
2. **H4 — `manage-users` treats a NULL caller `company_id` as "no restriction"**, dumping
   every tenant's users and permitting a password reset on the super admin.
3. **H1 — any company member can UPDATE their own `companies` row**, self-granting plan
   tier, subscription status, expiry and approval status.
4. **H6 / M6 — any member can rewrite any colleague's `user_profiles` row**, including
   `status` and `must_change_password` — enough to lock the company admin out.
5. **H5 — RLS grants every authenticated company member full INSERT/UPDATE/DELETE on all
   payroll tables.** The `viewer` and `creator` roles are decorative.
6. **M3 — policies named "Company admins can …" contain no admin predicate.**
7. **Critic 1 — `saved_stundennachweise` has no RLS enabled and no policy anywhere**, and
   the client deletes from it by id with no company filter.
8. **Critic 1 — `get_user_company_id()` / `is_user_super_admin()` are SECURITY DEFINER
   with no `SET search_path`** — and these two functions are the predicate behind most RLS
   policies in the system.
9. **M5 — suspension and soft-delete are enforced only on the password sign-in path.** An
   existing session survives revocation; the Google button skips the check entirely.
10. **M2 — `/resend-invite` has no tenant check.** **M1 — `company-signup` trusts a
    body-supplied `discount_code_id`** and never records a redemption, so `max_redemptions`
    is unenforceable even on the honest path.

---

## Phase 3 — Payroll correctness · `fix/payroll-premiums`

**Blocked on Phase 0.** Eleven high findings, all producing wrong euro amounts on documents
that go to an accountant.

The findings cluster into four groups. Fix them as groups, not individually — they overlap.

**Group A — the four engines disagree with each other.**
`FinalizePlanningModal.tsx`, `MonatsplanungStundennachweisPreview.tsx`,
`historicalWorkingHoursCleanEngine.ts` and `HistoricalWorkingHoursWizard.tsx` each carry
their own premium model. H20: the night window starts at 23:00 in one and 20:00 in another,
so 20:00–23:00 carries no premium in the monthly pipeline. H18: the monthly pipeline applies
the 40% rate to the 25% bucket and pays nothing for 00:00–04:00. **Consolidate to one
engine** — against the Phase 0c ground truth, not against each other.

**Group B — night hours receive a surcharge but no base wage.**
H16 and H17: `computeFinalSalaryCents` pays Grundlohn only for daytime seconds. A pure
night shift is paid at 25–40% of the hourly rate instead of 125–140%. If confirmed against
0c, this is systematic underpayment.

**Group C — the holiday calendar is wrong in four different ways.**
H19 (Sunday and Feiertag cumulated; Ostersonntag wrongly national), H27 (the two live
Bundesland parsers resolve the same `company_settings.state` differently), H28
(`germanHolidays.ts` is missing Reformationstag, omits BW from Allerheiligen, wrongly grants
Buß- und Bettag to Thüringen), M16/M26 (Buß- und Bettag lands on the wrong date when
23 November is a Wednesday). **One holiday table, derived from 0c.**

**Group D — the finalized PDF disagrees with the preview the user approved.**
H11 and H24: the finalized Stundennachweis **hard-codes Feiertag and Weihnachten to 0,00** —
holiday hours simply vanish from the statutory document. H13 and M22: the finalized PDF uses
a different minute model than the preview (no 30-minute minimum shift, different compression),
so the same driver-month yields two different Grundlohn totals. H14 and H25: Sonntag is
attributed by the block's `trip_date` rather than by actual clock hours, so cross-midnight
Sunday work loses its 50% Zuschlag. H12: a transfer applied from inside the finalize modal
invalidates the finalization, yet the modal keeps serving PDFs from the pre-transfer snapshot
while the XLSX is re-queried live — **the two delivered documents disagree with each other.**

Also here: **H15** — regular-driver block assignment is never written to the exported
Fahrtenbuch or the hour summary, so every non-shifted ride keeps its imported original
driver and drivers blow past their target hours. This makes the Arbeitsstunden mode's
central promise not hold.

Adjacent, same branch: **H21** — `salaries.amount_due` is written once and never refreshed,
so payment status is computed from a stale figure and drivers are marked fully paid while
money is still owed. **M17** — the payroll split adds Bankgehalt on top of a Bargehalt that
already equals the whole salary when "Brutto in Lohnabrechnung" is blank.

---

## Phase 4 — Silent truncation · `fix/pagination-truncation`

PostgREST caps a response at 1000 rows **without an error**. Six confirmed places read past
that cap and treat the truncated set as complete. Every one produces a plausible-looking
wrong number.

- **H8** — saved-plan Fahrtenbuch re-export loads trips unpaginated: the delivered statutory
  XLSX is silently cut off.
- **H9** — wizard driver auto-population reads trips unbounded and unordered: drivers
  appearing after ride 1000 are dropped from the plan entirely.
- **H29** — salary calculation loads `income` unpaginated, so a driver's revenue can read as
  zero — **and that zero is then written into the `salaries` table.**
- **M9** — the Overview dashboard loads all income and filters in JS; its Umsatz and Gewinn
  figures are wrong for any company past the cap.
- **M21** — export pagination orders by a non-unique key across separate `range()` calls, so
  rows can be duplicated or dropped.
- **M24** — the finalization pre-flight itself paginates with **no ORDER BY**, so the
  statutory gate runs on a non-deterministic row set.

M24 deserves emphasis: the gate that decides whether documents may be released is itself
non-deterministic.

---

## Phase 5 — Debt and consolidation

Lowest urgency, highest long-term leverage. Do not start before Phases 1–3 land.

- `chore/dead-code` — remove the ~14.7k lines confirmed dead. This alone deletes three of
  the four competing premium engines' dependencies and makes Phase 3's consolidation
  tractable.
- `refactor/consolidate-engines` — one block builder, one holiday table, one premium model,
  one set of constants. The divergent `MIN_VEHICLE_SWITCH_BUFFER_MINUTES` (60 vs 30) is a
  symptom, not the disease.
- `fix/schema-completeness` — write the missing `CREATE TABLE` migrations for `companies`,
  `drivers`, `receipts`, `saved_stundennachweise` so the chain can build a database.
  Related: **L5**, a non-idempotent unguarded UPDATE that grants every `inactive` company an
  active subscription on any chain re-run.
- `chore/bundle-splitting` — one 3.66 MB JavaScript chunk (963 kB gzipped), no code
  splitting.
- Remaining mediums and lows in FINDINGS.md.

---

## What this plan does not cover

The audit's own critics identified live, document-producing code that **no reviewer
opened**:

- `src/pages/StundennachweisPage.tsx` — 3,985 lines, routed at `/stundennachweis`,
  persists to `saved_stundennachweise`, and exports statutory PDFs. **Zero findings**
  because nobody looked.
- `HistoricalReconciliationWizard.tsx` + `shiftBlockEngine.ts` — the entire Brutto-Gehälter
  pipeline, reachable from the planner. Contains a fourth premium table and a fourth holiday
  table.
- The Ausgleichsstunden adjustment subsystem — the only mechanism reconciling app hours to
  the Steuerberater's Brutto figures.
- Migration-chain replay safety against the live database. One example already found:
  `20251008100001_fix_income_table_created_by.sql:15` is an unguarded
  `DROP TABLE IF EXISTS income CASCADE`.
- Concurrency between two admins of the same company working the same month — no locking,
  no stale-view detection anywhere.
- Statutory working-time and minimum-wage limits (MiLoG, ArbZG) are modelled **nowhere** in
  a product whose entire output is a working-time record.

A second audit round should target these before Phase 3 is considered complete.

---

## Suggested order

```
Phase 0  safety net + legal ground truth     ← blocks Phase 3; 0c is not a coding task
Phase 1  irreversible data loss              ← cheap, do immediately
Phase 2  authorization & tenant isolation
Phase 3  payroll correctness                 ← the reason the product exists
Phase 4  silent truncation
Phase 5  debt, consolidation, schema
```

Phases 1 and 2 can run concurrently with Phase 0 — they touch different code and need no
payroll ground truth.

**If the system is currently live with real customers**, Phase 1 and the H3/H4 items of
Phase 2 should be treated as same-day work, and the team should decide whether to keep
issuing Stundennachweise while Phase 3 is outstanding. Documents already filed were produced
by the code described in Phase 3.
