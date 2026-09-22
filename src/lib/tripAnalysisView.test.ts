import { describe, expect, it } from 'vitest';
import type {
  AnalysisShift,
  AnalysisTrip,
  DriverAnalysis,
  Issue,
  TripAnalysisResult,
  TripBlock,
} from '../utils/tripAnalysis/types';
import {
  berlinDateKey,
  berlinDayBounds,
  budgetInputFor,
  budgetInputs,
  budgetState,
  driverTableRows,
  driverTimeline,
  effectiveSettings,
  fareTotals,
  filterIssues,
  formatBerlinDateTime,
  issueStatusCounts,
  recomputeLog,
  TEST_DEFAULT_MINUTES,
  unlinkedDrivers,
  type BudgetRow,
  type CompanyDriver,
} from './tripAnalysisView';

const at = (iso: string) => Date.parse(iso);

function trip(id: string, over: Partial<AnalysisTrip> = {}): AnalysisTrip {
  return {
    id, driver_id: 'drv1', driver_name: 'Anna Berg', vehicle: 'B-EP 101',
    start_ms: at('2026-08-03T06:00:00Z'), end_ms: at('2026-08-03T06:30:00Z'),
    status: 'completed', price: '12.50', currency: 'EUR', source_row: 2, ...over,
  };
}

function driverAnalysis(over: Partial<DriverAnalysis> = {}): DriverAnalysis {
  return {
    driverId: 'drv1', driverNames: ['Anna Berg'], tripIds: ['t1'],
    statusCounts: { completed: 1, cancelled: 0, unknown: 0 }, analysedTripIds: ['t1'], blockIds: ['drv1#0'],
    metrics: { durationSumMs: 1_800_000, unionMs: 1_800_000, spanMs: 1_800_000, outsideShiftMs: null },
    shiftIds: [], shiftUnionMs: null, shiftsWithoutActivityIds: [],
    prices: { totals: [{ currency: 'EUR', status: 'completed', totalCents: 1250, tripCount: 1 }], unpricedTripIds: [] },
    budget: null, budgetComparison: null, issueIds: [], ...over,
  };
}

function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id, type: 'driver_overlap', severity: 'error', status: 'conflict', driverId: 'drv1', tripIds: ['t1'],
    values: {}, explanation: 'Überschneidung', confidence: 'high', ...over,
  };
}

function block(over: Partial<TripBlock> = {}): TripBlock {
  return {
    id: 'drv1#0', driverId: 'drv1', index: 0, vehicle: 'B-EP 101', startReason: 'first', gapBeforeMs: null,
    tripIds: ['t1'], startMs: at('2026-08-03T06:00:00Z'), endMs: at('2026-08-03T06:30:00Z'),
    metrics: { durationSumMs: 1_800_000, unionMs: 1_800_000, spanMs: 1_800_000, outsideShiftMs: null },
    prices: { totals: [], unpricedTripIds: [] }, issueIds: [], ...over,
  };
}

function result(over: Partial<TripAnalysisResult> = {}): TripAnalysisResult {
  const trips = [trip('t1')];
  return {
    algorithmVersion: 'trip-analysis/1.0.0',
    settings: { blockGapMinutes: 30, travelMarginMinutes: 30 },
    travelEstimatorSource: 'none',
    counts: { rows: 1, byStatus: { completed: 1, cancelled: 0, unknown: 0 }, analysed: 1, needsReview: 0 },
    trips: trips.map(t => ({ trip: t, blockId: 'drv1#0', excludedBecause: [], outsideShiftMs: null, issueIds: [] })),
    blocks: [block()],
    drivers: [driverAnalysis()],
    issues: [],
    reviewTripIds: [],
    checks: {
      driverOverlap: { passed: 1, conflict: 0, unverifiable: 0 },
      vehicleOverlap: { passed: 1, conflict: 0, unverifiable: 0 },
      travelGap: { passed: 0, conflict: 0, unverifiable: 0 },
      shiftCoverage: { passed: 0, conflict: 0, unverifiable: 1 },
      budget: { passed: 0, conflict: 0, unverifiable: 1 },
    },
    ...over,
  };
}

const anna: CompanyDriver = {
  id: 'drv1', name: 'Anna Berg', status: 'active',
  planning_min_salary: 1000, planning_max_salary: 1500, planning_hourly_rate: 13.9,
};

function budgetRow(over: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: 'b1', driver_id: 'drv1', year: 2026, month: 8, reserved_hours: null,
    planning_min_salary: null, planning_max_salary: null, planning_hourly_rate: null,
    confirmed_at: null, confirmed_by: null, recompute_log: [], ...over,
  };
}

describe('effectiveSettings', () => {
  it('runs with the stored values', () => {
    const got = effectiveSettings({ id: 's', block_gap_minutes: 45, travel_margin_minutes: 10, updated_at: null }, false);
    expect(got.settings).toEqual({ blockGapMinutes: 45, travelMarginMinutes: 10 });
    expect(got.usesTestDefault).toBe(false);
  });

  it('does not run while a value is not set, and never assumes one', () => {
    const got = effectiveSettings({ id: 's', block_gap_minutes: 45, travel_margin_minutes: null, updated_at: null }, false);
    expect(got.settings).toBeNull();
    expect(got.travelMargin).toEqual({ value: null, source: 'missing' });
    expect(effectiveSettings(null, false).settings).toBeNull();
  });

  it('uses the test value only where nothing is set, and says so', () => {
    const got = effectiveSettings({ id: 's', block_gap_minutes: 45, travel_margin_minutes: null, updated_at: null }, true);
    expect(got.settings).toEqual({ blockGapMinutes: 45, travelMarginMinutes: TEST_DEFAULT_MINUTES });
    expect(got.blockGap.source).toBe('stored');
    expect(got.travelMargin.source).toBe('test_default');
    expect(got.usesTestDefault).toBe(true);
    expect(TEST_DEFAULT_MINUTES).toBe(30);
  });
});

describe('budgets', () => {
  it("uses the driver's current figures until the month is confirmed", () => {
    expect(budgetState(anna, undefined)).toBe('not_confirmed');
    expect(budgetInputFor(anna, budgetRow({ reserved_hours: 5 }))).toEqual({
      salaryMin: 1000, salaryMax: 1500, hourlyRate: 13.9, reservedHours: 5,
    });
  });

  it('uses the snapshot once confirmed, and says when the driver has moved since', () => {
    const row = budgetRow({
      confirmed_at: '2026-09-01T10:00:00Z', planning_min_salary: '1000.00', planning_max_salary: '1500.00', planning_hourly_rate: '13.90',
    });
    expect(budgetState(anna, row)).toBe('confirmed');
    expect(budgetState({ ...anna, planning_max_salary: 1800 }, row)).toBe('inputs_changed');
    expect(budgetInputFor({ ...anna, planning_max_salary: 1800 }, row).salaryMax).toBe('1500.00');
  });

  it('keeps a reserve that is not set apart from a reserve of 0', () => {
    expect(budgetInputFor(anna, undefined).reservedHours).toBeNull();
    expect(budgetInputFor(anna, budgetRow({ reserved_hours: 0 })).reservedHours).toBe(0);
    expect(budgetInputs([anna], [])).toEqual({ drv1: { salaryMin: 1000, salaryMax: 1500, hourlyRate: 13.9, reservedHours: null } });
  });

  it('reads the recompute log the database writes, and ignores anything else', () => {
    const row = budgetRow({
      recompute_log: [
        { kind: 'reserve', at: '2026-09-02T08:00:00Z', by: 'u1', previous: { reserved_hours: 0 } },
        { kind: 'recompute', at: '2026-09-03T08:00:00Z', by: null },
        { forged: true },
        'x',
      ],
    });
    expect(recomputeLog(row)).toEqual([
      { kind: 'reserve', at: '2026-09-02T08:00:00Z', by: 'u1' },
      { kind: 'recompute', at: '2026-09-03T08:00:00Z', by: null },
    ]);
    expect(recomputeLog(undefined)).toEqual([]);
  });
});

describe('driverTableRows', () => {
  it('shows the budget, the activity against it and the fares apart from it', () => {
    const rows = driverTableRows(
      result({
        drivers: [driverAnalysis({
          shiftUnionMs: 2 * 3_600_000,
          budget: {
            status: 'ok', rangeStatus: 'ok', capStatus: 'ok', problems: [],
            hoursMin: 1000 / 13.9, hoursMax: 1500 / 13.9, hoursMaxMinutes: 6474, reservedHours: 5,
            capHours: 1500 / 13.9 - 5, capMinutes: 6174, capBelowHoursMin: false,
          },
          budgetComparison: {
            maxMinutes: 6474.8, minMinutes: 4316.5, activityMinutes: 30, shiftMinutes: 120,
            activityVsMaxMinutes: -6444.8, shiftVsMaxMinutes: -6354.8,
          },
          issueIds: ['i1', 'i2'],
        })],
        issues: [issue('i1'), issue('i2', { status: 'unverifiable' })],
      }),
      [anna],
      [budgetRow({ reserved_hours: 5 })],
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.linked).toBe(true);
    expect(row.reservedHours).toBe(5);
    expect(row.shiftHours).toBe(2);
    expect(row.activityHours).toBe(0.5);
    expect(row.overByMinutes).toBe(0);
    expect(row.remainingMinutes).toBeCloseTo(6444.8);
    expect(row.fares).toEqual([{ currency: 'EUR', status: 'completed', totalCents: 1250, tripCount: 1 }]);
    expect(row.conflictCount).toBe(1);
    expect(row.unverifiableCount).toBe(1);
  });

  it('shows over budget as a positive number and no remaining capacity', () => {
    const [row] = driverTableRows(
      result({
        drivers: [driverAnalysis({
          budgetComparison: {
            maxMinutes: 60, minMinutes: 30, activityMinutes: 90, shiftMinutes: null,
            activityVsMaxMinutes: 30, shiftVsMaxMinutes: null,
          },
        })],
      }),
      [anna],
      [],
    );
    expect(row.overByMinutes).toBe(30);
    expect(row.remainingMinutes).toBe(0);
  });

  it('keeps a driver the company does not know, unlinked, and without a budget', () => {
    const [row] = driverTableRows(result({ drivers: [driverAnalysis({ driverId: 'ghost', driverNames: ['Geist'] })] }), [anna], []);
    expect(row.linked).toBe(false);
    expect(row.name).toBe('Geist');
    expect(row.overByMinutes).toBeNull();
    expect(row.salaryMax).toBeNull();
  });

  it("adds the drivers' fare totals by currency", () => {
    expect(fareTotals(result({ drivers: [driverAnalysis(), driverAnalysis({ driverId: 'drv2' })] }))).toEqual([
      { currency: 'EUR', status: 'completed', totalCents: 2500, tripCount: 2 },
    ]);
  });
});

describe('unlinkedDrivers', () => {
  it('groups trips without a driver id by name, and names an id the company does not know', () => {
    const got = unlinkedDrivers(
      [trip('t1'), trip('t2', { driver_id: null, driver_name: 'Zoe Unbekannt' }), trip('t3', { driver_id: null, driver_name: 'Zoe Unbekannt' }),
       trip('t4', { driver_id: 'old', driver_name: 'Ben Alt' })],
      [anna],
    );
    expect(got).toEqual([
      { name: 'Ben Alt', driverId: 'old', tripIds: ['t4'] },
      { name: 'Zoe Unbekannt', driverId: null, tripIds: ['t2', 't3'] },
    ]);
  });
});

describe('issues', () => {
  const issues = [
    issue('a'),
    issue('b', { type: 'travel_gap', severity: 'info', status: 'unverifiable' }),
    issue('c', { type: 'travel_gap', severity: 'warning', status: 'passed', driverId: 'drv2' }),
  ];

  it('filters by type, severity, status and driver', () => {
    expect(filterIssues(issues, { type: 'travel_gap', severity: 'all', status: 'all' }).map(i => i.id)).toEqual(['b', 'c']);
    expect(filterIssues(issues, { type: 'all', severity: 'all', status: 'unverifiable' }).map(i => i.id)).toEqual(['b']);
    expect(filterIssues(issues, { type: 'all', severity: 'error', status: 'all' }).map(i => i.id)).toEqual(['a']);
    expect(filterIssues(issues, { type: 'all', severity: 'all', status: 'all', driverId: 'drv2' }).map(i => i.id)).toEqual(['c']);
  });

  it('counts each of the three statuses', () => {
    expect(issueStatusCounts(issues)).toEqual({ passed: 1, conflict: 1, unverifiable: 1 });
  });
});

describe('the Berlin clock', () => {
  it('formats and keys an instant on Berlin time', () => {
    expect(formatBerlinDateTime(at('2026-08-31T22:30:05Z'))).toBe('01.09.2026, 00:30:05');
    expect(berlinDateKey(at('2026-08-31T22:30:00Z'))).toBe('2026-09-01');
  });

  it('knows a DST day is 25 hours long', () => {
    const bounds = berlinDayBounds('2026-10-25');
    expect(bounds.endMs - bounds.startMs).toBe(25 * 3_600_000);
  });
});

describe('driverTimeline', () => {
  it('cuts a trip across midnight into the two days it touches, marking the cut', () => {
    const night = trip('t1', { start_ms: at('2026-08-03T21:00:00Z'), end_ms: at('2026-08-03T23:00:00Z') });
    const shifts: AnalysisShift[] = [
      { id: 's1', driver_id: 'drv1', start_ms: at('2026-08-03T20:00:00Z'), end_ms: at('2026-08-03T21:30:00Z'), source: 'saved_stundennachweis' },
    ];
    const days = driverTimeline(
      result({
        trips: [{ trip: night, blockId: 'drv1#0', excludedBecause: [], outsideShiftMs: null, issueIds: ['i1'] }],
        blocks: [block({ startMs: night.start_ms!, endMs: night.end_ms! })],
        issues: [issue('i1', { type: 'activity_outside_shift', status: 'conflict' })],
      }),
      'drv1',
      shifts,
    );
    expect(days.map(d => d.dateKey)).toEqual(['2026-08-03', '2026-08-04']);
    const tripFirst = days[0].segments.find(s => s.lane === 'trip')!;
    const tripSecond = days[1].segments.find(s => s.lane === 'trip')!;
    // 23:00 Berlin to midnight, then midnight to 01:00.
    expect(tripFirst.from).toBeCloseTo(23 / 24);
    expect(tripFirst.to).toBeCloseTo(1);
    expect(tripFirst.clippedEnd).toBe(true);
    expect(tripSecond.from).toBe(0);
    expect(tripSecond.to).toBeCloseTo(1 / 24);
    expect(tripSecond.clippedStart).toBe(true);
    expect(days[0].segments.find(s => s.lane === 'issue')?.status).toBe('conflict');
    expect(days[0].segments.some(s => s.lane === 'shift')).toBe(true);
    expect(days[0].segments.some(s => s.lane === 'block')).toBe(true);
  });

  it('answers nothing for a driver the result does not know', () => {
    expect(driverTimeline(result(), 'nobody', [])).toEqual([]);
  });
});
