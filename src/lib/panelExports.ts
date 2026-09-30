/**
 * The `ExportOptions` behind the platform panel's Excel exports.
 *
 * Until now the panel had **no export anywhere**: an operator reconciling a
 * month's invoices, answering "who holds platform rights", or attaching the
 * Protokoll to an incident report retyped it or took a screenshot. The reads
 * themselves were corrected first (PR #159) — an export over a read that came
 * back short is a file that lies with more authority than a screen does.
 *
 * Every builder is a pure mapping from what its screen already holds to what
 * `exportTableToExcel` writes, so the mapping is testable without a renderer:
 * every defect one of these exports can carry is a wrong column, a wrong unit,
 * a wrong scope claim or a wrong order, and all four are visible here.
 *
 * ── The rules these builders preserve ─────────────────────────────────────────
 *
 * 1. **A file says what it holds — decision D-C.** The platform read models cap
 *    a page at 100 rows and write one audited `read` row per call. So an export
 *    writes **the page the operator is looking at**, never a hidden re-read of
 *    every page, and `pageScopeLine(...)` puts that in the filter band while
 *    `pageSuffix(...)` puts it in the filename. Where a screen genuinely holds
 *    every row it read — CompaniesPage reads `companies` directly, the Team
 *    roster pages itself to the end — the band says *that* instead. The two are
 *    never blurred: a file labelled as a list it does not hold is the defect
 *    this whole module is shaped around.
 * 2. **An export adds no column the read model withholds — decision D-D.** The
 *    directories omit salary, bank data, every personal identifier beyond the
 *    name, and any account with a `platform_staff` row; the billing models omit
 *    the paying and collecting account ids, the payment method, the free-text
 *    notes, the customer's e-mail and the country. None of that is reachable
 *    from a row type here, and nothing below reaches past one.
 * 3. **A money cell holds EUROS, never integer cents.** `type: 'money'` renders
 *    `#,##0.00 "€"`, so a cents value in such a cell is wrong by a factor of 100
 *    and looks entirely plausible. Every money column below names its source and
 *    its unit at its own line. Three columns carry money and all three are euros:
 *    `subscription_invoices.amount` and `.cash_received_amount` (migration
 *    20260916130000 records that `platform_invoice_mark_paid` takes integer cents
 *    and stores `round(cents / 100, 2)` euros — the column's unit) and
 *    `company_subscriptions.monthly_price` (numeric euros, 20260607125649). They
 *    go through `toCents(...) / 100` so the cell is rounded by `utils/money.ts`,
 *    the one module that reads a decimal amount, exactly as the Gehaltsquittung
 *    ledger export does.
 * 4. **No builder invents a figure.** The one totals row in this module carries
 *    the two sums the **database** computed (`platform_invoices_list`'s summary),
 *    and only when the file holds the whole filtered set those sums are over —
 *    see `invoiceTotalsCoverPage`. On a deeper page the same two figures move
 *    into the band, labelled as the whole filtered set. Summing the page here
 *    instead would be arithmetic no screen ever showed; writing the server's sum
 *    over a partial page would be a total that does not add up to its own rows.
 * 5. **Column 0 of the totals row is that row's label.** `buildTableWorkbook`
 *    throws when `totals` names `columns[0].key`, so the first column of every
 *    builder below is chosen on purpose and never carries a figure; a count
 *    sentence goes in `labels.totalsRow`.
 * 6. **A figure whose read failed is not exported.** Enforced by the callers,
 *    which withhold the button; these builders are only reached with data.
 * 7. **No statutory document is touched.** All of these are working lists, so
 *    their headers and their chrome follow the UI language — which is why every
 *    label arrives as an argument and no dictionary is read here. The filenames
 *    stay fixed German slugs, like every existing export's, so a folder of files
 *    sorts the same whatever language produced them.
 *
 * ── Retention ─────────────────────────────────────────────────────────────────
 * `app_private.platform_audit_purge()` (decision D4) deletes `read` rows after
 * 12 months and every other category after 36. The audit export writes the rows
 * **already on screen** and asks the database for nothing, so it can never reach
 * a purged row: a filter naming an earlier date simply comes back short and the
 * file is short with it. The other five exports read live tables and no history
 * at all. What does cost audit rows is filling the file — one
 * `platform_read.audit_list` row per press of "Mehr laden" — never the export.
 */
import { toCents } from '../utils/money';
import { EMPTY_CELL, deCount, deDate, deDateTime } from './platformFormat';
import { DIRECTORY_PAGE_SIZE, directoryReachablePageCount } from './platformReadModels';
import type { PlatformInvoiceRow, PlatformInvoiceSummary, PlatformSubscriptionRow } from './platformBilling';
import type { PlatformDriverRow, PlatformStaffRow, PlatformUserRow, PlatformVehicleRow } from './platformReadModels';
import type { AuditRow } from './platformAuditLog';
import type { ExportChromeLabels, ExportColumn, ExportOptions } from '../utils/excelExport';

/**
 * `ExportColumn.key` is a bare `string` and the older callers cast their domain
 * rows with `as unknown as Record<string, unknown>[]` — which is how the Fahrer
 * export's "Erstellt am" column was blank for every driver until #153. Every
 * builder below maps to an explicit object of this type instead, never a cast,
 * so a key that does not match a column is a missing property a test catches
 * rather than an empty column in an operator's file.
 */
type ExportRow = Record<string, unknown>;

/**
 * The workbook chrome, in the screen's language.
 *
 * Structurally identical to `tableExportRows.ExportChromeText`, which is what
 * `useExportChrome()` returns, and deliberately declared here rather than
 * imported: these builders own no file another agent is converting, and a type
 * import across that seam would make this module fail to compile for a rename
 * that changes nothing about it. TypeScript matches the two by shape.
 */
export interface PanelExportChrome {
  empty: string;
  filters: string;
  totals: string;
  footer: string;
}

function chromeLabels(text: PanelExportChrome): ExportChromeLabels {
  return {
    emptyState: text.empty,
    activeFilters: text.filters,
    totalsRow: text.totals,
    footer: text.footer,
  };
}

/** A euro amount as a money cell: rounded by utils/money.ts, returned in euros. */
function euros(amount: number): number {
  return toCents(amount) / 100;
}

/** A label/value pair for the filter band, dropped when the value is empty. */
export interface FilterEntry {
  label: string;
  value: string | null;
}

/**
 * The band the exporter prints under the header: `Label: value`, the pairs that
 * have a value, in the order given. `template` is `ui.export.filterLine`, so the
 * separator follows the UI language like every other label.
 */
export function filterBand(template: string, entries: readonly FilterEntry[]): string[] {
  return entries
    .filter((entry): entry is { label: string; value: string } => Boolean(entry.value))
    .map(entry => template.replace('{label}', entry.label).replace('{value}', entry.value));
}

// ─── What the file covers, said in the file ──────────────────────────────────

export interface PageScope {
  /** Zero-based, as every panel screen's state holds it. */
  pageIndex: number;
  /** The row count the read model reported for the whole filtered set. */
  total: number;
  /** How many rows this file actually carries. */
  rowCount: number;
  pageSize?: number;
}

/**
 * Whether the file holds the whole filtered set rather than one page of it.
 *
 * Both terms are load-bearing. `pageIndex === 0` alone would call page 1 of
 * seven complete; `rowCount >= total` alone would call page 3 complete whenever
 * a later page happened to hold as many rows as the total. A `total` the parser
 * could not read comes through as the item count (`parsePlatformReadPage`'s own
 * fallback), which makes the two equal — and there "complete" is what the
 * database effectively said, so it is not overridden here.
 */
export function coversWholeSet(scope: PageScope): boolean {
  return scope.pageIndex === 0 && scope.rowCount >= scope.total;
}

/**
 * One sentence for the band: either "every one of N rows" or "page P of Q, R of
 * N rows". Which of the two is the whole point of decision D-C, so it is a
 * function with a test rather than a string built at five call sites.
 */
export function pageScopeLine(
  labels: { whole: string; page: string },
  scope: PageScope,
): string {
  const size = scope.pageSize ?? DIRECTORY_PAGE_SIZE;
  if (coversWholeSet(scope)) {
    return labels.whole.replace('{rows}', deCount(scope.rowCount));
  }
  return labels.page
    .replace('{page}', deCount(scope.pageIndex + 1))
    .replace('{pages}', deCount(directoryReachablePageCount(scope.total, size)))
    .replace('{rows}', deCount(scope.rowCount))
    .replace('{total}', deCount(scope.total));
}

/**
 * `_seite-3` for a page, nothing for a complete set — so two files downloaded
 * from two pages of one filter never overwrite each other, and a complete file
 * is not labelled as a page.
 */
export function pageSuffix(scope: PageScope): string {
  return coversWholeSet(scope) ? '' : `_seite-${scope.pageIndex + 1}`;
}

/** A euro figure for a band line: German, two decimals, never a bare float. */
export function bandEuro(amount: number): string {
  const cents = toCents(amount);
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = deCount(Math.trunc(absolute / 100));
  return `${sign}${whole},${String(absolute % 100).padStart(2, '0')} €`;
}

// ─── Rechnungen ──────────────────────────────────────────────────────────────

export interface InvoiceExportLabels {
  sheetTitle: string;
  company: string;
  plan: string;
  period: string;
  number: string;
  amount: string;
  collected: string;
  status: string;
  due: string;
  paidOn: string;
  note: string;
  created: string;
  /** By stored `subscription_invoices.status`; an unmapped value is written verbatim. */
  statusNames: Readonly<Record<string, string>>;
  /** Twelve month names, indexed by `invoice_month - 1`. */
  monthNames: readonly string[];
  /** The two figures the database summed, for the band or the totals row. */
  expected: string;
  totalsCollected: string;
  scope: { whole: string; page: string };
  chrome: PanelExportChrome;
}

export interface InvoiceExportInput {
  /** The page the screen is showing, in the order the database returned it. */
  rows: readonly PlatformInvoiceRow[];
  /** `platform_invoices_list`'s own summary, over the whole filtered set. */
  summary: PlatformInvoiceSummary;
  scope: PageScope;
  /** What the operator filtered by, already translated. */
  filters: readonly FilterEntry[];
  filterLineTemplate: string;
  /** `2026-09` or `2026` for the filename — the period the operator asked for. */
  periodSlug: string;
  labels: InvoiceExportLabels;
}

/**
 * Whether the two summed figures belong in the totals row.
 *
 * `filtered_amount` and `filtered_collected` are computed in SQL over the whole
 * filtered set, and the file holds one page of it. On page 1 of a set that fits
 * in a page they are exactly the sum of the rows in the file; anywhere else they
 * are not, and a totals row that does not add up to its own column is worse than
 * no totals row. So the same two figures move to the band there, where their
 * label says what they cover.
 */
export const invoiceTotalsCoverPage = coversWholeSet;

/**
 * What the office reconciles against the bank: which customer owes what for
 * which month, what was collected, and when.
 */
export function buildInvoicesExport(input: InvoiceExportInput): ExportOptions {
  const { rows, summary, scope, filters, filterLineTemplate, periodSlug, labels } = input;
  const inTotals = invoiceTotalsCoverPage(scope);

  const band = filterBand(filterLineTemplate, [
    ...filters,
    // Named in the band whenever they are NOT in the totals row, so the two
    // figures the screen's KPI cards print are in the file either way — and
    // never in a place that implies they sum the rows above them.
    ...(inTotals ? [] : [
      { label: labels.expected, value: bandEuro(summary.filteredAmount) },
      { label: labels.totalsCollected, value: bandEuro(summary.filteredCollected) },
    ]),
  ]);
  band.push(pageScopeLine(labels.scope, scope));

  return {
    filename: `rechnungen_${periodSlug}${pageSuffix(scope)}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: band,
    columns: [
      // Column 0: the customer's name. It carries the totals row's label, so it
      // is never a figure — and it is what an operator sorts a reconciliation by.
      { key: 'company', label: labels.company, width: 28 },
      { key: 'number', label: labels.number, width: 20 },
      { key: 'period', label: labels.period, width: 18 },
      { key: 'plan', label: labels.plan, width: 16 },
      // Euros. See rule 3.
      { key: 'amount', label: labels.amount, width: 16, align: 'right', type: 'money' },
      { key: 'collected', label: labels.collected, width: 16, align: 'right', type: 'money' },
      { key: 'status', label: labels.status, width: 14 },
      { key: 'due', label: labels.due, width: 14 },
      { key: 'paidOn', label: labels.paidOn, width: 20 },
      { key: 'note', label: labels.note, width: 30 },
      { key: 'created', label: labels.created, width: 14 },
    ],
    rows: rows.map((row): ExportRow => ({
      company: row.company_name ?? EMPTY_CELL,
      number: row.invoice_number,
      period: `${labels.monthNames[row.invoice_month - 1] ?? String(row.invoice_month)} ${row.invoice_year}`,
      plan: row.plan_name ?? EMPTY_CELL,
      amount: euros(row.amount),
      // Null stays empty rather than becoming 0,00 €: "no cash counted" and a
      // receipt of nothing are different facts, and the ledger reads a 0 as
      // absent (migration 20260924110000's `filtered_collected`). An empty
      // string is left on the text path by `numericCell`, which is what it is
      // for — a money cell of 0,00 € here would claim a counted handover.
      collected: row.cash_received_amount === null ? '' : euros(row.cash_received_amount),
      status: labels.statusNames[row.status] ?? row.status,
      due: deDate(row.due_date),
      paidOn: deDateTime(row.paid_at),
      note: row.receipt_note ?? '',
      created: deDate(row.created_at),
    })),
    // `company` is column 0 and carries the label, so it never appears here.
    // Only the database's own two sums, and only where they sum these rows.
    totals: inTotals
      ? { amount: euros(summary.filteredAmount), collected: euros(summary.filteredCollected) }
      : undefined,
    labels: chromeLabels(labels.chrome),
  };
}

// ─── Abonnements ─────────────────────────────────────────────────────────────

export interface SubscriptionExportLabels {
  sheetTitle: string;
  company: string;
  plan: string;
  pricePerMonth: string;
  status: string;
  start: string;
  billingDay: string;
  statusNames: Readonly<Record<string, string>>;
  /** How many subscriptions are active across the platform, for the band. */
  activeCount: string;
  scope: { whole: string; page: string };
  chrome: PanelExportChrome;
}

export interface SubscriptionExportInput {
  rows: readonly PlatformSubscriptionRow[];
  /** The one figure `platform_subscriptions_list` sums; there is no price sum. */
  activeCount: number;
  scope: PageScope;
  filters: readonly FilterEntry[];
  filterLineTemplate: string;
  /** Today in the reader's zone, `YYYY-MM-DD`, for the filename. */
  today: string;
  labels: SubscriptionExportLabels;
}

/**
 * Who pays what every month — the basis on which a month's invoices are
 * generated, and the one list that answers "is this customer on the rate we
 * agreed".
 *
 * **No totals row.** `platform_subscriptions_list`'s summary carries a count and
 * no sum, and adding up `monthly_price` here would be a monthly-revenue figure
 * no screen has ever shown, over one page, with cancelled and suspended rows in
 * it. The count goes in the band; Excel's status bar sums a typed column for
 * whoever wants the page's.
 */
export function buildSubscriptionsExport(input: SubscriptionExportInput): ExportOptions {
  const { rows, activeCount, scope, filters, filterLineTemplate, today, labels } = input;

  const band = filterBand(filterLineTemplate, [
    ...filters,
    { label: labels.activeCount, value: deCount(activeCount) },
  ]);
  band.push(pageScopeLine(labels.scope, scope));

  return {
    filename: `abonnements_${today}${pageSuffix(scope)}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: band,
    columns: [
      // Column 0: the customer. No totals row, so nothing collides with the
      // label the exporter would write here.
      { key: 'company', label: labels.company, width: 28 },
      { key: 'plan', label: labels.plan, width: 18 },
      // Euros: company_subscriptions.monthly_price is numeric euros, a rate
      // rather than a price — which is why no coverage period is priced from it.
      { key: 'price', label: labels.pricePerMonth, width: 16, align: 'right', type: 'money' },
      { key: 'status', label: labels.status, width: 14 },
      { key: 'start', label: labels.start, width: 14 },
      { key: 'billingDay', label: labels.billingDay, width: 16, align: 'right', type: 'integer' },
    ],
    rows: rows.map((row): ExportRow => ({
      company: row.company_name ?? EMPTY_CELL,
      plan: row.plan_name ?? EMPTY_CELL,
      price: euros(row.monthly_price),
      status: labels.statusNames[row.status] ?? row.status,
      start: deDate(row.starts_at),
      billingDay: row.billing_day,
    })),
    labels: chromeLabels(labels.chrome),
  };
}

// ─── Unternehmen ─────────────────────────────────────────────────────────────

/** Exactly the columns `CompaniesPage` reads and shows; see the builder's note. */
export interface CompanyExportRow {
  name: string;
  slug: string;
  status: string;
  email: string | null;
  city: string | null;
  created_at: string;
  /** From `platform_companies_list`; absent where that page did not reach the row. */
  user_count?: number;
}

export interface CompanyExportLabels {
  sheetTitle: string;
  name: string;
  slug: string;
  status: string;
  email: string;
  city: string;
  users: string;
  created: string;
  statusNames: Readonly<Record<string, string>>;
  /**
   * The whole-list wording, with `{rows}`. It is the same label the paged
   * exports use for their complete case, on purpose: a reader should not have to
   * learn two sentences to tell a complete file from a page.
   */
  scopeWhole: string;
  /** Said only when at least one company has no user count. */
  countsIncomplete: string;
  chrome: PanelExportChrome;
}

export interface CompanyExportInput {
  /** The screen's own filtered list, in the order it shows. */
  rows: readonly CompanyExportRow[];
  filters: readonly FilterEntry[];
  filterLineTemplate: string;
  today: string;
  labels: CompanyExportLabels;
}

/**
 * The customer list. `CompaniesPage` reads `public.companies` directly — the one
 * table decision D14 deliberately left readable on `companies.read`, because
 * choosing a company to open a context on cannot require a context — so this
 * export covers **every row the screen read**, not a page, and the band says so.
 *
 * **The columns are the screen's own, and that is a choice rather than a
 * limit.** `select('*')` hands the page `legal_name`, `phone`, `address`,
 * `postal_code`, `country` and `logo_url` as well; none of them is on screen and
 * none is here. The recipient's postal address already travels on the invoice
 * PDF, which is the document that needs it. Widening this file is a data
 * protection decision, exactly as widening a read model is.
 *
 * **No totals row.** `user_count` is absent for a company `platform_companies_list`
 * did not reach on its one page, and the screen prints a dash there; a sum over a
 * column with unknown cells is a wrong number, so the band names how many rows
 * are affected instead.
 */
export function buildCompaniesExport(input: CompanyExportInput): ExportOptions {
  const { rows, filters, filterLineTemplate, today, labels } = input;
  const unknownCounts = rows.filter(row => typeof row.user_count !== 'number').length;

  const band = filterBand(filterLineTemplate, [
    ...filters,
    {
      label: labels.countsIncomplete,
      value: unknownCounts > 0 ? deCount(unknownCounts) : null,
    },
  ]);
  // Not a page: this screen read the list itself, so the file says so rather
  // than leaving a reader to assume either way (decision D-C).
  band.push(labels.scopeWhole.replace('{rows}', deCount(rows.length)));

  return {
    filename: `unternehmen_${today}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: band,
    columns: [
      // Column 0: the company's name. No totals row.
      { key: 'name', label: labels.name, width: 28 },
      { key: 'slug', label: labels.slug, width: 22 },
      { key: 'status', label: labels.status, width: 14 },
      { key: 'email', label: labels.email, width: 28 },
      { key: 'city', label: labels.city, width: 20 },
      { key: 'users', label: labels.users, width: 12, align: 'right', type: 'integer' },
      { key: 'created', label: labels.created, width: 14 },
    ],
    rows: rows.map((row): ExportRow => ({
      name: row.name,
      slug: row.slug,
      status: labels.statusNames[row.status] ?? row.status,
      email: row.email ?? '',
      city: row.city ?? '',
      // An em dash, never 0: the screen prints a dash and a 0 would say this
      // customer has no users. `numericCell` leaves a non-numeric value on the
      // text path, so the cell reads as the screen does.
      users: typeof row.user_count === 'number' ? row.user_count : EMPTY_CELL,
      created: deDate(row.created_at),
    })),
    labels: chromeLabels(labels.chrome),
  };
}

// ─── Verzeichnisse ───────────────────────────────────────────────────────────

export type DirectoryTab = 'vehicles' | 'drivers' | 'users';

export interface DirectoryExportLabels {
  /** The tab's own name — also the sheet name, so it stays short. */
  sheetTitle: string;
  company: string;
  status: string;
  created: string;
  kennzeichen: string;
  tuev: string;
  lastHu: string;
  name: string;
  usage: string;
  email: string;
  fullName: string;
  role: string;
  confirmed: string;
  lastSignIn: string;
  statusNames: Readonly<Record<string, string>>;
  scope: { whole: string; page: string };
  /** Why these columns and no others — the reduced-column note, in the file. */
  reducedNote: string;
  chrome: PanelExportChrome;
}

export type DirectoryExportInput =
  | { tab: 'vehicles'; rows: readonly PlatformVehicleRow[]; scope: PageScope;
      filters: readonly FilterEntry[]; filterLineTemplate: string; labels: DirectoryExportLabels }
  | { tab: 'drivers'; rows: readonly PlatformDriverRow[]; scope: PageScope;
      filters: readonly FilterEntry[]; filterLineTemplate: string; labels: DirectoryExportLabels }
  | { tab: 'users'; rows: readonly PlatformUserRow[]; scope: PageScope;
      filters: readonly FilterEntry[]; filterLineTemplate: string; labels: DirectoryExportLabels };

/** The filename slug per tab: fixed German, like every other export's. */
const DIRECTORY_SLUG: Record<DirectoryTab, string> = {
  vehicles: 'verzeichnis_fahrzeuge',
  drivers: 'verzeichnis_fahrer',
  users: 'verzeichnis_benutzer',
};

/**
 * The fleet, the drivers and the accounts across every company — one workbook
 * per tab, because the three carry different columns and a sheet that changed
 * shape with a tab would be unusable as a file.
 *
 * **Decision D-D is what is not here.** The vehicle rows omit `created_by` and
 * `updated_at`; the driver rows omit the account id, the Personalnummer, every
 * salary figure and every planning figure; the user rows omit all metadata and
 * the profile id, and the read model lists **no account that has a
 * `platform_staff` row** at all. The three internal uuids the models do return
 * (`id`, `company_id`, `user_id`) are left out too — they identify nothing an
 * operator reconciles by, the company's name is beside every row, and the Team
 * roster is where a platform account's id is actually needed. `reducedNote` is
 * the screen's own sentence about this, carried into the band so a file read
 * away from the panel says why a column is missing.
 *
 * **No totals row and no numeric column.** Every column is a name, a status or a
 * date; a count of rows is the chrome's own `totalsRow` wording, not a figure.
 */
export function buildDirectoryExport(input: DirectoryExportInput): ExportOptions {
  const { tab, scope, filters, filterLineTemplate, labels } = input;

  const band = filterBand(filterLineTemplate, filters);
  band.push(pageScopeLine(labels.scope, scope));
  band.push(labels.reducedNote);

  const status = (value: string | null): string =>
    value ? labels.statusNames[value] ?? value : EMPTY_CELL;

  let columns: ExportColumn[];
  let rows: ExportRow[];

  if (input.tab === 'vehicles') {
    columns = [
      // Column 0: the plate, which is how a vehicle is spoken about.
      { key: 'kennzeichen', label: labels.kennzeichen, width: 16 },
      { key: 'company', label: labels.company, width: 28 },
      { key: 'status', label: labels.status, width: 14 },
      { key: 'tuev', label: labels.tuev, width: 16 },
      { key: 'lastHu', label: labels.lastHu, width: 16 },
      { key: 'created', label: labels.created, width: 14 },
    ];
    rows = input.rows.map((row): ExportRow => ({
      kennzeichen: row.kennzeichen || EMPTY_CELL,
      company: row.company_name ?? EMPTY_CELL,
      status: status(row.status),
      tuev: deDate(row.tuev_gueltig_bis),
      lastHu: deDate(row.letzte_hu),
      created: deDate(row.created_at),
    }));
  } else if (input.tab === 'drivers') {
    columns = [
      { key: 'name', label: labels.name, width: 26 },
      { key: 'company', label: labels.company, width: 28 },
      { key: 'status', label: labels.status, width: 14 },
      { key: 'usage', label: labels.usage, width: 18 },
      { key: 'created', label: labels.created, width: 14 },
    ];
    rows = input.rows.map((row): ExportRow => ({
      name: row.name || EMPTY_CELL,
      company: row.company_name ?? EMPTY_CELL,
      status: status(row.status),
      usage: row.driver_usage_type ?? EMPTY_CELL,
      created: deDate(row.created_at),
    }));
  } else {
    columns = [
      { key: 'email', label: labels.email, width: 30 },
      { key: 'fullName', label: labels.fullName, width: 26 },
      { key: 'company', label: labels.company, width: 28 },
      { key: 'role', label: labels.role, width: 18 },
      { key: 'status', label: labels.status, width: 16 },
      { key: 'confirmed', label: labels.confirmed, width: 20 },
      { key: 'lastSignIn', label: labels.lastSignIn, width: 20 },
      { key: 'created', label: labels.created, width: 14 },
    ];
    rows = input.rows.map((row): ExportRow => ({
      email: row.email ?? EMPTY_CELL,
      fullName: row.full_name ?? EMPTY_CELL,
      company: row.company_name ?? EMPTY_CELL,
      // The role's own name where the company gave it one, else the stored
      // word — exactly what the screen prints, and never the id.
      role: row.role_name ?? row.role ?? EMPTY_CELL,
      status: status(row.status),
      confirmed: deDateTime(row.email_confirmed_at),
      lastSignIn: deDateTime(row.last_sign_in_at),
      created: deDate(row.created_at),
    }));
  }

  return {
    filename: `${DIRECTORY_SLUG[tab]}${pageSuffix(scope)}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: band,
    columns,
    rows,
    labels: chromeLabels(labels.chrome),
  };
}

// ─── Protokoll ───────────────────────────────────────────────────────────────

export interface AuditExportLabels {
  sheetTitle: string;
  time: string;
  actor: string;
  actorRole: string;
  action: string;
  category: string;
  outcome: string;
  target: string;
  targetId: string;
  company: string;
  before: string;
  after: string;
  categoryNames: Readonly<Record<string, string>>;
  outcomeNames: Readonly<Record<string, string>>;
  /** "the rows loaded so far", the only honest claim this file can make. */
  loadedNote: string;
  /** Said when the answer restricted the account to its own rows. */
  ownScopeNote: string | null;
  chrome: PanelExportChrome;
}

export interface AuditExportInput {
  /** Every row loaded so far, newest first, as the screen holds them. */
  rows: readonly AuditRow[];
  filters: readonly FilterEntry[];
  filterLineTemplate: string;
  today: string;
  labels: AuditExportLabels;
}

/**
 * The Protokoll as a file — what an incident report or a data protection request
 * is answered with, which a scrolling table cannot be.
 *
 * **The file is the rows loaded, and the band says exactly that.** The log pages
 * by a keyset cursor, so there is no total to compare against and no page
 * number: "Seite 1 von N" would be an invention. Pressing "Mehr laden" before
 * exporting is how an operator gets more into the file, and each press is one
 * audited read — the export itself asks the database for nothing.
 *
 * **`before_value` and `after_value` are written as JSON, unabridged.** They are
 * what a support write actually changed, already redacted at the source by
 * `app_private.support_write_redaction_pattern()`, and re-shaping them here
 * would put a second redaction rule in the codebase — the thing that rule exists
 * to be the only copy of. A row with neither is two empty cells.
 *
 * **No totals row.** Nothing in the log is a quantity.
 */
export function buildAuditExport(input: AuditExportInput): ExportOptions {
  const { rows, filters, filterLineTemplate, today, labels } = input;

  const band = filterBand(filterLineTemplate, filters);
  band.push(labels.loadedNote.replace('{rows}', deCount(rows.length)));
  if (labels.ownScopeNote) band.push(labels.ownScopeNote);

  return {
    filename: `protokoll_${today}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: band,
    columns: [
      // Column 0: the instant. The log's order is chronological and a reader
      // opens the file at the newest row, as the screen does.
      { key: 'time', label: labels.time, width: 22 },
      { key: 'actor', label: labels.actor, width: 30 },
      { key: 'actorRole', label: labels.actorRole, width: 14 },
      { key: 'action', label: labels.action, width: 34 },
      { key: 'category', label: labels.category, width: 16 },
      { key: 'outcome', label: labels.outcome, width: 14 },
      { key: 'target', label: labels.target, width: 20 },
      { key: 'targetId', label: labels.targetId, width: 38 },
      { key: 'company', label: labels.company, width: 28 },
      { key: 'before', label: labels.before, width: 40 },
      { key: 'after', label: labels.after, width: 40 },
    ],
    rows: rows.map((row): ExportRow => ({
      // To the second: two rows of one transaction are ordered by nothing else.
      time: deDateTime(row.occurred_at),
      // The address where the log has one, else the account id in full. The
      // screen shortens it to eight characters with the rest in a tooltip; a
      // file has no tooltip, and half a uuid identifies nobody.
      actor: row.actor_email ?? row.actor_user_id ?? EMPTY_CELL,
      actorRole: row.actor_role ?? EMPTY_CELL,
      action: row.action,
      category: labels.categoryNames[row.category] ?? row.category,
      outcome: labels.outcomeNames[row.outcome] ?? row.outcome,
      target: row.target_type ?? EMPTY_CELL,
      targetId: row.target_id ?? '',
      company: row.company_name ?? EMPTY_CELL,
      before: jsonCell(row.before_value),
      after: jsonCell(row.after_value),
    })),
    labels: chromeLabels(labels.chrome),
  };
}

/**
 * A stored JSON value as one cell. Null and undefined are empty rather than the
 * string "null", which would read as a recorded value of null.
 */
function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    // A cyclic value cannot come out of a JSON column, but a cell is not the
    // place to throw: the export must not fail on one unreadable detail.
    return EMPTY_CELL;
  }
}

// ─── Team ────────────────────────────────────────────────────────────────────

export interface StaffExportLabels {
  sheetTitle: string;
  member: string;
  userId: string;
  role: string;
  status: string;
  disabledOn: string;
  invitationPending: string;
  grantedBy: string;
  since: string;
  note: string;
  roleNames: Readonly<Record<string, string>>;
  statusActive: string;
  statusDisabled: string;
  yes: string;
  no: string;
  noAddress: string;
  /** What `created_by IS NULL` means: written with no session at all. */
  grantedByUnrecorded: string;
  /** One line for the band: what the file covers. */
  scopeComplete: string;
  /** Said instead when the roster could not be paged to the end. */
  scopeIncomplete: string;
  chrome: PanelExportChrome;
}

export interface StaffExportInput {
  /** The roster as `collectStaffRoster` returned it. */
  rows: readonly PlatformStaffRow[];
  /** False when the paging stopped early: the file is then not the whole team. */
  complete: boolean;
  today: string;
  labels: StaffExportLabels;
}

/**
 * Who holds platform rights — the access-review artefact, and the platform's
 * counterpart to the Rollen matrix a company exports.
 *
 * `collectStaffRoster` pages `platform_staff_list` to the end, so this file is
 * the whole team when `complete` is true and says so; when it is false the band
 * says the roster is partial rather than the file implying a complete one. It is
 * not withheld in that case: a partial roster is still a fact, labelled.
 *
 * **The full `user_id` is a column here and nowhere else in this module.** The
 * screen already shows it — shortened, with the whole value in the cell's title
 * — and "Vorhandenes Konto hinzufügen" takes exactly that id, so a roster
 * without it cannot be acted on. It is a platform account's id, never a
 * customer's.
 *
 * **No totals row.** A count of owners would be a claim about who administers
 * the platform, drawn from a roster that may be partial.
 */
export function buildStaffExport(input: StaffExportInput): ExportOptions {
  const { rows, complete, today, labels } = input;

  const band = [
    (complete ? labels.scopeComplete : labels.scopeIncomplete).replace('{rows}', deCount(rows.length)),
  ];

  return {
    filename: `plattform_team_${today}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: band,
    columns: [
      // Column 0: the sign-in address, which is what the roster is a list of.
      { key: 'member', label: labels.member, width: 32 },
      { key: 'role', label: labels.role, width: 16 },
      { key: 'status', label: labels.status, width: 14 },
      { key: 'disabledOn', label: labels.disabledOn, width: 14 },
      { key: 'invitationPending', label: labels.invitationPending, width: 18 },
      { key: 'grantedBy', label: labels.grantedBy, width: 32 },
      { key: 'since', label: labels.since, width: 14 },
      { key: 'note', label: labels.note, width: 36 },
      { key: 'userId', label: labels.userId, width: 38 },
    ],
    rows: rows.map((row): ExportRow => ({
      member: row.email ?? labels.noAddress,
      role: labels.roleNames[row.role] ?? row.role,
      status: row.status === 'disabled' ? labels.statusDisabled : labels.statusActive,
      disabledOn: row.disabled_at ? deDate(row.disabled_at) : '',
      invitationPending: row.invitation_pending ? labels.yes : labels.no,
      // The same three cases `grantedBy()` distinguishes: the address, the id of
      // an account that is gone, or nothing recorded at all. A row written by a
      // migration or by psql has no actor, and saying so beats guessing one.
      grantedBy: row.created_by === null
        ? labels.grantedByUnrecorded
        : row.created_by_email ?? row.created_by,
      since: deDate(row.created_at),
      note: row.note ?? '',
      userId: row.user_id,
    })),
    labels: chromeLabels(labels.chrome),
  };
}
