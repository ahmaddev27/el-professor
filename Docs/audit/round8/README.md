# FleetBook audit, round 8

- `Auftrag-fleetbook-round8.txt`: the auditor's specification, as received.
- `PLAN.md`: the root-cause analysis and the plan the owner approved on 27.11.2026, with the decisions D1–D10.

Branch `feat/fleetbook-round8`, one PR against `staging`. One commit per slice: S0 holds the documents, and S1–S10 each come with tests.

## Where each deliverable of §13 is

| §13 | Deliverable | Where |
|---|---|---|
| 1 | Root-cause analysis | `PLAN.md` |
| 2 | Source-code changes | the branch (S1–S10) |
| 3 | Migration | `supabase/migrations/20261127200000_company_simulation_settings.sql`, kit file `tests/rls/simulation-settings.sql` and lines in `tests/rls/matrix.sql` |
| 4 | Regression tests | the `*.test.ts` files beside each module; `deploy/export-service/tests/test_month_closing.py` |
| 5 | Test execution evidence | the PR description |
| 6, 7 | September and October 2026 workbooks | written by `scripts/fleetbook-round8-month.mts --fetch` into `~/design-inputs/round8-out/`, never into git (they hold the DEMO company's names and addresses) |
| 8 | Salary and hour reconciliation | sheet `Lohn und Arbeitszeit` of `SIMULIERT_Monatsabschluss_YYYY-MM_<seed>_<VERDICT>.xlsx` |
| 9 | Uber earnings and tips reconciliation | sheet `Uber Tagesabgleich` |
| 10 | Shift start-location evidence | sheet `Fahrerschichten` (column `Startbasis` for each shift), the legs leaving the base with their coordinates on `Fahrzeuge und Leerfahrten`, and the base's point and source on `Pruefung und Herkunft` |
| 11 | Repositioning and routing report | sheet `Fahrzeuge und Leerfahrten`, the `SIMULIERT_Betriebsbericht`, and `scripts/fleetbook-route-check.mts --legs` |
| 12 | Source provenance report | sheet `Pruefung und Herkunft` |
| 13 | Unsupported, missing or unverifiable data | sheet `Pruefung und Herkunft`, and the "nicht gelesen" cells |
| 14 | Before and after | `scripts/fleetbook-round8-before.mts` writes `vorher-nachher-YYYY-MM.md` beside the month |

## Producing the example months

These steps need staging, so the steering session runs them, in this order:

1. As root, run the DEMO seed: `docker exec -i ya-mobility-staging-db-1 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/seed-demo-company.sql`.
   - To set a base, add `-v demo_base_lat=<lat> -v demo_base_lon=<lon>`.
   - It writes only DEMO Monatsplanung GmbH's rows and ends with a read-only report.
2. Build each month as the DEMO login:
   ```
   R8_E2E_ENV=~/workspace/el-professor/e2e/.env.local npx vite-node scripts/fleetbook-round8-month.mts --fetch --month 2026-09 --out ~/design-inputs/round8-out
   ```
   Then run the same command with `--month 2026-10`.
   - Until round 8 is deployed, staging has no `company_simulation_settings`, so the settings come from the arguments `--share-percent 30..33` and `--return-to-base`. Sheet 7 then names them as the source.
3. Run `python3 scripts/fleetbook-report-verify.py <closing.xlsx>` and `npx vite-node scripts/fleetbook-route-check.mts --legs <closing.xlsx> --out ~/design-inputs/round8-out` on each closing.
4. For the comparison, follow the commands in the header of `scripts/fleetbook-round8-before.mts`. They use a detached worktree at `c1de16a`.

A month repeats without the network from its snapshot (`--from-inputs`), and the same seed gives byte-identical payloads.
