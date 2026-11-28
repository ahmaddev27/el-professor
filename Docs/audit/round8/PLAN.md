# FleetBook Round 8: plan and root-cause analysis (stop point 1)

Approved by the owner on 27.11.2026, with the defaults D1–D10 of §4 exactly as written. This is deliverable 1 (§13 item 1), the root-cause analysis. The auditor's specification is beside it, `Auftrag-fleetbook-round8.txt`, copied unchanged except that its line endings are stored as LF.

## 0. The five findings everything else follows from

1. **The calendar-mode generator plans vehicles, not drivers.** For every vehicle-day it places up to three shifts of random length (270–360 min, inside a hard 240–360 rule) and gives each shift a random eligible driver. It reads only a driver's weekdays, planning flag, status and confirmed notes. It never reads hours, pay or the work window. This is the root cause of §2 and §9.
2. **Every fare and every tip in calendar mode is invented.** Fares come from `fareFor` (`generator.ts`); tips go to 12 % of rides at 1–5 €. The month's revenue, and the 30–33 % share, are computed from those invented fares. Calendar mode never reads imported Uber money. This is the root cause of §4, §5 and §6.
3. **The share is a continuous draw of 3000–3300 basis points** (`monthlyRate.ts`, so 31,42 % can come out), applied to the generated revenue.
4. **With no saved base, the screen falls back to the centre of the address pool** (`const origin = base ?? pool.center`, `SimulatedRidesPage.tsx`). That is a guess. There is also no return-to-base leg and no setting for one. This is the root cause of §3.
5. **Imported Uber money exists, and daily, but only as per-driver totals for each operating day, in `income`.** It has no trips and no fee, and nothing says whether it is gross or net.

## 1. The data

| What | Where | Notes |
|---|---|---|
| Uber fare | `income`, `type = 'umsatz'` | Reidey's `fare` |
| Promotions | `income`, `type = 'aktionen'` | `promotion` |
| Tips | `income`, `type = 'trinkgeld'` | `tips` |
| Cash collected | `income`, `type = 'bargeld'` | `cash` |
| Trip count | `income.trip_count`, on the `umsatz` row only | `trips` |
| Period | `source_period_start`, `source_period_end`, `date`, `week` | |
| Driver | `source_driver_key` (Reidey's id) → `partner_driver_links (partner 'reidey', external_driver_id) → driver_id` | `income` has no `driver_id`; `driver_name` is our `drivers.name`, copied at write time |

**Three writers, three granularities:**
- **Nightly pull** (`_shared/uber-pull-delivery.ts`, `income_import_uber_system`):
  - writes one row per driver, per type, per Uber operating day;
  - operating day D runs from **D 04:00 to D+1 04:00, Europe/Berlin** (`uber-pull-core.ts:11`);
  - `period_start = period_end = D`.
  - **This is daily data.**
- **Manual Uber import** (`UberEarningsImportModal`, `income_import_uber`): one Uber week, Monday 04:00 to Monday 04:00. **Weekly.**
- **Hand-typed** (`IncomeManagement`): `source IS NULL`, period not stated, usually "Woche N". **Not usable as an Uber source.**

**Constraints on these rows:**
- Unique key: `income_source_period_key (company, source, source_driver_key, source_period_start, type)`.
- Overlapping source periods are refused (`20261014100000`).
- A daily row and a weekly row for the same driver-day should therefore be impossible. That is not measured, so the reader will detect it anyway.
- Negative amounts are stored for `umsatz`, `aktionen` and `trinkgeld` (refunds and clawbacks, `20261016170000`).

**Per trip:** only the Fahrtenbuch XLSX import has trip-level data. Its columns in `fahrtenbuch_trips` are:
- `price_amount` (Fahrpreis) and `tip_amount` (Trinkgeld);
- `cash_amount` / `online_amount`;
- `is_canceled`, `trip_status` and `declined_fee_cents`;
- `start_at` / `end_at` and `original_driver_id`.

All of it is immutable, and there is no per-trip fee column.

**Gross or net: unknown.** Reidey sends seven figures: `fare`, `promotion`, `tips`, `cash`, `net_outstanding`, `difference` and `trips`. We store the first four, plus the trip count on the `umsatz` row, and discard `net_outstanding` and `difference`. Nothing states whether `fare` is before or after Uber's service fee:
- not the code;
- not any migration;
- not the wire contract.

No fee figure reaches the database. The XLSX "Fahrpreis" has the same gap.

**Simulated markers (untouched by Round 8):**
- `is_simulated` on imports and trips is immutable.
- `fahrtenbuch_trips_refuse_double_count` stays.
- The simulator writes no `income` row.

Round 8 writes nothing to any of these.

## 2. Section by section

### §2 Driver shifts

**Exists:**
- **What the Drivers page (`DriverModal`) edits:**
  - `employment_type` (employee / company_owner) and `driver_usage_type`;
  - `salary_ratio` (the commission);
  - `planning_min_salary` / `planning_max_salary` (with `planning_target_salary` as the legacy fallback) and `planning_hourly_rate`;
  - `work_window_start/end`, `allowed_weekdays` and `is_full_day_available`;
  - `planning_enabled` and `planning_priority`.
- **Leave and sickness** already exist as driver notes: `sick`, `vacation` and `off`, with `exclude_from_plan` and date ranges.
- **The monthly plan** derives a driver's hours range as salary ÷ hourly rate (`monthlyPlan/hoursRange.ts`). It names a missing or zero rate, and a minimum above the maximum, as configuration problems.

**Missing:**
- The simulator reads none of the hours, pay or window fields.
- Shift length is random. `SHIFT_LIMITS` 240–360 is enforced in four places: `generator.ts` `validateRides`, `fullMonth.ts:709`, `figures.ts:360` and the Python verifier.
- Driver overlap is checked by name.
- Breaks have no field.
- There is no per-driver month summary.

**A conflict to flag:**
- The brief lists `target_monthly_hours` and `max_monthly_hours`. **Neither is on the Drivers page**, which is the auditor's reference.
- The owner's monthly-plan requirement also says `target_monthly_hours` "is ignored entirely" (`hoursRange.ts` header).
- Proposal: read the range exactly as `hoursRange.ts` does, as the one source, and print the two legacy values for information only. This is decision D5.

**Change:**
- **A new pure module, `driverMonthPlan.ts`.** Per driver UUID it computes:
  - **eligible days:** allowed weekdays, minus days blocked by a confirmed sick, vacation or off note, and, when daily Uber data exists, only the days Uber shows activity;
  - **the hours range,** from `hoursRange`;
  - **the work window;**
  - **minutes per day.**
  - Problems are reported as `CONFIGURATION_REQUIRED` and the driver is not planned.
- **`fullMonth.ts` becomes driver-led.** Days and lengths come from the driver plan. Then a vehicle is chosen that is free, has a valid TÜV, and is outside any `vehicle_unavailability` window.
- **Shift length:**
  - The universal 240-minute floor goes.
  - The 360-minute ceiling stays, with its reason: a longer shift needs a break that the generator does not place (§4 ArbZG).
  - The 11-hour rest between shifts stays.
- **Per-driver validation replaces 240–360:**
  - inside the driver's window;
  - total at most the maximum;
  - a shortfall below the minimum is a row;
  - overlap checked by UUID.
- **Discrepancies are rows, never adjustments.** No salary is written or changed.

**Files:** `fullMonth.ts`, `generator.ts`, new `driverMonthPlan.ts`, `simulationInputsClient.ts`, `scripts/fleetbook-report-verify.py`.

### §3 Company base

**Exists:**
- `trip_analysis_settings.base_latitude`, `base_longitude` and `base_radius_km`, saved by an administrator in the Fahrtenanalyse.
- The company address: `companies.address`, `city` and `postal_code`, and `company_settings.street`, `house_number`, `postal_code` and `city`.
- The routed `from_base` leg, which already delays the shift start by the drive.

**Missing:**
- The `pool.center` fallback (a guess).
- A return to base, and a setting for it.

**Change:**
- **Base selection,** in order:
  1. the saved point;
  2. otherwise, the company address, geocoded at house level by our own geocoder and labelled as derived from the address (D7);
  3. otherwise, `CONFIGURATION_REQUIRED`, and no month is generated.
- The pool-centre fallback is removed.
- **Return to base** becomes a company setting, off by default (D8). When it is on, a routed `to_base` leg follows the last drop-off; it records empty km and the shift ends on arrival.
- **Base legs** are working time and carry no fare.

**Files:** `SimulatedRidesPage.tsx`, `repositioningLegs.ts`, `fullMonth.ts`, `tenantSettings.ts`.

### §4 Real trips

**Exists:** weeks mode refuses a week that has real trips (`real_trips_exist`). Calendar mode does not look.

**Change:**
- **Load the month's real trips** (`is_simulated = false`).
- **A driver-day with real trips is actual.** It goes into sheet 1 as `IMPORTIERT`, with everything unchanged:
  - original id, date and times;
  - driver, fare and tip;
  - cancellation.
- **It is not simulated over.**
- **Simulated fares stay as the fare model gives them, never scaled.** The gap to the imported Uber amount is shown, not closed.

**Weeks mode:** `generateFromFigures` bends simulated fares so a week sums to the imported `umsatz`. §4 and §5 read that as forbidden. Round 8 does not use weeks mode and leaves it untouched. Retiring it is decision D6.

### §5 The share

**Exists:**
- **The simulator's draw:** a continuous draw on its own random stream, per month, applied to generated revenue.
- **The arithmetic:** `applyMonthlyShare`, exact to the cent.
- **The stored product table:** `company_monthly_revenue_share`, 0–100 % per month. No screen reads it.

**Change:**
- **Values:** exactly 30, 31, 32 or 33.
- **Mode:** either fixed in the company setting, or random. Random means seeded, with a scope of month or day, on its own stream as today.
- **Base:** imported Uber `umsatz` per driver per operating day. `aktionen` and tips are shown beside it, not in it, until D1.
- **Rounding:** half away from zero per day; the month total is the sum of the days.
- **Meaning:** `CONFIGURATION_REQUIRED`. Nothing is booked, and no "total according to the configured formula" is produced while the meaning is unconfigured. **Superseded by D1's answer (27.11.2026, §4):** the company share.
- **A negative day** is computed with its sign and flagged.
- The product table and `PRODUCT_RATE_RANGE` are not touched.

**Statement, as the brief requires: moving from the continuous [30,00, 33,00] draw to four discrete values changes existing outputs.**
- **The rate:** for the same seed and month it changes; 31,42 %, for example, becomes one of 30, 31, 32 or 33.
- **The share and remainder** change with it.
- **The base** changes too, from generated revenue to imported Uber amounts.
- **The rides do not move:** the share has its own random stream.
- **The pinned values** in `monthlyRate.test.ts` and the round 6 tests change. They will be read and reviewed, not regenerated blind.

### §6 Trinkgeld

**Exists:** calendar mode invents tips; weeks mode spreads weekly `trinkgeld`.

**Change:** no tip is drawn any more.
- **Allocation:** each day's imported `trinkgeld` per driver is allocated across that driver's simulated completed passenger rides that day.
  - It is exact to the cent, using the existing `allocateCents`, seeded, and is labelled simulated.
  - The imported total stays in its own column.
- **Never** on cancelled, declined or empty legs, and **never moved** between drivers or days.
- **Weekly-only tips** are not split by day; they are reconciled per week. A week that crosses the month boundary is listed as not attributable (§7).
- **Imported tips with no simulated ride** for that driver and day (for example, a weekday the driver's config forbids) stay unallocated, with the reason. The financial status is then `INCOMPLETE`.
- **Any unexplained cent** is `FAILED`.

### §7 Calendar month

**Exists:**
- `buildPeriod` builds every calendar day, zero days included.
- The operating day starts at 04:00, Europe/Berlin.

**Change:**
- **Imported rows** count for the month their operating day falls in. That is Uber's rule (D 04:00) and the simulator's `operatingDayStartHour` 4.
- **A weekly row entirely inside the month** counts for the month, without a daily split.
- **A week across the boundary** is not split. It is listed in both months as "nicht zuordenbar" and counted in neither.
- **A daily and a weekly row for the same driver-day** are a conflict. Neither is used silently.
- **The business-week code is not touched.**
- **Tests:**
  - February 2027 (28 days) and February 2028 (29);
  - both DST months;
  - a ride across midnight;
  - a week across a month.

### §8 Repositioning

Kept as round 6 built it: the margin and the rule that the next ride waits for the vehicle. One addition: the `to_base` leg.

### §9 Joint plan

The planner combines:
- the driver plan;
- vehicle availability: TÜV, plus `vehicle_unavailability` windows, which exist since `20261023130000`;
- the days Uber shows activity;
- routing;
- the base.

Anything that cannot be satisfied becomes a reconciliation row with its reason, never a change. Round 6 recorded "no maintenance window in the data model"; that is now out of date, and Round 8 reads the windows. A negative Werkstatt check stays review-only, because it has no window.

### §10 Workbook

**The new file:** `SIMULIERT_Monatsabschluss_<YYYY-MM>_<run>.xlsx`, a third workbook. The two existing workbooks stay.
- **Sheets:** seven, in the auditor's order, with German names (CLAUDE.md: generated documents are German). Sheet 7 maps each name to the auditor's.
- **`Kennzeichnung`** is the first column of every row: `SIMULIERT`, `IMPORTIERT` or `ABGELEITET`.
- **The file name** keeps `SIMULIERT`.
- **Re-import refusal** (`findSimulationMarker`) gets a test, including for a month with only real trips.
- **Written by** the export service: plain shape and bare numbers.

**Sheet contents:**
1. **Fahrtenbuch:**
   - real trips (`IMPORTIERT`) and simulated rides (`SIMULIERT`);
   - eligible cancellations and their fees;
   - no declined orders and no empty drives.
2. **Fahrerschichten:**
   - driver UUID and name;
   - shift id, date, start and end;
   - base, vehicle and ride count;
   - empty time and hours;
   - break status;
   - discrepancy and status.
3. **Lohn und Arbeitszeit:**
   - the configured basis: commission, hourly rate, salary range;
   - hours: contracted range, scheduled, actual (not available for simulated rides);
   - the commission by the product's rule, `(Umsatz + Aktionen) × salary_ratio + Trinkgeld`, from imported figures;
   - hours × rate;
   - booked `salaries` rows, read only;
   - differences.
4. **Uber Tagesabgleich:**
   - date and driver UUID;
   - `umsatz`, `aktionen` and tips;
   - the base, p and the share;
   - simulated fare total and the gap;
   - real fare total, when available;
   - status.
5. **Fahrzeuge und Leerfahrten:**
   - vehicle, driver and shift;
   - passenger km and empty km;
   - base departure;
   - leg start, end and duration;
   - provider and status.
6. **Kalendermonat:** every day, with fares, tips, cancellations, salary calculation, share, km, empty km, hours and shifts.
7. **Pruefung und Herkunft:**
   - source ids, month, tenant and time zone;
   - generator version (`full-month/4.0.0`);
   - the classification of every figure;
   - the rules;
   - p;
   - test status;
   - open differences;
   - the unavailable data.

### §11 Routing report

**Exists:** sheet G and `scripts/fleetbook-route-check.mts`, which re-routes through our OSRM. A route-check without routing already gives `VERIFICATION_INCOMPLETE`.

**Change:**
- **More columns:** each route row gains the coordinates of both ends as geocoded, the provider, departure time, available seconds, our seconds and km, the margin and the status.
- **More rows:** the base legs and the return legs.
- **A CSV** from the route-check script that the auditor can feed into his Valhalla run.

**On "19 warnings and 109 unverified":** we do not have the auditor's run, so the plan claims no cause for it. What we have measured:
- **Round 4, on his 60-pair sample:**
  - 35 were the straight-line model underestimating the road (fixed by measured legs);
  - 25 were the two engines disagreeing;
  - of the 22 pairs that still did not fit, 18 differed in road km by more than 25 %, which means the two geocoders placed the same address differently;
  - multi-number house numbers were also fixed in round 4.
- **Round 6's own re-check:** 0 warnings and 0 unverifiable, on 1675 and 1709 transitions.

Sending our coordinates removes the geocoder difference from his comparison.

## 3. Migration: one, `20261127200000_company_simulation_settings.sql`

**Table `public.company_simulation_settings`:**
- `company_id`: unique, cascades on delete.
- `share_mode`: `'fixed'` or `'random'`.
- `share_percent`: NULL or 30, 31, 32 or 33.
- `share_scope`: NULL, `'month'` or `'day'`.
- `seed`: bigint, NULL.
- `return_to_base`: boolean, NOT NULL, default false.
- created and updated, at and by.
- **CHECK rules:**
  - **fixed:** the percent is set; scope and seed are NULL.
  - **random:** the percent is NULL; scope and seed are set.

**No column for the share's meaning or its base.** Those come with the owner's answer; until then the report says `CONFIGURATION_REQUIRED`.

**Access:**
- The `20260917130000` business-table shape.
- Writes need `is_company_admin()`, like `trip_analysis_settings` and `company_monthly_revenue_share`.
- Both tenant triggers: `refuse_read_only_context_write` and `record_support_write`.
- REVOKE ALL FROM PUBLIC, anon; GRANT SELECT, INSERT, UPDATE, DELETE TO authenticated.

**Also in this migration:**
- **No function,** so no SECURITY DEFINER and no RPC line.
- **Table lines** in `tests/rls/matrix.sql`, and a new `tests/rls/simulation-settings.sql`.
- **A self-check** DO block.
- **No epoch bump:** it is a new table and nothing existing changes.

**Without a migration**, the setting would stay a form option like the other simulator settings. It would then not be a company setting, and §5 would not be met. **I recommend the table.**

**No driver columns** are added; see D2–D4.

## 4. Decisions for the owner (a default is given so building can start)

| # | Question | Default until answered |
|---|---|---|
| D1 | **The share:** what it means, who receives it, its base (`umsatz` only, or with `aktionen`), negative days, cancellation fees, and whether Uber's fare is gross or net. | `CONFIGURATION_REQUIRED`. Computed on `umsatz` and shown, never booked. **Answered 27.11.2026** (below the table). |
| D2 | **Breaks.** Proposal: `drivers.break_after_minutes` and `drivers.break_minutes`, with NULL meaning the statute. | No field. Shifts stay at 6 h or less, so §4 ArbZG needs no break; reported as "no break rule per driver". **Revised 28.11.2026** (owner's delegation, after 139 h could not be reached): still no field, because the statute is the rule. A day may hold up to 8 h of work (§3, without the 10-h extension), and over 6 h it is two parts around a 30-minute break at the base (§4); at most 48 h a week. `full-month/4.2.0`. |
| D3 | **Leave and sickness.** The days already come from driver notes. What is missing is an annual entitlement, and whether an absence day counts against the hours range. Proposal: `drivers.annual_leave_days` plus a company rule. | Absence days reduce the available days. The range is not reduced. A shortfall is reported. |
| D4 | **Pay model.** Only employee and company_owner exist. Proposal: `drivers.pay_model` (commission, hourly, fixed, minijob). | Commission and hours × rate side by side. The difference is not resolved. |
| D5 | **`target_monthly_hours` and `max_monthly_hours`.** Neither is on the Drivers page, and the monthly plan ignores the target by his rule. | Use `hoursRange` (salary ÷ rate). The legacy values are printed only. |
| D6 | **Weeks mode** bends simulated fares to the weekly `umsatz`. | Left untouched and not used by Round 8. |
| D7 | **The company address as base** when no point is saved. | Accepted and labelled. |
| D8 | **Return to base.** | Off. |
| D9 | **Top up DEMO** with invented daily Uber rows and a base (a write to staging, test company only). | Wait for his yes. |
| D10 | **The verdict.** | Keep the export verdict separate from a new financial status, so an unconfigured share does not block a valid Fahrtenbuch. The other option: the whole month reads `VERIFICATION_INCOMPLETE` until D1. |

### D1, answered (27.11.2026)

The owner asked for four things. He left the choices to the developer and accepted these.

1. **A day's rides should equal the company's daily Uber earnings.** No fare is fitted to that figure, because §4 and §5 forbid forcing a reconciliation. Sheet 4 shows the gap instead, `Differenz Umsatz - Fahrpreise`: the imported `umsatz` minus the simulated and real fares of the driver-day.
2. **Premiums in the hours.** None, until he sends each driver's contract premium rates.
3. **The share** is the company share (`Unternehmensanteil`). It is computed on the imported `umsatz`, shown, never in a fare and never booked. `share_meaning_unconfigured` is gone, so a month reads `RECONCILED` when every row of sheet 4 does.
4. **The wait between two rides** is at most 30 minutes in a calendar month. The weeks mode is untouched.

## 5. Unavailable data (§13 item 13)

1. **Uber's service fee and adjustments:** not stored. `net_outstanding` and `difference` arrive and are discarded.
2. **Gross or net:** not stated for `income.umsatz` (Reidey's `fare`) or for the XLSX "Fahrpreis".
3. **Trips behind the daily Uber totals:** not delivered. Real trips exist only from the Fahrtenbuch XLSX import.
4. **A daily breakdown of weekly imports:** the manual Uber import and hand-typed rows have none.
5. **Per-trip tips for daily totals:** none. Any per-trip tip is a simulated allocation.
6. **Actual hours worked:** no time clock. For simulated rides, actual hours are always unavailable.
7. **Breaks:** no field.
8. **Leave:** no entitlement field and no rule for crediting absence hours.
9. **Pay model:** no field beyond commission, the hourly rate and the salary range.
10. **`target_monthly_hours` and `max_monthly_hours`:** legacy columns, not on the Drivers page.
11. **Company time zone:** no column. It is the constant Europe/Berlin.
12. **The share's meaning and base:** not configured.
13. **Driver identity in `income`:** no driver id. It is resolved through partner links, or by name with a flag.
14. **Cancellation fees inside Uber's daily totals:** not separable.
15. **Event dates** (occurred, reported, verified): not in the model. Already open since round 6.
16. **Valhalla on our side:** not run, by the owner's decision of 29.10.

## 6. The September and October 2026 workbooks (DEMO Monatsplanung GmbH, staging only)

**W1. Read-only inventory.** The steering session runs this as root on the VPS:

```bash
docker exec -i ya-mobility-staging-db-1 psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT count(*) AS demo_companies FROM companies WHERE name = 'DEMO Monatsplanung GmbH';
SELECT id AS demo FROM companies WHERE name = 'DEMO Monatsplanung GmbH' \gset
SELECT id, name, status, employment_type, driver_usage_type, salary_ratio, planning_enabled,
       planning_min_salary, planning_max_salary, planning_target_salary, planning_hourly_rate,
       target_monthly_hours, max_monthly_hours, allowed_weekdays, work_window_start, work_window_end,
       is_full_day_available
  FROM drivers WHERE company_id = :'demo' ORDER BY name;
SELECT id, kennzeichen, status, tuev_gueltig_bis FROM cars WHERE company_id = :'demo' ORDER BY kennzeichen;
SELECT to_char(date, 'YYYY-MM') AS month, coalesce(source, '(hand)') AS source, type,
       count(*), sum(amount), min(source_period_start), max(source_period_end)
  FROM income WHERE company_id = :'demo' AND date >= '2026-08-24' AND date < '2026-11-09'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT base_latitude, base_longitude, base_radius_km FROM trip_analysis_settings WHERE company_id = :'demo';
SELECT address, postal_code, city FROM companies WHERE id = :'demo';
SELECT street, house_number, postal_code, city FROM company_settings WHERE company_id = :'demo';
SELECT car_id, starts_local, ends_local, reason FROM vehicle_unavailability WHERE company_id = :'demo';
SELECT to_char(trip_date, 'YYYY-MM') AS month, is_simulated, count(*), count(original_driver_id) AS with_driver
  FROM fahrtenbuch_trips WHERE company_id = :'demo' AND trip_date >= '2026-08-25' AND trip_date < '2026-11-05'
 GROUP BY 1, 2 ORDER BY 1, 2;
SELECT partner, external_driver_id, driver_id IS NOT NULL AS linked, status FROM partner_driver_links WHERE company_id = :'demo';
SELECT note_type, note_planning_behavior, start_date, end_date, count(*)
  FROM driver_notes WHERE company_id = :'demo'
   AND coalesce(end_date, start_date) >= '2026-09-01' AND start_date <= '2026-10-31'
 GROUP BY 1, 2, 3, 4 ORDER BY 3;
ROLLBACK;
SQL
```

**W2. Top-up data (me).** A new, invented section in `scripts/seed-demo-company.sql`:
- **Daily Uber rows** from 1 September to 31 October for DEMO's drivers:
  - `source 'uber'`, with keys `demo-uber-N`;
  - their partner links;
  - only on each driver's allowed weekdays.
- **Two deliberate cases:** activity on a forbidden weekday, and one refund day.
- **A base** in `trip_analysis_settings`, only if none is saved, at DEMO's own address.

**How the seed behaves:**
- It is add-only, guarded by `WHERE NOT EXISTS`.
- It refuses unless exactly one DEMO company exists.
- It is committed, because the data is invented.
- **Side effect:** these figures appear on DEMO's Umsätze, Abrechnung and Gehälter screens for September and October.

**W3. Run the seed.** The steering session runs it as root, after the owner's yes (D9). This writes to staging, DEMO only:

```bash
docker exec -i ya-mobility-staging-db-1 psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < /home/ahmad/workspace/el-professor-wt/round8/scripts/seed-demo-company.sql
```

**W4. Generate.** Staging cannot be deployed while Actions is billing-blocked, so the settings table will not exist there. The new `scripts/fleetbook-round8-month.mts` runs here instead:
- **Reads:** it signs into staging as `demo-admin@example.com`, with the password from the gitignored `e2e/.env.local`, the same way round 6 used the screen. It reads only the DEMO company.
- **Generates:** it loads the same inputs the screen loads and runs the same generator and workbook builder.
- **Writes the file:** it posts the payload to staging's export service (openpyxl).
- **The share setting:** taken from the table when it exists, otherwise from `--share-percent`. Sheet 7 records which.
- **The seed** is fixed.
- **After the next staging deploy,** the screen must produce byte-identical files from the same months.
- **This needs the go,** because it signs into staging.

**W5. Verify:**
- `fleetbook-report-verify.py`, extended for Round 8, with openpyxl from the pinned requirements in a scratchpad venv;
- `fleetbook-route-check.mts` against OSRM on staging;
- the before/after comparison, item 14: the generator on `origin/staging` against Round 8, same inputs and seed.

**W6. Output, out of git:** `~/design-inputs/round8-out/`, holding the workbooks, route CSVs and verify logs. Summary figures, with no addresses, go into `Docs/audit/round8/README.md`.

## 7. Slices (one commit each, with tests)

The numbers in brackets are the §12 test classes each slice covers.

| Slice | What | §12 classes |
|---|---|---|
| S0 | `Docs/audit/round8/`: a copy of the spec and this analysis | — |
| S1 | The share: four values, fixed or random, scope month or day | 14, 15 |
| S2 | Reader of imported Uber figures: daily, weekly, straddling and double source; negative amounts; driver identity; plus its loader | 11, 12, 18 |
| S3 | `driverMonthPlan`: `hoursRange` reused; weekdays, window and absences from notes | 1, 2, 3, 4, 24 |
| S4 | Driver-led scheduling, vehicle unavailability windows, per-driver validation, the Python verifier | 5, 9, 10, 21 |
| S5 | Base selection, no pool-centre fallback, `to_base` | 6, 7, 8, 22, 23 |
| S6 | Real trips kept, driver-days not simulated over | 16, 17 |
| S7 | Tip allocation and the reconciliation engine | 13, 19, 20 |
| S8 | Migration, settings client, settings panel on the simulator page (admin only, i18n in both dictionaries), RLS kit file | 25 |
| S9 | The 7-sheet workbook, route CSV, verifier round 8, re-import refusal | 26 |
| S10 | Seed top-up, generator script, example months, comparison, status documents | — |

**Checks:**
- **Mine:** narrow vitest on the touched files, `npm run styles`, pytest for the verifier, all under `nice -n 10`.
- **The steering session:** the RLS kit, as root.
