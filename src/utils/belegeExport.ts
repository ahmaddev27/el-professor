/**
 * The Belege Excel export, as data rather than as a click.
 *
 * WHY THIS MODULE EXISTS. The screen had two export buttons — "Excel" in the
 * page header and "Zusammenfassung PDF" in the filter row — reading two
 * different row sets. The PDF got `sortedReceipts`, the list the operator was
 * looking at. Excel got a *copy* of it, lifted into BelegePage as
 * `filteredReceipts` and kept in step by an `onExportFiltered` callback that
 * ReceiptList never called, so the copy stayed whatever an effect had put there:
 * the whole company's Belege, labelled "Gefilterte Auswahl". Filter to one
 * driver for August, press Excel, get every Beleg ever entered.
 *
 * The repair is not to call the callback. It is to have one row set and one
 * description of the filter that produced it, computed where the filter lives
 * (ReceiptList) and rendered here. Both buttons now read the same binding, so
 * there is nothing left to keep in step.
 *
 * THE RULE THIS PRESERVES: a file that leaves the building states the selection
 * it holds. The filter band is the only thing in the workbook that tells the
 * reader whether the file is complete, so it names every term that narrowed the
 * list — and never claims a narrowing that did not happen.
 *
 * Pure on purpose: no React, no i18n runtime, no XLSX. The caller passes its
 * `t`, so this is testable under vitest's `environment: 'node'`, which has no
 * DOM to render a component in.
 */
import type { Receipt } from '../types/receipt';
import type { TranslationKey, TranslationVars } from '../i18n';
import type { ExportColumn, ExportOptions } from './excelExport';
import { formatDate } from '../components/ui/format';
import { toCents } from './money';
import { clockTime, textOrNull } from './receiptDisplay';

/** `useTranslation().t`, as much of it as this module needs. */
export type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

/**
 * Exactly the terms that narrowed the exported list — one field per condition
 * in ReceiptList's filter memo, so the description cannot fall behind the
 * filtering. A term added there without a field here is a filter the file does
 * not admit to.
 */
export interface ReceiptExportFilters {
  /**
   * The inclusive `YYYY-MM-DD` bounds actually applied, or null when no date
   * narrowed the list. These are the same two keys the list compares against,
   * as calendar days and not instants: the screen learned that a date-only
   * value read through `Date` is UTC midnight and drops every receipt on a
   * period's last day.
   */
  dateRange: { start: string; end: string } | null;
  /**
   * The business week **inside the selected month** — 1..5, as
   * `getBusinessWeeksForMonth` numbers them (`index + 1` over the month's
   * Mondays) — or null for all weeks. It is not an ISO calendar week, so nothing
   * here may label it `KW`. The screen cannot set this and a custom date range at
   * once: both date inputs reset `selectedWeek` to 0 and `handleWeekChange`
   * clears both dates, so a week named here was always the week applied.
   */
  week: number | null;
  /** The chosen driver's name, or '' for all drivers. */
  driver: string;
  /** The free-text search, or '' for none. */
  search: string;
}

/** No filter at all: every Beleg, every date, every driver. */
export const NO_RECEIPT_FILTERS: ReceiptExportFilters = {
  dateRange: null,
  week: null,
  driver: '',
  search: '',
};

/**
 * The filter band's lines, in reading order.
 *
 * The period and the driver are stated even when they narrow nothing, because
 * their absence is what the reader has to be able to trust: "Zeitraum: Alle"
 * and "Fahrer: Alle Fahrer" say the file is complete, where a missing line only
 * says nobody wrote one. The week and the search appear only when set — each is
 * off by default, and adding "no week" to every file would bury the two lines
 * that matter.
 */
export function describeReceiptFilters(filters: ReceiptExportFilters, t: Translate): string[] {
  const period = filters.dateRange
    ? `${formatDate(filters.dateRange.start)} – ${formatDate(filters.dateRange.end)}`
    : t('common.all');
  const lines = [`${t('common.period')}: ${period}`];
  if (filters.week !== null) lines.push(`${t('common.week')} ${filters.week}`);
  lines.push(`${t('common.driver')}: ${filters.driver || t('common.allDrivers')}`);
  if (filters.search) lines.push(`${t('common.search')}: ${filters.search}`);
  return lines;
}

/**
 * The file's own name, built from the period it holds rather than from the day
 * it was written. A folder of `belege_2026-09-24.xlsx` says when somebody
 * clicked; a folder of `belege_2026-08-17_2026-08-23_Woche3.xlsx` says what is
 * inside. The driver stays out of the name — transliterating "Müller" for a
 * filename is the summary PDF's own business, and duplicating it here would
 * give the two files two spellings — and the band inside names it.
 *
 * NOT `KW`. `KW` is *Kalenderwoche* in German, and this number is nothing of the
 * kind: `getBusinessWeeksForMonth` numbers the weeks of the selected month
 * `index + 1`, so it runs 1..5 and 3 means "the third week of this month".
 * August 2026's third week is 17.08.–23.08., whose ISO calendar week is 34 — a
 * file named `…_KW3` would name mid-January to every reader who knows what KW
 * means. `Woche` is the word the screen itself uses for this number, in the week
 * dropdown and in the active-week band, so the file and the screen agree.
 */
export function belegeExportFilename(filters: ReceiptExportFilters): string {
  const period = filters.dateRange
    ? `${filters.dateRange.start}_${filters.dateRange.end}`
    : 'alle';
  const week = filters.week !== null ? `_Woche${filters.week}` : '';
  return `belege_${period}${week}`;
}

/**
 * The rows' expenses summed in integer cents, or null when one of them is not a
 * readable amount.
 *
 * Money goes through utils/money.ts (CLAUDE.md): adding euro floats drifts, and
 * this total sits in a cell an accountant sums against. Null rather than a
 * silent 0 — the totals cell is then left empty, because an amount nobody can
 * read must not be printed as a figure.
 */
function totalExpenseCents(rows: Receipt[]): number | null {
  let cents = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.expense)) return null;
    cents += toCents(row.expense);
  }
  return cents;
}

/**
 * The columns of the dump. Per CLAUDE.md this satisfies no statutory form — it
 * is a convenience export of an operational list, not a Fahrtenbuch — so every
 * header follows the UI language.
 */
export function receiptExportColumns(t: Translate): ExportColumn[] {
  return [
    { key: 'receiptNumber', label: t('belege.number'), width: 20 },
    // formatDate reads the stored YYYY-MM-DD text directly. `new Date(iso)` is
    // UTC midnight, and toLocaleDateString('de-DE') does not pad — the column
    // used to write "1.9.2026" where the screen writes "01.09.2026".
    { key: 'date', label: t('common.date'), width: 14, format: v => (typeof v === 'string' ? formatDate(v) : '') },
    { key: 'driverName', label: t('common.driver'), width: 22 },
    { key: 'description', label: t('common.description'), width: 40 },
    // The Beleg's own details, one column each as on the screen. A figure the
    // Beleg does not carry is an empty cell, never 0 (see types/receipt.ts).
    { key: 'merchantName', label: t('rec.merchant'), width: 22 },
    { key: 'city', label: t('rec.place'), width: 18 },
    { key: 'receiptTime', label: t('common.time'), width: 10 },
    { key: 'litres', label: t('rec.litres'), width: 10, align: 'right', type: 'number' },
    { key: 'pricePerLitre', label: t('rec.pricePerLitre'), width: 14, align: 'right', type: 'number3' },
    { key: 'odometerKm', label: t('rec.odometer'), width: 16, align: 'right', type: 'kilometres' },
    { key: 'rangeKm', label: t('rec.rangeLeft'), width: 16, align: 'right', type: 'kilometres' },
    {
      key: 'paymentMethod', label: t('belege.paymentMethod'), width: 16,
      format: v => (v === 'uberweisung' ? t('belege.transfer') : t('belege.cash')),
    },
    // Euros, not cents: receipts.expense is numeric(10,2) and ReceiptModal
    // stores Math.round(amount * 100) / 100, a euro amount. So the raw value
    // goes into a 'money' cell unchanged — dividing by 100 here would print
    // every Beleg at a hundredth of what it cost, which reads entirely
    // plausibly. `type` and `format` are exclusive: a formatted string is a
    // text cell and Excel cannot sum it (PR #150).
    { key: 'expense', label: t('belege.amount'), width: 16, align: 'right', type: 'money' },
  ];
}

/**
 * Everything `exportTableToExcel` needs for one Belege file. Returned rather
 * than written so a test can inspect the workbook cell by cell without a
 * filesystem or a DOM.
 */
export function buildBelegeExportOptions(
  rows: Receipt[],
  filters: ReceiptExportFilters,
  t: Translate,
): ExportOptions {
  const cents = totalExpenseCents(rows);
  return {
    filename: belegeExportFilename(filters),
    sheetTitle: t('belege.title'),
    moduleName: t('belege.title'),
    filterSummary: describeReceiptFilters(filters, t),
    columns: receiptExportColumns(t),
    // Built key by key rather than cast from Receipt: a cast makes a column key
    // the database does not have compile, which is how the Fahrer export came to
    // have a permanently blank "Erstellt am".
    rows: rows.map(r => ({
      receiptNumber: r.receiptNumber,
      date: r.date,
      driverName: r.driverName,
      description: r.description,
      merchantName: textOrNull(r.merchantName),
      city: textOrNull(r.city),
      receiptTime: clockTime(r.receiptTime),
      litres: r.litres ?? null,
      pricePerLitre: r.pricePerLitre ?? null,
      odometerKm: r.odometerKm ?? null,
      rangeKm: r.rangeKm ?? null,
      paymentMethod: r.paymentMethod ?? 'bar',
      expense: r.expense,
    })),
    // A number, so the totals cell is a number in the column's money format and
    // sums with the rows above it. cents / 100 is the exact euro value of an
    // integer cent count; the empty string is the unreadable case above.
    totals: { expense: cents === null ? '' : cents / 100 },
  };
}
