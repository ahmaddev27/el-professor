# Excel export — the audit of 29.09.2026 and the plan that follows

**Eleven agents, 61 claims, every one put to a refuter whose instruction was to kill it.
5 refuted, 4 downgraded to nothing, **70 live** once the completeness critic's 17 are added:
15 **broken**, 47 **degraded**, 8 **missing**.**

The subject was narrow — every Excel export in the product — and it turned out to be nine buttons
where the screens suggest twenty, three of them writing figures that disagree with the screen above
them. Two whole export features exist with no button at all.

Nothing here is a guess about severity. Where a measurement and a claim disagreed, the measurement
won and is written down as such.

---

## Already closed: PR #150

`fix/excel-numeric-cells` → `staging`. **Every cell the generic exporter wrote was text**, provable
from the type signatures (`format?: (v) => string`, `totals?: Record<string,string>`) before reading
a line of the body. `=SUM()` returned 0 in all six exports; numeric sort put `1200.00` above `89.90`.

Closed for the columns that opted in: Fixkosten's amount and total, Bargeldbestand's amount, and
Fahrer's seven numeric columns. 17 tests, 12 of which pin the old behaviour and passed against the
unchanged code. tsc 213 → 213 with an identical error *set*. Round-trip proven through a real file
write.

**Two corrections to figures this project had recorded wrongly**, both found while verifying #150:

- the typecheck baseline is **213**, not ~199;
- `npx tsc --noEmit` at the repo root **checks nothing** — the root `tsconfig.json` has
  `"files": []`. The real check is `-p tsconfig.app.json`. A count taken the other way is a
  fabrication, and one nearly entered this plan.

---

## Group 0 — the build gate is already red, before any of this

`tests/deploy/google-signin-guards.test.ts` fails two tests on this machine —
`kong_parse_inputs` and `redact_env_values`. Proven pre-existing: stash the export work, re-run,
identical failures. They look like bash and mode-600 behaviour under Windows.

`npm run build` runs the full `vitest run`, so **the project's own gate cannot pass here** until
these two are settled. Everything below is verified with the three commands the gate is made of
(`vitest run`, `tsc -p tsconfig.app.json`, `style-ratchet.mjs`) rather than through `npm run build`,
and that is a workaround, not a fix.

**Do this first, or accept that no group below can be gated.**

---

## Group 1 — a file the office uses that disagrees with the screen it came from

The worst class in the set: the file looks complete, is named for the period the operator chose,
and holds other data. Five items, four files, all independent of each other.

| # | at | what the operator gets |
|---|---|---|
| 1 | `src/components/ReceiptList.tsx:31`, `src/pages/BelegePage.tsx:155` | **The Belege export ignores every filter.** `filteredReceipts` has exactly one writer, the `onExportFiltered` callback, and `ReceiptList` **never calls it**. Filter to one driver for August, press Excel, get every Beleg the company ever entered — labelled `Gefilterte Auswahl`. The PDF button on the same screen passes `sortedReceipts` and is correct, so the two buttons on one screen disagree. |
| 2 | `src/pages/WerkstattPage.tsx:59` | **`loadChecks` reads `weeks` and it is not in the dep array** (line 53), so it always runs with the previous render's value. First mount in the first business week exports an empty file, or another week's rows. |
| 3 | `src/pages/WerkstattPage.tsx:72` | **The catch never calls `setChecks`**, so a failed week-40 read leaves week 39's rows in state. The header, the filename and the filter band all say KW 40. `werkstatt_2026-10_KW40.xlsx` holds week 39. This is the exact case the batch-2 rule was written for. |
| 4 | `src/components/DriversManagement.tsx:110`, `src/lib/driverRow.ts:39` | **The Fahrer export's `Erstellt am` column is blank for every driver, in every company, always.** The column reads `createdAt`; `mapDriverRow` builds its object from an explicit key list holding neither `createdAt` nor `created_at`. TypeScript cannot see it: `ExportColumn.key` is a bare `string` and the call site casts rows to `Record<string, unknown>`. |
| 5 | `src/utils/excelExport.ts:1334` | **A total placed on column 0 is discarded.** Column 0's cell is overwritten unconditionally with a hard-coded `Gesamt (n Einträge)`, with no warning. Three of six callers pass their total there (`CarsManagement` on `kennzeichen`, `DriversManagement` on `name`). Those totals have never appeared in a file. |

**Item 4 deserves a second fix beyond itself.** Make `ExportColumn<TRow>` generic with
`key: keyof TRow & string` and drop the six `as unknown as Record<string, unknown>[]` casts. That is
what stops the next blank column, and it is the same defect class as PR #122.

---

## Group 2 — a payroll figure, and the only item here that reaches a person's pay

`src/utils/excelExport.ts:964`, `exportSalariesToExcel`.

On 28.09 `SalariesManagement` was corrected to read `salaryBase(calc)` —
`COALESCE(netto_salary, amount_due)` — in both the per-driver column and the KPI, and to **derive**
the payment status from what was actually paid instead of reading the stored word.
**`exportSalariesToExcel` was not touched and is now the last reader of both discarded quantities.**

So the Gehälter screen and the Gehälter export now print different numbers for the same month, and
the export prints the one the screen stopped trusting. 51 of 58 production salary rows have
`netto_salary IS NULL`, which is why `amount_due` is the operative figure — measured, not assumed.

**State the rule before editing**, per CLAUDE.md: *due is `COALESCE(netto_salary, amount_due)`, and
paid is derived from the payments, never from the stored status word.* Then make the export call the
same `salaryBase` the screen calls, rather than a copy of it.

Its own group because it is the one item whose output goes to an accountant.

---

## Group 3 — an export that claims zero after a read that failed

`exportTableToExcel` has **no failure channel** — it writes a file for whatever `rows` it is handed,
with no early return. So the guard has to live at each call site, and Bargeldbestand is the only one
that has it (`disabled={isLoading || loadFailed}`, `BargeldbestandPage.tsx:468`).

- `src/components/FixedCostsManagement.tsx:365` — `error` is set, the list stays empty, the button
  writes `Keine Daten vorhanden` and a total of `0.00`.
- `src/components/CarsManagement.tsx` — the screen has **no failure state at all**; a failed load
  exports an empty fleet.
- `src/components/UserManagement.tsx` — the same, for the company's users.
- `src/pages/BelegePage.tsx` — not withheld on a failed read; the totals row claims `0,00 €`.
- `src/pages/DocumentsPage.tsx` — the Stundennachweis archive **discards its read error** and renders
  "nothing saved".

Per the batch-2 rule this is one `useState` per screen, cleared where the load starts and set in the
existing catch, and the export withheld while it is set. **Those lines are the only ones a proof may
list as added.**

A better second move: give the helper itself a refusal. A call site that hands it zero rows *and*
knows its read failed should get no file — but the helper cannot know that, so the honest fix is to
make the parameter explicit rather than optional.

---

## Group 4 — the statutory Fahrtenbuch writer

`src/utils/fahrtenbuchExport.ts`, `src/utils/historicalWorkingHoursFahrtenbuchExport.ts`.
**Highest care in the set**: the `'original'` export mode must reproduce the imported sheet's headers
byte for byte, and a corrected Fahrtenbuch is a statutory record.

- `:138` — **the uploaded file's own sheet name is passed to the library unvalidated.**
  `sourceSheetName` comes verbatim from the workbook the customer uploaded
  (`FahrtenbuchImportModal.tsx:373`). `book_append_sheet` → `check_ws_name` **throws** on a name over
  31 characters, on `: \ / ? * [ ]`, and on a leading apostrophe. One module sanitises it; three do
  not. A customer whose Excel tab is called `Fahrten 01.08.–31.08. (Nachtrag)` gets no file.
- `:123` — **returns with no file and no signal on three conditions.** `raw_data_json` is
  `jsonb NOT NULL DEFAULT '{}'`, and since slice A "a row the file left incomplete is stored and
  flagged, not dropped" — so `{}` is reachable. It passes the first guard, `Object.keys` gives `[]`,
  and the function returns at line 134. The user clicks and nothing happens.
- In `'all'` mode the export **stamps one import's file name, sheet name and column set onto a month
  that may hold several imports.**
- Two live, parallel implementations of the same statutory writer sit in one 11.7k-line file.

**Do not touch the `'original'` mode's header reproduction.** Fix the crash and the silent return;
leave the byte-for-byte path alone unless a test pins it first.

---

## Group 5 — the backup, and one commercial item

`src/utils/backup.ts`, and it is not strictly Excel — the critic found it while sweeping for export
entry points, and it is worse than most of what was in scope.

- `:17` — **a table whose read fails is written into the backup as an empty array.**
  `fetchTableData` swallows the error, the download succeeds, the success toast appears. A backup
  missing a table is indistinguishable from a company with no rows in it.
- `:30` — **nine company-scoped tables are absent from every backup ever taken**, while
  `de.ts:833` tells the customer the file `enthält alle Tabellen des Systems`. Missing: `cars`,
  `werkstatt_checks`, `cash_movements`, `salary_cash_receipts`, `salary_payments` and four more. The
  one cash table it does back up is **the legacy one**.
- `:12` — **truncated at 1000 rows per table.** No `.range()`, no batch loop. A company with 1,400
  Belege gets 400 fewer, `error === null`, no warning. Nothing in the JSON says how many were
  expected.

**And the one that is a commercial exposure, not a bug:**
`src/pages/LandingPage.tsx:534` publishes **`Backup` in the Basic plan's feature list**
(`de.ts:1562`). The only backup in the product is `BackupManagement`, a tab of `UsersPage`, and
`/users` is `<PlanGate feature="rollen_nutzer">` with `rollen_nutzer: 'advanced'`. **A Basic customer
is sold a feature the plan refuses.** → decision **D-A**.

---

## Group 6 — the platform panel: what the owner actually asked for

Ten screens, zero exports. But **four of them cannot be exported yet, because their reads are
broken**, and an export over a broken read is a file that lies with more authority than a screen.

Fix the reads first:

| at | what |
|---|---|
| `src/pages/CompanyBillingPage.tsx:86` | **The Aktivierungsverlauf is always empty for the company it belongs to.** `activation_codes` SELECT is gated on `codes.manage`, held by `owner` and `billing` and **by no company role at all**. A company admin at `/billing` gets zero rows, silently. |
| `src/pages/SubscriptionBillingPage.tsx:137` | **The invoice list is truncated at 1000 rows and the two money KPIs are computed over the truncation.** No `.range()`, and `PGRST_DB_MAX_ROWS: 1000`. Newest first, so the oldest invoices vanish — 19 companies × 12 invoices/year reaches it in about four and a half years. |
| `src/pages/SubscriptionBillingPage.tsx` | **Never inspects the three reads' `error`**, so a refused read renders as an empty platform with `0,00 €` collected. |
| `src/components/DiscountCodesManagement.tsx:393` | **The error is not even destructured, and there is no try/catch.** `support` and `read_only` lack `codes.manage`; either lands on `setCodes([])` rendering "no discount codes exist", with no message of any kind. |

Plus four narrower ones: activation codes are read `.limit(200)`, so any export of them is the 200
newest; `CompaniesPage`'s Benutzer column is a dash for every company past the first 100 because the
read model is called once, unpaged; `ReferralCodesManagement`'s usage counts read 0 whenever the
parent dashboard's read failed; `SuperAdminDashboard` prints a drivers allowance built from a silent
default of 4 when the settings limit was not read.

**Then the exports.** Two of the ten are worth it and the rest follow cheaply:
`SubscriptionBillingPage` (invoices — money leaving and arriving) and `CompaniesPage` (the customer
list). The constraint that shapes all of them → decision **D-C**: the platform read models cap at
**100 rows** and **write one audit row per call**, so an export of a directory either pages — N audit
rows, and the audit log has a 12-month retention for `read` — or is labelled as a page. A file
labelled as the whole list while holding 100 rows is the defect this group exists to avoid.

**What must not widen:** the directories deliberately omit salary, bank details, every personal
identifier beyond the name, and any account holding a staff row. An export adding a column the read
model does not return is a data-protection decision, not a convenience.

---

## Group 7 — the exports that are missing and should exist

Ranked by what an operator does with the file.

1. **`AbrechnungPage`** (`:1141`) — **the one screen whose figures are reconciled against the
   Steuerberater's, and its only output is a PNG.** Highest value in the set. The export must reuse
   the screen's own computed numbers so the file and the screen cannot disagree.
2. **`DocumentsPage`'s Stundennachweis archive** (`:368`) — the export already exists and takes this
   row shape unchanged.
3. **`GehaltsquittungList`** (`:428`) — the cash-receipt ledger. Note the numbering convention changed
   mid-history: `GQ-YYYY` is the **salary's** business year since `20260919160000`, the payment year
   before it, and both exist. Group by the stored `business_year`, never by the number.
4. **`FahrtenbuchTripsView`** (`:172`) — a working list. Verified safe: the screen does hold every
   trip, not a page.
5. **`RolesManagement`** (`:228`) — needs the per-permission rows, not the screen's summary sentence,
   which would be useless in a file.

---

## Group 8 — dead code, two of it whole features

- **`exportFahreruebersichtToExcel`** has **no live caller at all**. `handleGenerateFahreruebersicht`
  (`StundennachweisPage.tsx:3630`) is defined and wired to nothing — no JSX tag, no `onClick`. Two of
  the five refutations were "the scenario cannot arise" for exactly this reason.
- **`exportFahrtenbuchAudit`** — 132 lines, three sheets, no caller. Nor has `validateExportDriverNotes`.
- **`exportToExcel`** (`excelExport.ts:504`) — 770 lines on a `Receipt` model the database does not
  have, with merge arithmetic that drifts by up to six rows. Evidence for **deleting** it, not
  repairing it → decision **D-E**.

Deleting these shrinks nothing at runtime — Rollup already tree-shakes them. What it removes is the
cost of the next reader believing they are live.

---

## Group 9 — the visual design of every export is a no-op

Settled from the installed library, not inferred: **`xlsx@0.20.3` (the community build) discards
every cell style on write.** `write_ws_xml_cell` → `get_cell_style` reads exactly one property,
`cell.z`. And `!freeze` and `!printSetup` **do not exist in the library at all**.

So the whole `T` token block, all 61 style objects, every fill, font, border and alignment, the frozen
header row and the print setup — in **four modules, not one** — draw nothing. The files come out
plain. (This is also why PR #150 works: `z` is the one property that survives.)

→ decision **D-B**.

Alongside it, the smaller formatting items, all real and all cosmetic: the sheet's own chrome is
hard-coded German while the column headers follow the UI language; dates read `1.9.2026` rather than
`01.09.2026`; date-only columns go through `new Date()`, which shifts them a day in any browser west
of UTC; the Monatsplanung Prüf-Export writes ISO dates in two sheets and German dates in a third **in
one workbook**; the Notizen export's third sheet mixes German and translated headers in the same
header row; the autofilter range is stretched over the totals row and the footer; a `format` returning
`undefined` deletes the cell rather than blanking it; one Blob download does not attach its anchor to
the document, unlike the other three in the repo.

---

## Decisions only the owner can take

| | |
|---|---|
| **D-A** | **Basic is sold `Backup` and the button is gated `advanced`.** Either remove the line from the Basic plan's published features, or move the gate. This is a promise made to paying customers today, so it is his call and not a code choice. |
| **D-B** | **The dead styling.** Delete some 500 lines of style objects and accept plain files, or move to a writer that supports styling (a new dependency, against CLAUDE.md's rule about introducing frameworks). Numbers and number formats work either way. |
| **D-C** | **The panel exports and the audit cost.** Paging a directory export writes one audit row per 100 rows. Acceptable, or label exports as a single page? |
| **D-D** | **The panel directory columns.** Any column beyond what the read models return is a data-protection decision. Confirm the reduced set stands. |
| **D-E** | **Delete `exportToExcel`** (770 lines, phantom model) and route Belege through the generic helper, keeping only the content worth keeping? |

---

## What this plan deliberately does not do

- **It does not reformat the statutory documents.** The Stundennachweis PDF, the Fahrtenbuch XLSX's
  `'original'` mode, the Gehaltsquittung, the Trinkgeld-Quittung, the Mietwagenauftrag and the two
  legal pages stay German and byte-stable. Group 4 fixes a crash and a silent return, nothing else.
- **It does not touch the premium engines, Lohnart computation, or the finalization checks.** Those
  wait on the accountant — `Docs/audit/FRAGEN_AN_DEN_STEUERBERATER_2026-09-28.md`.
- **It does not add a dependency** to make the styling work. That is D-B.

## Still unmeasured

- **No file was opened in Excel.** Every claim about what Excel does with a cell was read off the
  library's own writer and, for PR #150, off a real round-trip through `XLSX.write`/`read`. The first
  check after any of this ships is opening one file in Excel under a German locale.
- **The two build-gate failures** were proven pre-existing but not diagnosed.
- **The cost of a paged panel export** in audit rows and wall-clock is unmeasured; time one on
  staging before relying on it.
