/**
 * The workbooks that are a SET of tables, drawn by the styled exporter.
 *
 * ## Why this module exists
 *
 * Umsätze, Gehälter and Notizen each export several related tables in one file,
 * and all three built them with `XLSX.utils.json_to_sheet` or `aoa_to_sheet` on
 * the community `xlsx` build. That build discards every style on write — the
 * header of `excelExport.ts` measures it: one hard-coded font, two fills and one
 * empty border for the whole file — so the fills and bold headers those
 * functions described drew **nothing**, and every figure was written as a STRING
 * by `.toFixed(2)`, so Excel could not sum a column of money. That is what the
 * owner reported on 01.10.2026.
 *
 * Each builder here returns one `ExportOptions` per sheet, which
 * `exportSheetsToExcel` draws through `exceljs` exactly as every other list in
 * the product is drawn: title band, meta row, column headers, banded rows,
 * borders, German number formats, a totals row, a freeze pane and an autofilter.
 *
 * ## What is deliberately unchanged
 *
 * **The wording.** Umsätze and Gehälter were German whatever the UI language
 * was, and both functions carried a note saying translating them is a separate
 * change. It still is: every label below is the string the old sheet wrote, so
 * the only difference in a German file is that it is drawn and its numbers are
 * numbers. Notizen was already translated at its call site and keeps passing its
 * labels in.
 *
 * **Every figure.** A money column holds the euro amount as a number and the
 * cell format displays it; nothing is rounded here that was not rounded before,
 * and no total is computed that the old sheet did not already print.
 *
 * ## The two traps in this file
 *
 * - A `percent` column multiplies by 100 on display, so it must hold the
 *   FRACTION. The old sheets wrote `'41.5%'` as text; these hold `0.415`.
 * - Column 0 of a totals row is that row's label and `buildTableWorkbook`
 *   **throws** when `totals` names it. So the first column of every sheet below
 *   is a name, a metric or a date — never a figure.
 */
import type { ExportColumn, ExportOptions } from './excelExport';
import type { Income, SalaryCalculation } from '../types/receipt';
import { salaryDueState } from './salaryDue';

type ExportRow = Record<string, unknown>;

/**
 * `DD.MM.YYYY`, the only date order this product writes (never US order).
 *
 * Built from the local calendar fields rather than `toLocaleDateString('de-DE')`,
 * which is what the old sheets called: that returns `1.9.2026` on a Node build
 * without full ICU and `01.09.2026` in a browser, so the same code produced two
 * different filenames and two different Datum columns depending on where it ran.
 * Local fields, not UTC ones, because that is the day the old call printed.
 */
function germanDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(parsed.getDate())}.${pad(parsed.getMonth() + 1)}.${parsed.getFullYear()}`;
}

/**
 * A share as the fraction a `percent` column needs.
 *
 * 0 rather than NaN for an empty total: a blank cell in a share column reads as
 * missing data, and a share of nothing is 0 %.
 */
function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// Umsätze
// ═════════════════════════════════════════════════════════════════════════════

const INCOME_TYPE_LABEL: Record<Income['type'], string> = {
  bargeld:   'Bargeld',
  umsatz:    'Umsatz',
  aktionen:  'Aktionen',
  trinkgeld: 'Trinkgeld',
};

const INCOME_TYPES: Income['type'][] = ['bargeld', 'umsatz', 'aktionen', 'trinkgeld'];

export function buildIncomeSheets(
  incomes: Income[],
  fromDate?: string,
  toDate?: string,
): ExportOptions[] {
  const amountOf = (income: Income) => Number(income.amount);
  const sumOf = (list: Income[]) => list.reduce((sum, income) => sum + amountOf(income), 0);

  const total = sumOf(incomes);
  const period = fromDate && toDate
    ? `Zeitraum: ${germanDate(fromDate)} bis ${germanDate(toDate)}`
    : 'Zeitraum: Alle Einträge';

  // ── Sheet 1: every entry, oldest first, as the old detail section was ──────
  const sorted = [...incomes].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const entries: ExportOptions = {
    filename: 'umsaetze',
    sheetTitle: 'Umsätze',
    moduleName: 'Einträge',
    filterSummary: [period],
    columns: [
      { key: 'date',        label: 'Datum',        width: 14 },
      { key: 'driver',      label: 'Fahrer',       width: 26 },
      { key: 'type',        label: 'Typ',          width: 14 },
      { key: 'description', label: 'Beschreibung', width: 38 },
      { key: 'amount',      label: 'Betrag',       width: 16, align: 'right', type: 'money' },
    ],
    rows: sorted.map((income): ExportRow => ({
      date: germanDate(income.date),
      driver: income.driver_name,
      type: INCOME_TYPE_LABEL[income.type],
      description: income.description,
      amount: amountOf(income),
    })),
    // The uuid column the old sheet wrote last is gone: it is not a figure, not a
    // label and not readable, and it was the widest column in the file.
    totals: { amount: total },
  };

  // ── Sheet 2: by type, with each type's share of the period ────────────────
  const byType: ExportOptions = {
    filename: 'umsaetze',
    sheetTitle: 'Umsätze',
    moduleName: 'Nach Typ',
    filterSummary: [period],
    columns: [
      { key: 'type',   label: 'Typ',    width: 20 },
      { key: 'amount', label: 'Betrag', width: 16, align: 'right', type: 'money' },
      { key: 'quota',  label: 'Anteil', width: 12, align: 'right', type: 'percent' },
    ],
    rows: INCOME_TYPES.map((type): ExportRow => {
      const sum = sumOf(incomes.filter(income => income.type === type));
      return { type: INCOME_TYPE_LABEL[type], amount: sum, quota: share(sum, total) };
    }),
    totals: { amount: total, quota: total > 0 ? 1 : 0 },
  };

  // ── Sheet 3: by driver, one row each, the four types side by side ──────────
  const drivers = [...new Set(incomes.map(income => income.driver_name))]
    .sort((a, b) => a.localeCompare(b, 'de'));

  const typeColumns: ExportColumn[] = INCOME_TYPES.map(type => ({
    key: type,
    label: INCOME_TYPE_LABEL[type],
    width: 15,
    align: 'right',
    type: 'money',
  }));

  const byDriver: ExportOptions = {
    filename: 'umsaetze',
    sheetTitle: 'Umsätze',
    moduleName: 'Nach Fahrer',
    filterSummary: [period],
    columns: [
      { key: 'driver', label: 'Fahrer', width: 26 },
      { key: 'count',  label: 'Anzahl', width: 10, align: 'right', type: 'integer' },
      ...typeColumns,
      { key: 'total',  label: 'Gesamt', width: 16, align: 'right', type: 'money' },
    ],
    rows: drivers.map((name): ExportRow => {
      const mine = incomes.filter(income => income.driver_name === name);
      const row: ExportRow = { driver: name, count: mine.length, total: sumOf(mine) };
      for (const type of INCOME_TYPES) {
        row[type] = sumOf(mine.filter(income => income.type === type));
      }
      return row;
    }),
    totals: {
      count: incomes.length,
      ...Object.fromEntries(
        INCOME_TYPES.map(type => [
          type,
          sumOf(incomes.filter(income => income.type === type)),
        ]),
      ),
      total,
    },
  };

  return [entries, byType, byDriver];
}

// ═════════════════════════════════════════════════════════════════════════════
// Gehälter
// ═════════════════════════════════════════════════════════════════════════════

const SALARY_STATUS_LABEL: Record<'paid' | 'partially_paid' | 'unpaid', string> = {
  paid:           'Bezahlt',
  partially_paid: 'Teilweise bezahlt',
  unpaid:         'Unbezahlt',
};

/**
 * ── THE RULE THIS BUILDER PRESERVES ──────────────────────────────────────────
 * **Due is `COALESCE(netto_salary, amount_due)`, and paid is derived from the
 * payments — never from the stored status word.**
 *
 * Both quantities come from `utils/salaryDue.ts`, the module `SalariesManagement`
 * imports, exactly as the old sheet did. Never inline either of them here: a
 * second copy of a payroll rule is how the screen and the file drifted apart
 * once already, and what this prints reaches a person's pay.
 */
export function buildSalarySheets(
  salaries: SalaryCalculation[],
  periodStart: string,
  periodEnd: string,
): ExportOptions[] {
  const priced = salaries.map(salary => ({
    salary,
    due: salaryDueState(salary, salary.total_paid),
  }));

  const totalRevenue      = salaries.reduce((sum, s) => sum + s.revenue, 0);
  const totalTips         = salaries.reduce((sum, s) => sum + s.tips, 0);
  const totalRevenueShare = salaries.reduce((sum, s) => sum + s.revenue_share, 0);
  const totalDue          = priced.reduce((sum, p) => sum + p.due.base, 0);
  const countOf = (status: keyof typeof SALARY_STATUS_LABEL) =>
    priced.filter(p => p.due.paymentStatus === status).length;

  const period = periodStart === periodEnd
    ? `Zeitraum: ${germanDate(periodStart)}`
    : `Zeitraum: ${germanDate(periodStart)} bis ${germanDate(periodEnd)}`;

  // ── Sheet 1: the four figures and the three derived counts ────────────────
  //
  // Two value columns, not one: a count and a euro amount cannot share a number
  // format, and the old sheet wrote both as text in one column so neither could
  // be summed. No totals row — adding four unrelated metrics means nothing.
  const summary: ExportOptions = {
    filename: 'gehaelter',
    sheetTitle: 'Gehaltsabrechnung',
    moduleName: 'Zusammenfassung',
    filterSummary: [period],
    columns: [
      { key: 'metric', label: 'Metrik', width: 28 },
      { key: 'amount', label: 'Betrag', width: 16, align: 'right', type: 'money' },
      { key: 'count',  label: 'Anzahl', width: 12, align: 'right', type: 'integer' },
    ],
    rows: [
      { metric: 'Gesamt Umsatz',       amount: totalRevenue },
      { metric: 'Gesamt Trinkgeld',    amount: totalTips },
      { metric: 'Gesamt Umsatzanteil', amount: totalRevenueShare },
      { metric: 'Gesamt Fällig',       amount: totalDue },
      { metric: 'Anzahl Fahrer',                    count: salaries.length },
      { metric: SALARY_STATUS_LABEL.paid,           count: countOf('paid') },
      { metric: SALARY_STATUS_LABEL.partially_paid, count: countOf('partially_paid') },
      { metric: SALARY_STATUS_LABEL.unpaid,         count: countOf('unpaid') },
    ],
  };

  // ── Sheet 2: one row per driver ───────────────────────────────────────────
  const perDriver: ExportOptions = {
    filename: 'gehaelter',
    sheetTitle: 'Gehaltsabrechnung',
    moduleName: 'Pro Fahrer',
    filterSummary: [period],
    columns: [
      { key: 'driver',  label: 'Fahrer',          width: 26 },
      { key: 'revenue', label: 'Umsatz',          width: 16, align: 'right', type: 'money' },
      { key: 'ratio',   label: 'Anteil',          width: 11, align: 'right', type: 'percent' },
      { key: 'share',   label: 'Umsatzanteil',    width: 17, align: 'right', type: 'money' },
      { key: 'tips',    label: 'Trinkgeld',       width: 15, align: 'right', type: 'money' },
      { key: 'due',     label: 'Fälliger Betrag', width: 18, align: 'right', type: 'money' },
      { key: 'status',  label: 'Status',          width: 18 },
    ],
    rows: priced.map(({ salary, due }): ExportRow => ({
      driver: salary.driver_name,
      revenue: salary.revenue,
      // `salary_ratio` is already a fraction (0.4 for 40 %), which is exactly what
      // a `percent` column holds. The old sheet multiplied it by 100 and appended
      // a '%' as text; the figure is the same one.
      ratio: salary.salary_ratio,
      share: salary.revenue_share,
      tips: salary.tips,
      due: due.base,
      status: SALARY_STATUS_LABEL[due.paymentStatus],
    })),
    // `ratio` carries no total: averaging percentages across drivers is a figure
    // the screen never showed, and the old sheet left that cell blank too.
    totals: {
      revenue: totalRevenue,
      share: totalRevenueShare,
      tips: totalTips,
      due: totalDue,
    },
  };

  return [summary, perDriver];
}

/** `salaries_01-10-2026` / `salaries_01-10-2026_to_31-10-2026`, as before. */
export function salaryExportFilename(periodStart: string, periodEnd: string): string {
  const slug = (value: string) => germanDate(value).replace(/\./g, '-');
  return periodStart === periodEnd
    ? `salaries_${slug(periodStart)}`
    : `salaries_${slug(periodStart)}_to_${slug(periodEnd)}`;
}
