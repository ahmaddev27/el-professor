# A per-company timezone — blast-radius assessment

**Status: assessment only. No production code, no migration, no test change.
Awaiting the owner's answers to §4 before any code is written.**

Written 23.10.2026, against `staging` at `11f4017`.

Everything below is marked **measured** (a command was run, a file was read) or
**inferred** (a conclusion drawn from what was read). Where a reading of the
repository contradicts a measurement, the measurement is given and the reading
is named as wrong — including one case where this repository's own comment is
overstated.

---

## 1. Why this document exists

An external audit (`corection/FleetBook_Claude_Correction_Prompt.txt`, §3) asks
that parse and serialize be made *"timezone aware, and configurable per
tenant"*, and (§5) that tests cover *"multiple tenants with different timezones
and operating-day cutoffs, midnight and DST changes"*.

Today `'Europe/Berlin'` is a hard constant. `companies` has no timezone column
(**measured**: `ADD COLUMN …time_zone` matches exactly one line in all 270
migrations, and it is on `fahrtenbuch_trips`, not `companies`).
`vitest.config.ts:11` pins `process.env.TZ = 'Europe/Berlin'` for the whole
suite.

The owner has approved building this **as its own slice**, on the condition
that the blast radius is measured and put in front of him first. This is that
step.

### The repository has already taken the opposite decision, three days ago

**Measured.** Three migrations merged on 23.10.2026 state the position in
their headers, twice in near-identical words:

> `20261023120000_driver_month_assignments.sql:115` — *"Europe/Berlin is a hard
> constant in some fifteen modules of this codebase and vitest.config.ts pins
> TZ=Europe/Berlin for the payroll golden masters; **there is no per-company
> timezone and this file does not introduce one**."*

> `20261023130000_vehicle_availability.sql:79` — *"There is no per-company
> timezone and none is introduced."*

And the position is **machine-enforced**. Self-check 10a of
`20261023120000` (lines 1805–1812) reads the gate function's own source and
raises unless it contains the literal `now() AT TIME ZONE 'Europe/Berlin'`
**and** contains **exactly one** `AT TIME ZONE` in the whole body:

```sql
OR (SELECT count(*) FROM regexp_matches(v_src, 'AT\s+TIME\s+ZONE', 'gi')) <> 1 THEN
  RAISE EXCEPTION 'driver month assignments self-check 10a: the gate''s clock is
    no longer …, or reads a second zone';
```

So this is not a gap to be filled. It is a documented, asserted decision that
the audit is asking to reverse, and the reversal fails a migration self-check
until that self-check is rewritten in the same commit. That is a cost, and it
is also a safety rail working as designed.

---

## 2. The inventory, measured

### 2.0 Counting rule

A single number here would be dishonest, because the sites divide into three
kinds with wildly different costs. The rule used throughout:

- **Tier A — an executable zone literal.** Code evaluates the string
  `'Europe/Berlin'`. Cheap to find (`rg` finds it), cheap to parameterise.
- **Tier B — a zone-*implicit* site.** No string exists. The code reads the
  **process zone** through `new Date(y, m, d, h)`, `.getHours()`, `.getDay()`
  or `date-fns`. **`rg 'Europe/Berlin'` does not find these, and they are the
  expensive ones.** This is the single most important line in the document.
- **Tier C — an assertion that pins the literal.** A test or a migration
  self-check that would fail if the constant moved.

**Totals (measured):**

| Tier | Count | Where |
|---|---|---|
| **A** — executable literals | **30** | 16 in SQL (13 database objects); 6 in `src/` code; 6 in `src/i18n` user-facing strings; 2 executable + ~4 display formatters in edge functions |
| **B** — zone-implicit modules | **14** | the payroll core and the planning engines — §3 |
| **C** — assertions pinning it | **~105** | 6 SQL self-checks; 75 occurrences in 9 `tests/rls/*.sql` files; ~20 vitest files; `vitest.config.ts` |
| *Excluded: unreachable* | 1 | `HistoricalWorkingHoursWizard.tsx:7598`, inside `AutoShiftPlanView` |

**So: 44 production sites, and ~105 places that assert the current value.**

The unreachable site was confirmed, not assumed (**measured**):
`AutoShiftPlanView` is declared at line 6895 and the next top-level
declaration is at 9002, so line 7598 is inside its body; `<AutoShiftPlanView`
appears nowhere as a JSX tag; `inhaberAutoShiftResult` occurs once outside
that range — its `useState(null)` at line 9941 — and is never read. It is not
counted as blast radius.

### 2.1 The audit's request conflates three different zones

This is the central design finding, and getting it wrong would produce a
feature that is actively harmful. **Measured** from the source comments and
confirmed by what each site computes:

| | Axis A — **the source file's zone** | Axis B — **the partner's reporting convention** | Axis C — **the zone the company operates in** |
|---|---|---|---|
| What it is | The zone the zone-less wall times in Uber's XLSX export were written in | Uber's Monday-04:00 week and 04:00 operating day | The employer's own working day: premium bands, day attribution, schedule times |
| Owned by | the **file format** | the **integration** | the **company** |
| Correct configurability | per import source / per file | per integration, and only if Uber's convention varies by market | **genuinely per-company** |
| Sites | `fahrtenbuchImportParser.ts:108/533/591`; the SQL twin `c_zone` in `fahrtenbuch_times_from_cells`; `returnCheck/parse.ts:55`; `simulatedRides/time.ts` (×5); `FahrtenbuchImportModal.tsx:157` | `uberEarningsImport.ts:98`; `uberPeriods.ts:64`; `uber-pull-core.ts:51`; `uber-earnings-core.ts` (prose only) | `localDayWindow.ts` + its 6 importers; `computeLohnartSeconds`; `weekCalculations.ts`; `uber_pull_schedules.run_time`; `abrechnung_schedules.send_time`; `tripAnalysisShifts.ts:43` |

**Only axis C is a per-company setting.** The parser says so itself
(`fahrtenbuchImportParser.ts:107`: *"the zone every wall-clock time in the
**source files** is read in"*), and `uber-earnings-core.ts:19-23` says axis B
belongs to the partner (*"Reidey applies the offset; nothing in this module
does"*).

**Why this matters concretely.** Two sites would break if a company zone were
applied to them:

- `FahrtenbuchImportModal.tsx:157` renders the preview table on *"the clock the
  file was written in"* (its own JSDoc) so the operator can compare the preview
  against the uploaded file. Switch it to a company zone and the operator's
  verification step silently stops matching the file.
- `uberPeriods.ts:64` decides which Uber week "now" falls in. A per-company
  override desynchronises the local chooser from Reidey's actual week
  boundaries and **misattributes a week's money** — and those segment dates are
  stored (`income.source_period_start` / `source_period_end`).

For a German fleet all three axes have the same value, which is exactly why the
conflation is invisible today.

### 2.2 The SQL side — 16 live executable sites in 13 objects

The migration chain redefines functions, so the **live** definition is the
newest one that defines each. **Measured:** 70 occurrences of `Europe/Berlin`
in `supabase/migrations/`, of which 18 are executable `AT TIME ZONE`
expressions; **4 of those 18 are in definitions a later migration dropped and
are dead text** (`20260919170000:382-383`, `20260924100000:317`,
`20261007110000:283`). Plus 2 executable `c_zone CONSTANT` declarations. No
generated column and no index uses the zone (**measured**: both greps empty).

| Object | Live definition | Class | Stored permanently? | Company in scope? |
|---|---|---|---|---|
| `app_private.subscription_invoice_apply(uuid,boolean)` | `20260921130000:274` | **MONEY/DOCUMENT** | **yes** — `subscription_coverage.period_start/_end` | yes |
| `app_private.invoice_grace_end(date)` | `20260919170000:283` | **MONEY/DOCUMENT** | via its caller | **no** — bare date, 1 caller |
| `app_private.fahrtenbuch_times_from_cells(...)` | `20260922100000:471` | **MONEY/DOCUMENT** | **yes** — `start_at`/`end_at`/`time_zone`, immutable | **no** — cells + dates only |
| `public.void_salary_cash_receipt(uuid,text)` | `20260914140000:560` | **MONEY/DOCUMENT** | **yes** — `cash_movements.movement_date`, append-only | yes |
| `app_private.partner_note_apply(uuid)` | `20261013100000:256`, spliced by `20261013130000` | MONEY/DOCUMENT (arguable) | **yes** — `driver_notes.note_date` | yes |
| `public.notification_candidates(int,int,uuid)` | `20261015170000:226` | OPERATIONAL | no | **no** — sweep over all companies |
| `public.uber_pull_candidates(int,uuid)` | `20261015130000:279` | OPERATIONAL | no | **no** — sweep |
| `public.uber_pull_claim(uuid,date,text)` | `20261015130000:342` | OPERATIONAL | no | yes |
| `app_private.driver_month_assignment_days_remaining(int,int)` | `20261023120000:487` | OPERATIONAL (+ stored audit tail) | **partly** — `opened_early`, `early_days_remaining`, immutable | **no** — year + month only |
| `public.confirm_salary_cash_payment(...)` | `20260914140000:363` | OPERATIONAL (future-date guard only) | no | yes |
| `public.record_cash_movement(...)` | `20261003130000:51` | OPERATIONAL (guard only) | no | yes |
| `app_private.platform_audit_purge()` | `20260921100000:222` | DISPLAY/RETENTION | zone + cut-off recorded in its own audit row; the `DELETE` is irreversible | **no** — platform-wide |
| `app_private.platform_invoices_list_statement()` | `20260924110000:304` | DISPLAY/RETENTION | no | **no** — cross-tenant count |
| `app_private.fahrtenbuch_wall_to_instant(timestamp,text,…)` | `20260922100000:441` | **already takes the zone** | — | zone is a parameter |

Sorted by what a per-company zone would cost:

- **Free — the company row is already being read:** `subscription_invoice_apply`
  (`v_inv.company_id`, already `SELECT`s `companies`), `partner_note_apply`,
  `confirm_salary_cash_payment`, `void_salary_cash_receipt`,
  `record_cash_movement`, `uber_pull_claim`.
- **A signature change — the company is at the caller, not in the function:**
  `invoice_grace_end` (1 caller), `driver_month_assignment_days_remaining`
  (2 callers, both with the company in scope, **and the self-check above pins
  the body**), `fahrtenbuch_times_from_cells`.
- **Structurally hard — a cron sweep with no single company, where the zone sits
  in a predicate an index serves:** `notification_candidates` (the window
  predicate is served by `cars_company_tuev_idx`, added precisely so the nightly
  run is not a sequential scan of every car in the installation) and
  `uber_pull_candidates`. Moving the zone inside the per-company term makes the
  predicate non-sargable — *inferred* from sargability, not measured here.
- **Not applicable — genuinely platform-wide:** `platform_audit_purge` (the
  platform audit log, no tenant exists) and
  `platform_invoices_list_statement` (a cross-tenant count on one operator's
  screen; it already mixes two zones deliberately, reading `overdue_count` in
  `'UTC'`).

#### Two SQL findings worth separating out

**`fahrtenbuch_wall_to_instant` already solves the hard part.** It takes the
zone as an argument, resolves a wall time against that zone's actual rules, and
returns a `candidates` count: `1` is the answer, `2` means the hour repeats
(autumn), `0` means it was skipped (spring). **It needs no change at all for a
per-tenant zone.** Its caller `fahrtenbuch_times_from_cells` is where
`c_zone CONSTANT text := 'Europe/Berlin'` is hard-coded.

**The Abrechnung and Uber schedules are the cheapest honest win.** A per-company
time of day is **already stored per company** —
`abrechnung_schedules.send_time time(0)` and
`uber_pull_schedules.run_time time(0)`, both commented *"a Europe/Berlin
wall-clock time"*. Only the zone it is read in is global, and that reading lives
in TypeScript (`abrechnung-schedule-core.ts:101`), not in SQL. **Measured, and
it contradicts the occurrence counts:** the live
`abrechnung_schedule_candidates` (`20261015120000:147`) and
`abrechnung_schedule_preview` (`20261015140000:218`) contain **no**
`Europe/Berlin` and no `AT TIME ZONE` at all; every occurrence in
`20261003120000` and `20261004100000` is prose or a `COMMENT`.

#### `vehicle_day_plans` is the model to copy, and it costs nothing

**Measured:** `grep -c "AT TIME ZONE" 20261022140000_vehicle_day_plans.sql` → 0,
and the file contains no `Europe/Berlin`. It already solves the per-tenant
operating-day problem:
`vehicle_day_plans.operating_day_start_hour integer NOT NULL` with no default,
`CHECK (… BETWEEN 0 AND 23)`, frozen for the plan's life by
`vehicle_day_plan_guard`, and every moment stored as `timestamp` **without**
time zone — wall clock — so `vehicle_day_shift_guard` recomputes the moments
from the stored hour with plain arithmetic.

`20261023130000_vehicle_availability.sql:320-327` states the DST reasoning
explicitly: *"25.10.2026 is a 25-hour local day and 29.03.2026 a 23-hour one;
because every boundary here is built from its own day's calendar parts and
compared as wall clock, both days are one operating day like any other. That
exact mistake — advancing a day by a fixed number of milliseconds — gave 11 real
rides on staging to drivers marked sick."*

**The wall-clock-plus-stored-hour pattern is per-tenant-ready for free.** The
functions that are hard are the ones that convert `now()` into a
tenant-relative calendar day.

### 2.3 Six self-checks and nine RLS files assert the literal

**Measured.** This is blast radius the occurrence counts hide, and it will
block a migration from replaying:

| file:line | asserts |
|---|---|
| `20260921110010:181` | `'Europe/Berlin'` appears in `confirm_salary_cash_payment`'s `prosrc` |
| `20260921110010:203` | same, for `void_salary_cash_receipt` |
| `20261013100000:567` | the fragment appears in `partner_note_apply` |
| `20260922100000:1045` | the derived `time_zone` **equals** `'Europe/Berlin'` |
| `20260922100000:961` | a fixture literal in an immutability probe |
| `20261023120000:1805-1812` | the literal **and** exactly one `AT TIME ZONE` |

`tests/rls/*.sql` holds **75 occurrences across 9 files**, heaviest in
`subscriptions.sql` (29) and `fahrtenbuch-import.sql` (30).

**And there is a pattern in them worth naming:** the tests **re-derive the
expected value with the same hard-coded constant** rather than asserting against
a fixture. `tests/rls/subscriptions.sql:933-934` recomputes the coverage
boundary in Berlin itself and asserts the function matches. So they verify
*consistency*, not *correctness* of the zone — **they would pass trivially if
the production constant and the test constant were changed together, and they
would not catch a per-tenant implementation that silently fell back to Berlin.**

**Three functions are spliced, not rewritten** — their live bodies are produced
by `pg_get_functiondef` + text `replace` + `EXECUTE`, with whitespace-exact
anchors (`20260921110010:117-149`, `20260919160000`, `20261013130000:257-316`).
*Inferred:* editing the zone line in `confirm_salary_cash_payment` or
`partner_note_apply` means either a fresh full `CREATE OR REPLACE` restating
every spliced block by hand, or a fourth splice.

### 2.4 `fahrtenbuch_trips.time_zone` — stored, constrained, and never read

**Measured.** The repository's only *zone-of-record*, and the pattern to copy:

- **Writers, both constants:** `fahrtenbuchImportParser.ts:938`
  (`time_zone: times.timeZone`, the live production path) and the one-time SQL
  backfill in `20260922100000:718-726`.
- **Frozen after insert:** listed in `protect_fahrtenbuch_immutable_fields`
  (`:886`, `:915`); `fahrtenbuch_trips_times_consistent` (`:789-797`) makes
  `start_at`/`end_at`/`time_zone` all-or-nothing.
- **Readers: no production code path does arithmetic with it.** The only
  references are the `CHECK`, the self-check, and a type declaration at
  `useFahrtenbuch.ts:43`. `tripAnalysis/adapter.ts` — the single adapter every
  analysis screen goes through — reads `start_at`/`end_at` as absolute and
  **ignores `time_zone` entirely**. No `AT TIME ZONE t.time_zone` exists in any
  migration.

**Both halves matter.** Good: the Fahrtenbuch is the one table whose history
stays re-interpretable, and the carrier already exists. Bad: because nothing
reads it, storing a different value there today would change **nothing** about
how any screen interprets `start_at` — the interpretation lives in the process
zone, not in the column.

### 2.5 DST handling — correct at the boundary, lossy on the way to storage

**Measured.** `wallTimeToInstant` (`fahrtenbuchImportParser.ts:526-547`) tries
every offset the zone uses either side of the day and keeps the readings that
round-trip: one hit is the answer, two is `'ambiguous'` (October), zero is
`'nonexistent'` (March). It never guesses and never normalises forward. The SQL
twin behaves identically.

**But the distinction is erased on the way to the database.** `resolvePair`
(`:585-587`) collapses both to `time_source = 'ambiguous'` with `start_at`,
`end_at` and `time_zone` all NULL; the `TimeSource` union has no
`'nonexistent'` member. `returnCheck/parse.ts` collapses both to
`problem: 'unparsed'`.

*Inferred, and it is a real constraint on stage 2 below:* **the stored history
cannot tell a skipped hour from a repeated one.** Under a different zone a row
that is `'ambiguous'` today may be perfectly readable — and the row is immutable,
so it cannot be re-derived in place.

### 2.6 `trip_date` vs `start_at`, and where the 04:00 cutoff actually is

The audit's **FB-WARN-001** reports 42 rows whose operating trip date differs
from the start's civil date, *"consistent with a potentially configured 04:00
operating day"*.

**Measured:** there is **no 04:00 cutoff anywhere in the real-file import
path.** `buildTripRows` takes "Datum der Fahrt" verbatim (`:858`, `:912`) and
invents a date only when the file has none (`:867`, with a
`missing_trip_date` reason). The divergence is counted, never corrected
(`:890`, `stats.startDateDiffers`), and surfaced as an *info* notice. The
parser's own measured window for the real export is **00:00–00:30**, not
00:00–04:00 (`fahrtenbuchImportParser.ts:24-26`, with 22 such rides in
August 2026 pinned by its test at `:176-184`).

Four separate 04:00 constants exist, in three paths, and **none touches an
imported real trip's `trip_date`**:

1. `simulatedRides/time.ts:4` `OPERATING_DAY_START_HOUR = 4` — **the only place
   in the ingestion path where a 04:00 rule writes a `trip_date`**, via
   `simulatedRides/sheet.ts:22-31`, whose output goes through the ordinary
   importer.
2. `uber-pull-core.ts:51` `OPERATING_DAY_START_MINUTES = 4 * 60` — earnings-pull
   scheduling only.
3. `uberEarningsImport.ts:98` `UBER_WEEK_START_HOUR = 4` — Uber's reporting week.
4. `shiftRecommendation/settings.ts:22` `operatingDayStartHour: 4` — **already
   per-company configurable**, picked in `SettingsStep.tsx:243`, validated,
   and persisted as `operating_day_start_hour`.

> **A measurement to take before answering the audit on FB-WARN-001.**
> *Inferred:* those 42 rows look like **generated** rides rather than a property
> of Uber's export — a full 00:00–04:00 spread is the generator's signature,
> while the measured real-file window is 00:00–00:30. `simulatedRides` is
> reachable production code (routed at `App.tsx:666` behind the `dokumente` plan
> feature, with no dev flag), so this is entirely possible.
> **Check `fahrtenbuch_imports.is_simulated` for the rows behind those 42 cells
> before conceding a 04:00 property of the real export.** This document does not
> assert either way.

### 2.7 Display-only, and already zone-immune by design

**Measured.** Ten production sites are cosmetic (two `tripAnalysisView.ts`
formatters, three `platformFormat.ts` formatters that deliberately render in the
*browser's* zone, `backup.ts`'s filename stamp, `abrechnungSchedulePreview.ts`,
and three i18n keys).

Eight modules are **already zone-immune on purpose**, each with a recorded
production post-mortem, and they cost nothing in a timezone change:
`cashLedger.ts` (compares `YYYY-MM-DD` as text), `salaryPeriodOverlap.ts`,
`salaryRowEdit.ts`, `invoiceDueDate.ts` (pure string arithmetic after two
production invoices showed a false *Überfällig* badge), `ui/format.ts`,
`ReceiptList.tsx` (after every receipt on the last day of a week or business
month vanished from the list, the total, the Excel export and the
Steuerberater's PDF — 93 of 915 production receipts on a Sunday),
`IncomeGroupedList.tsx`, `TripAnalysisTimeline.tsx`. **These are the pattern to
cite in any reply to the audit.**

Three i18n keys are a **promise** that would become false:
`ta.shiftsSource`, `settings.abrSchedule.timeHint`,
`settings.uberPull.timeHint` — each hard-codes "Europe/Berlin" in both
languages.

### 2.8 One correctness dependency nobody would guess

**Measured.** `shiftRecommendation/timeline.ts:71-73` floors slots in **UTC**,
justified at `:6` by *"Europe/Berlin is always a whole number of hours off
UTC"*. `settings.ts:18` allows `SUPPORTED_SLOT_MINUTES = [15, 30, 60]`.
*Inferred:* for any zone with a 45-minute offset (`Asia/Kathmandu`,
`Australia/Eucla`) the 30- and 60-minute slots silently misalign with local
wall-clock boundaries. This is the only site found where the constant is
load-bearing for **correctness** rather than for labelling.

---

## 3. The payroll core — judged separately, and first

### 3.1 The mechanism

**Measured.** `computeLohnartSeconds`
(`historicalWorkingHoursCleanEngine.ts:120`) walks local calendar days:

```ts
const startDate = new Date(startMs);
const dayStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0);
for (let d = dayStart; d.getTime() < endMs; ) {
  const nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  const dayKey  = `${d.getFullYear()}-…`;
  const isSunday  = d.getDay() === 0;
  const isHoliday = holidaySet.has(dayKey);
  const n40End = localHourMs(dMs, 4);   // 00:00–04:00 → Lohnart 1501 (40 %)
  …                                      // 04:00–06:00 and 20:00–24:00 → 1500 (25 %)
```

Every one of `getFullYear`, `getMonth`, `getDate`, `getDay` and `localHourMs`
reads the **process zone**. There is no string to parameterise. This is a
Tier B site, and it is the whole payroll core.

**`localDayWindow.ts` is the hardest module in the repository for this work, and
it does not appear in any `rg 'Europe/Berlin'` count** (**measured**:
`grep -c 'Europe/Berlin'` → **0**). Its five exports — `localMidnightMs`,
`nextLocalMidnightMs`, `localHourMs`, `localDateKey`, `splitAtLocalMidnight` —
are the runtime-local primitive set, imported by six production modules:
`historicalWorkingHoursCleanEngine.ts`, `monthlyPlan/blocks.ts`,
`monatsplanungRepairPass.ts`, `shiftRecommendation/timeline.ts`,
`FinalizePlanningModal.tsx`, `MonatsplanungStundennachweisPreview.tsx`.

Its own header records the defect it exists to remove, and the stake:

> *"Spring forward … the day is **23** hours … an hour moves from 1500 (25 %)
> up into 1501 (40 %) — paid too generously … Fall back … the day is **25**
> hours … credited as 1500 instead of 1501 — paid too little, on a night shift,
> on the night the driver worked an hour longer than the clock suggests.*
> ***26 production trips already sit on 29.03.2026, and the next transition is
> 25.10.2026.***"

**That next transition is two days from the date of this document.**

Zone-implicit day-boundary code in the payroll and planning path
(**measured**, counts of local `Date`-from-components constructors and local
getters):

| module | local ctors | local getters |
|---|---|---|
| `historicalWorkingHoursCleanEngine.ts` | 4 | 13 |
| `weekCalculations.ts` | 2 | 5 |
| `historicalRowLevelEngine.ts` | 2 | 2 |
| `monatsplanungPhase3.ts` | 2 | 1 |
| `monatsplanungRepairPass.ts` | 2 | 1 |
| `monatsplanungPhase1.ts` | 0 | 2 |
| `shiftBlockEngine.ts` | 0 | 2 |
| `monthlyPlan/blocks.ts` | 1 | 0 |
| `fahrtenbuchExport.ts` | 1 | 0 |
| `monatsplanungPhase4.ts` | 0 | 0 |

`weekCalculations.ts` is zone-implicit through `date-fns` on
`new Date(year, month, 1)`. The business-week rule — **a week belongs to the
month containing its Monday** — and the module's **0-indexed** month
(`getBusinessMonthRange(4, 2026)` returns **May**) are both unaffected by a
zone *in themselves*, because they are calendar arithmetic; what moves is
*which* calendar day a stored instant lands on before that arithmetic begins.

**The export builders are clean (measured).** `fahrtenbuchExport.ts`,
`historicalWorkingHoursFahrtenbuchExport.ts`,
`historicalWorkingHoursStundennachweisPreview.ts`,
`monthlyPlanDocumentBuilders.ts` and `stundennachweisArchiveExport.ts` contain
**zero** `Europe/Berlin` and almost no local date reads — they render values
they are handed. The zone dependence is entirely upstream, in the engine. Two
exceptions worth one line each:
`historicalWorkingHoursStundennachweisPreview.ts:125` picks the holiday
table's **year** with `new Date(block.startMs).getFullYear()` (process zone —
an instant at 23:30Z on 31 December reads as the next year in Berlin and the
old one in UTC, selecting the wrong holiday table), and
`monthlyPlanDocumentBuilders.ts:114` builds a date key from local getters.

### 3.2 Which golden snapshots would move — measured, and the answer is none

This is the question the brief asks, and the measured answer inverts the
premise. **Every claim in this subsection was measured by running the suite,
not inferred.**

**Method.** A measurement-only vitest config was placed in the repository, run,
and deleted (it is not in this branch). It is identical to `vitest.config.ts`
except that the zone comes from a `TZ_PROBE` variable, so
`src/utils/*.golden.test.ts` could be run in zones other than Berlin.

**Control (must be green):** `TZ_PROBE=Europe/Berlin` → exit 0,
**4 test files, 139 tests passed.**

**Result:**

| zone | exit | result |
|---|---|---|
| `Europe/Berlin` (control) | 0 | 4 files, 139 tests passed |
| `Asia/Kolkata` (+05:30, no DST) | 0 | **all passed** |
| `America/New_York` (US DST dates) | 0 | **all passed** |
| `Europe/Lisbon` (EU DST, different offset) | 0 | **all passed** |
| `Australia/Eucla` (+08:45) | 0 | **all passed** |

**Positive control, so the green is not vacuous.** A probe test asserting
Berlin's own offsets was run in the same harness and **failed loudly**
elsewhere, proving `TZ` reaches the worker:

```
Asia/Calcutta     → janOff -330, marOff -330, octOff -330
America/New_York  → janOff  300, marOff  240, octOff  240
Europe/Berlin     → janOff  -60, marOff -120, octOff  -60   (control, passed)
```

**So: a per-company zone would move no golden snapshot — and that is the
finding, not the reassurance.**

The reason (**measured**): `lohnart.golden.test.ts:34-36` builds its inputs
with `new Date(y, m - 1, d, hh, mm)` — the comment says *"Local-time
constructor, matching how the engine reads dates."* The test input and the
engine's reading of it are in the **same** zone, so they cancel. The snapshots
describe **wall-clock behaviour**, not Berlin behaviour. And no golden case
crosses a DST boundary.

**This contradicts `vitest.config.ts`'s own comment**, which states that *"A run
in another timezone would classify night, Sunday and holiday hours differently,
so the golden masters are only meaningful pinned to the zone the product
actually runs in."* The first half is true of production and false of these
tests. The comment is overstated, and the practical consequence is severe:

> **The golden masters are blind to exactly this change.** They would stay green
> through a per-company timezone that silently re-banded every night shift. The
> safety net this work most needs does not exist yet, and building it is a
> prerequisite, not a follow-up.

**`getGermanNationalHolidays` is zone-invariant (measured).** It returned the
identical ten dates for 2026 in all three zones:
`2026-01-01, 04-03, 04-05, 04-06, 05-01, 05-14, 05-25, 10-03, 12-25, 12-26`.
So `holidays.golden.test.ts` and `weekCalculations.golden.test.ts` are sound —
they are pure date arithmetic. **The pre-existing disagreement between the two
holiday tables is not a timezone matter and must not be attributed to this
work:** `holidays.golden.test.ts.snap` pins it as exactly one date per year in
`onlyInCleanEngine` — `2026-04-05`, `2025-04-20`, `2024-03-31`, `2027-03-28` —
which is Ostersonntag, every year.

### 3.3 What *does* move a figure — measured

Production does not hand the engine a wall-clock description. It hands it an
**absolute stored instant** (`fahrtenbuch_trips.start_at`, immutable by
trigger), and the engine reads its band boundaries in the process zone. So the
same stored row yields a different premium split per zone.

Measured by calling `computeLohnartSeconds` on fixed UTC instants with the real
2026 holiday set, in three zones. Figures are hours:

| stored instant | zone | base | **n25 (1500)** | **n40 (1501)** | **Sunday** | total |
|---|---|---|---|---|---|---|
| `2026-03-10 21:00Z → 11 05:00Z` | Berlin | 0 | **4** | **4** | 0 | 8 |
| | Kolkata | 4.5 | **2** | **1.5** | 0 | 8 |
| | New York | 3 | **4** | **1** | 0 | 8 |
| `2026-03-08 19:00Z → 09 03:00Z` (Sun→Mon) | Berlin | 0 | 4 | 4 | **4** | 8 |
| | Kolkata | 2.5 | 2 | 3.5 | **0** | 8 |
| | New York | 5 | 3 | 0 | **8** | 8 |
| `2026-03-28 22:00Z → 29 06:00Z` (DE spring-forward) | Berlin | 2 | 3 | **3** | 7 | 8 |
| | Kolkata | 5.5 | 2 | **0.5** | 8 | 8 |
| `2026-10-24 22:00Z → 25 06:00Z` (DE fall-back) | Berlin | 1 | 2 | **5** | 8 | 8 |
| | Kolkata | 5.5 | 2 | **0.5** | 8 | 8 |

**Read the first row and the Sunday row plainly:**

- One eight-hour night shift is **4 h at 25 % + 4 h at 40 %** in Berlin, and
  **2 h + 1.5 h with 4.5 h unpremiumed base** in Kolkata. Lohnart 1501 — the
  40 % steuerfrei band — moves by **2.5 hours on a single shift**.
- A Sunday-into-Monday shift carries **4 h** of Sunday premium in Berlin,
  **0 h** in Kolkata and **8 h** in New York. **The Sunday premium swings by
  the whole shift.**
- Berlin's own two DST days are genuinely asymmetric (n40 of **3** on the
  23-hour day against **5** on the 25-hour day), which is `localDayWindow.ts`'s
  correction working.

**Every one of these numbers is a payroll figure for a real person, on a
document that goes to a Steuerberater.** Each is `1500` or `1501` — the
§3b EStG steuerfrei bands — and §3.4 is why none of them can be called correct
or incorrect today.

### 3.4 This work is downstream of a blocker that already exists

**Measured**, from `Docs/audit/REMEDIATION-PLAN.md:25` and `:78-100`:

> *"The app contains **four** independent night/Sunday/holiday premium tables
> and **four** independent German-holiday tables. Every premium finding in the
> audit has the form 'module A disagrees with module B'. **Not one establishes
> which module is legally correct.** Converging them without an external source
> of truth risks standardising on a wrong rate — turning a partial error into a
> uniform one."*

Phase 0c — *"Establish the legal ground truth · **not a coding task**"* — asks
the Steuerberater for the night window and its rate boundaries, whether Sunday
and holiday premiums cumulate, which Bundesland's calendar applies and whether
Ostersonntag counts, and whether Grundlohn is owed for night hours in addition
to the surcharge. **"Phase 3 cannot start until this answer exists."**

The engines themselves say the same thing in the comments at the exact lines a
zone change would touch —
`historicalWorkingHoursCleanEngine.ts:152`,
`MonatsplanungStundennachweisPreview.tsx:235`,
`FinalizePlanningModal.tsx:484` all record that the differing band hours
(20:00 here, 23:00 there) are *"a decision about §3b EStG and not about
timezones."*

**The honest conclusion: the zone question for the payroll core cannot be
settled before the §3b question.** Asking "does §3b's night window follow the
employee's local time?" of a codebase that carries four mutually inconsistent
answers to "what *is* the night window?" produces a per-tenant feature built on
a rate nobody has checked. The right order is 0c, then the payroll zone — and
§5 and the staged plan below are written on that basis.

---

## 4. Questions only the owner can answer

Each answerable in one line. **1, 2 and 10 block any code at all.**

1. **What is a company's timezone *for*?** §2.1 found three different zones
   collapsed into one constant: (a) the zone Uber's export writes its wall
   times in, (b) Uber's 04:00 reporting convention, (c) the zone the company's
   employees actually work in. **Only (c) is a company setting.** Is (c) what
   you want, and are (a) and (b) to stay as they are?
2. **What happens to the existing data of a company whose zone is then set?**
   Is history re-interpreted under the new zone, or does the zone apply from a
   date forward? Every `subscription_coverage` period, every
   `cash_movements.movement_date` and every `driver_notes.note_date` already on
   production was computed in Berlin **with nothing recording that it was
   Berlin**.
3. **Is a ride imported from Uber read in the source file's zone or the
   company's?** If a German fleet's file is always Berlin regardless of where
   the company is, (a) is a property of the integration and never moves.
4. **Does §3b EStG's night/Sunday definition follow the employee's local time in
   every case** — including a driver working a shift abroad? *This is a question
   for the Steuerberater, and it sits behind Phase 0c (§3.4).*
5. **A shift spanning a DST transition: what is owed?** 25.10.2026 is a
   **25-hour** day and 29.03.2026 a **23-hour** one. A 22:00–06:00 shift is
   9 real hours on the first and 7 on the second. Is the driver paid elapsed
   time, or clock time? Which band does the repeated 02:00 hour fall in?
6. **Is there a customer who needs this?** Every current customer is a German
   company (§5). Is this a real requirement, a prospect, or an auditor's
   checklist item?
7. **Who may set a company's zone** — the company's own administrator, or
   platform staff only? (A company administrator changing it would silently
   re-band their own drivers' premiums.)
8. **Does the Uber 04:00 operating day move with the company's zone?** It is
   Uber's convention, not the company's; `uberPeriods.ts` keys stored income
   rows off it, so moving it misattributes a week's money.
9. **The audit retention purge and the platform invoice count have no tenant**
   (§2.2). Do they stay platform constants, or become a platform *setting*?
10. **May the §3b question (Phase 0c) be answered first?** §3.4 argues the
    payroll zone cannot honestly be settled before it. If the answer is no, the
    plan below stops after stage 4.

A measurement question that is not the owner's but should be taken before
replying to the auditor: **are the 42 rows behind FB-WARN-001 simulated rides?**
(§2.6.)

---

## 5. A staged plan

Smallest honest first step first. Stages 0–3 change **no behaviour** and are the
literal *"make parse/serialize timezone aware"* half of the audit's request.
Stage 4 onward changes figures.

### Stage 0 — Name the three zones. No behaviour change. · `docs/`
Record §2.1 in `CLAUDE.md` and in the three affected module headers, and give
axis A a name distinct from axis C. Prose only. **Revert:** revert the commit.
This stage is valuable even if nothing else is ever built, because the
conflation is the thing most likely to cause a wrong fix.

### Stage 1 — Build the safety net the golden masters are missing. **No behaviour change.** · `test/`
§3.2 measured that the golden masters stay green in every zone. Before any zone
code, add golden cases the change *would* move:
- `computeLohnartSeconds` on **fixed absolute instants** (not local-constructed
  wall times), so the snapshot pins the Berlin reading of a stored row —
  §3.3's table is the fixture.
- Cases crossing both 2026 DST transitions in both directions.
- A test asserting `localDayWindow`'s primitives against explicit expected
  instants rather than against themselves.

**Proof:** the suite is green in Berlin; the new cases **fail** under
`TZ=Asia/Kolkata` where the old ones pass. That contrast is the deliverable.
**Revert:** delete the test file. **This stage is a prerequisite for every stage
below and is worth doing on its own merits** — it also covers the 25.10.2026
transition, two days away.

### Stage 2 — Record the zone beside every stored figure that was computed in one. **No behaviour change.** · one migration
Add a `zone_used text NOT NULL DEFAULT 'Europe/Berlin'` (or equivalent) to
`subscription_coverage`, `cash_movements` and `driver_notes`, backfilled
`'Europe/Berlin'`. **Nothing reads it.** This copies the
`fahrtenbuch_trips.time_zone` pattern (§2.4) and is what makes question 2
answerable later instead of unanswerable for ever.
**Proof:** RLS kit green; a probe asserting every existing row reads
`'Europe/Berlin'`. **Revert:** drop the columns (no reader exists).
*Caveat from §2.5:* this does **not** make the Fahrtenbuch re-derivable, because
`'nonexistent'` and `'ambiguous'` are already collapsed and the rows are
immutable.

### Stage 3 — `companies.time_zone`. **No behaviour change.** · one migration
`NOT NULL DEFAULT 'Europe/Berlin'`, with a CHECK against a known zone list.
**Nothing reads it.** Add a kit probe asserting every company is Berlin, so
stage 4 cannot go out silently.
**Proof:** RLS kit green; `matrix.sql` lines for the new column.
**Revert:** drop the column.

### Stage 4 — Read it in the **schedule** paths only. **Changes when a mail goes out; changes no stored figure.** · `feat/`
`abrechnung_schedules.send_time` and `uber_pull_schedules.run_time` already
store a per-company time of day (§2.2); only the zone reading it is global, and
that reading is one function, `abrechnung-schedule-core.ts:101`. Thread the
company's zone into it and correct the three i18n strings (§2.7).
**Proof on staging, before/after on a real month:** for every company, compute
the next send occurrence under the old and new code with every zone still
Berlin, and assert the two are **byte-identical**. Then set the e2e test
company to another zone and show its occurrence moves by exactly the offset
while no other company's does.
**Revert:** the previous release reads the column not at all.
**This is the cheapest honest per-tenant win in the repository, and the only one
available before Phase 0c.**

### Stage 5 — The sweeps. Changes what is selected. · `feat/`
`notification_candidates` and `uber_pull_candidates` (§2.2). This is an index
and performance problem as much as a correctness one — moving the window
predicate inside the per-company term defeats `cars_company_tuev_idx`.
**Proof:** `EXPLAIN` before and after on staging's row counts, plus a
before/after of the candidate set with every zone Berlin (must be identical).

### Stage 6 — The per-company RPCs where the company row is already in hand. Changes stored figures. · `feat/`
The six "free" functions of §2.2, plus the three signature changes. Each is its
own commit with its own self-check rewrite, because each has an assertion
pinning the literal (§2.3) — including the spliced bodies.
**Proof:** per function, run it on staging for a real company with the zone
Berlin and diff the written row against the pre-change row; then for one test
company in another zone, show the written value moves as predicted and nothing
else does.

### Stage 7 — The payroll core. **Gated on Phase 0c.** · `feat/`
`localDayWindow.ts`'s five primitives take an explicit zone; `computeLohnartSeconds`'s
day walk is rewritten against an explicit-zone calendar; the six importers are
threaded. The correctness notes in `localDayWindow.ts:73-97` (monotone bands,
the clamp, "on a fall-back day 02:00 happens twice and `new Date` answers the
**first** occurrence — that is the right one for a band boundary") must all be
**re-derived** against the explicit-zone implementation, not carried over.
**Proof on staging, on a real month:** pick a company and a month with night
and Sunday work, export the Stundennachweis and the Lohnart totals before and
after with the zone Berlin, and require them **byte-identical**. Then run the
same month with the zone changed and require the diff to match §3.3's predicted
figures exactly.
**Revert:** possible only before any document is issued under a non-Berlin
zone; afterwards a reverted release reprints a previously issued Stundennachweis
with different figures, which is why this stage is last.

### Never
`platform_audit_purge` and `platform_invoices_list_statement` (§2.2) have no
tenant. They stay platform constants, or become a platform setting — not a
company one.

---

## 6. Recommendation

**Build stages 0–2 now, stage 3–4 if the owner wants a per-tenant story for the
auditor, and do not build the payroll half (stage 7) until Phase 0c has
answered what §3b EStG requires.** The reasoning, concretely. What the full
feature *buys* today is nothing a customer has asked for: every current customer
is a German company, so all three zones of §2.1 have the same value for all of
them, and the measured per-tenant surface is 44 production sites plus ~105
assertions, three of which are spliced function bodies with whitespace-exact
anchors and one of which is a self-check that counts the occurrences of
`AT TIME ZONE` in a function and fails on two. What it *costs* is sharper than
that count suggests: §3.3 measured that one eight-hour night shift re-bands by
2.5 hours between Lohnart 1500 and 1501, and a Sunday-into-Monday shift's Sunday
premium swings by the entire shift — these are §3b steuerfrei figures on a
document that goes to a Steuerberater, and §3.4 establishes that nobody has yet
checked **any** of the four premium tables against the statute, so a per-tenant
zone would be parameterising a rate of unknown correctness and turning a partial
error into a configurable one. Worse, §3.2 measured that the golden masters —
the only safety net over this code — **stay green in every timezone tried**,
because their inputs are built with the same local constructor the engine reads;
they would not notice the change at all, which means the first stages must build
the net before anything moves. Against all that, stages 0–2 are cheap and
independently worth it: naming the three zones prevents the wrong fix, the new
golden cases cover the 25.10.2026 transition **two days from now** on a module
whose header already records 26 production trips sitting on the last one, and
recording the zone beside each stored figure is the only thing that keeps
question 2 answerable at all — right now, every coverage period and cash
movement on production was computed in Berlin with nothing saying so, and that
becomes irreversible the day a second zone exists. Stage 4 then gives a genuine,
provable per-tenant behaviour (the Abrechnung and Uber send times, where the
per-company value is *already stored* and only its zone is global) for close to
no risk, which is a real answer to the auditor without touching a payroll
figure. The one thing to refuse outright is doing stage 7 first because it is
where the audit points: that is the order in which this change corrupts
someone's payslip.

---

## Appendix — what was measured, and how

- `rg` counts of `Europe/Berlin` across `src/`, `supabase/`, `tests/` — §2.0.
- Live-definition tracing through the migration chain (a later
  `CREATE OR REPLACE` or `DROP` supersedes an earlier definition) — §2.2;
  4 of 18 `AT TIME ZONE` expressions are dead text.
- Reachability of `AutoShiftPlanView` by declaration range, JSX-tag search and
  state-read search — §2.0.
- `src/utils/*.golden.test.ts` run under five timezones through a
  measurement-only vitest config, with a Berlin control and a failing positive
  control proving `TZ` reached the worker — §3.2. The config and probe test were
  deleted; neither is in this branch.
- `computeLohnartSeconds` called on fixed UTC instants in three zones — §3.3.
- `getGermanNationalHolidays(2026)` compared across three zones — §3.2.
- Local-`Date`-constructor and local-getter counts per payroll module — §3.1.
- Zero-`Europe/Berlin` confirmation for the five export builders — §3.1.

**Not measured, and named as such:** whether the 42 rows behind FB-WARN-001 are
simulated (needs a staging query on `fahrtenbuch_imports.is_simulated`, §2.6);
the sargability claim about `cars_company_tuev_idx` (§2.2); the cost of a
splice-vs-restate on the three spliced bodies (§2.3); the 45-minute-offset slot
misalignment (§2.8).
