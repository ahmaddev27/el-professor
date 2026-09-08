# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Keep this file at the repository root — Claude Code only auto-loads `CLAUDE.md` from the project root or `.claude/`. A copy under `Docs/` is not loaded and will silently drift.

## Project

**Y&A Mobility / El-Professor** — a multi-tenant, German-language SaaS for German taxi & Mietwagen fleet operators. A React SPA talking directly to Supabase (PostgreSQL + Auth + Storage + Edge Functions). There is no application server of our own.

The domain is German payroll & compliance paperwork: import the monthly Fahrtenbuch (XLSX ride log), assign drivers to vehicle blocks, produce Stundennachweise (statutory time records) and a corrected Fahrtenbuch that reconcile with the Steuerberater's payroll figures.

Numbers use German formatting (decimal comma: `41,47`), dates `DD.MM.YYYY` in the UI and `YYYY-MM-DD` in storage. **Never use US `MM/DD/YYYY`.**

### Language

The UI is bilingual German/English; German is the source language and the fallback. `src/i18n/de.ts` is canonical and defines the key type, `en.ts` is a `Partial`, so screens convert incrementally and a missing English key renders German rather than a raw key. `useTranslation()` from `src/contexts/LanguageContext.tsx` gives you `t(key, vars)` and `tPlural({one, other}, count)`.

Roughly ten screens are converted; the other ~90 files still hold German literals. Converting one means adding keys to **both** dictionaries and swapping the literals for `t(...)`.

Three things stay German in both languages, and the reasoning is in the header of `src/i18n/index.ts`:

- **Generated documents.** Stundennachweis PDFs and the Fahrtenbuch XLSX carry statutory German text, and the `'original'` export mode has to reproduce the imported sheet's headers byte for byte. Translating any of it breaks the export and produces invalid records. Those strings live in the export modules, never in the dictionaries.
- **Domain vocabulary** — `Stundennachweis`, `Fahrtenbuch`, `Abrechnung`, `Beleg`, `Werkstatt`, `Monatsplanung`, `Lohnart`, `Bundesland` — so the screen and the paperwork agree.
- **Money and date formatting**, because on-screen figures map one-to-one onto German documents.

## Commands

```bash
npm install
npm run dev              # Vite dev server
npm run build            # typecheck ratchet, then vite build -> dist/
npm run typecheck        # raw tsc --noEmit, full error list
npm run typecheck:update # lower the ratchet baseline after fixing errors
npm run lint             # ESLint (flat config, typescript-eslint + react-hooks)
npm run preview          # serve the production build
```

There is **no test suite** — no vitest/jest, no `*.test.*` files. The typecheck plus `npm run lint` is the entire automated safety net. Verify behavior changes by running the app.

### The typecheck ratchet

`npm run build` used to be `vite build` alone. Vite strips types without checking them, so the project accumulated **376 TypeScript errors** that nothing ever surfaced — including undefined identifiers that threw at render, permission checks that were always true, four `ConfirmationModal` call sites using invented prop names (one dialog never rendered at all), and 71 `showToast` calls with their arguments reversed, which made every one of those notifications display the bare word "success" instead of its German message.

`scripts/typecheck-ratchet.mjs` now runs before every build and compares the error count against `typecheck-baseline.json`:

- **more** errors than the baseline → build fails, listing the worst files
- **fewer** errors → build fails, asking you to run `npm run typecheck:update` and commit the lowered baseline
- **equal** → build proceeds

Failing on improvement is deliberate: a baseline that moves only by an explicit commit stays honest. Use `npm run build:novalidate` if you genuinely need the bundle without the gate.

The remaining errors are not uniform. Roughly 182 are unused locals (`TS6133`, noise from `noUnusedLocals`); the rest include real type mismatches worth triaging. `TS2304` (undefined name), `TS2774` (condition always true) and `TS2367` (impossible comparison) are almost always genuine defects.

Env (`.env`, see `.env.example`): `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required; `VITE_APP_URL` is the origin baked into auth email redirect links (`/auth/callback`) and must be the real domain in production. `VITE_API_URL` belongs to the dead PHP backend (see below) and is unused.

## Architecture

### Provider stack

`main.tsx` mounts `ThemeProvider → AuthProvider → ToastProvider → App`. `App.tsx` then adds `CompanySettingsProvider → SuperAdminProvider → PlanProvider → BrowserRouter`. Anything needing `usePlan()` must live below that — which is why the plan-gated routes are all inside `App`, not `main`.

### Auth is a chain of gates, not a single check

`App.tsx` is the authoritative map of who may see what. Read it before touching access control. The order is:

1. `authLoading` → spinner
2. no `user` → public routes only (`/`, `/login`, `/signup`, `/auth/*`)
3. `companyApprovalStatus` `pending` / `rejected` / `suspended` → full-page takeover, no router at all
4. `MustChangePasswordGuard` → forces `/set-new-password`
5. `SubscriptionGuard` → forces `/abo-aktivieren` when an approved company's subscription is inactive
6. `PlanGate` per route → `LockedFeaturePage` when the plan tier is too low
7. `isAdmin` / `isSuperAdmin` conditionally *register* the route at all

`AuthContext` also enforces a 20-minute inactivity logout (`SESSION_TIMEOUT`, tracked in `localStorage.lastActivity`).

### Multi-tenancy and the two company IDs

Every business table carries `company_id`, isolated by RLS. `AuthContext.companyId` is the logged-in user's own company. `SuperAdminContext.effectiveCompanyId` is the company whose data should actually be queried — it differs when a super admin has "entered" another company to view its data. Most components still use `companyId` directly; only `MonatsplanungStundennachweisPreview.tsx` uses `effectiveCompanyId`. When adding a query a super admin should be able to run *as* a customer, use `effectiveCompanyId`.

### Plan gating

`PlanContext` maps `FeatureKey → minimum Plan` in `FEATURE_MIN_PLAN` (`basic` < `advanced` < `premium`). Two behaviors are easy to miss: a company **in trial** gets `effectivePlan = 'premium'` regardless of its stored plan, and a super admin's `can()` always returns `true`. Add a new gated feature by extending `FeatureKey` + `FEATURE_MIN_PLAN` in `PlanContext.tsx` and `FEATURE_LABELS` in `App.tsx`, then wrapping the route in `<PlanGate>`.

### Data access

There is no repository layer. Components call `supabase.from(...)` directly (~63 files), with `src/hooks/useDatabase.ts` covering only the older receipt/driver/income/salary CRUD — and that hook falls back to `localStorage` when Supabase is unreachable, which is a legacy quirk, not a pattern to extend.

Supabase caps a query at 1000 rows, so trip loading is paginated with `while (true)` + `.range()` batch loops. That pattern is deliberate — don't "simplify" it into a single select.

Writes that RLS forbids go through `SECURITY DEFINER` RPCs: `apply_monthly_planning_run`, `replace_monthly_planning_run`, `reassign_fahrtenbuch_trip`, `get_weekly_abrechnung` / `get_monthly_abrechnung`, `redeem_activation_code`, `update_company_subscription_manual`, and others in `supabase/migrations/`.

### `fahrtenbuch_trips` is append-only by design

A DB trigger (`protect_fahrtenbuch_immutable_fields`) raises an exception on any UPDATE to `trip_date`, `start_time`, `end_time`, `duration_minutes`, `car_id`, `car_identifier`, route/description, all amount columns, `raw_data_json`, `original_driver_*`, `import_id`, `company_id`. Only the `assigned_driver_*` / `assignment_*` columns are mutable, and **there is no UPDATE RLS policy at all** — every write must go through an RPC. Trips with `is_canceled = true` must never be reassigned or counted.

This constraint shapes the whole planning system: it is why planning is computed entirely in memory and committed in one apply step, and why time corrections in the historical wizard are stored as separate `historical_time_adjustments` rows rather than edits.

## The planning pipeline (the core of the product)

Entry point `src/pages/CompanyPlannerPage.tsx` branches on `planningMode` into three workflows: `new_month` (the standard pipeline), `historical_reconciliation` (Brutto-Gehälter mode), and `hist_working_hours` (Arbeitsstunden block-engine mode).

### Standard monthly planning

Phases 1–4 are **pure, in-memory, zero DB I/O**. Nothing is written until "Plan anwenden".

| Phase | File | Entry point |
|---|---|---|
| 1 — build vehicle blocks from trips | `utils/monatsplanungPhase1.ts` | `buildPhase1VehicleBlocks` |
| 3 — assign drivers to blocks (greedy + repair) | `utils/monatsplanungPhase3.ts` | `assignBlocksPhase3` |
| 4 — build change set + consistency check | `utils/monatsplanungPhase4.ts` | `buildChangeSet` |
| 5 — apply | `components/MonatsplanungAssignmentPreview.tsx` | `handleApply()` |

`utils/monatsplanungRepairPass.ts` (`repairFinalOverlaps`) and `utils/driverNoteValidation.ts` are pulled in by the preview component during phase 3/4 review.

Phase 3 splits rejection reasons into **hard** constraints that can never be bypassed (`wrong_weekday`, `driver_overlap`, `vehicle_switch_buffer_violation`, `one_vehicle_per_day`, `note_constraint`) and **bypassable** ones a manual exception can override (`outside_working_time_window`, `daily_max_exceeded`, `monthly_max_exceeded`). Preserve that distinction — the bypassable ones are persisted as flags on the trip and audited in `monthly_planning_manual_exceptions`.

Phase 5 writes `company_planning_runs`, batch-updates trips via RPC, inserts manual exceptions, and stores an `apply_summary_json` whose `updated_trips` count is re-verified later during finalization. **One applied run per company/month/year**; a second apply offers "Bestehende Planung ersetzen" via `replace_monthly_planning_run`, which archives the old run.

Downstream of apply: `MonatsplanungStundennachweisPreview.tsx` (time records, Lohnart computation, Gehaltsabweichung, Transfer Analysis) and `FinalizePlanningModal.tsx` (pre-flight checks, then document generation).

### Finalization is a hard gate

`FinalizePlanningModal.tsx` runs ~10 blocking pre-flight checks (run status is `applied`, trip count matches `apply_summary_json`, no duplicate trips, every non-canceled trip has a driver / block / start+end time, max 3 Schichten per driver per day, no short vehicle switch, driver summary builds). **There is no override.** Documents are downloadable only after all checks pass. Applying a trip transfer afterwards sets `planning_finalizations.is_stale`, forcing re-finalization.

The `Fahrzeugwechsel zu kurz` check compares absolute millisecond timestamps and skips negative gaps — an older `HH:MM`-string implementation produced nonsense negative gaps across midnight. Keep timestamp arithmetic; do not regress to time-of-day math.

### Historical Arbeitsstunden mode — the block engine

`HistoricalWorkingHoursWizard.tsx` (~11.7k lines) drives a deterministic block pipeline. **The engine lives in `utils/historicalWorkingHoursCleanEngine.ts`** (~2.8k lines, 55 exports) — `buildVehicleBlocksForHistoricalWorkingHours`, `assignRegularDriversToVehicleBlocks`, `assignSurplusBlocksToInhaberWithoutTimeChange`, `shiftOverlappingInhaberBlocks`, `buildFinalBlockAssignmentSnapshot`, `validateHistoricalWorkingHoursExportReadiness`, `computeLohnartSeconds`, `getGermanNationalHolidays`.

The wizard also pulls in three sibling modules: `historicalRowLevelEngine.ts` (row-level Arbeitsstunden engine + export overlap validation), `historicalWorkingHoursFahrtenbuchExport.ts` (final XLSX build + overlap validation), and `historicalWorkingHoursStundennachweisPreview.ts`.

> **Do not trust `README.md` here.** It attributes the block engine to `ManualTimeCorrectionPanel.tsx` and to `historicalReconstructionSolver.ts`. Both are now **dead code, imported by nothing reachable** (see Dead code below). The `Clean Engine` module above is the live implementation.

Two rules still hold:

- **Overlap checks are ride-level and absolute.** Build intervals from `date-midnight-ms + secondOfDay * 1000`, never from a bare `HH:MM:SS` string (which parses to `0`). Cross-midnight rides depend on this.
- The snapshot produced by `buildFinalBlockAssignmentSnapshot` is the **sole** source of truth for Stundennachweis PDF rows, Lohnart actuals, export validation, name validation, and the Fahrtenbuch XLSX driver overlay. Do not add a second source.

Overlaps that already exist in the raw imported data are tracked separately and surface as amber "Originaldaten-Warnung" that does **not** block export. Only overlaps the app itself created are blocking errors.

The Brutto-Gehälter mode (`HistoricalReconciliationWizard.tsx`) is a different pipeline — it uses `utils/shiftBlockEngine.ts`, not the clean engine and not the reconstruction solver.

## Domain rules that are easy to break

- **Business week ownership** (`utils/weekCalculations.ts`): a week belongs to the month containing its **Monday**. April 1st falling on a Tuesday belongs to March. Every monthly aggregation depends on this.
- **Salary**: `(Umsatz + Aktionen) × driver.salary_ratio + Trinkgeld × 100%`. Bargeld and Trinkgeld are pass-through and never count toward company profit.
- **Abrechnung**: weekly balance = cash collected − cash expenses; positive means the driver owes the company.
- **Tankenquote** uses only receipts with Kategorie `Tanken` for that driver and period, and only the resulting percentage is displayed.
- **Night/Sunday premiums**: Lohnart `1500` (25% steuerfrei) and `1501` (40% steuerfrei) are mutually exclusive — `1500 = nightSec − night0to4Sec`, `1501 = night0to4Sec`. Never double-count.
- **Schicht compression** (max 3 shifts/day) is display- and export-only. It must not alter stored minutes, premium buckets, or Brutto figures.
- **Ausgleichsstunden** exist only in the Stundennachweis, always as Lohnart `1000` with no premium. They must never create trips or touch `fahrtenbuch_trips`, and must never appear in the Fahrtenbuch.
- **Belegnummer is always system-generated** (`BEL-{timestamp}-{random}`, collision-checked). OCR output must never overwrite it.

## Known defects and sharp edges

- **`supabase/migrations/` cannot bootstrap a database.** `companies`, `drivers`, `receipts` and `saved_stundennachweise` are only ever `ALTER`ed and RLS-policied — they have no `CREATE TABLE` anywhere in the chain. The live schema was partly created outside version control. A fresh Supabase project will not come up from migrations alone.
- **Duplicated constants with divergent values.** `MIN_VEHICLE_SWITCH_BUFFER_MINUTES` is `60` in `carBlockResolver.ts` and `vehicleBlockPlanner.ts` but `30` in `monatsplanungPhase3.ts`. Block-gap thresholds likewise differ across `monatsplanungPhase1.ts` (60 min) and `shiftBlockEngine.ts` (90 min). `buildVehicleBlocks`, `parseFullDatetimeMs` and `getHolidaysForYear` each exist in two modules. Always check which module the calling code actually imports.
- **Transfer application is not atomic.** `MonatsplanungStundennachweisPreview.tsx` (~line 3204) applies a multi-trip transfer by looping `reassign_fahrtenbuch_trip` once per trip. A mid-loop failure aborts and leaves the transfer **partially applied** — the error message even reports "X von Y Fahrten wurden aktualisiert". There is no rollback.
- **Edge functions trust their request bodies.** `apply-discount-code` runs with the service-role key and takes `company_id`, `user_id`, `discount_amount` and `final_price` straight from the body without verifying the caller or recomputing the price. `extract-receipt` performs no auth check at all and spends `ANTHROPIC_API_KEY` on any request. There is no `supabase/config.toml` in the repo, so `verify_jwt` per function exists only in dashboard settings — nothing in version control enforces it.
- **Two OCR implementations, one live.** The UI uses client-side Tesseract (`utils/receiptOcr.ts` → `ReceiptModal.tsx`). The `extract-receipt` edge function (Claude vision via the Anthropic SDK) is called by **nothing**. The README's claim that it "wraps Tesseract" is wrong on both counts.
- `index.html` still declares `lang="en"` and serves bolt.new placeholder OG/Twitter images.

## Dead code (~14.7k lines, ≈15% of `src/`)

Imported by nothing reachable. Do not extend, and read with suspicion — much of it is an earlier design that the docs still describe:

`pages/CompanyPlannerPage.legacy.tsx` (4620) · `components/HistoricalSteuerberaterView.tsx` (3314) · `utils/historicalPlannerSolver.ts` (1986) · `components/ManualTimeCorrectionPanel.tsx` (1477) · `utils/historicalReconstructionSolver.ts` (988) · `utils/vehicleBlockPlanner.ts` (554) · `hooks/useDocuments.ts` (395) · `components/CreateDocumentModal.tsx` (371) · `components/DocumentCard.tsx` (361) · `components/DocumentBuilder.tsx` (339) · `lib/api.ts` (325) · `components/UploadDocumentModal.tsx` (261) · `components/UpdateIncomeWeeks.tsx` (79) · `pages/StatistikenPage.tsx` (50) · `pages/DruckenPage.tsx` (41)

`vehicleBlockPlanner`, `historicalPlannerSolver`, `historicalReconstructionSolver` and `useDocuments` are *transitively* dead — their only importers are themselves dead. `StatistikenPage` and `DruckenPage` have no route in `App.tsx`.

The whole `backend/` directory (10 PHP files, placeholder DB credentials) is dead too — see below.

## Repository hazards

- **The docs contradict the code. The code wins.** `MIGRATION_COMPLETE.md` and `MYSQL_MIGRATION_GUIDE.md` describe a completed migration to a PHP/MySQL backend that **never happened**: `backend/` and `src/lib/api.ts` are imported by nothing and `src/lib/supabase.ts` still exports a real Supabase client. `RLS_FIX_EXPLANATION.md` claims `user_profiles.id` is a `bigint`; the first migration creates it as `uuid`. Confirm every constant, table and RPC name in source before relying on a doc.
- `README.md` contains **two concatenated copies** of itself. The first (§1–25) is current; the second (§1–24) is an older revision.
- `Docs/` duplicates several root docs byte-for-byte. Editing one leaves the other stale.
- Root-level `*.sql` fix scripts (`FIX_INCOME_POLICIES.sql`, `fix_admin_role.sql`, `apply_salaries_migration.sql`, …) are **not** part of the migration chain. Only `supabase/migrations/` is schema history — with the completeness caveat above.
- Large files to grep rather than read whole: `HistoricalWorkingHoursWizard.tsx` (11.7k), `CompanyPlannerPage.legacy.tsx` (4.6k, dead), `StundennachweisPage.tsx` (4.0k), `MonatsplanungStundennachweisPreview.tsx` (3.9k), `HistoricalSteuerberaterView.tsx` (3.3k, dead), `historicalWorkingHoursCleanEngine.ts` (2.8k).
- `.claude/settings.json` registers a `PostToolUse` hook pointing at `/tmp/cc-agent/57153190/project/.claude/strip-prose.py`, a path from a different machine. It fails silently (`|| true`).
- `project/` is empty. `.bolt/` is leftover Bolt scaffolding. Two `vite.config.ts.timestamp-*.mjs` files are Vite temp artifacts.

## Audit and remediation

`Docs/audit/` holds the output of a 259-agent review: `FINDINGS.md` (71 findings that survived adversarial verification, with evidence and file:line) and `REMEDIATION-PLAN.md` (phased plan). Read the plan before starting security or payroll work — it explains why the payroll fixes are blocked on establishing what §3b EStG actually requires, since the app carries four competing premium tables and nobody has checked any of them against the statute.

`CONTRIBUTING.md` records the branch model and the rules that must not be traded away.

## Working style for this codebase

Prefer small, targeted, reversible changes. The planning, salary, and reconciliation code encodes statutory German payroll rules that are far more intricate than the code shape suggests, has no test coverage, and produces documents that go to an accountant — a plausible-looking refactor can silently corrupt someone's payroll. When a change touches Phase 1/3/4, the clean engine, Lohnart computation, or the finalization checks, state the rule you believe you are preserving before editing.
