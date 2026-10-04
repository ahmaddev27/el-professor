/**
 * The Stundennachweis archive, one month, as a spreadsheet.
 *
 * THE RULE THIS PRESERVES — the file reuses the screen's own computed numbers,
 * so the file and the screen cannot disagree, and there is no second source for
 * a figure. A month's minute total and its gross total come in as arguments
 * (the ones `monthGroups` already computed in DocumentsPage); a row's hours are
 * `minsToDecimal(totalMins(rec))`, the same call the table cell makes. Nothing
 * here recomputes a payroll figure out of `rows_json`.
 *
 * `minsToDecimal` and `totalMins` live here rather than in the page for exactly
 * that reason: with one function, the exported hours and the displayed hours
 * cannot drift apart. Their bodies are the page's, character for character.
 *
 * WHAT THIS IS NOT. The archive list is a working list, not a statutory
 * document: the Stundennachweis PDF (`stundennachweisPdfExport.ts`) is the
 * prescribed form and is untouched by this module. So these headers follow the
 * UI language, which `src/i18n/index.ts` settles in writing for an
 * `exportTableToExcel` dump — while the seven Lohnart names inside them stay
 * German in both languages, because a Lohnart is domain vocabulary and this
 * sheet has to reconcile with the PDF beside it.
 *
 * UNITS, per column, measured rather than assumed — a cents value in a `money`
 * cell is wrong by 100x and looks entirely plausible:
 *
 *   - the seven `*_min` columns are MINUTES (`saved_stundennachweise`, written
 *     from the Stundennachweis totals), so every hour cell is
 *     `minsToDecimal(...)` and never the raw minutes — a factor of 60;
 *   - `working_days` is a count (`rows.filter(r => r.grundlohn).length`);
 *   - `hourly_rate` is EUROS per hour: `numeric` in the column, stored as the
 *     typed rate and converted to cents only inside `salaryEuros`;
 *   - `calculated_salary` is EUROS: `numeric`, written as
 *     `salaryEuros(rows, hourlyRate)` = `salaryInCents(...) / 100`, and the
 *     screen prints it with `formatEuro`, which takes a euro amount.
 *
 * Neither money column is integer cents. The `_cents` columns this codebase
 * has say so in their names (`hourly_rate_cents integer -- euro-cents per hour`).
 */
import { exportTableToExcel, type ExportColumn, type ExportOptions } from './excelExport';

/** The seven premium buckets a saved Stundennachweis stores, in minutes. */
export interface ArchiveHoursRecord {
  grundlohn_min: number;
  nachtarbeit_min: number;
  nacht04_min: number;
  samstag_min: number;
  sonntag_min: number;
  feiertag_min: number;
  weihnachten_min: number;
}

/** Minutes as decimal hours, rounded to 0,01 h. Moved here from DocumentsPage. */
export function minsToDecimal(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

/**
 * Every recorded minute of one Stundennachweis. Moved here from DocumentsPage.
 *
 * Note it includes `samstag_min`, which the statutory PDF has no column for
 * (`stundennachweisPdfExport.ts`: "Samstag is deliberately excluded from
 * visible columns"). So the archive's total already exceeds the PDF's totals
 * row wherever a Saturday was worked — which is why the sheet below gives
 * Samstag a column of its own instead of hiding the difference inside a sum.
 */
export function totalMins(rec: ArchiveHoursRecord): number {
  return rec.grundlohn_min + rec.nachtarbeit_min + rec.nacht04_min +
    rec.samstag_min + rec.sonntag_min + rec.feiertag_min + rec.weihnachten_min;
}

/** The subset of a saved record this sheet reads. `SavedRecord` satisfies it. */
export interface ArchiveExportRecord extends ArchiveHoursRecord {
  driver_name: string;
  personalnummer: string | null;
  working_days: number;
  saved_at: string;
  updated_at: string;
  generation_source?: string | null;
  hourly_rate?: number | null;
  calculated_salary?: number | null;
}

/**
 * Every word the sheet prints, passed in, so this module stays pure and holds
 * no dictionary. The precedent is `CashLedgerLabels` in `utils/cashLedger.ts`.
 *
 * Every string arrives already interpolated, because `t()` and `tPlural()` are
 * hook values the caller holds. That includes `totalsRow`: the three call sites
 * #152 corrected — Fahrzeuge, Fahrer and Benutzer — pass `t(...)` with the count
 * already resolved, and `chromeText` in `excelExport.ts` simply finds no
 * `{count}` left to replace.
 */
export interface ArchiveExportLabels {
  sheetTitle: string;
  moduleName: string;
  driver: string;
  personalnummer: string;
  workingDays: string;
  grundlohn: string;
  nachtarbeit: string;
  nacht04: string;
  samstag: string;
  sonntag: string;
  feiertag: string;
  weihnachten: string;
  totalHours: string;
  hourlyRate: string;
  gross: string;
  source: string;
  sourceFahrtenbuch: string;
  sourceMonatsplanung: string;
  savedAt: string;
  updatedAt: string;
  /** The totals row's own label — a sentence, never a figure. See below. */
  totalsRow: string;
}

export interface ArchiveExportParams {
  /** 1-indexed, as `saved_stundennachweise.month` stores it — not the 0-indexed month of `weekCalculations`. */
  month: number;
  year: number;
  records: ArchiveExportRecord[];
  /** The month group's own minute total, so the sheet cannot disagree with the header on screen. */
  totalMinutes: number;
  /** The group's own gross total, null when any record of the month has none. */
  totalGross: number | null;
  labels: ArchiveExportLabels;
}

/** German date, `DD.MM.YYYY` — never a US order. An unset timestamp is an empty cell. */
function germanDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('de-DE');
}

function sourceLabel(source: string | null | undefined, labels: ArchiveExportLabels): string {
  if (source === 'fahrtenbuch') return labels.sourceFahrtenbuch;
  if (source === 'monatsplanung') return labels.sourceMonatsplanung;
  return '';
}

/**
 * The workbook description for one month of the archive.
 *
 * Split out from the download so the sheet can be inspected cell by cell in a
 * test — `exportTableToExcel` writes a file, this returns a value.
 */
export function buildArchiveExportOptions(params: ArchiveExportParams): ExportOptions {
  const { month, year, records, totalMinutes, totalGross, labels } = params;

  // Every numeric column declares its `type`, or `exportTableToExcel` writes it
  // as text and Excel can neither sum nor sort it — the defect #150 fixed. The
  // two money columns hold EUROS (see the header); the seven bucket columns and
  // the total hold decimal hours; `working_days` holds a count.
  const columns: ExportColumn[] = [
    { key: 'driver',         label: labels.driver,         width: 26 },
    // An identifier, never a number cell: as a number it would lose its zeros.
    { key: 'personalnummer', label: labels.personalnummer, width: 14 },
    { key: 'workingDays',    label: labels.workingDays,    width: 12, align: 'right', type: 'integer' },
    { key: 'grundlohn',      label: labels.grundlohn,      width: 15, align: 'right', type: 'number' },
    { key: 'nachtarbeit',    label: labels.nachtarbeit,    width: 15, align: 'right', type: 'number' },
    { key: 'nacht04',        label: labels.nacht04,        width: 16, align: 'right', type: 'number' },
    { key: 'samstag',        label: labels.samstag,        width: 14, align: 'right', type: 'number' },
    { key: 'sonntag',        label: labels.sonntag,        width: 14, align: 'right', type: 'number' },
    { key: 'feiertag',       label: labels.feiertag,       width: 14, align: 'right', type: 'number' },
    { key: 'weihnachten',    label: labels.weihnachten,    width: 18, align: 'right', type: 'number' },
    { key: 'totalHours',     label: labels.totalHours,     width: 15, align: 'right', type: 'number' },
    { key: 'hourlyRate',     label: labels.hourlyRate,     width: 15, align: 'right', type: 'money' },
    { key: 'gross',          label: labels.gross,          width: 16, align: 'right', type: 'money' },
    { key: 'source',         label: labels.source,         width: 16 },
    { key: 'savedAt',        label: labels.savedAt,        width: 14 },
    { key: 'updatedAt',      label: labels.updatedAt,      width: 14 },
  ];

  const rows: Record<string, unknown>[] = records.map(rec => ({
    driver:         rec.driver_name,
    personalnummer: rec.personalnummer ?? '',
    workingDays:    rec.working_days,
    grundlohn:      minsToDecimal(rec.grundlohn_min),
    nachtarbeit:    minsToDecimal(rec.nachtarbeit_min),
    nacht04:        minsToDecimal(rec.nacht04_min),
    samstag:        minsToDecimal(rec.samstag_min),
    sonntag:        minsToDecimal(rec.sonntag_min),
    feiertag:       minsToDecimal(rec.feiertag_min),
    weihnachten:    minsToDecimal(rec.weihnachten_min),
    totalHours:     minsToDecimal(totalMins(rec)),
    // A rate or a gross the record does not carry stays EMPTY. `numericCell`
    // refuses null and the text path writes '' for it, so a missing figure is
    // never a 0,00 € — the screen's "—" by another name. Do not add a `format`
    // to either column: that would put a real number back on the text path.
    hourlyRate:     rec.hourly_rate ?? null,
    gross:          rec.calculated_salary ?? null,
    source:         sourceLabel(rec.generation_source, labels),
    savedAt:        germanDate(rec.saved_at),
    updatedAt:      germanDate(rec.updated_at),
  }));

  // The totals row's first cell is its LABEL — naming `columns[0].key` here
  // THROWS since #152, because that cell can never render a figure. The count
  // sentence goes in `labels.totalsRow`, as Fahrzeuge, Fahrer and Benutzer do.
  //
  // Each bucket is summed in MINUTES and converted once, so the totals row is
  // the figure the screen's header prints. Re-summing the column inside Excel
  // can differ by up to 0,005 h per row, because a row's hours are rounded to
  // 0,01 h before they are written; the screen's figure wins, since the rule is
  // that the file must not disagree with the screen.
  const sumMinutes = (pick: (rec: ArchiveExportRecord) => number) =>
    minsToDecimal(records.reduce((sum, rec) => sum + pick(rec), 0));

  const totals: Record<string, string | number> = {
    workingDays: records.reduce((sum, rec) => sum + rec.working_days, 0),
    grundlohn:   sumMinutes(rec => rec.grundlohn_min),
    nachtarbeit: sumMinutes(rec => rec.nachtarbeit_min),
    nacht04:     sumMinutes(rec => rec.nacht04_min),
    samstag:     sumMinutes(rec => rec.samstag_min),
    sonntag:     sumMinutes(rec => rec.sonntag_min),
    feiertag:    sumMinutes(rec => rec.feiertag_min),
    weihnachten: sumMinutes(rec => rec.weihnachten_min),
    // The group's own total, not a second sum of the same minutes.
    totalHours:  minsToDecimal(totalMinutes),
  };
  // Exactly the screen's all-or-nothing rule: a month where one record has no
  // gross shows no month gross, so the sheet leaves that cell empty rather than
  // totalling only the records that happen to have one. `hourlyRate` gets no
  // total at all — a rate is not summable.
  if (totalGross != null) totals.gross = totalGross;

  return {
    // Not confusable with the statutory `Stundennachweis_<Fahrer>_<Monat>_<Jahr>.pdf`.
    filename: `stundennachweise_${year}-${String(month).padStart(2, '0')}`,
    sheetTitle: labels.sheetTitle,
    moduleName: labels.moduleName,
    columns,
    rows,
    labels: { totalsRow: labels.totalsRow },
    totals,
  };
}

/** Downloads one month of the archive. `excelExport.ts` is called, never edited. */
export function exportArchiveMonthToExcel(params: ArchiveExportParams): void {
  exportTableToExcel(buildArchiveExportOptions(params));
}
