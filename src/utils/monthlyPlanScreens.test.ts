import { describe, it, expect } from 'vitest';
import {
  plannableMonths,
  dayBefore,
  notesQueryFromDate,
  estimateSalaryCents,
  buildPlanSummaryRows,
  groupWarnings,
  type PlanImportRow,
} from './monthlyPlanScreens';
import {
  computeHoursRange,
  assessAgainstRange,
  type AssignResult,
  type DriverPlanState,
  type PlanDriverInput,
  type PlanViolation,
  type PlanWarning,
  type ValidationResult,
} from './monthlyPlan';

/**
 * These are the screens' own derivations, not the engine's rules. The figures
 * come from §5 and §16 of `تعليمات_كلود_لتنفيذ_التخطيط_الشهري.md` and are
 * written out literally rather than recomputed from the implementation.
 */

// ── plannableMonths ─────────────────────────────────────────────────────────

/** An import row with this file's defaults. Written out rather than spread, so
 *  the fixture's own type cannot depend on how a spread of optionals infers. */
function imp(over: {
  id: string;
  month?: number | null;
  year?: number | null;
  file_name?: string | null;
  imported_at?: string | null;
  row_count?: number | null;
  status?: string | null;
}): PlanImportRow {
  return {
    id: over.id,
    month: over.month === undefined ? 8 : over.month,
    year: over.year === undefined ? 2026 : over.year,
    file_name: over.file_name === undefined ? 'fahrten.xlsx' : over.file_name,
    imported_at: over.imported_at === undefined ? '2026-09-01T10:00:00Z' : over.imported_at,
    row_count: over.row_count === undefined ? 100 : over.row_count,
    status: over.status === undefined ? 'confirmed' : over.status,
  };
}

describe('plannableMonths', () => {
  it('offers one entry per calendar month, newest first', () => {
    const { months } = plannableMonths([
      imp({ id: 'a', month: 7, year: 2026 }),
      imp({ id: 'b', month: 8, year: 2026 }),
      imp({ id: 'c', month: 12, year: 2025 }),
    ]);
    expect(months.map(m => m.key)).toEqual(['2026-08', '2026-07', '2025-12']);
  });

  it("still offers a legacy 'pending' import", () => {
    // The status column has existed since 20260605082259 with a default of
    // 'pending' and nothing ever read it, so every row written before the
    // current import path is still 'pending'. A rule of `status = 'confirmed'`
    // would hide those months entirely — this is the test that fails if
    // somebody narrows it that way.
    const { months } = plannableMonths([imp({ id: 'legacy', status: 'pending' })]);
    expect(months).toHaveLength(1);
    expect(months[0].imports[0].id).toBe('legacy');
  });

  it('leaves out an archived import and reports it', () => {
    const { months, archived } = plannableMonths([
      imp({ id: 'live' }),
      imp({ id: 'gone', status: 'archived' }),
    ]);
    expect(months[0].imports.map(i => i.id)).toEqual(['live']);
    expect(archived).toEqual(['gone']);
  });

  it('drops a month only when the month itself cannot be read, and says so', () => {
    const { months, unreadable } = plannableMonths([
      imp({ id: 'ok' }),
      imp({ id: 'no-month', month: null }),
      imp({ id: 'month-13', month: 13 }),
      imp({ id: 'month-0', month: 0 }),
      imp({ id: 'no-year', year: null }),
    ]);
    expect(months).toHaveLength(1);
    expect(unreadable.sort()).toEqual(['month-0', 'month-13', 'no-month', 'no-year']);
  });

  it('sums row_count over a month and orders its imports newest first', () => {
    const { months } = plannableMonths([
      imp({ id: 'older', imported_at: '2026-09-01T08:00:00Z', row_count: 40 }),
      imp({ id: 'newer', imported_at: '2026-09-02T08:00:00Z', row_count: 60 }),
      imp({ id: 'undated', imported_at: null, row_count: 1 }),
    ]);
    expect(months[0].rowCount).toBe(101);
    expect(months[0].imports.map(i => i.id)).toEqual(['newer', 'older', 'undated']);
  });

  it('breaks a timestamp tie on the id, so the order cannot change between renders', () => {
    const at = '2026-09-01T08:00:00Z';
    const forward = plannableMonths([imp({ id: 'b', imported_at: at }), imp({ id: 'a', imported_at: at })]);
    const backward = plannableMonths([imp({ id: 'a', imported_at: at }), imp({ id: 'b', imported_at: at })]);
    expect(forward.months[0].imports.map(i => i.id)).toEqual(['a', 'b']);
    expect(backward.months[0].imports.map(i => i.id)).toEqual(['a', 'b']);
  });

  it('reads no month from an empty list rather than inventing one', () => {
    expect(plannableMonths([])).toEqual({ months: [], archived: [], unreadable: [] });
  });
});

// ── dayBefore / notesQueryFromDate ──────────────────────────────────────────

describe('dayBefore', () => {
  it('rolls back a day, a month and a year', () => {
    expect(dayBefore('2026-08-15')).toBe('2026-08-14');
    expect(dayBefore('2026-08-01')).toBe('2026-07-31');
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    // 2024 is a leap year.
    expect(dayBefore('2024-03-01')).toBe('2024-02-29');
  });

  it('crosses the March DST transition without losing the day', () => {
    // vitest pins TZ=Europe/Berlin, where 2026-03-29 is 23 hours long. The day
    // boundaries are built from calendar parts, so subtracting one day is still
    // one calendar day and not 24 hours.
    expect(dayBefore('2026-03-30')).toBe('2026-03-29');
    expect(dayBefore('2026-03-29')).toBe('2026-03-28');
    expect(dayBefore('2026-10-26')).toBe('2026-10-25');
  });

  it('answers null for anything that is not a plain date', () => {
    for (const bad of ['', '2026-8-1', '15.08.2026', '2026-08-15T10:00:00Z', 'nope']) {
      expect(dayBefore(bad)).toBeNull();
    }
  });
});

describe('notesQueryFromDate', () => {
  it('reaches one day before the earliest ride, not the month it is named after', () => {
    // An import for August carrying a ride dated 31 July: a note whose window
    // ends on 31 July can still cover that ride, so the query must reach it. A
    // bound of the month's own first day would drop the note and the exclusion
    // with it — a hard constraint failing open, silently.
    expect(notesQueryFromDate(['2026-08-04', '2026-07-31', '2026-08-20'], '2026-08-01'))
      .toBe('2026-07-30');
  });

  it('falls back to the month when no ride has a readable date', () => {
    expect(notesQueryFromDate([], '2026-08-01')).toBe('2026-08-01');
    expect(notesQueryFromDate([null, undefined, '', 'not-a-date'], '2026-08-01')).toBe('2026-08-01');
  });

  it('cannot be lowered by a malformed date', () => {
    // '0001-01-01' would be readable and would legitimately lower the bound;
    // '1-1-1' is not, and must not.
    expect(notesQueryFromDate(['2026-08-10', '1-1-1'], '2026-08-01')).toBe('2026-08-09');
  });

  it('reads a timestamp as its calendar day', () => {
    expect(notesQueryFromDate(['2026-08-10T23:30:00Z'], '2026-08-01')).toBe('2026-08-09');
  });
});

// ── estimateSalaryCents ─────────────────────────────────────────────────────

describe('estimateSalaryCents — the inverse of §5, at the same rate', () => {
  it('prices §16\'s own pair: 1950 € ÷ 14 €/h worked back to 1.950,00 €', () => {
    // 1950/14 h is 139,285714… h = 8357,142857… minutes. Worked exactly, the
    // minimum salary comes back out.
    expect(estimateSalaryCents((1950 / 14) * 60, 14)).toBe(195000);
    // 2100 € ÷ 14 €/h is exactly 150 h = 9000 minutes.
    expect(estimateSalaryCents(9000, 14)).toBe(210000);
  });

  it('prices whole minutes as whole minutes, not as the bound', () => {
    // 8357 integer minutes at 14 €/h is 1.949,97 €, three cents under the
    // minimum, because the driver worked 8357 minutes and not 8357,142857.
    // A screen that printed 1.950,00 € here would be claiming the bound was met.
    expect(estimateSalaryCents(8357, 14)).toBe(194997);
  });

  it('does not round the hourly rate before multiplying', () => {
    // planning_hourly_rate is a bare numeric, so 14,125 €/h is storable. Two
    // hours of it is exactly 28,25 €. Rounding the rate to cents first (1413)
    // and multiplying would give 28,26 € — one cent per hour, every hour.
    expect(estimateSalaryCents(120, 14.125)).toBe(2825);
    expect(estimateSalaryCents(120, 14.125)).not.toBe(2826);
  });

  it('answers null — never 0 — for a rate that cannot be used', () => {
    // 0 € is a claim that the driver costs nothing. This is the defect
    // HistoricalWorkingHoursWizard.tsx:10121 has, and the reason this returns
    // an absent value instead.
    for (const rate of [0, -14, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateSalaryCents(6000, rate as number | null | undefined)).toBeNull();
    }
  });

  it('prices no hours as nothing, and refuses impossible minutes', () => {
    expect(estimateSalaryCents(0, 14)).toBe(0);
    expect(estimateSalaryCents(-60, 14)).toBeNull();
    expect(estimateSalaryCents(Number.NaN, 14)).toBeNull();
  });

  it('answers null instead of throwing on an absurd rate', () => {
    // toCents throws above the safe-integer range; the summary screen must not
    // go down because one driver's rate is nonsense.
    expect(estimateSalaryCents(6000, 1e15)).toBeNull();
  });
});

// ── buildPlanSummaryRows ────────────────────────────────────────────────────

/**
 * A driver on §16's figures: 1950–2100 € at 14 €/h, so the range is 139,29–150 h.
 *
 * `=== undefined` rather than `??`, because a test that passes `hourlyRate: null`
 * means null and must not be given the default back.
 */
function driver(over: {
  id: string;
  name: string;
  isOwner?: boolean;
  minSalary?: number | null;
  maxSalary?: number | null;
  hourlyRate?: number | null;
}): PlanDriverInput {
  return {
    id: over.id,
    name: over.name,
    isOwner: over.isOwner === undefined ? false : over.isOwner,
    minSalary: over.minSalary === undefined ? 1950 : over.minSalary,
    maxSalary: over.maxSalary === undefined ? 2100 : over.maxSalary,
    hourlyRate: over.hourlyRate === undefined ? 14 : over.hourlyRate,
  };
}

function state(d: PlanDriverInput, minutes: number, blocks = 2, trips = 5): DriverPlanState {
  const range = computeHoursRange({
    minSalary: d.minSalary,
    maxSalary: d.maxSalary,
    hourlyRate: d.hourlyRate,
    isOwner: d.isOwner,
  });
  return {
    driver: d,
    range,
    assignedBlockIds: Array.from({ length: blocks }, (_, i) => `${d.id}|b${i}`),
    minutes,
    rideMinutes: Math.round(minutes * 0.8),
    tripCount: trips,
    assessment: assessAgainstRange(minutes, range, d.isOwner),
  };
}

const result = (states: DriverPlanState[]): AssignResult => ({
  assignments: [],
  unassigned: [],
  pinConflicts: [],
  driverStates: states,
});

const validation = (
  violations: PlanViolation[] = [],
  warnings: PlanWarning[] = [],
): ValidationResult => ({ violations, warnings, confirmable: violations.length === 0 });

describe('buildPlanSummaryRows', () => {
  it('produces exactly one row per driver, by name (criterion 13)', () => {
    const rows = buildPlanSummaryRows(
      result([
        state(driver({ id: '2', name: 'Zeller' }), 9000),
        state(driver({ id: '1', name: 'Albrecht' }), 9000),
      ]),
      validation(),
    );
    expect(rows.map(r => r.driverName)).toEqual(['Albrecht', 'Zeller']);
    expect(rows).toHaveLength(2);
  });

  it('carries the engine\'s own hours figures and nothing recomputed', () => {
    const d = driver({ id: '1', name: 'A' });
    const rows = buildPlanSummaryRows(result([state(d, 8400)]), validation());
    const row = rows[0];
    expect(row.assignedMinutes).toBe(8400);
    expect(row.minHours!.toFixed(2)).toBe('139.29');
    expect(row.maxHours).toBe(150);
    expect(row.effectiveMaxHours).toBe(150);
    // 8400 minutes is 140 h, inside 139,29–150.
    expect(row.status).toBe('in_range');
    expect(row.deviationHours).toBe(0);
    expect(row.blockCount).toBe(2);
    expect(row.tripCount).toBe(5);
    // 140 h × 14 €/h = 1.960,00 €.
    expect(row.estimatedSalaryCents).toBe(196000);
  });

  it('never carries a monthly-target field (§5 forbids reading it at all)', () => {
    const rows = buildPlanSummaryRows(result([state(driver({ id: '1', name: 'A' }), 9000)]), validation());
    expect(Object.keys(rows[0]).filter(k => /target/i.test(k))).toEqual([]);
  });

  it('shows a violation as a blocking conflict, ahead of the range position', () => {
    const d = driver({ id: '1', name: 'A' });
    const rows = buildPlanSummaryRows(
      result([state(d, 8400)]),
      validation([{ rule: 'driver_overlap', blockId: 'x', driverId: '1', detail: 'blocks x and y overlap' }]),
    );
    expect(rows[0].status).toBe('has_conflict');
    expect(rows[0].blocking).toBe(true);
    expect(rows[0].conflicts).toEqual(['driver_overlap: blocks x and y overlap']);
  });

  it('shows a driver-scoped warning as a conflict that does not block', () => {
    const d = driver({ id: '1', name: 'A' });
    const rows = buildPlanSummaryRows(
      result([state(d, 8400)]),
      validation([], [{ kind: 'unmet_mandatory_note', driverId: '1', noteId: 'n1', detail: 'no_matching_block' }]),
    );
    expect(rows[0].status).toBe('has_conflict');
    expect(rows[0].blocking).toBe(false);
  });

  it('leaves a row alone for a plan-wide warning that names no driver', () => {
    // An unassigned block belongs to the plan, not to a driver. Marking every
    // row as conflicted because one block could not be covered would make the
    // status column useless.
    const rows = buildPlanSummaryRows(
      result([state(driver({ id: '1', name: 'A' }), 8400)]),
      validation([], [
        { kind: 'unassigned_block', blockId: 'b', detail: 'no selected driver was available' },
        { kind: 'contested_block', blockId: 'c', detail: 'mandatory claims by 1 and 2' },
      ]),
    );
    expect(rows[0].status).toBe('in_range');
    expect(rows[0].conflicts).toEqual([]);
  });

  it('keeps the owner as the owner, with no cap and no deviation (§8)', () => {
    const owner = driver({ id: '1', name: 'Inhaber', isOwner: true });
    const rows = buildPlanSummaryRows(result([state(owner, 20000)]), validation());
    expect(rows[0].status).toBe('owner');
    expect(rows[0].effectiveMaxHours).toBeNull();
    expect(rows[0].deviationHours).toBeNull();
    // The owner is still priced — §8 exempts them from the ceiling, not from
    // pay. 20000 minutes is 333,333… h, which at 14 €/h is 4.666,67 €.
    expect(rows[0].estimatedSalaryCents).toBe(466667);
  });

  it('reports a missing rate as no_range with no estimate and the reason', () => {
    const broken = driver({ id: '1', name: 'A', hourlyRate: null });
    const rows = buildPlanSummaryRows(result([state(broken, 8400)]), validation());
    expect(rows[0].status).toBe('no_range');
    expect(rows[0].estimatedSalaryCents).toBeNull();
    expect(rows[0].rangeProblems).toContain('missing_hourly_rate');
  });

  it('separates a driver with no hours from one merely below the minimum', () => {
    const rows = buildPlanSummaryRows(
      result([
        state(driver({ id: '1', name: 'Leer' }), 0, 0, 0),
        state(driver({ id: '2', name: 'Wenig' }), 6000),
      ]),
      validation(),
    );
    expect(rows[0].status).toBe('no_hours');
    expect(rows[1].status).toBe('below');
    expect(rows[1].deviationHours).toBeCloseTo(100 - 1950 / 14, 10);
  });

  it('reports over the cap with a positive deviation', () => {
    // 9060 minutes is 151 h against a 150 h cap.
    const rows = buildPlanSummaryRows(result([state(driver({ id: '1', name: 'A' }), 9060)]), validation());
    expect(rows[0].status).toBe('above_cap');
    expect(rows[0].deviationHours).toBeCloseTo(1, 10);
  });
});

// ── groupWarnings ───────────────────────────────────────────────────────────

describe('groupWarnings', () => {
  it('counts every warning by kind, most frequent first', () => {
    const groups = groupWarnings(
      validation([], [
        { kind: 'unassigned_block', blockId: '1', detail: 'a' },
        { kind: 'unassigned_block', blockId: '2', detail: 'b' },
        { kind: 'rejected_trip', tripId: 't', detail: 'missing_start' },
      ]),
    );
    expect(groups.map(g => [g.kind, g.count])).toEqual([
      ['unassigned_block', 2],
      ['rejected_trip', 1],
    ]);
  });

  it('counts all of them but samples only a few', () => {
    const many: PlanWarning[] = Array.from({ length: 12 }, (_unused, i): PlanWarning => ({
      kind: 'unassigned_block',
      blockId: String(i),
      detail: `block ${i}`,
    }));
    const [group] = groupWarnings(validation([], many), 3);
    // The count is the truth; the samples are only what fits on screen.
    expect(group.count).toBe(12);
    expect(group.samples).toEqual(['block 0', 'block 1', 'block 2']);
  });

  it('counts a driver-scoped warning here as well as on the driver\'s row', () => {
    // Criterion 23: nothing silently dropped. The row says which driver, this
    // panel says how many of each kind — subtracting one from the other would
    // make the two disagree about the same plan.
    const v = validation([], [{ kind: 'pin_conflict', driverId: '1', blockId: 'b', detail: 'driver_overlap' }]);
    expect(groupWarnings(v)[0].count).toBe(1);
    expect(buildPlanSummaryRows(result([state(driver({ id: '1', name: 'A' }), 8400)]), v)[0].conflicts)
      .toHaveLength(1);
  });
});
