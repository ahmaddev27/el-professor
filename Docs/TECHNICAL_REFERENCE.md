# Y&A Mobility — Technical Developer Reference

> **Read this first.** Moved here unchanged from `README.md` on 15.09.2026. This reference predates the self-hosted Supabase stack in places, and some files it names have since been deleted. [CLAUDE.md](../CLAUDE.md) is authoritative, and wherever this reference, CLAUDE.md and the code disagree, the code wins. The current project status lives in the "Project status" section of [README.md](../README.md).

---

> **For new developers:** This document contains all business rules, workflow logic, database schema details, UI flows, validation rules, and architectural decisions needed to continue development without any prior chat history. Read this before touching any planning, salary, OCR, historical reconciliation, or document-generation code.

---

Sections 1–25 below describe the application. Where they disagree with the code, the code wins.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure & Code Map](#3-project-structure--code-map)
4. [Development Principles](#4-development-principles)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Main Application Routes & Feature Gating](#6-main-application-routes--feature-gating)
7. [Business Week Logic](#7-business-week-logic)
8. [Income Types & Revenue Rules](#8-income-types--revenue-rules)
9. [Salary Calculation](#9-salary-calculation)
10. [Settlement (Abrechnung) Logic](#10-settlement-abrechnung-logic)
11. [Monthly Planning System (Monatsplanung)](#11-monthly-planning-system-monatsplanung)
    - [Phase 1 — Vehicle Block Building](#phase-1--vehicle-block-building)
    - [Phase 3 — Driver Assignment](#phase-3--driver-assignment)
    - [Phase 4 — Change Set Building](#phase-4--change-set-building)
    - [Phase 5 — Apply Plan](#phase-5--apply-plan)
    - [Post-Apply Popup Behavior](#post-apply-popup-behavior)
12. [Stundennachweis (Time Record) System](#12-stundennachweis-time-record-system)
13. [Gehaltsabweichung / Ausgleichsanalyse](#13-gehaltsabweichung--ausgleichsanalyse)
14. [Transfer Analysis](#14-transfer-analysis)
15. [Finale Dokumente erstellen](#15-finale-dokumente-erstellen)
16. [Short Vehicle Switch Rule](#16-short-vehicle-switch-rule)
17. [Fahrtenbuch XLSX Export](#17-fahrtenbuch-xlsx-export)
18. [Beleg / Receipt System & OCR](#18-beleg--receipt-system--ocr)
19. [Historical Reconciliation System](#19-historical-reconciliation-system)
    - [Alter Monat / Mit Brutto-Gehältern Mode](#alter-monat--mit-brutto-gehältern-mode)
    - [Alter Monat / Mit Arbeitsstunden Mode — Block Engine](#alter-monat--mit-arbeitsstunden-mode--block-engine)
    - [Block Engine — 7-Phase Pipeline](#block-engine--7-phase-pipeline)
    - [Phase 2 Overlap Check Detail](#phase-2-overlap-check-detail)
    - [Export Validation & Original-Data Warnings](#export-validation--original-data-warnings)
    - [FinalBlockAssignmentSnapshot](#finalblockassignmentsnapshot)
20. [Database Architecture](#20-database-architecture)
21. [Supabase Edge Functions](#21-supabase-edge-functions)
22. [Known Implementation Notes & Caveats](#22-known-implementation-notes--caveats)
23. [Current Open Tasks](#23-current-open-tasks)
24. [Getting Started](#24-getting-started)
25. [Deployment Checklist](#25-deployment-checklist)

---

## 1. Project Overview

Y&A Mobility is a multi-tenant German-language SaaS platform for taxi and fleet companies. It handles:

- **Fahrtenbuch import/export** — importing XLSX ride logs, tracking per-trip assignments
- **Monatsplanung** — monthly driver-vehicle-block assignment planning (4-phase in-memory engine)
- **Fahrer assignments** — assigning drivers to vehicle blocks with constraint checking
- **Stundennachweis generation** — generating monthly time-record summaries and PDFs per driver
- **Gehaltsabweichung / Ausgleichsanalyse** — salary deviation analysis and compensation hour suggestions
- **Transfer Analysis** — suggesting and applying trip transfers between drivers to balance salaries
- **Beleg / receipt upload** — expense tracking with OCR for tank receipts
- **Finale Dokumente** — consistency-checked finalization producing Fahrtenbuch XLSX + Stundennachweise
- **Documents / Stundennachweise storage** — document management system
- **Abrechnung** — weekly/monthly cash settlement reports per driver
- **Historical Reconciliation** — reconcile historical months against Steuerberater values (two modes: Brutto-Gehälter and Arbeitsstunden with 7-phase block engine)

UI language: **German**. German UI labels must remain in German.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18.3.1 + TypeScript 5.5.3 |
| Build | Vite 5.4.2 |
| Routing | React Router DOM 7.9.4 |
| Styling | Tailwind CSS 3.4.1 |
| Icons | Lucide React 0.344.0 |
| Dates | date-fns 4.1.0 |
| XLSX export | xlsx 0.18.5 |
| Image capture | html2canvas 1.4.1 |
| PDF export | jspdf 4.2.1 |
| OCR | tesseract.js 7.0.0 |
| Backend | Supabase (PostgreSQL + Auth + Storage + Edge Functions) |
| Auth | Supabase Auth (email/password) |

---

## 3. Project Structure & Code Map

```
src/
├── App.tsx                          # All routes, feature gating
├── main.tsx                         # Entry point
├── index.css                        # Global theme variables
├── components/
│   ├── AppLayout.tsx                # Sidebar + header shell
│   ├── Sidebar.tsx                  # Nav with role-based visibility
│   ├── LoginForm.tsx                # Auth form
│   ├── MonatsplanungAssignmentPreview.tsx  *** CORE PLANNING UI
│   ├── MonatsplanungStundennachweisPreview.tsx  *** STUNDENNACHWEIS
│   ├── MonatsplanungAppliedRuns.tsx         *** APPLIED RUNS LIST
│   ├── MonatsplanungDriverPool.tsx          # Driver pool for planning
│   ├── FinalizePlanningModal.tsx            *** FINAL DOCS + CHECKS
│   ├── FahrtenbuchImportModal.tsx           # Import XLSX modal
│   ├── FahrtenbuchTripsView.tsx             # Trip view for import
│   ├── ReceiptModal.tsx                     # Receipt form + OCR
│   ├── ReceiptList.tsx                      # Receipt table
│   ├── ReceiptStatistics.tsx               # Receipt stats
│   ├── SalaryDetailsModal.tsx              # Salary breakdown + payroll split
│   ├── SalaryPaymentModal.tsx              # Record payment
│   ├── SalariesManagement.tsx             # Salary list
│   ├── DriverSalarySummaryCard.tsx         # Per-driver salary card
│   ├── DriversManagement.tsx              # Driver CRUD
│   ├── DriverModal.tsx                    # Driver form
│   ├── CarsManagement.tsx                 # Vehicle CRUD
│   ├── WerkstattCheckModal.tsx            # Workshop inspection form
│   ├── IncomeManagement.tsx               # Income tracking
│   ├── FixedCostsManagement.tsx           # Fixed costs
│   ├── DocumentBuilder.tsx               # Visual document editor
│   ├── GenerateStundennachweisModal.tsx   # Generate Stundennachweis
│   ├── GenerateInvoicesModal.tsx          # Invoice generation
│   ├── PlanManagementModal.tsx            # Plan management
│   ├── FinalizePlanningModal.tsx          # See §15
│   ├── TrinkgeldQuittungModal.tsx         # Tip receipt
│   ├── MietwagenauftragModal.tsx          # Rental order
│   ├── UpdateIncomeWeeks.tsx             # Batch week update UI
│   ├── HistoricalReconciliationWizard.tsx *** Brutto-Gehälter mode
│   ├── HistoricalWorkingHoursWizard.tsx   *** Arbeitsstunden mode (block engine)
│   ├── ManualTimeCorrectionPanel.tsx      *** Block engine + exported pure fns
│   ├── HistoricalHourTargetsManager.tsx   # Manage saved hour targets
│   └── ... (other modals/cards)
├── pages/
│   ├── CompanyPlannerPage.tsx            *** MAIN PLANNING PAGE
│   ├── StundennachweisPage.tsx           # Stundennachweis list
│   ├── BelegePage.tsx                    # Receipt page
│   ├── SalariesPage.tsx                  # Payroll page
│   ├── AbrechnungPage.tsx               # Settlement page
│   ├── UmsaetzePage.tsx                 # Revenue page
│   ├── FahrerPage.tsx                   # Drivers page
│   ├── CarsPage.tsx                     # Cars page
│   ├── OverviewPage.tsx                 # Dashboard
│   ├── StatistikenPage.tsx              # Analytics
│   ├── WerkstattPage.tsx               # Workshop
│   ├── NotesPage.tsx                   # Driver notes
│   ├── SettingsPage.tsx                # Company settings
│   ├── UsersPage.tsx / RolesPage.tsx   # User/role admin
│   ├── SuperAdminDashboard.tsx          # Super-admin panel
│   ├── AbnahmeDiagnosticPage.tsx       # Diagnostic tool (super-admin)
│   └── CompanyPlannerPage.legacy.tsx   # LEGACY — DO NOT MODIFY
├── contexts/
│   ├── AuthContext.tsx                 # Auth state, session timeout
│   ├── CompanySettingsContext.tsx      # Company logo/name
│   ├── PlanContext.tsx                 # Subscription plan gating
│   ├── ToastContext.tsx               # Toast notifications
│   └── ThemeContext.tsx               # Dark/light theme
├── hooks/
│   ├── useDatabase.ts                 # Data access layer
│   ├── useFahrtenbuch.ts             # Fahrtenbuch import/trip loading
│   └── useDocuments.ts              # Document operations
├── utils/
│   ├── monatsplanungPhase1.ts         *** Phase 1 block builder
│   ├── monatsplanungPhase3.ts         *** Phase 3 driver assignment
│   ├── monatsplanungPhase4.ts         *** Phase 4 change set
│   ├── monatsplanungXlsxExport.ts     *** XLSX export + applied run fetch
│   ├── stundennachweisPdfExport.ts    *** PDF generation for Stundennachweis
│   ├── historicalReconstructionSolver.ts  *** Historical solver (Brutto mode + holidays)
│   ├── historicalPlannerSolver.ts     # Historical planner helpers
│   ├── receiptOcr.ts                  *** OCR parsing logic
│   ├── weekCalculations.ts           # Business week logic
│   ├── shiftBlockEngine.ts           # Shift block calculation
│   ├── shiftWindow.ts                # Shift window helpers
│   ├── vehicleBlockPlanner.ts        # Vehicle block planning helpers
│   ├── carBlockResolver.ts           # Car block resolution
│   ├── driverSalaryPdf.ts            # Driver salary PDF
│   ├── fahrtenbuchExport.ts          # Fahrtenbuch export helpers
│   ├── fahreruebersichtExport.ts     # Driver overview export
│   ├── overviewHelpers.ts            # Dashboard calculations
│   ├── warningCategories.ts          # Warning classification
│   ├── pricing.ts                   # Subscription pricing
│   ├── excelExport.ts               # Excel export utilities
│   ├── backup.ts                    # Backup utilities
│   └── errorHandler.ts             # Error formatting
├── lib/
│   ├── supabase.ts                  # Supabase client init
│   └── api.ts                       # Legacy API utilities
└── types/
    ├── car.ts / receipt.ts / document.ts / role.ts / settings.ts
```

**Files marked \*\*\* are the most business-critical and contain most of the complex logic.**

---

## 4. Development Principles

> These principles must be followed by all developers.

- **Work step by step.** Prefer small, safe, targeted changes. Avoid large refactors.
- **Do not modify V2 unless explicitly requested.** The file `CompanyPlannerPage.legacy.tsx` and any "V2" experimentation must not be touched.
- **V1/current stable planning is the active workflow.** `CompanyPlannerPage.tsx` + its 4-phase engine is the canonical planning system.
- **German UI labels must stay German.** Never translate German UI text to English. Labels like `Stundennachweis`, `Fahrer`, `Schicht`, `Fahrzeugwechsel zu kurz`, etc. are fixed.
- **Fahrtenbuch and Stundennachweise must be generated from the same final planning snapshot.** No decoupled generation. Both documents must come from the identical set of finalized `fahrtenbuch_trips` rows belonging to the applied planning run. Finalization is not complete unless both are generated from the same snapshot. See §23 open task #3 for current implementation gap.
- **Do not modify Fahrtenbuch data for Stundennachweis purposes.** Ausgleichsstunden appear in Stundennachweis only; they must not create fake trips or modify `fahrtenbuch_trips`.
- **Never bypass finalization checks.** Documents are only downloadable after all consistency checks pass.
- **Canceled trips (`is_canceled = true`) must not be modified or re-assigned.**
- **Historical block engine is the sole pipeline for Arbeitsstunden mode.** Do not re-introduce the old `runReconstructionSolver` path for `HistoricalWorkingHoursWizard`. The block engine in `ManualTimeCorrectionPanel.tsx` (exported pure functions) is the authoritative assignment logic.

---

## 5. Authentication & Authorization

### Auth Flow

**Implemented.** Uses Supabase email/password auth.

```typescript
// AuthContext.tsx
SESSION_TIMEOUT = 20 * 60 * 1000  // 20 minutes inactivity
LAST_ACTIVITY_KEY = localStorage key for inactivity tracking
Activity events tracked: mousedown, keypress, touchstart, click
```

### User Profile (`user_profiles` table)

```typescript
{
  id: uuid,
  user_id: uuid (FK auth.users),
  email: string,
  full_name?: string,
  role: 'admin' | 'creator' | 'viewer',
  role_id?: uuid (FK roles),
  company_id: uuid (FK companies),
  is_super_admin: boolean,
  status: 'active' | 'inactive' | 'pending_invite' | 'suspended' | 'deactivated',
  created_at, updated_at
}
```

### Block Reasons

When login is blocked, `checkProfileAccess()` returns a `BlockReason`:

| Reason | Message |
|---|---|
| `user_inactive` | Benutzerkonto deaktiviert |
| `user_suspended` | Benutzerkonto gesperrt |
| `user_deactivated` | Benutzerkonto wurde deaktiviert |
| `company_suspended` | Unternehmenskonto gesperrt |
| `company_inactive` | Unternehmenskonto nicht aktiv |
| `company_deleted` | Unternehmenskonto gelöscht |

### Roles

| Role | Description |
|---|---|
| `admin` | Full access, user/role management, settings |
| `creator` | Create/edit own records, read all |
| `viewer` | Read-only |
| Custom roles | Page-level view/edit permissions via `role_permissions` |

Support user `support@yamobility.de` has admin-level access for troubleshooting.

---

## 6. Main Application Routes & Feature Gating

Routes are gated via `PlanContext` / `PlanGate`:

```
/overview          — Dashboard (ungated)
/belege            — Receipts (ungated)
/fahrer            — Drivers (ungated)
/cars              — Vehicles (ungated)
/umsaetze          — Revenue (ungated)
/fixkosten         — Fixed Costs (ungated)
/bargeldbestand    — Cash Balance (ungated)
/werkstatt         — Workshop (gated: werkstatt)
/abrechnung        — Settlement (gated: abrechnung)
/notizen           — Notes (gated: notizen)
/benachrichtigungen — Notifications (gated: benachrichtigungen)
/salaries          — Payroll (gated: gehaelter)
/dokumente         — Documents (gated: dokumente)
/stundennachweis   — Stundennachweis (gated: dokumente)
/company-planner   — Monthly Planning (gated: dokumente)
/users             — User management (admin only)
/roles             — Roles (admin only)
/settings          — Settings (admin only)
/billing           — Billing (admin only)
/super-admin       — Super admin panel (is_super_admin only)
/super-admin/abnahme-diagnose — Diagnostic tool (super-admin)
```

---

## 7. Business Week Logic

**Implemented** in `src/utils/weekCalculations.ts`.

**Core principle:** A week belongs to the month where its **Monday** falls.

```
April 1 (Tuesday) → Monday = March 31 → Belongs to March
```

Key functions:
- `getWeekMonday(date)` — Returns the Monday of the given date's week
- `getBusinessWeekRange(date)` — Returns Monday–Sunday range
- `getBusinessMonth(date)` — Determines business month membership
- `getBusinessWeeksForMonth(month, year)` — All business weeks for a month
- `getWeekNumberForDate(date)` — Week number within business month
- `isDateInBusinessMonth(date, month, year)` — Validates week membership

---

## 8. Income Types & Revenue Rules

**Implemented.** Four tracked income types:

| Type | German | Description | Used In |
|---|---|---|---|
| `bargeld` | Bargeld | Physical cash | Settlement (Abrechnung) |
| `umsatz` | Umsatz | Card/online payments | Salary calculation |
| `trinkgeld` | Trinkgeld | Tips (100% to driver) | Salary calculation |
| `aktionen` | Aktionen | Promotions | Salary calculation |

**Business rule:** Cash (Bargeld) and Tips (Trinkgeld) are pass-through; they do not count toward company profit.

**Tankenquote rule (Business rule, Implemented in Abrechnung):**

> Tankenquote = (Summe Tanken-Belege brutto) / (Netto-Fahrpreis + Aktionen) × 100

Only Belege with Kategorie = `Tanken` for the selected driver and period are included. Do not use all Belege. Only the final percentage is displayed — do not show the internal Tanken sum.

---

## 9. Salary Calculation

**Implemented.**

```
Driver Salary = (Online Revenue × salary_ratio) + (Tips × 100%)
Online Revenue = Umsatz + Aktionen
salary_ratio = driver commission (0.0 – 1.0, default 0.5)
```

### Payroll Split (SalaryDetailsModal.tsx)

```typescript
calculatedSalaryTotal = salary.netto_salary ?? salary.amount_due
cashSalary = calculatedSalaryTotal - payroll_gross_amount   // paid in cash
bankSalary = payroll_net_amount                              // paid via bank
totalNetPayout = cashSalary + bankSalary
```

Validation:
- `grossExceedsTotal`: warns if `payroll_gross_amount > calculatedSalaryTotal + 0.01`
- `cashIsNegative`: warns if `cashSalary < -0.01`

### Payment Tracking

Payment records include `payment_type` (`'cash'|'uberweisung'`), `source_type`, `source_reference`.

Duplicate prevention: checks `source_type='weekly_cash_difference' AND source_reference=ref` before inserting.

---

## 10. Settlement (Abrechnung) Logic

**Implemented.**

```
Weekly Balance = Cash Collected (Bargeld) – Cash Expenses (Bar Receipts)
Monthly Balance = Sum of all weekly balances
```

- Positive: driver returns cash to company
- Negative: company owes driver

DB functions (RPCs):
- `get_weekly_abrechnung(p_year, p_month)` — all drivers, weekly
- `get_driver_weekly_abrechnung(p_driver, p_year, p_month)` — single driver weekly
- `get_monthly_abrechnung(p_year, p_month)` — all drivers, monthly
- `get_driver_monthly_abrechnung(p_driver, p_year, p_month)` — single driver monthly

View: `abrechnung_weekly`

---

## 11. Monthly Planning System (Monatsplanung)

**Implemented.** The entire planning engine (Phases 1–4) is in-memory and read-only until "Plan anwenden" is clicked. Only a single DB write occurs at apply time.

### Full Workflow

```
1. Import Fahrtenbuch (XLSX → fahrtenbuch_imports + fahrtenbuch_trips)
2. Phase 1: Build vehicle blocks from trips
3. Phase 3: Assign drivers to blocks (greedy + repair)
4. Manual resolution for unassigned blocks (optional)
5. Phase 4: Build change set
6. Apply plan (Phase 5) → writes to DB
7. Review applied run in MonatsplanungAppliedRuns
8. Check Transfer Analysis
9. Apply selected valid transfers (if needed)
10. Check Gehaltsabweichung / Ausgleichsanalyse
11. Add Ausgleichsstunden (if drivers under target)
12. Open Stundennachweis Preview
13. Run Finale Dokumente Erstellen (consistency checks)
14. Download Fahrtenbuch XLSX + Stundennachweise PDFs
```

---

### Phase 1 — Vehicle Block Building

**File:** `src/utils/monatsplanungPhase1.ts`
**Export:** `buildPhase1VehicleBlocks(trips, options?): Phase1Result`

**Constants:**
```typescript
VEHICLE_BLOCK_GAP_MINUTES = 60         // gap between trips → new block
DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES = 270  // 4h30 max block
MIN_VEHICLE_BLOCK_DURATION_MINUTES = 30           // short block threshold
```

**Logic:**
1. Group trips by vehicle + service_date
2. Sort chronologically (start_time)
3. Split into blocks when gap > `blockSeparatorGapMinutes` (UI-configurable, default 60)
4. Split blocks exceeding `maxBlockDurationMinutes` (default 270)
5. Merge short blocks (< `minBlockDurationMinutes`, default 30) greedily with neighbors, never exceeding max

**Output `Phase1Result`:**
- `blocks[]` — `Phase1VehicleBlock` objects (with `trip_ids`, `duration_minutes`, `split_reason`, `merge_status`)
- `summary` — aggregate stats (blocks_split_by_gap, blocks_split_by_max_duration, short_blocks_merged, etc.)
- `perVehicle[]` — per-vehicle stats
- `coverageIssues[]` — validation issues
- `skippedTrips[]` — trips excluded due to missing_time / missing_vehicle / invalid_datetime

---

### Phase 3 — Driver Assignment

**File:** `src/utils/monatsplanungPhase3.ts`
**Export:** `assignBlocksPhase3(blocks, selectedDrivers, options?): Phase3Result`

**Constants:**
```typescript
DEFAULT_MAX_DAILY_HOURS = 8                  // default daily limit
MIN_VEHICLE_SWITCH_BUFFER_MINUTES = 60       // switch buffer (planning)
```

**`RejectReason` type:**
```typescript
'wrong_weekday' | 'outside_working_time_window' | 'daily_max_exceeded' |
'monthly_max_exceeded' | 'driver_overlap' | 'vehicle_switch_buffer_violation' |
'one_vehicle_per_day' | 'note_constraint'
```

**Hard constraints (NEVER bypassable):**
- `wrong_weekday` — allowed_weekdays not satisfied
- `driver_overlap` — driver already has overlapping time
- `vehicle_switch_buffer_violation` — < 60 min gap for different vehicle
- `one_vehicle_per_day` — (when option enabled) driver uses multiple vehicles
- `note_constraint` — hard note token (e.g., "keine nachtschicht")

**Bypassable constraints (via manual exception):**
- `outside_working_time_window` → flag `allowDienstzeit`
- `daily_max_exceeded` → flag `allowDaily`
- `monthly_max_exceeded` → flag `allowMonthly`

**Repair strategies (automatic):**
1. Direct — find driver with free slot
2. Move — move conflicting blocks
3. Swap — swap conflicting blocks between drivers

**Output `Phase3Result`:**
- `assigned[]` — `AssignedBlock[]` with `assignment_reason: 'auto'|'repair'|'manual_exception'`
- `unassigned[]` — `UnassignedBlock[]` with `rejected[]`, `repair_attempted`, `intentionally_open?`
- `driverStates[]` — per-driver state
- `validation` — counts: overlaps, vehicle_switch_violations, window_violations, etc.
- `noteWarnings[]` — drivers with uninterpretable notes

---

### Phase 4 — Change Set Building

**File:** `src/utils/monatsplanungPhase4.ts`
**Export:** `buildChangeSet(phase3, trips, selectedDrivers): Phase4Result`

**`ChangeRow` fields:**
```typescript
{
  trip_id, excel_row, service_date, start_datetime, end_datetime, vehicle_identifier,
  original_driver_id, original_driver_name, new_driver_id, new_driver_name,
  block_id, assignment_source: 'auto' | 'repair' | 'manual_exception',
  dienstzeit_exception, tageslimit_exception, monatslimit_exception, exception_reason,
  changed, is_canceled
}
```

**`Phase4Summary`:**
- `total_trips, abgeschlossen, zu_aendern, unveraendert, zugewiesene_bloecke, offene_fahrten`
- `manual_ausnahmen, dienstzeit_ausnahmen, tageslimit_ausnahmen, monatslimit_ausnahmen`

**Consistency issues checked:** duplicate_trip_in_changeset, canceled_trip_in_changeset, missing_driver, non_selected_driver, manual_exception_missing_flag, abgeschlossen_not_in_changeset, change_count_mismatch. Up to 200 issues shown.

**Output `Phase4Result.valid`** = `true` only if no consistency issues.

---

### Phase 5 — Apply Plan

**Implemented in `MonatsplanungAssignmentPreview.tsx`**, `handleApply()`.

**Writes to DB:**
1. Upsert `company_planning_runs` (creates run or updates existing with month/year conflict)
2. Batch UPDATE `fahrtenbuch_trips` via RPC (sets `assigned_driver_id`, `assigned_driver_name`, `assignment_block_id`, `assignment_planning_run_id`, `assignment_source`, exception flags)
3. INSERT into `monthly_planning_manual_exceptions` (one row per manual exception block)
4. UPDATE run status to `'applied'`, writes `apply_summary_json`

**`apply_summary_json` contains:**
```json
{
  "updated_trips": 1692,
  "skipped_canceled": 0,
  "manual_exceptions_saved": 5,
  "applied_at": "2026-05-01T...",
  "applied_by": "uuid...",
  "verify_assigned_in_import": 1692,
  "verify_canceled_in_import": 12,
  "verify_rows_with_run": 1692,
  "verify_exceptions_in_run": 5
}
```

**One planning run per month/year per company.** If a run already exists for the same month/year, `already_applied = true` is returned and the user is offered "Bestehende Planung ersetzen".

**Replace flow** (`replace_and_archive_monthly_planning_run` RPC):
- Archives old run (status → `'replaced'`)
- Re-applies new planning assignments

---

### Post-Apply Popup Behavior

**Implemented** in `MonatsplanungAssignmentPreview.tsx`.

After a successful apply, the "Plan erfolgreich angewendet" popup shows:
- Green success banner
- Planning Run ID, updated trips, skipped canceled, applied_at, applied_by
- Nachprüfung (verification) row summary

**Action buttons (bottom of popup):**

| Button | Action |
|---|---|
| **Stundennachweis Preview öffnen** | Closes popup, opens `MonatsplanungStundennachweisPreview` for the applied run |
| **Finale Dokumente erstellen** | Closes popup, opens `FinalizePlanningModal` for the applied run |
| **Schließen** | Closes popup |

> **Critical rule:** No "Fahrtenbuch XLSX herunterladen" button exists in this popup. Final Fahrtenbuch download is only available after finalization checks pass inside `FinalizePlanningModal`.

---

## 12. Stundennachweis (Time Record) System

### Data Loading

**Implemented in `MonatsplanungStundennachweisPreview.tsx`.**

Trips are loaded from `fahrtenbuch_trips` WHERE:
- `company_id = companyId`
- `assignment_planning_run_id = run.id`
- Only non-canceled trips used for calculations

### Night Shift Buckets

```typescript
PREM_NIGHT = 0.40  // 40% night premium
PREM_SUN   = 0.50  // 50% Sunday premium

Night buckets:
  n23_00: 23:00 – 00:00
  n00_04: 00:00 – 04:00
  n04_06: 04:00 – 06:00
  n_premium_20_04: 20:00 – 04:00 (generator-compatible window)
```

### Lohnarten

| Lohnart | Description | Premium |
|---|---|---|
| 1000 | Stundenlohn (Grundlohn) | base rate |
| 1500 | Nachtzuschlag 25% steuerfrei | 20:00–00:00 + 04:00–06:00 |
| 1501 | Nachtzuschlag 40% steuerfrei | 00:00–04:00 |
| 1510 | Sonntagszuschlag | 50% steuerfrei |
| 1520 | Feiertagszuschlag | 125% steuerfrei |

> **Night split rule (no double-counting):** 1500 = `nightSec − night0to4Sec`; 1501 = `night0to4Sec`. These two buckets are mutually exclusive.

### Schicht Compression

**Important rule (Implemented):**

- Max 3 Schichten per Fahrer per day in Stundennachweis
- Compression constants: `MAX_SHIFT = 270` (4h30), `MAX_DAY = 510` (8h30)
- Compression is **display/export only** — it must NOT modify actual minutes, night/Sunday/holiday values, Brutto calculation, or trip assignments

### PDF Export (`stundennachweisPdfExport.ts`)

**Export:** `exportStundennachweisAsPdf(data: StundennachweisExportData, filename: string): void`

PDF layout:
- Page 1: Header (name, Personalnummer, month/year), day-by-day table with 3 shift columns, totals row, signature lines
- Page 2+: Historical Lohnart reconciliation table (for `isHistorical = true`), notes, warnings
- German decimal format for all hours: `minsToDecimal(mins) = Math.round((mins/60)*100)/100`
- Color rows: holiday (light orange), Sunday + Saturday (light gray)

---

## 13. Gehaltsabweichung / Ausgleichsanalyse

**Implemented in `MonatsplanungStundennachweisPreview.tsx`.**

### Deviation Detection

```
Tolerance: ±100 €

Status:
- Über Ziel   (> Wunschgehalt + 100)
- Im Zielbereich
- Unter Ziel  (< Wunschgehalt - 100)
```

### Ausgleichsstunden

```
missing_amount = Wunschgehalt - Brutto erwartet
needed_hours   = missing_amount / driver_hourly_rate
```

Rules:
- Use Lohnart 1000 (Stundenlohn) only
- No night/Sunday/holiday premium for Ausgleichsstunden
- Must NOT appear in Fahrtenbuch; must NOT create fake trips; must NOT modify `fahrtenbuch_trips`

---

## 14. Transfer Analysis

**Implemented in `MonatsplanungStundennachweisPreview.tsx`.**

### Validation Statuses

| Status | Meaning |
|---|---|
| Gültig | Transfer is valid and can be applied |
| Nicht möglich | Hard constraint violated — do not apply |
| Prüfung erforderlich | Soft warning — review before applying |

### Weekday Business Rules (Override for Transfer Analysis Only)

```
Ahmed Hemaid:  Sa, So only           → display: "Wochentage: Sa, So (Business Rule Ahmed)"
Alev Büyükay:  Mo, Di, Mi, Do, Fr    → display: "Wochentage: Mo, Di, Mi, Do, Fr (Business Rule Alev)"
All others:    whole week             → display: "Wochentage: ganze Woche (Business Rule)"
```

> These rules are hardcoded as business rules. They override the general weekly availability check.

---

## 15. Finale Dokumente erstellen

**Implemented in `src/components/FinalizePlanningModal.tsx`.**

### Step Flow

```
idle → checking → (ready | blocked) → finalizing → done
```

### Pre-Flight Checks (10 total)

All must pass for finalization to proceed. Each failed check shows a red error line with details. There is no override.

| # | Check | Blocking |
|---|---|---|
| 1 | Planning run status is `'applied'` | Yes |
| 2 | Trip count matches `apply_summary_json.updated_trips` | Yes |
| 3 | No duplicate trip IDs | Yes |
| 4 | All non-canceled trips have `assigned_driver_id` (no driver overlaps accepted) | Yes |
| 5 | All non-canceled trips have `assignment_block_id` | Yes |
| 6 | All non-canceled trips have `start_time` and `end_time` | Yes |
| 7 | Max 3 Schichten per Fahrer per day | Yes |
| 8 | **Fahrzeugwechsel zu kurz** — same driver + different `car_identifier` + gap < 60 min | Yes |
| 9 | Driver summary builds without error | Yes |
| 10 | All driver trip data internally consistent | Yes |

### Stale Detection

After finalization, if a trip transfer is applied, the finalization record is marked `is_stale = true`. The applied run list shows "Nicht aktuell" badge. User must re-finalize.

---

## 16. Short Vehicle Switch Rule

**Implemented.** Critical hard-blocking rule.

```typescript
// src/components/FinalizePlanningModal.tsx
const MIN_CAR_SWITCH_GAP_MINUTES = 60;
```

**Rule:** Same driver + different `car_identifier` + gap < 60 minutes = **Fahrzeugwechsel zu kurz**

This blocks `Finale Dokumente erstellen`. There is no override.

> **Known bug:** The current gap calculation compares only `HH:MM` string values. This fails for trips spanning midnight. Negative values like `-86100 Sek` have been observed. **Fix required:** use full `startDateTime = trip_date + 'T' + start_time` as a timestamp. Only display a violation when `0 <= gapMinutes < MIN_CAR_SWITCH_GAP_MINUTES`. See §23 open task #1.

---

## 17. Fahrtenbuch XLSX Export

**Implemented in `src/utils/monatsplanungXlsxExport.ts`.**

### Export Modes

| Mode | Description |
|---|---|
| `'original'` | Exact original headers/column order. Only replaces Fahrername with assigned driver for completed trips. Strict header match required. |
| `'audit'` | Original sheet + extra "Planung_Audit" sheet with assignment metadata columns. |

### Driver Column Detection (in order)

1. Exact match: `"Fahrername"`
2. Match `raw_data_json[header] == trip.original_driver_name`
3. Case-insensitive: `"fahrername"`, `"fahrer"`, `"fahrer name"`, `"driver name"`, `"driver"`

---

## 18. Beleg / Receipt System & OCR

### Belegnummer Generation

**Critical business rule (Implemented):**

> **The Belegnummer is ALWAYS generated by the system. Never overwrite it from OCR.**

Format: `BEL-{timestamp}-{4-digit-random}` — collision-checked against existing receipts.

### Date Handling

- Internal storage: `YYYY-MM-DD`
- Display input: `DD/MM/YYYY` (German format)
- OCR parse: `DD.MM.YYYY` → convert to `YYYY-MM-DD`
- **Never use US format `MM/DD/YYYY`**

### Amount Format

- Display: German decimal comma — `41,47` (correct), `41.47` (wrong)
- Parse: `cleaned.replace(/\./g, '').replace(',', '.')` → float

### OCR Logic (`src/utils/receiptOcr.ts`)

Amount scoring: `Gesamtbetrag`/`Z-Summe` context (+100), `EUR` same line (+70), fuel unit lines (−9999 rejection), `Netto`/`MwSt`/`Rückgeld` (−80). Amount < 1.00 EUR or >= 10000 EUR rejected.

**Confidence thresholds:**
```typescript
CONFIDENT = 50   // shown directly
UNCERTAIN = 25   // shown with orange "Bitte prüfen" indicator
```

---

## 19. Historical Reconciliation System

The historical reconciliation feature ("Alter Monat / Steuerberater-Abgleich") allows operators to align a past month's time records against Steuerberater (accountant) values. It has two modes:

### Alter Monat / Mit Brutto-Gehältern Mode

**File:** `src/components/HistoricalReconciliationWizard.tsx`

This mode reconciles gross salary totals (Lohnarten 1000, 1500, 1501, 1510, 1520) against the Steuerberater values for each driver. It uses `historicalReconstructionSolver.ts` to find a trip assignment that matches the target Lohnart hours as closely as possible.

---

### Alter Monat / Mit Arbeitsstunden Mode — Block Engine

**Files:** `src/components/HistoricalWorkingHoursWizard.tsx` (wizard), `src/components/ManualTimeCorrectionPanel.tsx` (block engine — exported pure functions)

This mode assigns whole vehicle blocks to drivers to match the target working hours. **It does NOT use `runReconstructionSolver`** — the solver was replaced with a deterministic 7-phase block engine.

#### Wizard Steps

```
Step 0 — Monat & Fahrtenbuch wählen
Step 1 — Lohnabrechnung-Zielwerte je Fahrer eingeben
Step 2 — Block-Abgleich berechnen (triggers the 7-phase engine)
Step 3 — Ergebnis prüfen (shows phase summary + driver results)
Step 4 — Dokumente erstellen (Fahrtenbuch XLSX + Stundennachweise PDFs)
```

---

### Block Engine — 7-Phase Pipeline

**Implemented in `handleCompute()` inside `HistoricalWorkingHoursWizard.tsx`.**

All block engine pure functions are exported from `ManualTimeCorrectionPanel.tsx`.

#### Block Config Constants (in ManualTimeCorrectionPanel.tsx)

```typescript
BLOCK_GAP_SEC  = 30 * 60   // 30 min gap chains rides into a block
SLOT_INC_SEC   = 15 * 60   // 15 min slot increment for owner overflow search
DAY_START_SEC  =  8 * 3600  // earliest slot start for overflow candidates
DAY_END_SEC    = 18 * 3600  // latest slot start for overflow candidates
```

Minimum block duration: 60 minutes (enforced by validity check in `chainToVehicleBlock`).

#### Phase 1 — Build Vehicle Blocks

`buildVehicleBlocks(allTrips): VehicleBlock[]`

Groups all non-canceled trips by `car_identifier + trip_date`, sorts by start time, chains rides into blocks when the gap between end of prior ride and start of next is ≤ `BLOCK_GAP_SEC` (30 min). Marks blocks as `'invalid'` if they contain internal vehicle overlaps or zero-duration rides.

#### Phase 2 — Assign Blocks to Regular Drivers

`assignBlocksToRegularDrivers(validBlocks, allowedDrivers): { assignments, rejections }`

- Sorts blocks by Lohnart impact (night/Sunday blocks first)
- For each block, tries each driver whose `targetWorkSec` is not yet fully satisfied
- **Strict ride-level overlap check:** builds absolute-ms intervals for every ride in the candidate block (`dateMidnightMs(block.date) + ride.startSecOfDay * 1000`), checks against every interval in the driver's `occupied` list
- On assignment, pushes one interval per ride into `occupied`
- If all drivers reject the block (overlap or target full) → pushed to Inhaber surplus (Phase 3); records a `Phase2Rejection` for the diagnostic UI

> **Critical:** The overlap check uses ride-level absolute milliseconds — NOT `parseFullDatetimeMs(block.originalBlockStartFull)`. This is because `originalBlockStartFull` may be a time-only string (`HH:MM:SS`) for some imports, which returns 0 from `parseFullDatetimeMs`. Always use `dateMidnightMs(block.date) + ride.startSecOfDay * 1000`.

#### Phase 3 — Remaining Blocks to Owner (Surplus)

All valid blocks not assigned in Phase 2 go to the owner/Inhaber without any time change.

#### Phase 4 — Detect & Resolve Owner Overlaps

`detectOwnerOverlaps(ownerBlocks): OwnerOverflowBlock[]`

`findOwnerOverflowSlots(overflowCandidates, allTrips, regularAssignments, ownerBlocks, inhaberDriverId): OwnerOverflowBlock[]`

- Detects which owner blocks overlap each other on the same date
- For each overlapping block, searches for a free time slot (vehicle-free + owner-free, checked against all non-overflow trips + already-placed owner blocks)
- Slot search: 08:00–18:00 in 15-min increments, then 00:00–08:00
- If a slot is found → `status: 'proposal'`, offset applied to all rides in block
- If no slot → `status: 'no_slot'`
- In the wizard, all proposals are **auto-approved** (no manual confirmation required)

#### Phase 5 — Build `finalBlockAssignmentSnapshot`

`expandToAdjustments(blocks, regularAssignments, ownerBlocks, overflowApproved, ...): TimeAdjustment[]`

Produces a `TimeAdjustment[]` for every ride in every block:
- Regular assignment: `adjustment_type = 'driver_block_assignment_v1'`, times unchanged
- Owner surplus: `adjustment_type = 'driver_block_assignment_v1'` with owner's driver ID, times unchanged
- Owner overflow (shifted): `adjustment_type = 'owner_overflow_block_v1'`, times shifted by `offsetSec`
- Invalid original block: `adjustment_type = 'invalid_original_block'`, `status = 'invalid'`, times unchanged

The wizard converts this list into `FinalBlockAssignmentRow[]` (`finalSnapshot`) — the sole source of truth for all downstream views.

#### Phase 6 — Compute `WzDriverResult` from Snapshot

For each configured driver, filters `finalSnapshot` rows where `final_driver_id === cfg.driverId && is_exportable`, then:
- Calls `computeLohnartActualsFromSnapshot(rows, holidays)` — computes Grundlohn/Nacht25/Nacht40/Sonntag seconds from final datetimes
- Calls `buildWzPdfRowsFromSnapshot(rows, month, year, holidays)` — builds day-by-day `PdfDayRow[]` for PDF
- Computes `corrBaseH = targetH − actualH` for each Lohnart
- Builds `HistoricalLohnartReconciliation` (shown in expanded driver card and on PDF page 2)

#### Phase 7 — Name Validation

Iterates `finalSnapshot` rows to count: `invalidCount`, `unresolvedCount`, `nonCanonicalCount`, `originalDataWarnings`. Unresolved and invalid rows block export.

---

### Phase 2 Overlap Check Detail

```typescript
// correct — ride-level absolute ms
function blockRideIntervals(block: VehicleBlock): Array<{ startMs: number; endMs: number }> {
  const baseDayMs = dateMidnightMs(block.date);
  return block.rides.map(ride => ({
    startMs: baseDayMs + ride.startSecOfDay * 1000,
    endMs:   baseDayMs + ride.startSecOfDay * 1000 + ride.durationSec * 1000,
  }));
}

// overlap predicate (half-open intervals)
function overlapsMs(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
```

Cross-midnight rides are handled naturally: `endMs > baseDayMs + 86400 * 1000` is valid and will correctly overlap with next-day rides if any.

---

### Export Validation & Original-Data Warnings

The Fahrtenbuch export (`handleExportFahrtenbuch`) computes:

1. **`originalDriverOverlapKeys`** — `Set<string>` of `"lo:hi"` row-index pairs that overlap in the **raw unmodified** data. These are pre-existing Originaldaten issues.
2. **`originalVehicleOverlapKeys`** — same for vehicle overlaps in raw data.

After applying the block engine assignments to the exported trips, the overlap check splits results:
- Pair in `originalDriverOverlapKeys` → `originalDriverOverlapDetails` (amber warning, does NOT block export)
- Pair NOT in set → `driverOverlapDetails` (red error, BLOCKS export)

`fahrerOverlaps` in the validation card counts **only app-created** driver overlaps. Original-data overlaps appear as a separate "Originaldaten-Warnung (Fahrer)" amber row.

---

### FinalBlockAssignmentSnapshot

```typescript
interface FinalBlockAssignmentRow {
  source_row_index: number | null;
  trip_id: string;
  block_id: string | null;
  vehicle: string;
  original_driver_name: string | null;
  original_start_datetime: string;
  original_end_datetime: string;
  final_start_datetime: string;
  final_end_datetime: string;
  final_driver_id: string | null;
  final_driver_name: string | null;
  final_driver_role: 'regular' | 'inhaber' | 'unassigned' | 'invalid_original';
  assignment_type:
    | 'regular_block_assignment'
    | 'owner_surplus_assignment'
    | 'owner_overflow_time_shift'
    | 'invalid_original_block'
    | 'unassigned';
  time_changed: boolean;
  is_exportable: boolean;
  validation_reason: string | null;
}
```

`finalSnapshot` is set in state after `handleCompute()`. It is the **only** input for:
- Stundennachweis PDF row generation
- Lohnart actuals calculation
- Export validation
- Name validation
- Fahrtenbuch XLSX driver name overlay

---

## 20. Database Architecture

### Core Tables

#### `companies`
Multi-tenant root. All data is company-scoped.

#### `user_profiles`
Extended user data. Fields: `id, user_id, email, full_name, role, role_id, company_id, is_super_admin, status`.

#### `fahrtenbuch_imports`
```sql
id, company_id, month, year, file_name, imported_by, imported_at,
status ('pending'|'confirmed'|'archived'), row_count, notes,
source_columns_json (original headers), source_sheet_name
```

#### `fahrtenbuch_trips`
```sql
id, company_id, import_id,
trip_date (date), start_time (time), end_time (time), duration_minutes,
original_driver_id, original_driver_name,   ← IMMUTABLE
assigned_driver_id, assigned_driver_name,   ← MUTABLE (via RPC only)
car_id, car_identifier,                     ← IMMUTABLE
route_start, route_end, description,        ← IMMUTABLE
price_amount, cash_amount, online_amount, tip_amount, action_amount, ← IMMUTABLE
raw_data_json,                              ← IMMUTABLE (original row)
is_canceled (boolean),
assignment_planning_run_id (uuid),          ← set on apply
assignment_block_id (uuid),                 ← set on apply
assignment_source (text),                   ← 'auto'|'repair'|'manual_exception'
source_row_index (integer),                 ← 1-based row number from original XLSX
created_at, updated_at
```

> **Immutability trigger:** The following fields are protected — any UPDATE raises an exception: `trip_date, start_time, end_time, duration_minutes, car_id, car_identifier, route_start, route_end, description, price_amount, cash_amount, online_amount, tip_amount, action_amount, raw_data_json, original_driver_id, original_driver_name, import_id, company_id`

> **RLS:** No UPDATE policy exists on `fahrtenbuch_trips`. All updates must go through SECURITY DEFINER RPCs.

#### `company_planning_runs`
```sql
id, company_id, month, year, import_id,
status ('draft'|'applied'|'archived'|'replaced'),
max_shift_minutes, summary_json, settings_json, apply_summary_json,
applied_at, applied_by, created_by, created_at, updated_at
```

#### `planning_finalizations`
```sql
id, planning_run_id, company_id,
finalized_at, finalized_by, trip_count, driver_count,
driver_summary_json, is_stale, stale_reason, stale_at,
document_status ('ready'|'generated'|'error'),
created_at, updated_at
```

#### Historical Reconciliation Tables

| Table | Purpose |
|---|---|
| `historical_reconciliations` | One reconciliation per company/month/year/mode |
| `historical_reconciliation_wh_drivers` | Driver configs for Arbeitsstunden mode (targets, rates) |
| `historical_driver_hour_targets` | Saved target hours per driver/month (global, reusable) |
| `historical_time_adjustments` | Per-ride adjustments with `adjustment_type` field |

`adjustment_type` values:
- `'driver_block_assignment_v1'` — regular driver block assignment (no time change)
- `'owner_overflow_block_v1'` — owner overflow block with time shift
- `'invalid_original_block'` — ride from a block with original-data errors

#### Financial Tables

| Table | Purpose |
|---|---|
| `income` | Revenue entries per driver/type/date |
| `receipts` | Business expenses + receipts |
| `fixed_costs` | Monthly recurring costs |
| `salaries` | Calculated salary records |
| `salary_payments` | Individual salary payment records |
| `cash_transactions` | Cash flow (deposits + payments) |

#### Other Operational Tables

| Table | Purpose |
|---|---|
| `drivers` | Driver profiles, hourly rates, commission |
| `driver_notes` | Notes attached to drivers |
| `cars` | Vehicle inventory |
| `car_driver_assignments` | Vehicle ↔ driver assignments |
| `werkstatt_checks` | Vehicle inspection records |
| `documents` | Document records |
| `document_templates` | Reusable PDF template files |
| `roles` | Custom role definitions |
| `role_permissions` | Page-level permissions |
| `company_settings` | Company name, logo, etc. |
| `notification_settings` | Per-user notification config |
| `discount_codes` | Subscription discount codes |

### Key RPCs (Supabase Functions)

| RPC | Purpose |
|---|---|
| `reassign_fahrtenbuch_trip(trip_id, new_driver_id, new_driver_name, reason)` | SECURITY DEFINER. Reassigns a trip. Writes audit row. |
| `delete_or_archive_monthly_planning_run(p_run_id)` | Archives or deletes a planning run. |
| `replace_and_archive_monthly_planning_run(...)` | Archives existing run, applies new assignments. |
| `get_weekly_abrechnung(p_year, p_month)` | Weekly settlement for all drivers. |
| `get_monthly_abrechnung(p_year, p_month)` | Monthly settlement for all drivers. |
| `get_current_user_role()` | Returns authenticated user's role. |
| `is_role(role_text)` | Checks if authenticated user has role. |
| `get_current_cash_balance(user_email)` | Calculates current cash balance. |

### Storage Buckets

| Bucket | Access |
|---|---|
| `company-logos` | Public read, authenticated write |
| `document-templates` | Public read, authenticated write |

### RLS Policy Pattern

All tables have RLS enabled. Policies follow:
```sql
-- One policy per CRUD verb (never FOR ALL)
CREATE POLICY "select_..." ON table FOR SELECT TO authenticated USING (company_id = get_company_id());
CREATE POLICY "insert_..." ON table FOR INSERT TO authenticated WITH CHECK (...);
CREATE POLICY "update_..." ON table FOR UPDATE TO authenticated USING (...) WITH CHECK (...);
CREATE POLICY "delete_..." ON table FOR DELETE TO authenticated USING (...);
```

---

## 21. Supabase Edge Functions

Located in `supabase/functions/`:

| Function | Purpose | JWT Verify |
|---|---|---|
| `company-signup` | Handles new company signup flow | No (public) |
| `manage-users` | Admin user management (invite, deactivate) | Yes |
| `update-income-weeks` | Batch backfill week assignments on income rows | Yes |
| `extract-receipt` | OCR receipt extraction (wraps Tesseract) | Yes |
| `apply-discount-code` | Validates and applies discount codes | Yes |
| `validate-discount-code` | Validates discount code without applying | No (public) |
| `generate-activation-code` | Super-admin: generate activation codes | Yes |

All edge functions include CORS headers:
```typescript
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
```

---

## 22. Known Implementation Notes & Caveats

### Planning System

- **Planning is fully in-memory until apply.** Phases 1–4 do no DB reads or writes.
- **One active run per month/year per company.**
- **Canceled trips are immutable.** `is_canceled = true` trips must never be reassigned or included in Stundennachweis calculations.
- **`assignment_block_id` is preserved across transfers.**

### Historical Reconciliation — Arbeitsstunden Mode

- **No solver.** `HistoricalWorkingHoursWizard` does NOT call `runReconstructionSolver` or `buildReconstructionUnits`. The entire assignment pipeline is the 7-phase block engine.
- **`finalSnapshot` is the sole source of truth.** Stundennachweis PDF rows, Lohnart actuals, and export validation all read from `finalSnapshot`. Do not reintroduce solver-based `tripAssignments` as a source.
- **Ride-level overlap check.** Phase 2 uses `dateMidnightMs(block.date) + ride.startSecOfDay * 1000` — never `parseFullDatetimeMs(block.originalBlockStartFull)` (returns 0 for HH:MM:SS-only strings).
- **Owner overlaps are auto-approved.** The wizard does not show a manual confirmation step for overflow slots — all `'proposal'` statuses are auto-approved immediately in `handleCompute`.
- **Original-data driver overlaps do not block export.** They appear as amber "Originaldaten-Warnung (Fahrer)" only. Only app-created overlaps block the Fahrtenbuch download.

### Finalization

- **Only 1 INSERT to `planning_finalizations`.** Per-driver PDF Stundennachweise are generated client-side on demand.
- **Stale detection is DB-driven.** The `is_stale` flag is set by the system when a transfer is applied post-finalization.

### OCR

- **Belegnummer from OCR is NEVER applied.** Always use the system-generated `BEL-{timestamp}-{random}`.
- **Uncertainty indicators** (orange border) appear when `dateReason` or `amountReason` starts with `'Unsicher'`.

---

## 23. Current Open Tasks

1. **[CRITICAL] Fahrzeugwechsel zu kurz: fix chronological gap calculation.** Negative gaps (`Abstand -86100 Sek`) have been observed. Root cause: HH:MM integer arithmetic without full datetime. **Required fix:** parse trips as full timestamps using `new Date(\`${trip_date}T${start_time}\`).getTime()`. Only report violations when `0 <= gapMinutes < MIN_CAR_SWITCH_GAP_MINUTES`.

2. **Ausgleichsstunden: full persistence flow.** Confirm that: (a) suggestions can be saved to `planning_run_adjustments` DB table, (b) saved adjustments are loaded and applied in Stundennachweis PDF export, (c) they do not appear in Fahrtenbuch XLSX.

3. **[TARGET BEHAVIOR] Finalization must generate both Fahrtenbuch and Stundennachweise from the same snapshot.** Current behavior: Fahrtenbuch XLSX is downloaded immediately on finalize; Stundennachweise PDFs are generated separately on-demand and not stored or linked to the finalization record.

4. **Add missing finalization checks.** Not yet in `FinalizePlanningModal.tsx` pre-flight: (a) no vehicle overlaps; (b) no Fahrer above `Wunschgehalt + 100 €`; (c) Stundennachweis Preview can be generated for all drivers.

5. **Finale Dokumente: error messages.** Ensure all error paths surface readable German error messages.

6. **Transfer Analysis: re-validation before apply.** Confirm apply-transfer flow re-runs validation immediately before committing.

7. **Post-apply Stundennachweis button: `source_columns_json` is null.** `AppliedRunSummary` constructed from `applyResult` passes `source_columns_json = null`, so XLSX 'original' export may fall back to union-of-keys header detection.

8. **OCR PLZ/Stadt: edge case for multi-line city names.** Pass 2 (adjacent-line) detection works for single-word cities; verify with multi-word names (e.g. "Bergisch Gladbach").

---

## 24. Getting Started

### Prerequisites

- Node.js 24 (`.nvmrc`)
- npm

### Installation

```bash
npm install
cp .env.example .env
# VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY — point them at staging for day-to-day work
```

### Build and test

```bash
npm run build     # typecheck ratchet, golden tests, vite build, mail templates
npm run test      # vitest
npm run test:rls  # RLS policy tests against a throwaway Postgres (Docker)
npm run lint
```

The backend is the self-hosted Supabase stack in `deploy/`. Schema changes are migrations in `supabase/migrations/`, applied by `deploy/deploy.sh` during a release — never by hand.

---

## 25. Deployment

How releases work is in CLAUDE.md ("Environments and deployment"); the day-to-day commands are in HANDOFF.md.

1. Open a PR into `staging`. Merging it deploys https://app.elprofessor.eu.
2. Verify the change on staging.
3. Merge `staging` into `main`, then Actions → Deploy → Run workflow on `main` and confirm `production`. The job refuses unless `main` is exactly what staging runs.
4. If a release is bad: Actions → Rollback. It restores the previous release's code; the database is not rolled back, which is why migrations must stay compatible with the release before them.

---

*Sections 1–23 were last reviewed as a whole in June 2026. The Project status section at the top is updated with every change.*
