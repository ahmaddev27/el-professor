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

- **Generated documents.** Stundennachweis PDFs and the Fahrtenbuch XLSX carry statutory German text, and the `'original'` export mode has to reproduce the imported sheet's headers byte for byte. Translating any of it breaks the export and produces invalid records. Those strings live in the export modules, never in the dictionaries. The list is closed — the Stundennachweis PDF, the Fahrtenbuch XLSX, the Trinkgeld-Quittung and the Mietwagenauftrag. An `exportTableToExcel(...)` dump of vehicles, drivers, users, Fixkosten, the Bargeldbestand or Werkstatt checks is **not** on it: no statutory form, so its headers follow the UI language like any other label.
- **Domain vocabulary** — `Stundennachweis`, `Fahrtenbuch`, `Abrechnung`, `Beleg`, `Werkstatt`, `Monatsplanung`, `Lohnart`, `Bundesland` — so the screen and the paperwork agree.
- **Money and date formatting**, because on-screen figures map one-to-one onto German documents.

## Commands

```bash
npm install
npm run dev              # Vite dev server
npm run build            # typecheck ratchet, tests, then vite build -> dist/
npm run test             # vitest run
npm run test:watch       # vitest
npm run typecheck        # raw tsc --noEmit, full error list
npm run typecheck:update # lower the ratchet baseline after fixing errors
npm run lint             # ESLint (flat config, typescript-eslint + react-hooks)
npm run preview          # serve the production build
```

End-to-end tests against staging live in `e2e/`, a separate npm package (Playwright with the installed Chrome): `cd e2e && npm install && npm run setup && npm test`. `setup-staging.sh` creates the test company, the `e2e` staging login and the `e2e` Mailpit login, keeping every password in the gitignored `e2e/.env.local`. The config refuses any host but staging.

### Golden-master tests

Coverage is narrow and deliberate: `src/utils/*.golden.test.ts` characterizes the money and calendar paths — `computeLohnartSeconds`, both German holiday tables, and the business-week rule. They run in the build gate.

These are **characterization tests, not specifications.** They assert what the code does today so that Phase 3 changes become visible: correct a premium against §3b EStG and the affected snapshots fail, to be reviewed on purpose rather than discovered on a payslip. Do not "fix" a failing snapshot by regenerating it without reading the diff.

Two things they already pin down:

- The two holiday tables disagree every year, and the difference is always Easter Sunday: `getGermanNationalHolidays` (clean engine) counts Ostersonntag as a nationwide holiday, `getHolidaysForYear` does not. Ostersonntag is not a statutory holiday in Germany outside Brandenburg, so the clean engine grants a Feiertagszuschlag that is not owed — and since it is also a Sunday, the cumulation described in FINDINGS.md H19 compounds it.
- **`weekCalculations` is 0-indexed throughout.** January is `0`; `getBusinessMonthRange(4, 2026)` returns the range of **May**. Nothing else in the codebase says so, and a caller passing a 1-indexed month silently reads the wrong month.

`vitest.config.ts` pins `TZ=Europe/Berlin`. The payroll code walks local calendar days, so night, Sunday and holiday classification is timezone-dependent and the snapshots only mean anything in the product's own zone.

Component-embedded logic — the premium models inside `FinalizePlanningModal` and `MonatsplanungStundennachweisPreview` — is **not** covered, because testing it requires extracting it, and extraction is the sort of refactor these tests exist to make safe. Cover it after Phase 3 establishes what the numbers should be.

### The typecheck ratchet

`npm run build` used to be `vite build` alone. Vite strips types without checking them, so the project accumulated **376 TypeScript errors** that nothing ever surfaced — including undefined identifiers that threw at render, permission checks that were always true, four `ConfirmationModal` call sites using invented prop names (one dialog never rendered at all), and 71 `showToast` calls with their arguments reversed, which made every one of those notifications display the bare word "success" instead of its German message.

`scripts/typecheck-ratchet.mjs` now runs before every build and compares the error count against `typecheck-baseline.json`:

- **more** errors than the baseline → build fails, listing the worst files
- **fewer** errors → build fails, asking you to run `npm run typecheck:update` and commit the lowered baseline
- **equal** → build proceeds

Failing on improvement is deliberate: a baseline that moves only by an explicit commit stays honest. Use `npm run build:novalidate` if you genuinely need the bundle without the gate.

The remaining errors are not uniform. Roughly 182 are unused locals (`TS6133`, noise from `noUnusedLocals`); the rest include real type mismatches worth triaging. `TS2304` (undefined name), `TS2774` (condition always true) and `TS2367` (impossible comparison) are almost always genuine defects.

Env (`.env`, see `.env.example`): `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required; `VITE_APP_URL` is the origin baked into auth email redirect links (`/auth/callback`) and must be the real domain in production, or reset emails point at localhost.

## Environments and deployment

Two full, separate stacks run on one VPS (159.195.205.30), behind ridy's Caddy.

| | production | staging |
|---|---|---|
| web | `https://elprofessor.eu` | `https://app.elprofessor.eu` |
| API | `https://api.elprofessor.eu` | `https://api-staging.elprofessor.eu` |
| branch | `main` | `staging` |
| host dir | `/srv/PRO` | `/srv/PRO-staging` |
| compose project | `ya-mobility` | `ya-mobility-staging` |
| mail | Resend | Mailpit keeps a copy and relays to Resend — real recipients get it, `@example.com` never; read it at `https://mail-staging.elprofessor.eu` (login) |
| deploys | **Actions → Deploy → Run workflow** on `main`, confirm `production` | every push to `staging` |

- **ridy is off limits.** It is a separate live product that only shares the host: no commits to its repository, no stopping, restarting or recreating its containers. Solve El-Professor's problems on El-Professor's side.
- **Routing is `deploy/caddy/elprofessor.caddy`, and ridy's deploy erases it.** ridy's Caddy owns ports 80 and 443, so our site blocks are a marked section at the end of ridy's Caddyfile (`/root/ridy/docker/Caddyfile`). That file is tracked in ridy's git, and every ridy release runs `git reset --hard` and recreates its Caddy, which drops the section and takes both our stacks offline. `el-professor-caddy-guard` (`deploy/caddy/guard.sh`, run by a systemd path unit on every change to that file plus a one-minute timer) puts it back within seconds — measured at 7 s with no failed request. It validates the whole file in a throwaway container of ridy's own Caddy image before writing, only appends or replaces the text between its markers, writes in place because ridy's container bind-mounts the file by inode, and never restarts a container. Change routes by editing the repo copy and running `deploy/caddy/publish.sh`, which goes through the guard, checks all sites and ridy afterwards, and rolls back on failure. Never edit the section in ridy's file by hand. The guard and its units are installed on the host by hand, like the release wrapper — CI cannot change routing on a host another project depends on.

- **Never change production's `PROJECT_NAME`.** It prefixes the named volumes that hold production's data (`ya-mobility_db-data`, `ya-mobility_storage-data`); any other name makes Docker create empty ones and the site looks wiped. The compose file has no default for it on purpose, so a staging checkout that forgot to set it fails instead of mounting production's database.
- **Staging runs on a copy of production data**, real accounts and password hashes included. It shows a "STAGING" banner on every screen (`VITE_DEPLOY_ENV`), and its JWT secret, anon and service keys all differ from production's — a key from one environment is rejected by the other in both directions.
- **Staging mail reaches real people.** The owner decided on 14.09.2026, knowing staging holds real customers' addresses, that its mail is delivered the way production's is. GoTrue and the functions still send only to Mailpit, which keeps every message (the e2e suite reads links and codes there) and relays all of it through production's Resend account, except mail to `@example.com`. A password reset requested on staging for a real customer therefore reaches that customer, with a staging link. Test with `@example.com` addresses, and remember that staging now spends production's sending quota and reputation. `deploy/set-staging-mail-relay.sh` writes the relay settings on the host (`--test` sends one mail to Resend's sink, `--off` keeps mail on the host again); `deploy.sh` refuses a staging release without the settings file, or with relaying on and no `example.com` block. Verified 14.09.2026: Resend lists the relayed test mails as `delivered`. Mailpit logs a relay only when it fails, so its log stays quiet when mail goes out.
- **Merging to `main` deploys nothing.** The account's GitHub plan has no required reviewers or branch protection for a private repo, so the production deploy is a manual button. That job asks the host what staging is running (`status staging`) and refuses unless `main`'s git tree is exactly that release's tree — so an untested merge, a failed staging release or a staging rollback cannot be promoted.
- **CI can release, roll back and ask — nothing else.** The deploy key is bound in `authorized_keys` to `/usr/local/sbin/el-professor-release` (`deploy/ci-release.sh`) with `restrict`: no shell, no pty, no port forwarding, and only `release <env> <sha>`, `rollback <env>` and `status <env>`. The wrapper lives outside `/srv/PRO*` so a release cannot overwrite it, and it refuses any archive containing an `.env`. It is installed by hand; after changing `deploy/ci-release.sh`, reinstall it before merging, and keep it accepting what the currently merged workflow sends.
- **Every release is kept, and Actions → Rollback undoes one.** Each release lives in `/srv/PRO*/releases/<utc>-<sha7>/` with a `manifest.env` (sha, schema epoch, migrations applied, status); `releases/current` points at the live one, and the live release plus the five newest clean ones are kept. A rollback re-activates the newest earlier clean release through `deploy.sh --activate`: code, edge functions, Kong and nginx config go back, **the database does not**. That is only safe because migrations stay backward compatible with the previous release. A migration that cannot (a drop, a rename, a changed meaning) must bump `deploy/SCHEMA_EPOCH` in the same commit; rollback refuses to cross an epoch, and also refuses when the old compose file would change the `db` service or loosen the auth settings. Undo a rollback by running Deploy again.
- **`deploy/deploy.sh` is the release.** Guards first (directory, project name, shared JWT secret, SMTP host, compose profiles), then migrations, then the bundle swap, then health checks. Migrations are tracked in `app_meta.schema_migrations` — a schema PostgREST does not expose — and each file runs in one transaction with its ledger row. An empty ledger on a populated database is refused; seeding it is `deploy.sh <env> --baseline`, typed once by a person. Production is snapshotted with `pg_dump` before any migration runs; the ten newest snapshots are kept. Health means the new bundle is live: CI writes the commit into `dist/version.txt`, and deploy.sh reads it back through the public URL. `kong.yml` and `nginx-spa.conf` are single-file bind mounts their services read once at start, so their hashes are compose labels — an edited file recreates exactly its container.
- **Login attempts are limited per client.** GoTrue applies its limits on `/token` (password login and refresh), `/verify` and `/recover` only when `GOTRUE_RATE_LIMIT_HEADER` names the header identifying a client; it was unset, and password guessing was unlimited. Caddy writes `X-Client-IP` from the connecting address on every API host, replacing whatever a client sends, so the header cannot be forged. Measured on staging: 52 wrong passwords answered, the 53rd refused with 429, a second address unaffected. Our edge functions reach GoTrue through Kong without the header and are not limited. For a load test on staging, raise `RATE_LIMIT_TOKEN` in its `.env`.
- Each environment's `.env` is provisioned by hand on the host and never leaves it. Build-time values (`VITE_*`) live as GitHub environment variables; the deploy key, host and pinned host key are repository secrets.
- `deploy.sh` reads every `.env` key with `|| true`. Under `set -euo pipefail` a bare `grep` that matches nothing ends the script with no message — that exact bug broke production login for a few minutes the first time it ran.

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

### `app_private`: state the browser must never reach

PostgREST serves only `public` and `storage`. Tables that hold security state live in `app_private` (since `20260915100000`): `otp_challenges`, `otp_send_events`, `pending_signups`, `platform_login_verifications`. Nobody but the owner has USAGE on the schema — not `anon`, not `authenticated`, not `service_role` — so the only way in is a `SECURITY DEFINER` function in `public` whose EXECUTE is granted to `service_role` alone. Four rules for anything added there:

- **Revoke from `PUBLIC, anon, authenticated`**, not just `authenticated`. Supabase's default privileges grant EXECUTE on every new `public` function to `anon` too; `20260911120000_redeem_discount_code_rpc.sql` missed that, so do not copy its grant block.
- **A new `app_private` object needs its own REVOKE.** EXECUTE-to-PUBLIC on new functions is a built-in global default and cannot be revoked per schema. Missing USAGE is what keeps callers out; the REVOKE is the second wall.
- **`LANGUAGE plpgsql`, `SET search_path = pg_catalog, public`, `app_private.*` and `auth.*` schema-qualified.** plpgsql resolves `auth.sessions` at call time; the RLS test database only gets GoTrue's tables when a test stubs them.
- **Outcomes are return values, never exceptions.** `otp_verify` counts the attempt before comparing the hash; raising on a wrong code would roll that count back and make the five-attempt lock worthless. A broken argument contract raises `22023` with a fixed message, and no function returns `SQLERRM`.

Each OTP migration ends with a `DO` block that fails the release: the schema file if `anon`, `authenticated` or `service_role` can reach `app_private` or any table in it, the RPC files if any function they created is executable by `anon`/`authenticated` or lacks a pinned `search_path`. `app_private.platform_login_verified(user_id, session_id)` has no grant for anyone: whatever calls it (PLATFORM's `is_user_super_admin()`) must be a `SECURITY DEFINER` function owned by a role that already holds USAGE on `app_private` and EXECUTE on it — in practice `supabase_admin`, which runs the migrations. The limits (10 min validity, 5 attempts, 60 s cooldown, 5 codes per address and 20 requests per IP per hour, 12 h platform verification) are `CONSTANT`s in the one function that enforces each.

Signup is code-confirmed: `signup_create_company` writes the company, an owner profile in status `pending_invite` and a `pending_signups` row in one transaction; `signup_complete` activates the owner and redeems the discount code only after the code is entered. `purge_unverified_signups` and `signup_discard_unverified` delete **only** accounts in `pending_signups` — legacy unconfirmed production accounts were never written there and no job can reach them. `auth.users.email` is copied to `user_profiles.email` by the `sync_user_profile_email` trigger, whatever changed it.

`npm run test:rls` runs `tests/rls/assertions.sql` and then every other `tests/rls/*.sql` in name order (the seeds excepted), in a throwaway `supabase/postgres` container with a random name, so parallel runs on the shared VPS cannot tear each other down. A test file that writes runs inside `BEGIN; … ROLLBACK;`, as `otp.sql` does, so the files after it see only the migrations and the seeds. There is no Docker locally: run it on the VPS in a `mktemp -d` copy, never against a stack's database. The `node` image has no Docker CLI, so mount the host's (it links only against glibc, which `bookworm` provides):

```bash
git archive HEAD scripts/rls-test.mjs tests supabase/migrations | ssh elprofessor 'd=$(mktemp -d /root/rls.XXXXXX) && tar -x -C "$d" &&
  docker run --rm --cpus 1 --memory 1g -v /var/run/docker.sock:/var/run/docker.sock -v /usr/bin/docker:/usr/bin/docker:ro \
    -v "$d":"$d" -w "$d" node:22-bookworm-slim node scripts/rls-test.mjs; rc=$?; rm -rf "$d"; exit $rc'
```

A new RPC needs no `NOTIFY pgrst` and no restart of `rest` (which `deploy.sh` never recreates): the `supabase/postgres` image installs the `pgrst_ddl_watch` event trigger, which tells PostgREST to reload its schema cache after every DDL statement.

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

> **Do not trust `README.md` here.** It attributes the block engine to `ManualTimeCorrectionPanel.tsx` and to `historicalReconstructionSolver.ts`. Both were dead code and have been deleted. The `Clean Engine` module above is the live implementation.

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
- **Two block-building pipelines still disagree.** `monatsplanungPhase1.ts` chains rides into a block across gaps up to `VEHICLE_BLOCK_GAP_MINUTES = 60`; `shiftBlockEngine.ts` (the Brutto-Gehälter pipeline) uses `BLOCK_SEPARATOR_GAP_MINUTES = 90`. The same month therefore produces different blocks depending on which mode processed it. The name collisions that used to compound this — `MIN_VEHICLE_SWITCH_BUFFER_MINUTES` defined as both 60 and 30, plus duplicate `buildVehicleBlocks` / `parseFullDatetimeMs` / `getHolidaysForYear` — are gone with the dead modules that held them; no exported name is defined twice any more.
- **Two holiday tables still disagree**, and the golden-master tests pin the difference: `getGermanNationalHolidays` (clean engine) counts Ostersonntag as nationwide, `getHolidaysForYear` does not. See the test section above.
- **Transfer application is not atomic.** `MonatsplanungStundennachweisPreview.tsx` (~line 3204) applies a multi-trip transfer by looping `reassign_fahrtenbuch_trip` once per trip. A mid-loop failure aborts and leaves the transfer **partially applied** — the error message even reports "X von Y Fahrten wurden aktualisiert". There is no rollback.
- **Who may call an edge function is decided in `supabase/functions/main/index.ts`, and nowhere else.** Self-hosted, there is no dashboard `verify_jwt` setting; the router verifies every bearer token against `JWT_SECRET` and `PUBLIC_FUNCTIONS` names the exceptions, each with its reason. A function added later that must be reachable without a session has to be listed there, in a commit. Note what that check is and is not: it proves the caller holds a token this stack signed. It is not authorization — each function still loads the caller's profile and checks role and tenancy itself (the `assertSameCompany()` pattern in `manage-users`), and it is not rate limiting, because the anon key that admits `company-signup` ships in the browser bundle.
- **`extract-receipt` still spends `ANTHROPIC_API_KEY` on any request that carries a valid token**, and does no role or tenant check of its own. It is called by nothing (see the OCR entry below), so the exposure is bounded by the router — but if it is ever wired up, it needs its own checks and a spend limit first.
- **Two OCR implementations, one live.** The UI uses client-side Tesseract (`utils/receiptOcr.ts` → `ReceiptModal.tsx`). The `extract-receipt` edge function (Claude vision via the Anthropic SDK) is called by **nothing**. The README's claim that it "wraps Tesseract" is wrong on both counts.
- **Nothing sends a notification.** `NotificationsPage.tsx` lets a company switch four types on and off — `tuev_bald_ablaufend`, `tuev_abgelaufen`, `trial_bald_ablaufend`, `trial_abgelaufen` — and writes them to `notification_settings`. **No other code in the repository reads that table.** There is no scheduler (no `pg_cron`, no cron container, no scheduled function), no sender, and no template. A TÜV expiry never produces a message; the screen is a preference panel for a feature that was never built. Building it needs a job runner and a sender; SMTP itself now works (below).
- **Outgoing mail goes through Resend over SMTP on port 2587**, configured by `deploy/set-resend.sh`. The VPS provider blocks outbound 465 and 587; Resend's alternate 2587 is STARTTLS. Do not "fix" it to 465 — GoTrue picks implicit TLS by looking for port 465, and that port is closed here anyway. Verified 2026-09-13 end to end through GoTrue's own mailer, not just a direct SMTP login: an invite sent via `/auth/v1/invite` reached Resend and showed `delivered`. Mails use German, El-Professor-branded templates built by `scripts/build-email-templates.mjs` into `public/email-templates/`; GoTrue fetches them from the `web` container. **Edit the generator, not the generated HTML.** The `recovery` template is sent in two situations — a newly invited employee and "Passwort vergessen" — so its copy says *festlegen*, not *zurücksetzen*. One gap remains: the Resend domain was created in region `ap-northeast-1` (Tokyo); an EU region would keep mail processing in the EU, and changing it means re-adding the domain and its three DNS records.
- **`GOTRUE_MAILER_URLPATHS_*` name an API route, not a screen.** GoTrue appends them to `API_EXTERNAL_URL`, so they must be `/auth/v1/verify`. They were once set to `/auth/callback` — the SPA page the user lands on *afterwards* — which put `https://api…/auth/callback?token=…` in every mail and Kong answered 404. `redirect_to` is what carries the user on to `/auth/callback`. GoTrue's own default, `/verify`, is wrong here too: it lacks the `/auth/v1` prefix Kong routes on.
- **`auth.admin.generateLink` does not send mail.** It returns a link for you to deliver yourself. `manage-users` used it to "invite" employees and discarded the result, so no invitation was ever sent while the UI reported one. Use `resetPasswordForEmail` (or `inviteUserByEmail` for an account that does not exist yet) when a message must actually go out.
- **A session minted by a link must survive the inactivity check.** `AuthContext` signs out a restored session whose `lastActivity` is missing or older than 20 minutes. A password-reset or invite link creates a *new* session in a browser that usually has exactly that — so every such link used to end in "Link ungültig". A session whose `last_sign_in_at` is under 5 minutes old now counts as fresh. Separately, supabase-js strips the URL hash while it creates the session, so `type=recovery` / `error=` are read into `authRedirect` in `src/lib/supabase.ts` before the client exists; `AuthCallbackPage` reads that, never `window.location.hash`.
- `index.html` still serves bolt.new placeholder OG/Twitter images. (Its `lang` attribute is now `de` and is kept in step with the chosen language at runtime.)

## Dead code

No dead **files**. 20 unreachable modules (18,063 lines) and the dead `backend/` PHP directory were removed; every file under `src/` is reachable from `src/main.tsx`.

**That claim is per file, and it hides things.** `AutoShiftPlanView` in `HistoricalWorkingHoursWizard.tsx` (lines ~6001–8957, about 2,100 lines with its two algorithms `runAutoShiftPlan` and `runLargestBlankPackingShiftPlan`) is never rendered: the tag appears nowhere, `inhaberAutoShiftResult` is set to `null` at all six call sites and never read, and `onApplyAutoShiftPlan` is a no-op. It sits inside a live file, so the file-level walk passes it. Its German text is deliberately untranslated — a note at line 6001 says so — because keys for text no user can reach are pure cost. Translate it in the same change that makes it reachable, or delete it.

Keep it that way, and check at both granularities. A reachability walk lives at the end of this section's history — rebuild it in a scratch file if you need to check again: start at `src/main.tsx`, follow every static and dynamic import transitively, and anything under `src/` not visited cannot execute. Grepping for a filename is not equivalent, because a module imported only by another dead module still looks used. Within a file, the equivalent question is whether a component is ever used as a JSX tag and whether the state feeding it is ever read.

Deleting it did **not** shrink the bundle — Rollup was already tree-shaking it. What it removes is the far more expensive kind of cost: three of the four competing premium engines, a second `MIN_VEHICLE_SWITCH_BUFFER_MINUTES` with a different value, and several thousand lines that the older docs still describe as the live implementation.

## Repository hazards

- **The docs contradict the code. The code wins.** `Docs/MIGRATION_COMPLETE.md` and `Docs/MYSQL_MIGRATION_GUIDE.md` describe a completed migration to a PHP/MySQL backend that **never happened**. The `backend/` directory and `src/lib/api.ts` they document have since been deleted as dead code; Supabase was always the only backend. `Docs/RLS_FIX_EXPLANATION.md` claims `user_profiles.id` is a `bigint`; the first migration creates it as `uuid`. Confirm every constant, table and RPC name in source before relying on a doc.
- **Status documents travel with every change.** `PROGRESS.md` (progress log, Arabic, for the owner), `HANDOFF.md` (where things stand, for whoever picks the work up), the "Project status" section at the top of `README.md` and the progress table in `el-professor-plan.html` are updated in the same PR as each fix or feature. `README.md` used to hold two concatenated copies of itself; the stale second copy was removed on 14.09.2026, and its §1–23 still predate the self-hosted stack in places — the code wins.
- `Docs/` duplicates several root docs byte-for-byte. Editing one leaves the other stale.
- Root-level `*.sql` fix scripts (`FIX_INCOME_POLICIES.sql`, `fix_admin_role.sql`, `apply_salaries_migration.sql`, …) are **not** part of the migration chain. Only `supabase/migrations/` is schema history — with the completeness caveat above.
- Large files to grep rather than read whole: `HistoricalWorkingHoursWizard.tsx` (11.7k), `StundennachweisPage.tsx` (4.0k), `MonatsplanungStundennachweisPreview.tsx` (3.9k), `historicalWorkingHoursCleanEngine.ts` (2.8k).
- `.claude/settings.json` registers a `PostToolUse` hook pointing at `/tmp/cc-agent/57153190/project/.claude/strip-prose.py`, a path from a different machine. It fails silently (`|| true`).
- `.bolt/` is leftover Bolt scaffolding. `vite.config.ts.timestamp-*.mjs` files are Vite temp artifacts and are gitignored.

## Audit and remediation

`Docs/audit/` holds the output of a 259-agent review: `FINDINGS.md` (71 findings that survived adversarial verification, with evidence and file:line) and `REMEDIATION-PLAN.md` (phased plan). Read the plan before starting security or payroll work — it explains why the payroll fixes are blocked on establishing what §3b EStG actually requires, since the app carries four competing premium tables and nobody has checked any of them against the statute.

`CONTRIBUTING.md` records the branch model and the rules that must not be traded away.

## Working style for this codebase

Prefer small, targeted, reversible changes. The planning, salary, and reconciliation code encodes statutory German payroll rules that are far more intricate than the code shape suggests, has no test coverage, and produces documents that go to an accountant — a plausible-looking refactor can silently corrupt someone's payroll. When a change touches Phase 1/3/4, the clean engine, Lohnart computation, or the finalization checks, state the rule you believe you are preserving before editing.
