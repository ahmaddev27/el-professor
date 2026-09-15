# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**El-Professor** — a multi-tenant, German-language SaaS for German taxi & Mietwagen fleet operators. A React SPA talking directly to Supabase (PostgreSQL + Auth + Storage + Edge Functions). There is no application server of our own.

The domain is German payroll & compliance paperwork: import the monthly Fahrtenbuch (XLSX ride log), assign drivers to vehicle blocks, produce Stundennachweise (statutory time records) and a corrected Fahrtenbuch that reconcile with the Steuerberater's payroll figures.

**All UI text is German and must stay German.** Never translate labels like `Stundennachweis`, `Fahrer`, `Schicht`, `Fahrzeugwechsel zu kurz`, `Abrechnung`, `Beleg`. Numbers use German formatting (decimal comma: `41,47`), dates `DD.MM.YYYY` in the UI and `YYYY-MM-DD` in storage. **Never use US `MM/DD/YYYY`.**

## Commands

```bash
npm install
npm run dev      # Vite dev server
npm run build    # tsc + vite build -> dist/
npm run lint     # ESLint (flat config, typescript-eslint + react-hooks)
npm run preview  # serve the production build
```

There is **no test suite** — no vitest/jest, no `*.test.*` files. `npm run build` (TypeScript strict, `noUnusedLocals`, `noUnusedParameters`) plus `npm run lint` is the entire automated safety net. Verify behavior changes by running the app.

Env (`.env`, see `.env.example`): `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required; `VITE_APP_URL` is the origin baked into auth email redirect links (`/auth/callback`) and must be the real domain in production. `VITE_API_URL` belongs to the dead PHP backend (see below) and is unused.

Migrations are plain SQL in `supabase/migrations/`, applied in filename-timestamp order via the Supabase SQL editor or MCP. There is no local Supabase CLI setup in the repo.

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

Every business table carries `company_id`, isolated by RLS. `AuthContext.companyId` is the logged-in user's own company. `SuperAdminContext.effectiveCompanyId` is the company whose data should actually be queried — it differs when a super admin has "entered" another company to view its data. Most components still use `companyId` directly; only a couple use `effectiveCompanyId`. When adding a query that a super admin should be able to run *as* a customer, use `effectiveCompanyId`.

### Plan gating

`PlanContext` maps `FeatureKey → minimum Plan` in `FEATURE_MIN_PLAN` (`basic` < `advanced` < `premium`). Two behaviors are easy to miss: a company **in trial** gets `effectivePlan = 'premium'` regardless of its stored plan, and a super admin's `can()` always returns `true`. Add a new gated feature by extending `FeatureKey` + `FEATURE_MIN_PLAN` in `PlanContext.tsx` and `FEATURE_LABELS` in `App.tsx`, then wrapping the route in `<PlanGate>`.

### Data access

There is no repository layer. Components call `supabase.from(...)` directly (~63 files do), with `src/hooks/useDatabase.ts` covering only the older receipt/driver/income/salary CRUD — and that hook falls back to `localStorage` when Supabase is unreachable, which is a legacy quirk, not a pattern to extend.

Writes that RLS forbids go through `SECURITY DEFINER` RPCs: `apply_monthly_planning_run`, `replace_monthly_planning_run`, `reassign_fahrtenbuch_trip`, `get_weekly_abrechnung` / `get_monthly_abrechnung`, `redeem_activation_code`, `update_company_subscription_manual`, and others defined in `supabase/migrations/`.

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

Phase 3 splits rejection reasons into **hard** constraints that can never be bypassed (`wrong_weekday`, `driver_overlap`, `vehicle_switch_buffer_violation`, `one_vehicle_per_day`, `note_constraint`) and **bypassable** ones a manual exception can override (`outside_working_time_window`, `daily_max_exceeded`, `monthly_max_exceeded`). Preserve that distinction — the bypassable ones are persisted as flags on the trip and audited in `monthly_planning_manual_exceptions`.

Phase 5 writes `company_planning_runs`, batch-updates trips via RPC, inserts manual exceptions, and stores an `apply_summary_json` whose `updated_trips` count is re-verified later during finalization. **One applied run per company/month/year**; a second apply offers "Bestehende Planung ersetzen" via `replace_monthly_planning_run`, which archives the old run.

Downstream of apply: `MonatsplanungStundennachweisPreview.tsx` (time records, Lohnart computation, Gehaltsabweichung, Transfer Analysis) and `FinalizePlanningModal.tsx` (pre-flight checks, then document generation).

### Finalization is a hard gate

`FinalizePlanningModal.tsx` runs ~10 blocking pre-flight checks (run status is `applied`, trip count matches `apply_summary_json`, no duplicate trips, every non-canceled trip has a driver / block / start+end time, max 3 Schichten per driver per day, no short vehicle switch, driver summary builds). **There is no override.** Documents are downloadable only after all checks pass. Applying a trip transfer afterwards sets `planning_finalizations.is_stale`, forcing re-finalization.

The `Fahrzeugwechsel zu kurz` check compares absolute millisecond timestamps and skips negative gaps — an older `HH:MM`-string implementation produced nonsense negative gaps across midnight. Keep timestamp arithmetic; do not regress to time-of-day math.

### Historical Arbeitsstunden mode — the block engine

`HistoricalWorkingHoursWizard.tsx` drives a deterministic 7-phase pipeline whose pure functions live in `ManualTimeCorrectionPanel.tsx` (`buildVehicleBlocks`, `assignBlocksToRegularDrivers`, `detectOwnerOverlaps`, `findOwnerOverflowSlots`, `expandToAdjustments`, plus the `overlapsMs` / `dateMidnightMs` / `parseFullDatetimeMs` time helpers). Two rules matter most:

- **Do not reintroduce the solver.** `runReconstructionSolver` / `buildReconstructionUnits` in `historicalReconstructionSolver.ts` belong to the Brutto-Gehälter mode only. The block engine replaced them here.
- **Overlap checks are ride-level and absolute.** Use `dateMidnightMs(block.date) + ride.startSecOfDay * 1000`, never `parseFullDatetimeMs(block.originalBlockStartFull)` — that field can be a bare `HH:MM:SS` string for some imports and returns `0`. Cross-midnight rides depend on this.

The engine's output, `finalSnapshot` (`FinalBlockAssignmentRow[]`), is the **sole** source of truth for Stundennachweis PDF rows, Lohnart actuals, export validation, name validation, and the Fahrtenbuch XLSX driver overlay. Do not add a second source.

Overlaps that already exist in the raw imported data are tracked separately (`originalDriverOverlapKeys` / `originalVehicleOverlapKeys`) and surface as amber "Originaldaten-Warnung" that does **not** block export. Only overlaps the app itself created are blocking errors.

## Domain rules that are easy to break

- **Business week ownership** (`utils/weekCalculations.ts`): a week belongs to the month containing its **Monday**. April 1st falling on a Tuesday belongs to March. Every monthly aggregation depends on this.
- **Salary**: `(Umsatz + Aktionen) × driver.salary_ratio + Trinkgeld × 100%`. Bargeld and Trinkgeld are pass-through and never count toward company profit.
- **Abrechnung**: weekly balance = cash collected − cash expenses; positive means the driver owes the company.
- **Tankenquote** uses only receipts with Kategorie `Tanken` for that driver and period, and only the resulting percentage is displayed.
- **Night/Sunday premiums**: Lohnart `1500` (25% steuerfrei) and `1501` (40% steuerfrei) are mutually exclusive — `1500 = nightSec − night0to4Sec`, `1501 = night0to4Sec`. Never double-count.
- **Schicht compression** (max 3 shifts/day) is display- and export-only. It must not alter stored minutes, premium buckets, or Brutto figures.
- **Ausgleichsstunden** exist only in the Stundennachweis, always as Lohnart `1000` with no premium. They must never create trips or touch `fahrtenbuch_trips`, and must never appear in the Fahrtenbuch.
- **Belegnummer is always system-generated** (`BEL-{timestamp}-{random}`, collision-checked). OCR output must never overwrite it.

## Repository hazards

- **The docs contradict the code in places. The code wins.** Notably `MIGRATION_COMPLETE.md` and `MYSQL_MIGRATION_GUIDE.md` describe a completed migration to a PHP/MySQL backend that **never happened** — `backend/` and `src/lib/api.ts` are dead code imported by nothing, and `src/lib/supabase.ts` still exports a real Supabase client. Constants also drift (README says the vehicle-switch buffer is 60 min; `monatsplanungPhase3.ts` says 30). Always confirm a constant in the source file before relying on a doc.
- `README.md` contains **two concatenated copies** of itself. The first (§1–25) is current and includes the Historical Reconciliation chapters; the second (§1–24) is an older revision. Read the first.
- `Docs/` is a byte-identical duplicate of five root-level docs. Editing one leaves the other stale.
- `src/pages/CompanyPlannerPage.legacy.tsx` (4.6k lines) is dead legacy. Do not modify or resurrect it.
- Several files are very large — `HistoricalWorkingHoursWizard.tsx` is ~11.7k lines, `StundennachweisPage.tsx` ~4k, `MonatsplanungStundennachweisPreview.tsx` ~3.9k. Grep for the specific symbol rather than reading them whole.
- `.claude/settings.json` registers a `PostToolUse` hook pointing at `/tmp/cc-agent/57153190/project/.claude/strip-prose.py`, a path from a different machine. It fails silently (`|| true`).
- The repo root is littered with ad-hoc `.sql` fix scripts (`FIX_INCOME_POLICIES.sql`, `fix_admin_role.sql`, …) that are **not** part of the migration chain. `supabase/migrations/` is the only authoritative schema history.
- `project/` is empty. `.bolt/` is leftover Bolt scaffolding.
- This directory is **not a git repository**, so there is no history to consult and no safety net for destructive edits.

## Working style for this codebase

Prefer small, targeted, reversible changes. The planning, salary, and reconciliation code encodes statutory German payroll rules that are far more intricate than the code shape suggests, has no test coverage, and produces documents that go to an accountant — a plausible-looking refactor can silently corrupt someone's payroll. When a change touches Phase 1/3/4, the block engine, Lohnart computation, or the finalization checks, state the rule you believe you are preserving before editing.
