import { permissionsFromTemplate, ROLE_PAGE_KEYS } from '../lib/companyRoles';
import type { RolePermission } from '../types/role';
import { formatDate } from '../components/ui/format';
import { toCents } from './money';
import { berlinToday } from './salaryCashReceiptFlow';
import { FAHRTENBUCH_ORIGINAL_COLUMNS, tripDriverName } from './fahrtenbuchExport';
import type { ExportChromeLabels, ExportColumn, ExportOptions } from './excelExport';

/**
 * The `ExportOptions` behind four screens that had no Excel export at all:
 * Abrechnung, the Gehaltsquittung ledger, the Fahrtenliste and the Rollen
 * matrix. Each builder is a pure mapping from what its screen already holds to
 * what `exportTableToExcel` writes, so the mapping can be tested without a
 * renderer — which is the point: every defect these four exports could carry is
 * a wrong column, a wrong unit or a wrong order, and all three are visible here.
 *
 * ── The rules these builders preserve ─────────────────────────────────────────
 *
 * 1. **A money cell holds euros, never integer cents.** `type: 'money'` renders
 *    `#,##0.00 "€"`, so a cents value in such a cell is wrong by a factor of 100
 *    and looks entirely plausible. Every money column below names its source's
 *    unit; the one source that is cents is converted at the row, as
 *    `BargeldbestandPage` does.
 * 2. **The Abrechnung sign is the RPC's.** The weekly balance is cash collected
 *    minus cash expenses, and **positive means the driver owes the company**.
 *    `bar_zuruck` is written verbatim, sign unchanged — the same number the
 *    screen prints through its own `barZurueck()`. Nothing here negates it.
 * 3. **A cancelled ride is never counted.** A trip with `is_canceled = true` is
 *    listed, with a column that says so, and enters no sum the file writes. The
 *    Fahrtenliste therefore carries no money totals row at all (see below).
 * 4. **`start_at` is the ride's real start.** `trip_date` is the file's "Datum
 *    der Fahrt", which the Uber export dates a day early for a ride starting
 *    just after midnight. Both are exported, and so is `time_source`, because
 *    `fallback_trip_date` means `start_at` was built from `trip_date` plus a
 *    clock time and inherits that same day-early error.
 * 5. **A Gehaltsquittung's year is the stored `business_year`, never the number.**
 *    `GQ-YYYY` is the salary's business year since 20260919160000 and the
 *    payment year before it; both conventions exist in the history and no
 *    receipt is ever renumbered. So the ledger is grouped and sorted by
 *    `business_year` / `business_month`, nothing parses a receipt number, and
 *    nothing derives a business month.
 * 6. **A figure whose load failed is not exported.** Enforced by the callers,
 *    which withhold the button; these builders are only reached with data.
 * 7. **The file cannot disagree with the screen.** Every figure written is a
 *    value the screen holds, or the output of the screen's own reducer applied
 *    to the screen's own filtered set. These builders do no arithmetic. The two
 *    exceptions are named where they occur, and both are conversions rather
 *    than sums: cents to euros, and a timestamp to the Berlin day.
 * 8. **No statutory document is touched.** All four are working lists, so their
 *    headers and their chrome follow the UI language — which is why every label
 *    arrives as an argument and no dictionary is read here.
 *
 * ── Column 0 of the totals row ────────────────────────────────────────────────
 * `buildTableWorkbook` writes the totals row's first cell unconditionally as the
 * row's label, and **throws** when `totals` names `columns[0].key`. So the first
 * column is chosen on purpose in each builder — `week`, `driver`, `number`,
 * `date`, `role` — and never carries a figure.
 */

/** The workbook chrome, in the screen's language. */
export interface ExportChromeText {
  /** Printed in the first cell when there are no rows. */
  empty: string;
  /** Prefix of the filter line. */
  filters: string;
  /** Label of the totals row; keeps `{count}` for the exporter to substitute. */
  totals: string;
}

/**
 * Every existing caller of `exportTableToExcel` leaves `labels` unset and so
 * writes German chrome whatever the UI language is. These four pass it, because
 * shipping a new export with chrome that ignores the language would be adding
 * that defect rather than inheriting it.
 */
/**
 * `ExportColumn.key` is a bare `string`, and the existing callers hand the
 * exporter their domain rows cast with `as unknown as Record<string, unknown>[]`
 * — which is how the Fahrer export's "Erstellt am" column was blank for every
 * driver until #153. Every builder below maps to an explicit object of this type
 * instead, never a cast, so a key that does not match a column is a missing
 * property the test catches rather than an empty column in a customer's file.
 */
type ExportRow = Record<string, unknown>;

function chromeLabels(text: ExportChromeText): ExportChromeLabels {
  return {
    emptyState: text.empty,
    activeFilters: text.filters,
    totalsRow: text.totals,
  };
}

/** `2026-09` for a filename, so a period sorts in a folder listing. */
function monthSlug(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ─── Abrechnung ───────────────────────────────────────────────────────────────

export type AbrechnungExportMode = 'weekly' | 'monthly';

/**
 * One row as `get_weekly_abrechnung` / `get_monthly_abrechnung` returns it. The
 * four amounts are declared `number | string` because PostgREST serialises a
 * numeric as a string, which is why the screen wraps each one in `Number(...)`
 * before formatting. They are handed to the exporter **raw**: its own
 * `asFiniteNumber` reads a decimal string, so no coercion — and no rounding —
 * happens here, and a value that is not an amount falls to the text path
 * instead of becoming NaN.
 */
export interface AbrechnungExportRow {
  /** Weekly mode only. */
  week_number?: number;
  /** Monthly mode only: how many business weeks the month's figures cover. */
  week_count?: number;
  driver_name: string;
  anzahl_belege: number | string;
  /** Euros. Cash the driver spent. */
  ausgegebene_bargeld: number | string;
  /** Euros. Cash the driver collected. */
  bargeld: number | string;
  /** Euros. Collected minus spent; positive means the driver owes the company. */
  bar_zuruck: number | string;
}

/** What `calculateWeekTotals` / `calculateMonthlyTotals` return — real numbers. */
export interface AbrechnungExportTotals {
  anzahl_belege: number;
  ausgegebene_bargeld: number;
  bargeld: number;
  bar_zuruck: number;
}

export interface AbrechnungExportLabels {
  sheetTitle: string;
  week: string;
  weeks: string;
  driver: string;
  belege: string;
  spent: string;
  cash: string;
  barZurueck: string;
  chrome: ExportChromeText;
}

export interface AbrechnungExportInput {
  mode: AbrechnungExportMode;
  /** The screen's own filtered set, in the order it shows. */
  rows: readonly AbrechnungExportRow[];
  /** The screen's own reducer over exactly those rows. */
  totals: AbrechnungExportTotals;
  year: number;
  /** 1-based, as the screen's state holds it. */
  month: number;
  filterSummary: readonly string[];
  labels: AbrechnungExportLabels;
}

/**
 * The figures the office reconciles against the Steuerberater's. Until now the
 * screen's only output was an html2canvas PNG of one driver's card, reachable
 * from the row-detail dialog alone, so a month of some thirty amounts was
 * retyped or screenshotted.
 *
 * The screen prints one totals row per week; a workbook has one totals row, so
 * the file's is the sum over the whole filtered set — the screen's own reducer
 * applied to the screen's own filtered set, never a second implementation.
 */
export function buildAbrechnungExport(input: AbrechnungExportInput): ExportOptions {
  const { mode, rows, totals, year, month, filterSummary, labels } = input;
  const weekly = mode === 'weekly';

  // Counts and euros, so Excel can sum the columns the office adds up by hand.
  // Every amount below arrives in euros: the screen hands the same value to
  // formatEuro, which reads euros.
  const amounts: ExportColumn[] = [
    { key: 'belege', label: labels.belege, width: 12, align: 'right', type: 'integer' },
    { key: 'spent', label: labels.spent, width: 16, align: 'right', type: 'money' },
    { key: 'cash', label: labels.cash, width: 16, align: 'right', type: 'money' },
    { key: 'barZurueck', label: labels.barZurueck, width: 18, align: 'right', type: 'money' },
  ];

  const columns: ExportColumn[] = weekly
    ? [
        { key: 'week', label: labels.week, width: 10, align: 'right', type: 'integer' },
        { key: 'driver', label: labels.driver, width: 26 },
        ...amounts,
      ]
    : [
        { key: 'driver', label: labels.driver, width: 26 },
        { key: 'weeks', label: labels.weeks, width: 10, align: 'right', type: 'integer' },
        ...amounts,
      ];

  return {
    filename: `abrechnung_${weekly ? 'woche' : 'monat'}_${monthSlug(year, month)}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: [...filterSummary],
    columns,
    rows: rows.map((row): ExportRow =>
      weekly
        ? {
            week: row.week_number ?? '',
            driver: row.driver_name,
            belege: row.anzahl_belege,
            spent: row.ausgegebene_bargeld,
            cash: row.bargeld,
            barZurueck: row.bar_zuruck,
          }
        : {
            driver: row.driver_name,
            weeks: row.week_count ?? '',
            belege: row.anzahl_belege,
            spent: row.ausgegebene_bargeld,
            cash: row.bargeld,
            barZurueck: row.bar_zuruck,
          },
    ),
    // `week` (weekly) and `driver` (monthly) are column 0 and carry the row's
    // label, so neither appears here. `weeks` has no total: the screen's monthly
    // reducer does not sum week_count, and inventing a sum would be arithmetic
    // the screen never did.
    totals: {
      belege: totals.anzahl_belege,
      spent: totals.ausgegebene_bargeld,
      cash: totals.bargeld,
      barZurueck: totals.bar_zuruck,
    },
    labels: chromeLabels(labels.chrome),
  };
}

// ─── Gehaltsquittungen ────────────────────────────────────────────────────────

/** A stored receipt, as `loadReceipts` returns it. */
export interface GehaltsquittungExportRow {
  receipt_number: string;
  driver: { name: string } | null;
  /** The salary's business year — the GQ-YYYY of receipts from 20260919160000 on. */
  business_year: number;
  /** 1–12, stored at confirmation and never re-derived. */
  business_month: number;
  period_start: string;
  period_end: string;
  payment_date: string;
  /** Euros, as a numeric column: `number | string`. */
  amount: number | string;
  status: 'confirmed' | 'voided';
  voided_at: string | null;
  signed_copy_path: string | null;
}

export interface GehaltsquittungExportLabels {
  sheetTitle: string;
  number: string;
  driver: string;
  businessYear: string;
  businessMonth: string;
  periodFrom: string;
  periodTo: string;
  paymentDate: string;
  amount: string;
  status: string;
  voidedOn: string;
  signed: string;
  statusConfirmed: string;
  statusVoided: string;
  signedPresent: string;
  signedMissing: string;
  /** Twelve month names, indexed by `business_month - 1`. */
  monthNames: readonly string[];
  chrome: ExportChromeText;
}

export interface GehaltsquittungExportInput {
  /** The screen's own filtered rows, voided ones included. */
  rows: readonly GehaltsquittungExportRow[];
  filterSummary: readonly string[];
  /** Today in Europe/Berlin, for the filename. Passed so a test can pin it. */
  today: string;
  labels: GehaltsquittungExportLabels;
}

/**
 * The cash-receipt ledger, which the screen answers only by scrolling a fixed
 * height. Two things are load-bearing:
 *
 * - **the order.** The list loads `confirmed_at DESC` — payment chronology —
 *   while the ledger's year is `business_year`. Since the GQ-YYYY changed
 *   meaning mid-history, sorting by the number would interleave the two
 *   conventions. So the file sorts newest business month first and, inside a
 *   month, by receipt number ascending.
 * - **voided receipts are present and marked.** Leaving them out would make the
 *   file read as a payout list; there is deliberately **no totals row**, because
 *   summing confirmed and voided amounts states a payout figure wrong by every
 *   Storno, and summing only the confirmed ones would be arithmetic the screen
 *   never did.
 */
export function buildGehaltsquittungExport(input: GehaltsquittungExportInput): ExportOptions {
  const { rows, filterSummary, today, labels } = input;

  const ordered = [...rows].sort(
    (a, b) =>
      b.business_year - a.business_year ||
      b.business_month - a.business_month ||
      a.receipt_number.localeCompare(b.receipt_number, 'de'),
  );

  return {
    filename: `gehaltsquittungen_${today}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: [...filterSummary],
    columns: [
      // Column 0: the receipt number carries the totals row's label, and there
      // is no totals row here anyway.
      { key: 'number', label: labels.number, width: 18 },
      { key: 'driver', label: labels.driver, width: 24 },
      { key: 'businessYear', label: labels.businessYear, width: 14, align: 'right', type: 'integer' },
      { key: 'businessMonth', label: labels.businessMonth, width: 16 },
      { key: 'periodFrom', label: labels.periodFrom, width: 14 },
      { key: 'periodTo', label: labels.periodTo, width: 14 },
      { key: 'paymentDate', label: labels.paymentDate, width: 14 },
      { key: 'amount', label: labels.amount, width: 16, align: 'right', type: 'money' },
      { key: 'status', label: labels.status, width: 14 },
      { key: 'voidedOn', label: labels.voidedOn, width: 14 },
      { key: 'signed', label: labels.signed, width: 16 },
    ],
    rows: ordered.map((row): ExportRow => ({
      number: row.receipt_number,
      driver: row.driver?.name ?? '',
      businessYear: row.business_year,
      businessMonth: labels.monthNames[row.business_month - 1] ?? String(row.business_month),
      periodFrom: formatDate(row.period_start),
      periodTo: formatDate(row.period_end),
      paymentDate: formatDate(row.payment_date),
      // `amount` is euros as a numeric column. It goes through toCents because
      // it may arrive as a decimal string and utils/money.ts is the one module
      // that reads those — and because the same rounding then puts the cell at
      // the figure the Gehaltsquittung PDF prints. `/ 100` returns it to euros,
      // the unit the money format expects.
      amount: toCents(row.amount) / 100,
      status: row.status === 'voided' ? labels.statusVoided : labels.statusConfirmed,
      // The Berlin day the Storno was booked on, which is the day the cash was
      // booked back. Formatting the timestamp directly would print the UTC day.
      voidedOn: row.voided_at ? formatDate(berlinToday(new Date(row.voided_at))) : '',
      signed: row.signed_copy_path ? labels.signedPresent : labels.signedMissing,
    })),
    labels: chromeLabels(labels.chrome),
  };
}

// ─── Fahrtenliste ─────────────────────────────────────────────────────────────

/** A trip as `useFahrtenbuch` loads it — only what the 18-column ride log reads. */
export interface FahrtenlisteExportTrip {
  raw_data_json: Record<string, unknown> | null;
  original_driver_name: string;
  assigned_driver_name: string;
}

export interface FahrtenlisteExportLabels {
  sheetTitle: string;
  chrome: ExportChromeText;
}

export interface FahrtenlisteExportInput {
  /** `filteredTrips`, never the current page: the screen holds every trip of the month. */
  trips: readonly FahrtenlisteExportTrip[];
  year: number;
  /** 1-based. */
  month: number;
  labels: FahrtenlisteExportLabels;
}

const DRIVER_COLUMN = 'Fahrername';

/** The three numeric source columns; everything else is the source's text. */
const FAHRTENLISTE_NUMERIC: Readonly<Record<string, ExportColumn['type']>> = {
  Fahrpreis: 'money',
  Trinkgeld: 'money',
  Kilometer: 'number',
};

/**
 * The ride log itself, in the 18 columns of the Uber Fahrtenbuch
 * (`FAHRTENBUCH_ORIGINAL_COLUMNS`, read from the export module and never
 * retyped), each cell the imported `raw_data_json` value. Headers are statutory
 * German and do not follow the UI language.
 *
 * `Fahrername` is the assigned driver, falling back to the original
 * (`tripDriverName`, the rule the corrected Fahrtenbuch uses).
 *
 * **This is a quick read of the same shape, not an equivalent of the official
 * Fahrtenbuch export**, which stays behind the Finalization checks. What the
 * file no longer carries against the former 15 columns: Zeitquelle, the system's
 * Status and Storniert, the Originalfahrer beside the assigned one, and the
 * Berlin start/end instants (Fahrtbeginn/-ende are the source's own text now).
 * A cancelled ride is listed with its source `Fahrtstatus`; nothing is totalled.
 */
export function buildFahrtenlisteExport(input: FahrtenlisteExportInput): ExportOptions {
  const { trips, year, month, labels } = input;
  const columns: ExportColumn[] = FAHRTENBUCH_ORIGINAL_COLUMNS.map(name => ({
    key: name,
    label: name,
    type: FAHRTENLISTE_NUMERIC[name],
  }));

  return {
    filename: `fahrtenliste_${monthSlug(year, month)}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    columns,
    rows: trips.map((trip): ExportRow => {
      const raw = trip.raw_data_json ?? {};
      const row: ExportRow = {};
      for (const name of FAHRTENBUCH_ORIGINAL_COLUMNS) {
        row[name] = name === DRIVER_COLUMN ? tripDriverName(trip) : raw[name] ?? '';
      }
      return row;
    }),
    labels: chromeLabels(labels.chrome),
  };
}

// ─── Rollen ───────────────────────────────────────────────────────────────────

/** A role with the permission rows the screen already loaded. */
export interface RoleExportRole {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  permissions: readonly RolePermission[];
}

export interface RolesExportLabels {
  sheetTitle: string;
  role: string;
  roleType: string;
  typeSystem: string;
  typeCustom: string;
  description: string;
  holders: string;
  area: string;
  areaKey: string;
  view: string;
  edit: string;
  yes: string;
  no: string;
  /** The area's name by stored `page_key`; the key itself is written beside it. */
  areaNames: Readonly<Record<string, string>>;
  /** One line for the filter band: what the file covers. */
  scope: string;
  chrome: ExportChromeText;
}

export interface RolesExportInput {
  /** The company's own roles, in the order the screen lists them. */
  companyRoles: readonly RoleExportRole[];
  /** The system templates, in the order the screen lists them. */
  templates: readonly RoleExportRole[];
  /** How many accounts hold each role, by role id. */
  holders: Readonly<Record<string, number>>;
  labels: RolesExportLabels;
}

/**
 * The access matrix: one row per role and area, which is the only artefact that
 * answers "who could read Gehälter".
 *
 * **It is the full matrix, not the stored rows.** A system role stores no row at
 * all for an area it does not permit (`permissionsFromTemplate`'s own docblock
 * says so), so flattening `role.permissions` would emit a different number of
 * rows per role and leave every unpermitted area **absent** rather than shown as
 * No — the shape that makes an access review misleading. Resolving through
 * `permissionsFromTemplate`, the same helper `RoleModal` uses to draw its boxes,
 * gives sixteen rows per role and applies `can_edit → can_view` exactly as the
 * form and `company_role_save` apply it, so the file says what an operator sees
 * when they open the role.
 *
 * One knowing divergence: the screen's own summary sentence counts the raw rows,
 * so a stored `{can_view: false, can_edit: true}` is one permission there and
 * view + edit here. The matrix is what the database enforces; the sentence is
 * the thing this export exists to replace, and it is left alone.
 */
export function buildRolesExport(input: RolesExportInput): ExportOptions {
  const { companyRoles, templates, holders, labels } = input;

  const all: readonly RoleExportRole[] = [...companyRoles, ...templates];
  const rows: ExportRow[] = all.flatMap(role => {
    const permissions = permissionsFromTemplate(role.permissions);
    return ROLE_PAGE_KEYS.map((pageKey): ExportRow => {
      const state = permissions[pageKey] ?? { can_view: false, can_edit: false };
      return {
        role: role.name,
        roleType: role.is_system ? labels.typeSystem : labels.typeCustom,
        description: role.description || '',
        holders: holders[role.id] ?? 0,
        area: labels.areaNames[pageKey] ?? pageKey,
        areaKey: pageKey,
        view: state.can_view ? labels.yes : labels.no,
        edit: state.can_edit ? labels.yes : labels.no,
      };
    });
  });

  return {
    filename: 'rollen_matrix',
    sheetTitle: labels.sheetTitle,
    moduleName: labels.sheetTitle,
    filterSummary: [labels.scope],
    columns: [
      // Column 0: the role's name. No totals row — a count of Ja cells would be
      // a claim about access that nobody asked this file for.
      { key: 'role', label: labels.role, width: 24 },
      { key: 'roleType', label: labels.roleType, width: 18 },
      { key: 'description', label: labels.description, width: 32 },
      { key: 'holders', label: labels.holders, width: 12, align: 'right', type: 'integer' },
      { key: 'area', label: labels.area, width: 26 },
      { key: 'areaKey', label: labels.areaKey, width: 18 },
      { key: 'view', label: labels.view, width: 12 },
      { key: 'edit', label: labels.edit, width: 12 },
    ],
    rows,
    labels: chromeLabels(labels.chrome),
  };
}
