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
