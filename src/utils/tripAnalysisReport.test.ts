import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { translate, type TranslationKey, type TranslationVars } from '../i18n';
import type { AnalysisTrip, TripAnalysisResult } from './tripAnalysis/types';
import { effectiveSettings } from '../lib/tripAnalysisView';
import { buildTripAnalysisReport, tripAnalysisReportFileName } from './tripAnalysisReport';

const de = (key: TranslationKey, vars?: TranslationVars) => translate('de', key, vars);
const en = (key: TranslationKey, vars?: TranslationVars) => translate('en', key, vars);

const trips: AnalysisTrip[] = [
  {
    id: 't1', driver_id: 'drv1', driver_name: 'Anna Berg', vehicle: 'B-EP 101',
    start_ms: Date.parse('2026-08-03T06:00:00Z'), end_ms: Date.parse('2026-08-03T06:30:00Z'),
    status: 'completed', price: '12.50', currency: 'EUR', source_row: 2,
  },
  {
    id: 't2', driver_id: 'drv1', driver_name: 'Anna Berg', vehicle: 'B-EP 101',
    start_ms: Date.parse('2026-08-03T06:20:00Z'), end_ms: Date.parse('2026-08-03T06:50:00Z'),
    status: 'completed', price: 7, currency: null, source_row: 3,
  },
];

const result: TripAnalysisResult = {
  algorithmVersion: 'trip-analysis/1.0.0',
  settings: { blockGapMinutes: 30, travelMarginMinutes: 30 },
  travelEstimatorSource: 'none',
  counts: { rows: 2, byStatus: { completed: 2, cancelled: 0, unknown: 0 }, analysed: 2, needsReview: 0 },
  trips: trips.map(trip => ({ trip, blockId: 'drv1#0', excludedBecause: [], outsideShiftMs: null, issueIds: ['driver_overlap:t1+t2'] })),
  blocks: [],
  drivers: [],
  issues: [{
    id: 'driver_overlap:t1+t2', type: 'driver_overlap', severity: 'error', status: 'conflict', driverId: 'drv1',
    tripIds: ['t1', 't2'], values: { overlapMinutes: 10 }, explanation: 'Zwei Fahrten gleichzeitig.', confidence: 'high',
  }],
  reviewTripIds: [],
  checks: {
    driverOverlap: { passed: 0, conflict: 2, unverifiable: 0 },
    vehicleOverlap: { passed: 2, conflict: 0, unverifiable: 0 },
    travelGap: { passed: 0, conflict: 0, unverifiable: 0 },
    shiftCoverage: { passed: 0, conflict: 0, unverifiable: 2 },
    budget: { passed: 0, conflict: 0, unverifiable: 0 },
  },
};

function build(t = de) {
  return buildTripAnalysisReport({
    t,
    result,
    settings: effectiveSettings({ id: 's', block_gap_minutes: 45, travel_margin_minutes: null, updated_at: null }, true),
    driverRows: [],
    month: 8,
    year: 2026,
    fileName: 'Uber August.xlsx',
    generatedAtMs: Date.parse('2026-09-22T08:00:00Z'),
  });
}

const cell = (ws: XLSX.WorkSheet, address: string) => ws[address] as XLSX.CellObject | undefined;

describe('buildTripAnalysisReport', () => {
  it('has four sheets, each opening with the analysis marker', () => {
    const workbook = build();
    expect(workbook.SheetNames).toEqual(['Analyse', 'Befunde', 'Befund-Fahrten', 'Fahrten']);
    for (const name of workbook.SheetNames) {
      expect(cell(workbook.Sheets[name], 'A1')?.v).toBe('Analyse — kein amtliches Dokument');
      expect(String(cell(workbook.Sheets[name], 'A2')?.v)).toContain('ersetzt nicht das Fahrtenbuch');
    }
  });

  it('says which setting was the test value', () => {
    const rows = XLSX.utils.sheet_to_json<string[]>(build().Sheets.Analyse, { header: 1 });
    expect(rows).toContainEqual(['Blockabstand', '45 Min. (festgelegt)']);
    expect(rows).toContainEqual(['Fahrtpuffer', '30 Min. (Testwert, nicht festgelegt)']);
  });

  it("writes each trip's price and currency as the trip carries them", () => {
    const ws = build().Sheets.Fahrten;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
    const headerRow = rows[3] as string[];
    const price = headerRow.indexOf('Preis');
    const currency = headerRow.indexOf('Währung');
    const byId = new Map(rows.slice(4).map(row => [row[0], row]));
    expect(byId.get('t1')?.[price]).toBe('12.50');
    expect(byId.get('t1')?.[currency]).toBe('EUR');
    expect(byId.get('t2')?.[price]).toBe(7);
    expect(byId.get('t2')?.[currency]).toBeNull();
  });

  it('lists one row per finding and trip', () => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(build().Sheets['Befund-Fahrten'], { header: 1 });
    const evidence = rows.slice(4);
    expect(evidence.map(row => [row[0], row[3]])).toEqual([
      ['driver_overlap:t1+t2', 't1'],
      ['driver_overlap:t1+t2', 't2'],
    ]);
  });

  it('keeps the German marker words in the English report', () => {
    const workbook = build(en);
    expect(workbook.SheetNames).toEqual(['Analysis', 'Findings', 'Finding trips', 'Trips']);
    expect(String(cell(workbook.Sheets.Analysis, 'A1')?.v)).toContain('Analyse — kein amtliches Dokument');
  });
});

describe('tripAnalysisReportFileName', () => {
  it("is never the Fahrtenbuch export's name", () => {
    expect(tripAnalysisReportFileName(2026, 8, 'Uber August.xlsx')).toBe('Fahrtenanalyse_2026-08_Uber_August.xlsx');
    expect(tripAnalysisReportFileName(2026, 8, '...')).toBe('Fahrtenanalyse_2026-08__.xlsx');
  });
});

// ─── The drawing, and the two row indices it depends on ─────────────────────
//
// Until 01.10.2026 these four sheets were bare `aoa_to_sheet` grids and
// `XLSX.writeFile` would have discarded styling anyway, so the report opened as a
// plain 13-column grid with no header and no column widths. It is drawn now, by
// `sheet()`, and drawn from two row indices written down as constants:
// `TABLE_HEADER_ROW` (3, after the two marker rows and a blank one) and
// `OVERVIEW_DRIVER_HEADER` (24, after the marker block and twenty label/value
// rows).
//
// **A wrong index paints the header band across a row of data**, silently, and the
// value assertions above would all still pass. So the indices are asserted here
// against the sheets themselves rather than trusted: each must be the row whose
// first cell is that table's first column label, and it must carry a fill.

describe('buildTripAnalysisReport — the drawing', () => {
  const wb = build();
  const sheetNamed = (key: Parameters<typeof de>[0]) => wb.Sheets[de(key)];
  const styleOf = (ws: XLSX.WorkSheet, address: string) =>
    (cell(ws, address)?.s ?? null) as { fill?: { fgColor?: { rgb?: string } }; font?: { bold?: boolean } } | null;

  it('the marker rows are a band, on every sheet', () => {
    for (const key of ['ta.report.sheet.overview', 'ta.report.sheet.findings',
                       'ta.report.sheet.evidence', 'ta.report.sheet.trips'] as const) {
      const ws = sheetNamed(key);
      expect(styleOf(ws, 'A1')?.fill?.fgColor?.rgb, `${de(key)} A1 has no fill`).toBeTruthy();
      expect(styleOf(ws, 'A1')?.font?.bold, `${de(key)} A1 is not bold`).toBe(true);
      expect(styleOf(ws, 'A2')?.fill?.fgColor?.rgb, `${de(key)} A2 has no fill`).toBeTruthy();
    }
  });

  it('row 4 is the column header of each tabular sheet, and it is drawn', () => {
    // 0-based row 3 is spreadsheet row 4. `TABLE_HEADER_ROW` is that index, and
    // these are the first column labels the three tabular sheets write.
    const expected: [Parameters<typeof de>[0], string][] = [
      ['ta.report.sheet.findings', de('ta.report.col.findingId')],
      ['ta.report.sheet.evidence', de('ta.report.col.findingId')],
      ['ta.report.sheet.trips', de('ta.report.col.tripId')],
    ];
    for (const [key, label] of expected) {
      const ws = sheetNamed(key);
      expect(cell(ws, 'A4')?.v, `${de(key)} row 4 is not the header`).toBe(label);
      expect(styleOf(ws, 'A4')?.font?.bold, `${de(key)} header is not bold`).toBe(true);
      expect(styleOf(ws, 'A4')?.fill?.fgColor?.rgb, `${de(key)} header has no fill`).toBeTruthy();
    }
  });

  it("the overview's driver-table header is drawn, wherever it sits", () => {
    // Row 20 today. The builder DERIVES the index from the array rather than
    // carrying a number, because the first version carried 24 — the real row is 19
    // (0-based) — and the band was painted across a row of a driver's figures while
    // every value assertion still passed. This test is what caught that, so it
    // checks the drawing landed on the row holding the labels, not on row 20.
    const ws = sheetNamed('ta.report.sheet.overview');
    expect(cell(ws, 'A20')?.v).toBe(de('ta.col.driver'));
    expect(cell(ws, 'B20')?.v).toBe(de('ta.report.col.driverId'));
    expect(styleOf(ws, 'A20')?.font?.bold).toBe(true);
    expect(styleOf(ws, 'A20')?.fill?.fgColor?.rgb).toBeTruthy();

    // And nowhere else: the row above is a label/value pair and must be unpainted.
    expect(styleOf(ws, 'A19')?.fill?.fgColor?.rgb).toBeFalsy();
  });

  it('freezes under the header and filters on it', () => {
    const ws = sheetNamed('ta.report.sheet.trips') as unknown as Record<string, unknown>;
    expect(ws['!freeze']).toEqual({ xSplit: 0, ySplit: 4 });
    expect(ws['!autofilter']).toEqual({ ref: 'A4:M4' });
  });

  it('keeps every value and every position exactly where they were', () => {
    // The guard for the whole change: `sheet()` creates a cell for an empty one
    // inside the marker band, and must touch nothing else. A1 of the trips sheet is
    // still the marker, and the first data row is still directly under the header.
    const ws = sheetNamed('ta.report.sheet.trips');
    expect(cell(ws, 'A1')?.v).toBe(de('ta.report.marker'));
    expect(cell(ws, 'A5')?.v).toBe('t1');
    expect(cell(ws, 'A6')?.v).toBe('t2');
  });
});
