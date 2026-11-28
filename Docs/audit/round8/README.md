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

Both SQL files are read from a checkout of `staging` at or after the commit that added `scripts/seed-demo-company-check.sql`; `git show <sha>:<path>` pins the exact text that runs. `DB` below is `docker exec -i ya-mobility-staging-db-1 psql -U postgres -d postgres -v ON_ERROR_STOP=1`.

1. As root, the read-only check: `git show <sha>:scripts/seed-demo-company-check.sql | $DB`.
   - It is one `BEGIN READ ONLY … ROLLBACK`, so it cannot write.
   - Its three `ready` lines must all read `t`, or the seed stops and writes nothing.
   - It also shows the company's simulation settings row, or that it has none.
2. As root, the DEMO seed: `git show <sha>:scripts/seed-demo-company.sql | $DB -v demo_share_percent=31 -v demo_return_to_base=on`.
   - It writes only DEMO Monatsplanung GmbH's rows, and every insert is guarded by `NOT EXISTS`, so a second run adds nothing.
   - `demo_share_percent` (30, 31, 32 or 33) writes the company's `company_simulation_settings` row, a fixed share, only when the company has none. A row an administrator saved on the screen is never changed. Leave both variables out to keep "no share, no return to base".
   - To set a base, add `-v demo_base_lat=<lat> -v demo_base_lon=<lon>`; it is written only when none is saved.
   - Then run step 1 again to see what the months will read.
3. Build each month as the DEMO login:
   ```
   R8_E2E_ENV=~/workspace/el-professor/e2e/.env.local npx vite-node scripts/fleetbook-round8-month.mts --fetch --month 2026-09 --out ~/design-inputs/round8-out
   ```
   Then run the same command with `--month 2026-10`.
   - Since `a11c512` staging has `company_simulation_settings`, so the company's row decides the share and the return to base, and the script refuses `--share-percent` and `--return-to-base` (exit 2). Sheet 7 names the row as the source. The arguments only stand in on a stack without the table.
4. Run `python3 scripts/fleetbook-report-verify.py <closing.xlsx>` and `npx vite-node scripts/fleetbook-route-check.mts --legs <closing.xlsx> --out ~/design-inputs/round8-out` on each closing.
5. For the comparison, follow the commands in the header of `scripts/fleetbook-round8-before.mts`. They use a detached worktree at `c1de16a`.

A month repeats without the network from its snapshot (`--from-inputs`), and the same seed gives byte-identical payloads.
