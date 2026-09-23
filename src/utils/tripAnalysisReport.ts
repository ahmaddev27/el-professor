/**
 * The Fahrtenanalyse report: an Excel workbook that lists every finding with
 * the trips behind it.
 *
 * **It is an analysis, not a document.** Every sheet opens with the marker
 * "Analyse — kein amtliches Dokument" and says that it does not replace the
 * Fahrtenbuch. It is not the Fahrtenbuch export (utils/fahrtenbuchExport.ts),
 * shares nothing with it, and is named so the two cannot be mistaken for each
 * other. Because it satisfies no statutory form, its headers follow the UI
 * language (src/i18n/index.ts); the marker keeps its German words in English.
 *
 * **Prices and currencies are written as the trips carry them.** A trip's
 * price is the value the import stored — a number or the decimal text a
 * numeric column returns — and it goes into its cell untouched, beside the
 * currency as given (empty when the file named none). Nothing is rounded,
 * converted or summed across currencies here.
 *
 * Four sheets: the overview (settings used, counts, one row per driver), the
 * findings, the findings with their trips (one row per finding and trip), and
 * every trip of the file by id.
 */
import * as XLSX from 'xlsx';
import { formatCentsForNumeric } from './money';
import {
  EXCLUSION_KEYS,
  ISSUE_SEVERITY_KEYS,
  ISSUE_STATUS_KEYS,
  ISSUE_TYPE_KEYS,
  TRIP_STATUS_KEYS,
} from '../lib/tripAnalysisLabels';
import type { TranslationKey, TranslationVars } from '../i18n';
import type { AnalyzedTrip, Issue, TripAnalysisResult } from './tripAnalysis/types';
import {
  formatBerlinDateTime,
  type DriverTableRow,
  type EffectiveSetting,
  type EffectiveSettings,
} from '../lib/tripAnalysisView';

export type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

export interface TripAnalysisReportInput {
  t: Translate;
  result: TripAnalysisResult;
  settings: EffectiveSettings;
  driverRows: readonly DriverTableRow[];
  month: number;
  year: number;
  fileName: string;
  /** When the report was made; passed in so the builder has no clock. */
  generatedAtMs: number;
}

type Cell = string | number | boolean | null;

const priceCell = (price: number | string | null): Cell => (price === null ? null : price);

function settingCell(t: Translate, setting: EffectiveSetting): string {
  if (setting.value === null) return t('ta.settings.notSet');
  const source = setting.source === 'test_default' ? t('ta.report.testDefault') : t('ta.report.stored');
  return `${t('ta.minutes', { value: setting.value })} (${source})`;
}

function header(t: Translate): Cell[][] {
  return [[t('ta.report.marker')], [t('ta.report.notFahrtenbuch')], []];
}

function values(issue: Issue): string {
  return Object.entries(issue.values)
    .map(([key, value]) => `${key}=${value === null ? '' : String(value)}`)
    .join('; ');
}

function tripRow(t: Translate, analyzed: AnalyzedTrip, extra: Cell[] = []): Cell[] {
  const trip = analyzed.trip;
  return [
    ...extra,
    trip.id,
    trip.source_row,
    formatBerlinDateTime(trip.start_ms),
    formatBerlinDateTime(trip.end_ms),
    trip.driver_name,
    trip.driver_id,
    trip.vehicle,
    t(TRIP_STATUS_KEYS[trip.status]),
    priceCell(trip.price),
    trip.currency,
  ];
}

function tripHeader(t: Translate, extra: Cell[] = []): Cell[] {
  return [
    ...extra,
    t('ta.report.col.tripId'),
    t('ta.col.row'),
    t('ta.col.start'),
    t('ta.col.end'),
    t('ta.col.driver'),
    t('ta.report.col.driverId'),
    t('ta.col.vehicle'),
    t('ta.col.tripStatus'),
    t('ta.col.price'),
    t('ta.report.col.currency'),
  ];
}

function sheet(rows: Cell[][], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map(wch => ({ wch }));
  return ws;
}

export function buildTripAnalysisReport(input: TripAnalysisReportInput): XLSX.WorkBook {
  const { t, result, settings, driverRows } = input;
  const tripsById = new Map(result.trips.map(analyzed => [analyzed.trip.id, analyzed]));
  const monthLabel = `${String(input.month).padStart(2, '0')}.${input.year}`;

  // ── Overview ──
  const overview: Cell[][] = [
    ...header(t),
    [t('ta.report.month'), monthLabel],
    [t('ta.report.file'), input.fileName],
    [t('ta.report.generated'), formatBerlinDateTime(input.generatedAtMs)],
    [t('ta.report.algorithm'), result.algorithmVersion],
    [t('ta.settings.blockGap'), settingCell(t, settings.blockGap)],
    [t('ta.settings.travelMargin'), settingCell(t, settings.travelMargin)],
    [t('ta.shiftsSourceShort'), t('ta.shiftsSource')],
    [],
    [t('ta.kpi.rows'), result.counts.rows],
    [t('ta.tripStatus.completed'), result.counts.byStatus.completed],
    [t('ta.tripStatus.cancelled'), result.counts.byStatus.cancelled],
    [t('ta.tripStatus.unknown'), result.counts.byStatus.unknown],
    [t('ta.kpi.review'), result.counts.needsReview],
    [t('ta.kpi.conflicts'), result.issues.filter(issue => issue.status === 'conflict').length],
    [t('ta.status.unverifiable'), result.issues.filter(issue => issue.status === 'unverifiable').length],
    [],
    [
      t('ta.col.driver'), t('ta.report.col.driverId'), t('ta.col.budget'),
      `${t('ta.col.salary')} (min)`, `${t('ta.col.salary')} (max)`, t('ta.col.hourlyRate'),
      `${t('ta.col.hoursRange')} (min, h)`, `${t('ta.col.hoursRange')} (max, h)`,
      `${t('ta.col.reserve')} (h)`, `${t('ta.col.cap')} (h)`, `${t('ta.col.shifts')} (h)`, `${t('ta.col.activity')} (h)`,
      `${t('ta.col.overBudget')} (min)`, `${t('ta.col.remaining')} (min)`, t('ta.col.fares'), t('ta.col.trips'), t('ta.status.conflict'), t('ta.status.unverifiable'),
    ],
    ...driverRows.map(row => [
      row.name,
      row.driverId,
      row.linked ? t(budgetStateKey(row.budgetState)) : t('ta.notLinked'),
      row.salaryMin === null ? null : String(row.salaryMin),
      row.salaryMax === null ? null : String(row.salaryMax),
      row.hourlyRate === null ? null : String(row.hourlyRate),
      row.hoursMin,
      row.hoursMax,
      row.reservedHours,
      row.capHours,
      row.shiftHours,
      row.activityHours,
      row.overByMinutes,
      row.remainingMinutes,
      row.fares.map(total => `${formatCentsForNumeric(total.totalCents)} ${total.currency ?? ''}`.trim()).join('; '),
      row.tripCount,
      row.conflictCount,
      row.unverifiableCount,
    ]),
  ];

  // ── Findings ──
  const findings: Cell[][] = [
    ...header(t),
    [
      t('ta.report.col.findingId'), t('ta.report.col.type'), t('ta.col.severity'), t('ta.col.status'),
      t('ta.report.col.driverId'), t('ta.col.vehicle'), t('ta.report.col.explanation'), t('ta.report.col.confidence'),
      t('ta.col.trips'), t('ta.report.col.tripIds'), t('ta.report.col.values'),
    ],
    ...result.issues.map(issue => [
      issue.id,
      t(ISSUE_TYPE_KEYS[issue.type]),
      t(ISSUE_SEVERITY_KEYS[issue.severity]),
      t(ISSUE_STATUS_KEYS[issue.status]),
      issue.driverId ?? null,
      issue.vehicle ?? null,
      issue.explanation,
      issue.confidence,
      issue.tripIds.length,
      issue.tripIds.join(', '),
      values(issue),
    ]),
  ];

  // ── Findings with their trips ──
  const evidence: Cell[][] = [
    ...header(t),
    tripHeader(t, [t('ta.report.col.findingId'), t('ta.report.col.type'), t('ta.col.status')]),
    ...result.issues.flatMap(issue =>
      issue.tripIds.flatMap(id => {
        const analyzed = tripsById.get(id);
        if (!analyzed) return [];
        return [tripRow(t, analyzed, [
          issue.id,
          t(ISSUE_TYPE_KEYS[issue.type]),
          t(ISSUE_STATUS_KEYS[issue.status]),
        ])];
      }),
    ),
  ];

  // ── Every trip, by id ──
  const trips: Cell[][] = [
    ...header(t),
    [...tripHeader(t), t('ta.col.block'), t('ta.report.col.excluded'), t('ta.col.findings')],
    ...[...result.trips]
      .sort((a, b) => a.trip.id.localeCompare(b.trip.id))
      .map(analyzed => [
        ...tripRow(t, analyzed),
        analyzed.blockId,
        analyzed.excludedBecause.map(reason => t(EXCLUSION_KEYS[reason])).join(', '),
        analyzed.issueIds.join(', '),
      ]),
  ];

  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: `${t('ta.title')} ${monthLabel}`, Subject: t('ta.report.marker') };
  XLSX.utils.book_append_sheet(workbook, sheet(overview, [34, 38, 18, 14, 14, 12, 14, 14, 12, 12, 14, 12, 14, 14, 22, 10, 10, 12]), t('ta.report.sheet.overview'));
  XLSX.utils.book_append_sheet(workbook, sheet(findings, [36, 34, 12, 14, 38, 14, 60, 12, 8, 50, 60]), t('ta.report.sheet.findings'));
  XLSX.utils.book_append_sheet(workbook, sheet(evidence, [36, 34, 14, 38, 8, 20, 20, 24, 38, 14, 14, 12, 10]), t('ta.report.sheet.evidence'));
  XLSX.utils.book_append_sheet(workbook, sheet(trips, [38, 8, 20, 20, 24, 38, 14, 14, 12, 10, 20, 30, 50]), t('ta.report.sheet.trips'));
  return workbook;
}

export function budgetStateKey(state: DriverTableRow['budgetState']): TranslationKey {
  switch (state) {
    case 'confirmed':
      return 'ta.budget.confirmed';
    case 'inputs_changed':
      return 'ta.budget.inputsChanged';
    default:
      return 'ta.budget.notConfirmed';
  }
}

/**
 * `Fahrtenanalyse_2026-08_<file>.xlsx` — never a name the Fahrtenbuch export
 * uses, so the two files cannot be confused in a download folder.
 */
export function tripAnalysisReportFileName(year: number, month: number, sourceFileName: string): string {
  const base = sourceFileName.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
  return `Fahrtenanalyse_${year}-${String(month).padStart(2, '0')}_${base || 'Datei'}.xlsx`;
}

/** Builds and downloads the report. */
export function downloadTripAnalysisReport(input: TripAnalysisReportInput): void {
  XLSX.writeFile(buildTripAnalysisReport(input), tripAnalysisReportFileName(input.year, input.month, input.fileName));
}
