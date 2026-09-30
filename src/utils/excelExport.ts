/**
 * TWO LIBRARIES LIVE HERE, AND THAT SPLIT IS THE DESIGN — NOT AN ACCIDENT.
 *
 * `xlsx@0.20.3` (the community build) discards every cell style on write:
 * `get_cell_style` reads exactly one property, `cell.z`, and writes `fontId:0,
 * fillId:0, borderId:0`, while `write_sty_xml` emits one hard-coded font, two
 * fills and one empty border for the whole file. `ws['!freeze']` is not a key
 * the library reads at all — its `write_ws_xml_sheetviews` emits no `<pane>`.
 * So the design the generic table exporter below describes drew NOTHING: those
 * files came out plain, however many fills and borders were named.
 *
 * `exportTableToExcel` therefore writes through `exceljs` now, from
 * `./styledWorkbookDownload` — the operational lists a person reads, sorts and
 * filters. Everything else in this file STAYS on `xlsx`, deliberately:
 * `exportIncomeToExcel` and `exportSalariesToExcel` here, and
 * `fahrtenbuchExport.ts` / `historicalWorkingHoursFahrtenbuchExport.ts`, whose
 * `'original'` mode must reproduce an imported sheet's headers byte for byte and
 * whose output is a statutory record an accountant reconciles against.
 *
 * Do not "unify" them. One library reproduces a prescribed sheet exactly; the
 * other paints a readable one.
 *
 * `buildTableWorkbook` is unchanged by that swap and still returns an
 * `XLSX.WorkBook`: it is the description of the file — values, `z` formats, `s`
 * styles and the `!` sheet settings — which the new writer translates. Keeping
 * it is what keeps the number formats, the `asFiniteNumber` rule and the
 * column-0 totals guard the exact code they were, still asserted cell by cell.
 */
import * as XLSX from 'xlsx';
import { downloadStyledWorkbook } from './styledWorkbookDownload';
import { Income, SalaryCalculation } from '../types/receipt';
// `salaryDueState` is `salaryBase` — COALESCE(netto_salary, amount_due) — plus
// the payment derivation, from the module SalariesManagement imports. Both
// quantities this export prints come from there and are never spelled here.
import { salaryDueState } from './salaryDue';

export const exportIncomeToExcel = (incomes: Income[], fromDate?: string, toDate?: string) => {
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: "El-Professor - Umsätze Report",
    Subject: "Income and Revenue Analysis",
    Author: "El-Professor Management System",
    CreatedDate: new Date()
  };

  const sortedIncomes = [...incomes].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const totalAmount = incomes.reduce((sum, income) => sum + Number(income.amount), 0);
  const byType = {
    bargeld: incomes.filter(i => i.type === 'bargeld').reduce((sum, i) => sum + Number(i.amount), 0),
    umsatz: incomes.filter(i => i.type === 'umsatz').reduce((sum, i) => sum + Number(i.amount), 0),
    aktionen: incomes.filter(i => i.type === 'aktionen').reduce((sum, i) => sum + Number(i.amount), 0),
    trinkgeld: incomes.filter(i => i.type === 'trinkgeld').reduce((sum, i) => sum + Number(i.amount), 0)
  };

  const drivers = [...new Set(incomes.map(i => i.driver_name))];
  const byDriver = drivers.map(driver => {
    const driverIncomes = incomes.filter(i => i.driver_name === driver);
    return {
      name: driver,
      count: driverIncomes.length,
      bargeld: driverIncomes.filter(i => i.type === 'bargeld').reduce((sum, i) => sum + Number(i.amount), 0),
      umsatz: driverIncomes.filter(i => i.type === 'umsatz').reduce((sum, i) => sum + Number(i.amount), 0),
      aktionen: driverIncomes.filter(i => i.type === 'aktionen').reduce((sum, i) => sum + Number(i.amount), 0),
      trinkgeld: driverIncomes.filter(i => i.type === 'trinkgeld').reduce((sum, i) => sum + Number(i.amount), 0),
      total: driverIncomes.reduce((sum, i) => sum + Number(i.amount), 0)
    };
  });

  const excelData = [
    ['EL-PROFESSOR - UMSÄTZE BERICHT', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Zeitraum', fromDate && toDate ? `${fromDate} bis ${toDate}` : 'Alle Einträge', '', '', '', ''],
    ['Erstellt am', new Date().toLocaleString('de-DE'), '', '', '', ''],
    ['Gesamtanzahl', incomes.length.toString(), '', '', '', ''],
    ['', '', '', '', '', ''],

    ['ZUSAMMENFASSUNG NACH TYP', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Typ', 'Betrag (€)', 'Anteil', '', '', '', ''],
    ['Bargeld', byType.bargeld.toFixed(2), totalAmount > 0 ? ((byType.bargeld / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['Umsatz', byType.umsatz.toFixed(2), totalAmount > 0 ? ((byType.umsatz / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['Aktionen', byType.aktionen.toFixed(2), totalAmount > 0 ? ((byType.aktionen / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['Trinkgeld', byType.trinkgeld.toFixed(2), totalAmount > 0 ? ((byType.trinkgeld / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['GESAMT', totalAmount.toFixed(2), '100%', '', '', '', ''],
    ['', '', '', '', '', '', ''],

    ['ZUSAMMENFASSUNG NACH FAHRER', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Fahrer', 'Anzahl', 'Bargeld (€)', 'Umsatz (€)', 'Aktionen (€)', 'Trinkgeld (€)', 'Gesamt (€)'],
    ...byDriver.map(d => [
      d.name,
      d.count.toString(),
      d.bargeld.toFixed(2),
      d.umsatz.toFixed(2),
      d.aktionen.toFixed(2),
      d.trinkgeld.toFixed(2),
      d.total.toFixed(2)
    ]),
    ['', '', '', '', '', ''],

    ['DETAILLIERTE EINTRÄGE', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Datum', 'Fahrer', 'Typ', 'Beschreibung', 'Betrag (€)', 'ID', ''],
    ...sortedIncomes.map(income => [
      new Date(income.date).toLocaleDateString('de-DE'),
      income.driver_name,
      income.type === 'bargeld' ? 'Bargeld' :
      income.type === 'umsatz' ? 'Umsatz' :
      income.type === 'aktionen' ? 'Aktionen' : 'Trinkgeld',
      income.description,
      Number(income.amount).toFixed(2),
      income.id,
      ''
    ])
  ];

  const ws = XLSX.utils.aoa_to_sheet(excelData);

  ws['!cols'] = [
    { wch: 20 },
    { wch: 15 },
    { wch: 15 },
    { wch: 30 },
    { wch: 15 },
    { wch: 36 },
    { wch: 15 }
  ];

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell_address = XLSX.utils.encode_cell({ c: C, r: R });
      if (!ws[cell_address]) continue;

      const cellValue = ws[cell_address].v;

      if (R === 0) {
        ws[cell_address].s = {
          font: { bold: true, size: 18, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "059669" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }

      if (cellValue && typeof cellValue === 'string' &&
          (cellValue.includes('ZUSAMMENFASSUNG') || cellValue.includes('DETAILLIERTE'))) {
        ws[cell_address].s = {
          font: { bold: true, size: 14, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "10B981" } },
          border: {
            top: { style: "medium", color: { rgb: "000000" } },
            bottom: { style: "medium", color: { rgb: "000000" } },
            left: { style: "medium", color: { rgb: "000000" } },
            right: { style: "medium", color: { rgb: "000000" } }
          }
        };
      }
    }
  }

  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
    { s: { r: 6, c: 0 }, e: { r: 6, c: 5 } },
    { s: { r: 14, c: 0 }, e: { r: 14, c: 5 } },
    { s: { r: 20, c: 0 }, e: { r: 20, c: 5 } }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Umsätze');

  const filename = `umsaetze_${fromDate || 'all'}_to_${toDate || new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, filename);
};

export const exportSalariesToExcel = (salaries: SalaryCalculation[], periodStart: string, periodEnd: string) => {
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: "El-Professor - Gehaltsabrechnung",
    Subject: "Salary Report",
    Author: "El-Professor Management System",
    CreatedDate: new Date()
  };

  /**
   * ── THE RULE THIS FUNCTION PRESERVES ─────────────────────────────────────
   * **Due is `COALESCE(netto_salary, amount_due)`, and paid is derived from the
   * payments — never from the stored status word.**
   *
   * It is the rule `confirm_salary_cash_payment` applies when it decides how
   * much cash a driver may be handed, and since 28.09.2026 the rule
   * `SalariesManagement` applies on screen. This export was the last reader of
   * the two quantities that correction discarded — `amount_due` on its own and
   * `salaries.status` — so the Gehälter screen and the Gehälter file printed
   * different numbers for the same month, and the file printed the ones the
   * screen had stopped trusting.
   *
   * Both quantities therefore come from `utils/salaryDue.ts`, the same module
   * the screen imports. Never inline either of them here: a second copy of a
   * payroll rule is exactly how the screen and the file drifted apart, and what
   * this file prints reaches a person's pay.
   */
  const priced = salaries.map(salary => ({ salary, due: salaryDueState(salary, salary.total_paid) }));

  const totalRevenue = salaries.reduce((sum, s) => sum + s.revenue, 0);
  const totalTips = salaries.reduce((sum, s) => sum + s.tips, 0);
  const totalRevenueShare = salaries.reduce((sum, s) => sum + s.revenue_share, 0);
  const totalDue = priced.reduce((sum, p) => sum + p.due.base, 0);
  const paidCount = priced.filter(p => p.due.paymentStatus === 'paid').length;
  const partiallyPaidCount = priced.filter(p => p.due.paymentStatus === 'partially_paid').length;
  const unpaidCount = priced.filter(p => p.due.paymentStatus === 'unpaid').length;

  // A derived status has three values where the stored word had two, so the
  // summary carries all three and the three counts still sum to the driver
  // count. The wording of this dump is German throughout, as it always has
  // been; it is not one of the statutory documents, so translating it is a
  // separate change and not this one.
  const STATUS_LABEL: Record<'paid' | 'partially_paid' | 'unpaid', string> = {
    paid:           'Bezahlt',
    partially_paid: 'Teilweise bezahlt',
    unpaid:         'Unbezahlt',
  };

  const SUMMARY_SECTION = 'ZUSAMMENFASSUNG';
  const DRIVER_SECTION  = 'GEHALTSÜBERSICHT PRO FAHRER';

  const excelData = [
    ['EL-PROFESSOR - GEHALTSABRECHNUNG', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Zeitraum', `${new Date(periodStart).toLocaleDateString('de-DE')} bis ${new Date(periodEnd).toLocaleDateString('de-DE')}`, '', '', '', '', ''],
    ['Erstellt am', new Date().toLocaleString('de-DE'), '', '', '', '', ''],
    ['Anzahl Fahrer', salaries.length.toString(), '', '', '', '', ''],
    ['', '', '', '', '', '', ''],

    [SUMMARY_SECTION, '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Metrik', 'Betrag (€)', 'Status', '', '', '', ''],
    ['Gesamt Umsatz', totalRevenue.toFixed(2), '', '', '', '', ''],
    ['Gesamt Trinkgeld', totalTips.toFixed(2), '', '', '', '', ''],
    ['Gesamt Umsatzanteil', totalRevenueShare.toFixed(2), '', '', '', '', ''],
    ['Gesamt Fällig', totalDue.toFixed(2), '', '', '', '', ''],
    [STATUS_LABEL.paid, paidCount.toString(), '', '', '', '', ''],
    [STATUS_LABEL.partially_paid, partiallyPaidCount.toString(), '', '', '', '', ''],
    [STATUS_LABEL.unpaid, unpaidCount.toString(), '', '', '', '', ''],
    ['', '', '', '', '', '', ''],

    [DRIVER_SECTION, '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Fahrer', 'Umsatz (€)', 'Anteil (%)', 'Umsatzanteil (€)', 'Trinkgeld (€)', 'Fälliger Betrag (€)', 'Status'],
    // `due.base`, not `amount_due`: a manual netto adjustment wins over the
    // calculated amount. `due.paymentStatus`, not `salary.status`: the stored
    // word was computed against whatever the base was when the last payment was
    // entered, and the screen recomputes the base from the period's income rows
    // on every load.
    ...priced.map(({ salary, due }) => [
      salary.driver_name,
      salary.revenue.toFixed(2),
      (salary.salary_ratio * 100).toFixed(1) + '%',
      salary.revenue_share.toFixed(2),
      salary.tips.toFixed(2),
      due.base.toFixed(2),
      STATUS_LABEL[due.paymentStatus]
    ]),
    ['', '', '', '', '', '', ''],
    ['GESAMT', totalRevenue.toFixed(2), '', totalRevenueShare.toFixed(2), totalTips.toFixed(2), totalDue.toFixed(2), '']
  ];

  const ws = XLSX.utils.aoa_to_sheet(excelData);

  ws['!cols'] = [
    { wch: 25 },
    { wch: 15 },
    { wch: 15 },
    { wch: 18 },
    { wch: 15 },
    { wch: 18 },
    { wch: 12 }
  ];

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell_address = XLSX.utils.encode_cell({ c: C, r: R });
      if (!ws[cell_address]) continue;

      const cellValue = ws[cell_address].v;

      if (R === 0) {
        ws[cell_address].s = {
          font: { bold: true, size: 18, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "3B82F6" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }

      if (cellValue && typeof cellValue === 'string' &&
          (cellValue.includes('ZUSAMMENFASSUNG') || cellValue.includes('GEHALTSÜBERSICHT'))) {
        ws[cell_address].s = {
          font: { bold: true, size: 14, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "60A5FA" } },
          border: {
            top: { style: "medium", color: { rgb: "000000" } },
            bottom: { style: "medium", color: { rgb: "000000" } },
            left: { style: "medium", color: { rgb: "000000" } },
            right: { style: "medium", color: { rgb: "000000" } }
          }
        };
      }

      if (cellValue === 'GESAMT') {
        ws[cell_address].s = {
          font: { bold: true, size: 12, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "left", vertical: "center" },
          fill: { fgColor: { rgb: "1E40AF" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }
    }
  }

  // The two section bands are found by their own text rather than counted by
  // hand. The literals were 6 and 17: 6 was right, 17 was the blank row BELOW
  // the driver band, so the driver section title has never been merged and an
  // empty row was. Deriving them also keeps the summary's new third count line
  // from silently shifting the band it merges.
  const bandRow = (title: string) => excelData.findIndex(row => row[0] === title);
  const summaryRow = bandRow(SUMMARY_SECTION);
  const driverRow  = bandRow(DRIVER_SECTION);

  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    ...(summaryRow >= 0 ? [{ s: { r: summaryRow, c: 0 }, e: { r: summaryRow, c: 6 } }] : []),
    ...(driverRow  >= 0 ? [{ s: { r: driverRow,  c: 0 }, e: { r: driverRow,  c: 6 } }] : []),
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Gehälter');

  const periodLabel = periodStart === periodEnd ?
    new Date(periodStart).toLocaleDateString('de-DE').replace(/\./g, '-') :
    `${new Date(periodStart).toLocaleDateString('de-DE').replace(/\./g, '-')}_to_${new Date(periodEnd).toLocaleDateString('de-DE').replace(/\./g, '-')}`;

  const filename = `salaries_${periodLabel}.xlsx`;
  XLSX.writeFile(wb, filename);
};

// ─── Generic reusable table export ────────────────────────────────────────────

export type ExportColumnType = 'text' | 'number' | 'integer' | 'money' | 'percent' | 'kilometres';

export interface ExportColumn {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  /**
   * The display of a TEXT column. A numeric column is displayed by its number
   * format instead, so `format` is ignored there — pass one or the other, never
   * both, or the cell reads as text again by accident.
   */
  format?: (value: unknown) => string;
  /**
   * Write the cell as a typed value with a German display format, so Excel can
   * sum, sort and compute with it. Default: 'text'.
   *
   * THE INVARIANT: a column that does not opt in renders byte-identically to
   * before this existed — same `t`, same `v`, no `z` key at all.
   */
  type?: ExportColumnType;
}

/**
 * The chrome `exportTableToExcel` writes around the caller's own columns.
 *
 * This dump satisfies no statutory form — it is a convenience export of an
 * operational list — so its wording follows the UI language, unlike the
 * Fahrtenbuch XLSX and the Stundennachweis PDF, whose German is prescribed.
 * The module stays pure: a screen passes its own translated labels, and the
 * German defaults below keep every existing caller byte-identical.
 */
export interface ExportChromeLabels {
  /** Printed in the first cell when there are no rows. */
  emptyState: string;
  /** Prefix of the filter line; the summary follows it. */
  activeFilters: string;
  /** Label of the totals row; `{count}` is the number of rows. */
  totalsRow: string;
  /** Footer line; `{count}` is the number of rows. */
  footer: string;
}

export const DEFAULT_EXPORT_CHROME: ExportChromeLabels = {
  emptyState:    'Keine Daten vorhanden',
  activeFilters: 'Aktive Filter:',
  totalsRow:     'Gesamt  ({count} Einträge)',
  footer:        'El-Professor Verwaltungssystem  —  {count} Datensätze exportiert',
};

function chromeText(template: string, count: number): string {
  return template.replace('{count}', String(count));
}

export interface ExportOptions {
  filename: string;
  sheetTitle: string;
  moduleName: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  filterSummary?: string[];
  /**
   * The totals row's figures, by column key. A number is written as a number
   * cell in its column's format; a string as text.
   *
   * THE CONTRACT: the row's FIRST cell is its label and carries no figure, so
   * naming `columns[0].key` here throws — that wording goes in
   * `labels.totalsRow`. Pass `{}` for a totals row that carries only its label.
   */
  totals?: Record<string, string | number>;
  /** Defaults to the German wording this export has always had. */
  labels?: Partial<ExportChromeLabels>;
}

// ─── Design tokens ────────────────────────────────────────────────────────────
// Slate-900 header, slate-700 subheader, sky-700 column header, clean grids
const T = {
  TITLE_BG:     '0F2337',  // very dark navy — report header band
  TITLE_FG:     'FFFFFF',
  META_BG:      '1C3A52',  // slightly lighter navy — meta row
  META_FG:      'B8D4E8',  // muted sky text
  FILTER_BG:    'F1F5F9',  // near-white slate
  FILTER_FG:    '475569',  // slate-600
  FILTER_BORDER:'CBD5E1',  // slate-300
  COL_HEAD_BG:  '1D5F8A',  // sky-800 — column header
  COL_HEAD_FG:  'FFFFFF',
  COL_HEAD_BTM: '0F4C75',  // darker bottom accent line
  ROW_EVEN_BG:  'F7F9FC',  // very subtle off-white
  ROW_ODD_BG:   'FFFFFF',
  ROW_BORDER:   'DDE3EA',  // soft grid lines
  ROW_BORDER_V: 'DDE3EA',
  TOTAL_BG:     'E3EEF7',  // light sky tint
  TOTAL_FG:     '0F2337',
  TOTAL_ACCENT: '1D5F8A',  // top border accent
  FOOTER_BG:    'F1F5F9',
  FOOTER_FG:    '94A3B8',  // slate-400
  FOOTER_LINE:  'CBD5E1',
} as const;

// ─── Number formats ───────────────────────────────────────────────────────────
// An xlsx number format is stored in EN-US convention and Excel renders it with
// the viewer's locale. So German 1.234,56 is written '#,##0.00' — NOT
// '#.##0,00', which would produce a file that looks right to nobody.
//
// 'percent' multiplies by 100 on display, so a column using it must hold the
// FRACTION (0.4147 for 41,47 %). A column whose raw value is already multiplied
// uses 'number' and keeps the % in its label.
//
// 'kilometres' is an integer with its unit in the cell's format rather than in
// the value, which is what keeps an odometer reading summable and sortable while
// it still reads as "123.456 km". The unit symbol is the same word in German and
// English, so it carries no language and stays out of the dictionaries.
const NUMBER_FORMATS: Record<Exclude<ExportColumnType, 'text'>, string> = {
  number:     '#,##0.00',
  integer:    '#,##0',
  money:      '#,##0.00\\ "€"',
  percent:    '0.0%',
  kilometres: '#,##0\\ "km"',
} as const;

// ─── Style helpers ────────────────────────────────────────────────────────────

function gridBorder() {
  return {
    top:    { style: 'thin',   color: { rgb: T.ROW_BORDER } },
    bottom: { style: 'thin',   color: { rgb: T.ROW_BORDER } },
    left:   { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
    right:  { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
  };
}

function outerBorder(color = T.COL_HEAD_BG) {
  return {
    top:    { style: 'medium', color: { rgb: color } },
    bottom: { style: 'medium', color: { rgb: color } },
    left:   { style: 'medium', color: { rgb: color } },
    right:  { style: 'medium', color: { rgb: color } },
  };
}

function cell(
  ws: XLSX.WorkSheet,
  r: number,
  c: number,
  value: string | number,
  style: object,
  numberFormat?: string,
) {
  const addr = XLSX.utils.encode_cell({ r, c });
  ws[addr] = { t: typeof value === 'number' ? 'n' : 's', v: value, s: style };
  // Set only for a column that opted in, so every other cell keeps exactly the
  // three keys it has always had.
  if (numberFormat) ws[addr].z = numberFormat;
}

/**
 * The finite number a raw value stands for, or null when it stands for none.
 *
 * Null is never coerced to 0: a 0,00 € where the datum is missing is a wrong
 * figure, and this product's figures reconcile against an accountant's. The
 * caller falls back to the text path instead.
 */
function asFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    // Number('   ') is 0, so an all-whitespace string must be refused by hand.
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The number cell a column asks for, or null to leave the value on the text path
 * — because the column did not opt in, or because its value cannot be read.
 * Returns an object rather than a number so that a legitimate 0 stays truthy.
 */
function numericCell(col: ExportColumn, raw: unknown): { value: number; z: string } | null {
  if (!col.type || col.type === 'text') return null;
  const value = asFiniteNumber(raw);
  if (value === null) return null;
  return { value, z: NUMBER_FORMATS[col.type] };
}

function blank(ws: XLSX.WorkSheet, r: number, numCols: number, bg = 'FFFFFF') {
  for (let c = 0; c < numCols; c++) {
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = { t: 's', v: '', s: { fill: { fgColor: { rgb: bg } } } };
  }
}

// ─── Main export function ─────────────────────────────────────────────────────

/**
 * Builds the workbook `exportTableToExcel` writes. Split out so the sheet can be
 * inspected cell by cell in a test without touching the filesystem —
 * `XLSX.writeFile` is the only part that does.
 */
export function buildTableWorkbook(opts: ExportOptions): XLSX.WorkBook {
  const { sheetTitle, moduleName, columns, rows, filterSummary = [], totals } = opts;
  const labels: ExportChromeLabels = { ...DEFAULT_EXPORT_CHROME, ...(opts.labels ?? {}) };

  // ── The totals row's first cell is its label, and there is only one cell ───
  // THE RULE: `totals` names the columns that carry a figure; column 0 carries
  // the row's label. Block 6 below writes that label unconditionally, so a
  // `totals` entry keyed to the first column could never be rendered — and was
  // dropped with no warning, which is what this refuses.
  //
  // It refuses rather than moving the label, because the label in the first cell
  // is the one piece of chrome every file this export has ever produced carries,
  // and a count sentence in the Kennzeichen or Fahrername column would be
  // sorted and filtered as data. Three callers were tripping over this —
  // Fahrzeuge, Fahrer and Benutzer — and every one of them was passing its own
  // WORDING and not a figure, so `labels.totalsRow` is where they belong. No
  // figure was ever lost; wording was.
  //
  // Loud, not a console warning: every call site is in this repository, so this
  // is a wrong program rather than wrong data, and it is meant to fail the first
  // click and the test rather than reach a customer's file.
  if (totals && columns.length > 0 && Object.prototype.hasOwnProperty.call(totals, columns[0].key)) {
    throw new Error(
      `exportTableToExcel: totals['${columns[0].key}'] can never be rendered — the first ` +
      `column of the totals row is that row's label. Pass wording as labels.totalsRow, ` +
      `and put a figure in any column but the first.`,
    );
  }

  const N = columns.length;
  const exportedAt  = new Date().toLocaleString('de-DE');
  const exportedDate = new Date().toLocaleDateString('de-DE');
  const exportedTime = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title:       sheetTitle,
    Subject:     moduleName,
    Author:      'El-Professor Verwaltungssystem',
    Company:     'El-Professor',
    CreatedDate: new Date(),
  };

  const ws: XLSX.WorkSheet = {};
  let R = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 1 — REPORT HEADER (3 rows tall)
  // ═══════════════════════════════════════════════════════════════════════════

  // Row 0: top accent stripe (very thin, dark)
  for (let c = 0; c < N; c++) {
    const addr = XLSX.utils.encode_cell({ r: R, c });
    ws[addr] = {
      t: 's', v: '',
      s: { fill: { fgColor: { rgb: T.TITLE_BG } } },
    };
  }
  R++;

  // Row 1: TITLE — large bold white text on dark navy, left-aligned
  for (let c = 0; c < N; c++) {
    cell(ws, R, c, c === 0 ? sheetTitle : '', {
      font: { bold: true, sz: 20, color: { rgb: T.TITLE_FG }, name: 'Calibri Light' },
      fill: { fgColor: { rgb: T.TITLE_BG } },
      alignment: { horizontal: 'left', vertical: 'center', indent: 2 },
    });
  }
  R++;

  // Row 2: META — module name (left) + export date/time (right)
  for (let c = 0; c < N; c++) {
    const isLast = c === N - 1;
    const metaVal = c === 0
      ? moduleName.toUpperCase()
      : isLast
        ? `${exportedDate}  ${exportedTime}`
        : '';
    cell(ws, R, c, metaVal, {
      font: {
        bold:   c === 0,
        sz:     c === 0 ? 10 : 9,
        color:  { rgb: T.META_FG },
        name:   'Calibri',
        italic: c !== 0 && isLast,
      },
      fill: { fgColor: { rgb: T.META_BG } },
      alignment: {
        horizontal: isLast ? 'right' : 'left',
        vertical:   'center',
        indent:     c === 0 ? 2 : 0,
      },
      border: {
        bottom: { style: 'thin', color: { rgb: T.COL_HEAD_BG } },
      },
    });
  }
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 2 — FILTER CONTEXT (optional, 1 row)
  // ═══════════════════════════════════════════════════════════════════════════

  let filterRow = -1;
  if (filterSummary.length > 0) {
    filterRow = R;
    const filterText = `${labels.activeFilters}  ${filterSummary.join('   |   ')}`;
    for (let c = 0; c < N; c++) {
      cell(ws, R, c, c === 0 ? filterText : '', {
        font:      { sz: 9, color: { rgb: T.FILTER_FG }, italic: true, name: 'Calibri' },
        fill:      { fgColor: { rgb: T.FILTER_BG } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 2, wrapText: false },
        border: {
          top:    { style: 'thin', color: { rgb: T.FILTER_BORDER } },
          bottom: { style: 'thin', color: { rgb: T.FILTER_BORDER } },
          left:   c === 0 ? { style: 'thin', color: { rgb: T.FILTER_BORDER } } : undefined,
          right:  c === N - 1 ? { style: 'thin', color: { rgb: T.FILTER_BORDER } } : undefined,
        },
      });
    }
    R++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 3 — SPACER ROW (provides visual breathing room)
  // ═══════════════════════════════════════════════════════════════════════════

  blank(ws, R, N);
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 4 — COLUMN HEADERS
  // ═══════════════════════════════════════════════════════════════════════════

  const colHeaderRow = R;
  columns.forEach((col, c) => {
    cell(ws, R, c, col.label, {
      font:      { bold: true, sz: 10, color: { rgb: T.COL_HEAD_FG }, name: 'Calibri' },
      fill:      { fgColor: { rgb: T.COL_HEAD_BG } },
      alignment: { horizontal: col.align ?? 'left', vertical: 'center', wrapText: false, indent: col.align === 'left' ? 1 : 0 },
      border: {
        top:    { style: 'medium', color: { rgb: T.TITLE_BG } },
        bottom: { style: 'medium', color: { rgb: T.COL_HEAD_BTM } },
        left:   { style: 'thin',   color: { rgb: T.COL_HEAD_BG } },
        right:  { style: 'thin',   color: { rgb: T.COL_HEAD_BG } },
      },
    });
  });
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 5 — DATA ROWS
  // ═══════════════════════════════════════════════════════════════════════════

  rows.forEach((dataRow, i) => {
    const isEven = i % 2 === 0;
    const rowBg  = isEven ? T.ROW_EVEN_BG : T.ROW_ODD_BG;

    columns.forEach((col, c) => {
      const rawVal   = dataRow[col.key];
      const numeric  = numericCell(col, rawVal);
      // A numeric column is displayed by its `z`; a text column by its `format`.
      // With no number to write, the text path below is exactly what it always was.
      const formatted = numeric
        ? numeric.value
        : col.format
          ? col.format(rawVal)
          : rawVal == null ? '' : String(rawVal);

      cell(ws, R, c, formatted, {
        font:      { sz: 10, name: 'Calibri', color: { rgb: '1E293B' } },
        fill:      { fgColor: { rgb: rowBg } },
        alignment: {
          horizontal: col.align ?? 'left',
          vertical:   'center',
          wrapText:   false,
          indent:     col.align === 'left' ? 1 : 0,
        },
        border: {
          top:    { style: 'thin', color: { rgb: T.ROW_BORDER } },
          bottom: { style: 'thin', color: { rgb: T.ROW_BORDER } },
          left:   c === 0
            ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } }
            : { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
          right:  c === N - 1
            ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } }
            : { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
        },
      }, numeric?.z);
    });
    R++;
  });

  // Empty-state placeholder
  if (rows.length === 0) {
    const msg = labels.emptyState;
    for (let c = 0; c < N; c++) {
      cell(ws, R, c, c === 0 ? msg : '', {
        font:      { sz: 10, italic: true, color: { rgb: '94A3B8' }, name: 'Calibri' },
        fill:      { fgColor: { rgb: T.ROW_EVEN_BG } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
        border:    gridBorder(),
      });
    }
    R++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 6 — TOTALS / SUMMARY ROW (optional)
  // ═══════════════════════════════════════════════════════════════════════════

  if (totals) {
    // Top-border accent line (1-row cap before totals)
    for (let c = 0; c < N; c++) {
      const addr = XLSX.utils.encode_cell({ r: R, c });
      ws[addr] = {
        t: 's', v: '',
        s: {
          fill:   { fgColor: { rgb: T.TOTAL_ACCENT } },
          border: {
            top:    { style: 'medium', color: { rgb: T.TITLE_BG } },
            bottom: { style: 'medium', color: { rgb: T.TITLE_BG } },
          },
        },
      };
    }
    R++;

    columns.forEach((col, c) => {
      const isLabel = c === 0;
      // The first cell is always the label, as it always was — never a figure,
      // which the guard at the top of this function now enforces instead of
      // silently discarding one. The label follows the UI language since #112;
      // only the figures are ours.
      const rawTotal = totals[col.key];
      const numeric  = isLabel ? null : numericCell(col, rawTotal);
      const val      = isLabel
        ? chromeText(labels.totalsRow, rows.length)
        : numeric ? numeric.value : (rawTotal ?? '');
      cell(ws, R, c, val, {
        font: {
          bold:  true,
          sz:    10,
          color: { rgb: isLabel ? T.TOTAL_ACCENT : T.TOTAL_FG },
          name:  'Calibri',
        },
        fill:      { fgColor: { rgb: T.TOTAL_BG } },
        alignment: {
          horizontal: isLabel ? 'left' : (col.align ?? 'right'),
          vertical:   'center',
          indent:     isLabel ? 1 : 0,
        },
        border: {
          top:    { style: 'medium', color: { rgb: T.TOTAL_ACCENT } },
          bottom: { style: 'medium', color: { rgb: T.TITLE_BG }    },
          left:   c === 0     ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } } : { style: 'thin', color: { rgb: T.ROW_BORDER_V } },
          right:  c === N - 1 ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } } : { style: 'thin', color: { rgb: T.ROW_BORDER_V } },
        },
      }, numeric?.z);
    });
    R++;
  } else {
    // Even without a totals row, close the table with a medium bottom border
    const lastDataR = R - 1;
    for (let c = 0; c < N; c++) {
      const addr = XLSX.utils.encode_cell({ r: lastDataR, c });
      if (ws[addr] && ws[addr].s) {
        ws[addr].s.border = {
          ...(ws[addr].s.border ?? {}),
          bottom: { style: 'medium', color: { rgb: T.COL_HEAD_BG } },
        };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 7 — FOOTER BAND
  // ═══════════════════════════════════════════════════════════════════════════

  R++; // one blank spacer row above footer

  // Footer line 1: system name + record count
  for (let c = 0; c < N; c++) {
    const isFirst = c === 0;
    const isLast  = c === N - 1;
    const val = isFirst
      ? chromeText(labels.footer, rows.length)
      : isLast
        ? exportedAt
        : '';
    cell(ws, R, c, val, {
      font:  { sz: 8, color: { rgb: T.FOOTER_FG }, italic: true, name: 'Calibri' },
      fill:  { fgColor: { rgb: T.FOOTER_BG } },
      alignment: {
        horizontal: isLast ? 'right' : 'left',
        vertical:   'center',
        indent:     isFirst ? 2 : 0,
      },
      border: {
        top:    { style: 'thin',   color: { rgb: T.FOOTER_LINE } },
        bottom: { style: 'thin',   color: { rgb: T.FOOTER_LINE } },
        left:   isFirst ? { style: 'thin', color: { rgb: T.FOOTER_LINE } } : undefined,
        right:  isLast  ? { style: 'thin', color: { rgb: T.FOOTER_LINE } } : undefined,
      },
    });
  }

  const footerRow = R;
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSHEET SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  // Range
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: N - 1 } });

  // Column widths — use provided widths; auto-min of 10
  ws['!cols'] = columns.map(col => ({ wch: Math.max(col.width ?? 18, 10) }));

  // Row heights (in points)
  const rowHeights: { [key: number]: { hpt: number } } = {
    0: { hpt: 4  },   // accent stripe — short
    1: { hpt: 32 },   // title row
    2: { hpt: 18 },   // meta row
  };
  if (filterRow >= 0) rowHeights[filterRow] = { hpt: 16 };
  rowHeights[colHeaderRow - 1] = { hpt: 6 };  // spacer
  rowHeights[colHeaderRow]     = { hpt: 22 };  // column headers
  for (let i = colHeaderRow + 1; i < colHeaderRow + 1 + rows.length; i++) {
    rowHeights[i] = { hpt: 18 };
  }
  rowHeights[footerRow] = { hpt: 14 };
  ws['!rows'] = Array.from({ length: R }, (_, i) => rowHeights[i] ?? { hpt: 18 });

  // Freeze pane: freeze everything above and including the column-header row
  ws['!freeze'] = { xSplit: 0, ySplit: colHeaderRow + 1 };

  // AutoFilter on column-header row
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: colHeaderRow, c: 0 },
      e: { r: colHeaderRow, c: N - 1 },
    }),
  };

  // Cell merges
  const merges: XLSX.Range[] = [
    // Accent stripe — full width
    { s: { r: 0, c: 0 }, e: { r: 0, c: N - 1 } },
    // Title row — full width
    { s: { r: 1, c: 0 }, e: { r: 1, c: N - 1 } },
    // Meta row — left part (module name) spans all but last cell
    { s: { r: 2, c: 0 }, e: { r: 2, c: N - 2 } },
    // Footer — left part spans all but last cell
    { s: { r: footerRow, c: 0 }, e: { r: footerRow, c: N - 2 } },
  ];
  if (filterRow >= 0) {
    merges.push({ s: { r: filterRow, c: 0 }, e: { r: filterRow, c: N - 1 } });
  }
  ws['!merges'] = merges;

  // Print settings
  ws['!margins'] = { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };

  XLSX.utils.book_append_sheet(wb, ws, moduleName.slice(0, 31));

  return wb;
}

export function exportTableToExcel(opts: ExportOptions): void {
  const wb = buildTableWorkbook(opts);
  const safeFilename = opts.filename.endsWith('.xlsx') ? opts.filename : `${opts.filename}.xlsx`;
  // ExcelJS produces a buffer, so writing is asynchronous where `XLSX.writeFile`
  // was synchronous — and this function's `void` signature, which every call
  // site is written against, has nowhere to hand a failure. A rejection is
  // logged rather than left unhandled; a real message on the button would mean
  // changing that signature, which is a change of its own. The guard against a
  // file that claims nought after a failed read stays at the call site either
  // way: this still writes a workbook for whatever rows it is handed.
  void downloadStyledWorkbook(wb, safeFilename).catch((error: unknown) => {
    console.error('exportTableToExcel: writing the workbook failed', error);
  });
}