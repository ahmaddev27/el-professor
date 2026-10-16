import { describe, expect, it } from 'vitest';
import { buildImportRows, weekNumberOf } from '../../../src/utils/uberEarningsImport';
import type { UberDriverEarnings } from './uber-earnings-core';
import { addDaysIso, mondayOf } from './uber-earnings-core';
import {
  buildDayRows,
  businessWeekNumber,
  completedOperatingDay,
  dueOccurrence,
  isFailure,
  isGap,
  planDay,
  unmatchedNotes,
  outcomeOfRefusal,
  planCompany,
  runningOperatingDay,
  type UberPullCompany,
} from './uber-pull-core';

/** A Berlin wall-clock moment as an instant; summer is +02:00, winter +01:00. */
const berlin = (iso: string, offset: '+01:00' | '+02:00') => new Date(`${iso}${offset}`);

function company(over: Partial<UberPullCompany> = {}): UberPullCompany {
  return {
    company_id: 'c1', run_time: '06:00', replace_corrections: false,
    armed_at: '2026-10-01T00:00:00Z', runs: [], ...over,
  };
}

describe('the operating day', () => {
  it('is still the previous calendar day before 04:00 Berlin time', () => {
    expect(runningOperatingDay(berlin('2026-10-15T03:59:00', '+02:00'))).toBe('2026-10-14');
    expect(runningOperatingDay(berlin('2026-10-15T04:00:00', '+02:00'))).toBe('2026-10-15');
  });

  it('pulls the COMPLETED day, never the one still running', () => {
    // At 10:00 on the 15th the running day is the 15th, so the 14th is complete.
    expect(completedOperatingDay(berlin('2026-10-15T10:00:00', '+02:00'))).toBe('2026-10-14');
    // At 03:00 on the 15th the 14th is still running; the 13th is the complete one.
    expect(completedOperatingDay(berlin('2026-10-15T03:00:00', '+02:00'))).toBe('2026-10-13');
  });

  it('holds on the spring-forward night (29.03.2026, 02:00 to 03:00)', () => {
    expect(runningOperatingDay(berlin('2026-03-29T03:30:00', '+02:00'))).toBe('2026-03-28');
    expect(runningOperatingDay(berlin('2026-03-29T04:00:00', '+02:00'))).toBe('2026-03-29');
    expect(completedOperatingDay(berlin('2026-03-29T06:00:00', '+02:00'))).toBe('2026-03-28');
  });

  it('holds on the fall-back night (25.10.2026, 03:00 to 02:00)', () => {
    // 02:30 happens twice that night; both are before 04:00, so both are still the 24th's day.
    expect(runningOperatingDay(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-24');
    expect(runningOperatingDay(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-24');
    expect(runningOperatingDay(berlin('2026-10-25T04:00:00', '+01:00'))).toBe('2026-10-25');
    expect(completedOperatingDay(berlin('2026-10-25T06:00:00', '+01:00'))).toBe('2026-10-24');
  });
});

describe('when an occurrence is due, and for which day', () => {
  it('is due from the scheduled moment and pulls the day that completed at 04:00', () => {
    const due = dueOccurrence(company(), berlin('2026-10-15T06:10:00', '+02:00'));
    expect(due).toEqual({ due: { occurrenceDay: '2026-10-15', pullDay: '2026-10-14' } });
  });

  it('is not due before the moment: yesterday\'s occurrence is the candidate, and it is stale', () => {
    const early = dueOccurrence(company(), berlin('2026-10-15T05:50:00', '+02:00'));
    // 23h50 after yesterday's 06:00, far outside the grace window.
    expect(early).toEqual({ due: null, reason: 'missed' });
  });

  it('asks for the same day on every tick of the window', () => {
    const first = dueOccurrence(company(), berlin('2026-10-15T06:00:00', '+02:00'));
    const last = dueOccurrence(company(), berlin('2026-10-15T17:59:00', '+02:00'));
    expect(first).toEqual(last);
  });

  it('is missed once the grace window has gone by', () => {
    expect(dueOccurrence(company(), berlin('2026-10-15T18:01:00', '+02:00')))
      .toEqual({ due: null, reason: 'missed' });
  });

  it('with a run time before 04:00 still pulls a day that has completed', () => {
    // 03:00 on the 15th: the running day is the 14th, so the 13th is the one to pull.
    const due = dueOccurrence(company({ run_time: '03:00' }), berlin('2026-10-15T03:10:00', '+02:00'));
    expect(due).toEqual({ due: { occurrenceDay: '2026-10-15', pullDay: '2026-10-13' } });
  });

  it('is correct on the DST days', () => {
    // 06:00 on 29.03.2026 (summer time already): the 28th completed at 04:00.
    expect(dueOccurrence(company({ armed_at: '2026-03-01T00:00:00Z' }), berlin('2026-03-29T06:20:00', '+02:00')))
      .toEqual({ due: { occurrenceDay: '2026-03-29', pullDay: '2026-03-28' } });
    // 06:00 on 25.10.2026 (winter time again): the 24th completed at 04:00.
    expect(dueOccurrence(company({ armed_at: '2026-10-01T00:00:00Z' }), berlin('2026-10-25T06:20:00', '+01:00')))
      .toEqual({ due: { occurrenceDay: '2026-10-25', pullDay: '2026-10-24' } });
  });

  it('never fires for a moment before the schedule was last changed', () => {
    // Armed at 07:00 the same day: the 06:00 occurrence belongs to the old schedule.
    const armed = berlin('2026-10-15T07:00:00', '+02:00').toISOString();
    expect(dueOccurrence(company({ armed_at: armed }), berlin('2026-10-15T07:30:00', '+02:00')))
      .toEqual({ due: null, reason: 'before_armed' });
    // The next morning's occurrence is after it.
    expect(dueOccurrence(company({ armed_at: armed }), berlin('2026-10-16T06:05:00', '+02:00')))
      .toEqual({ due: { occurrenceDay: '2026-10-16', pullDay: '2026-10-15' } });
  });

  it('a time moved mid-day does not fire the old moment, only the new one', () => {
    // Was 06:00, moved to 09:00 at 08:00: armed_at is 08:00.
    const armed = berlin('2026-10-15T08:00:00', '+02:00').toISOString();
    const moved = company({ run_time: '09:00', armed_at: armed });
    expect(dueOccurrence(moved, berlin('2026-10-15T08:30:00', '+02:00')).due).toBeNull();
    expect(dueOccurrence(moved, berlin('2026-10-15T09:05:00', '+02:00')).due)
      .toEqual({ occurrenceDay: '2026-10-15', pullDay: '2026-10-14' });
  });

  it('refuses a schedule it cannot read', () => {
    expect(dueOccurrence(company({ run_time: 'soon' }), new Date())).toEqual({ due: null, reason: 'invalid_schedule' });
    expect(dueOccurrence(company({ armed_at: 'never' }), new Date())).toEqual({ due: null, reason: 'invalid_schedule' });
  });
});

describe('what is claimed', () => {
  const NOW = berlin('2026-10-15T06:10:00', '+02:00');

  it('claims the completed day once', () => {
    expect(planCompany(company(), NOW)?.tasks).toEqual([{ day: '2026-10-14', pass: 'first' }]);
  });

  it('a day already claimed is not claimed again, whatever became of it', () => {
    for (const outcome of ['imported', 'partner_unavailable', 'blocked_unlinked', null]) {
      const held = company({ runs: [{ day_key: '2026-10-14', pass: 'first', outcome }] });
      expect(planCompany(held, NOW), String(outcome)).toBeNull();
    }
  });

  it('claims no recheck unless the corrections switch is on', () => {
    const runs = [{ day_key: '2026-10-13', pass: 'first', outcome: 'imported' }];
    expect(planCompany(company({ runs }), NOW)?.tasks).toEqual([{ day: '2026-10-14', pass: 'first' }]);
  });

  it('rechecks the day before, only when its first pass was imported, and once', () => {
    const imported = [{ day_key: '2026-10-13', pass: 'first', outcome: 'imported' }];
    expect(planCompany(company({ replace_corrections: true, runs: imported }), NOW)?.tasks).toEqual([
      { day: '2026-10-14', pass: 'first' },
      { day: '2026-10-13', pass: 'recheck' },
    ]);
    const failed = [{ day_key: '2026-10-13', pass: 'first', outcome: 'partner_unavailable' }];
    expect(planCompany(company({ replace_corrections: true, runs: failed }), NOW)?.tasks)
      .toEqual([{ day: '2026-10-14', pass: 'first' }]);
    const done = [...imported, { day_key: '2026-10-13', pass: 'recheck', outcome: 'imported' }];
    expect(planCompany(company({ replace_corrections: true, runs: done }), NOW)?.tasks)
      .toEqual([{ day: '2026-10-14', pass: 'first' }]);
  });

  it('rechecks a day that was imported with a gap too', () => {
    const gapped = [{ day_key: '2026-10-13', pass: 'first', outcome: 'imported_with_gap' }];
    expect(planCompany(company({ replace_corrections: true, runs: gapped }), NOW)?.tasks).toEqual([
      { day: '2026-10-14', pass: 'first' },
      { day: '2026-10-13', pass: 'recheck' },
    ]);
  });

  it('plans nothing when nothing is due', () => {
    expect(planCompany(company(), berlin('2026-10-15T21:00:00', '+02:00'))).toBeNull();
  });
});

describe('the rows of one day', () => {
  const driver = (over: Partial<UberDriverEarnings> = {}): UberDriverEarnings => ({
    externalDriverId: '4711', uberDriverUuid: null, name: 'X', fareCents: 12345, promotionCents: 0,
    tipsCents: 250, cashCents: 1000, netOutstandingCents: 0, trips: 7, differenceCents: 0, ...over,
  });

  it('writes one row per driver per type, zero amounts left out, trips on umsatz only', () => {
    const rows = buildDayRows('2026-10-14', [driver()]);
    expect(rows.map((r) => [r.type, r.amount, r.trip_count])).toEqual([
      ['umsatz', '123.45', 7], ['trinkgeld', '2.50', null], ['bargeld', '10.00', null],
    ]);
    expect(rows.every((r) => r.period_start === '2026-10-14' && r.period_end === '2026-10-14' && r.date === '2026-10-14')).toBe(true);
  });

  it('keeps a day of trips and no fare as a umsatz of zero', () => {
    const rows = buildDayRows('2026-10-14', [driver({ fareCents: 0, tipsCents: 0, cashCents: 0 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'umsatz', amount: '0.00', trip_count: 7 });
  });

  it('is the screen\'s own row for the same day (parity with buildImportRows)', () => {
    const day = '2026-10-14';
    const monday = mondayOf(day);
    const screen = buildImportRows([{ segment: { from: day, to: day, monday }, drivers: [driver()] }]);
    expect(buildDayRows(day, [driver()])).toEqual(screen);
  });
});

describe('the week number', () => {
  it('equals the screen\'s weekNumberOf for every Monday of four years', () => {
    let monday = '2025-01-06';
    const differences: string[] = [];
    while (monday < '2029-01-01') {
      const screen = weekNumberOf({ from: monday, to: addDaysIso(monday, 6), monday });
      if (businessWeekNumber(monday) !== screen) differences.push(`${monday}: ${businessWeekNumber(monday)} vs ${screen}`);
      monday = addDaysIso(monday, 7);
    }
    expect(differences).toEqual([]);
  });
});

describe('outcomes', () => {
  it('only imported and nothing_to_import are not failures, and a claim with no outcome is one', () => {
    expect(isFailure('imported')).toBe(false);
    expect(isFailure('nothing_to_import')).toBe(false);
    expect(isFailure('already_imported')).toBe(true);
    expect(isFailure('partner_unavailable')).toBe(true);
    expect(isFailure(null)).toBe(true);
  });

  it('a gap is neither a success nor a failure, and only it is a gap', () => {
    expect(isFailure('imported_with_gap')).toBe(false);
    expect(isGap('imported_with_gap')).toBe(true);
    expect(isGap('imported')).toBe(false);
    expect(isGap(null)).toBe(false);
  });

  it('maps a writer refusal to the outcome a person reads', () => {
    expect(outcomeOfRefusal('already_imported')).toBe('already_imported');
    expect(outcomeOfRefusal('driver_not_linked')).toBe('blocked_unlinked');
    expect(outcomeOfRefusal('anything else')).toBe('refused');
  });
});


describe('a day with an earner Reidey could not place', () => {
  const day = '2026-10-14';
  const sent = (id: string, fare: number): UberDriverEarnings => ({
    externalDriverId: id, uberDriverUuid: null, name: 'N' + id, fareCents: fare, promotionCents: 0,
    tipsCents: 0, cashCents: 0, netOutstandingCents: 0, trips: 3, differenceCents: 0,
  });
  const nobody = { name: 'Nobody Known', uberDriverUuid: null, trips: 12 };
  const linked = new Set(['1', '2']);

  it('still has the matched earners\' rows to write', () => {
    const plan = planDay(day, [sent('1', 1000), sent('2', 2000)], [nobody], linked);
    expect(plan.unlinked).toBe(0);
    expect(plan.rows.map((r) => r.external_driver_id)).toEqual(['1', '2']);
  });

  it('carries the unmatched earner to the run\'s record, with the trip count', () => {
    const plan = planDay(day, [sent('1', 1000)], [nobody, nobody], linked);
    expect(plan.unmatched).toEqual([{ name: 'Nobody Known', trips: 12 }]);
  });

  it('records a day of only unmatched earners as a gap, and an empty day as nothing', () => {
    expect(planDay(day, [], [nobody], linked)).toMatchObject({ rows: [], emptyOutcome: 'imported_with_gap' });
    expect(planDay(day, [], [], linked)).toMatchObject({ rows: [], emptyOutcome: 'nothing_to_import' });
  });

  it('keeps stopping the day for an earner who has money and no link', () => {
    expect(planDay(day, [sent('1', 1000), sent('9', 500)], [nobody], linked).unlinked).toBe(1);
  });

  it('records each earner once and at most 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: 'E' + i, uberDriverUuid: 'u' + i, trips: null }));
    expect(unmatchedNotes(many)).toHaveLength(200);
  });
});
