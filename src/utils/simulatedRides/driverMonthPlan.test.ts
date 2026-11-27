import { describe, expect, it } from 'vitest';
import type { StructuredNote } from '../monatsplanungPhase3';
import { wallTimeToInstant } from '../fahrtenbuchImportParser';
import {
  MAX_DAY_MINUTES,
  MIN_DAY_MINUTES,
  planDriverMonth,
  spreadMinutes,
  type DriverMonthInputs,
  type DriverPlanConfig,
} from './driverMonthPlan';

const SETTINGS = { timeZone: 'Europe/Berlin', operatingDayStartHour: 4 };

/** 1400–1680 € at 14 €/h: 100–120 h, middle 110 h = 6600 min. */
const ANNA: DriverPlanConfig = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Anna Beispiel', status: 'active', employmentType: 'employee',
  planningEnabled: true, allowedWeekdays: [1, 2, 3, 4, 5], workWindowStart: '08:00', workWindowEnd: '16:00',
  isFullDayAvailable: false, minSalary: 1400, maxSalary: 1680, hourlyRate: 14, salaryRatio: 0.45,
  targetSalary: 1500, targetMonthlyHours: 160, maxMonthlyHours: 200,
};

function inputs(over: Partial<DriverMonthInputs> = {}): DriverMonthInputs {
  return { year: 2026, month: 9, settings: SETTINGS, notes: new Map(), uberActiveDays: new Map(), uberWeeklyOnly: new Set(), ...over };
}

function note(over: Partial<StructuredNote>): StructuredNote {
  return {
    id: 'n-1', driver_id: ANNA.id, note_type: 'sick', note_text: '', note_planning_behavior: 'exclude_from_plan',
    is_full_day: true, start_date: null, end_date: null, note_date: null, start_time: null, end_time: null, ...over,
  };
}

const at = (day: string, hh: number, mm = 0): number => {
  const r = wallTimeToInstant({ year: +day.slice(0, 4), month: +day.slice(5, 7), day: +day.slice(8, 10), hour: hh, minute: mm, second: 0 });
  if (r.kind !== 'ok') throw new Error(`no instant ${day} ${hh}:${mm}`);
  return r.ms;
};

const planned = (p: ReturnType<typeof planDriverMonth>) => p.days.filter(d => d.plannedMinutes > 0);

describe('class 1: each driver is planned from his own salary settings', () => {
  it('plans the middle of the range, exactly, spread evenly over the allowed weekdays inside the window', () => {
    const p = planDriverMonth(ANNA, inputs());
    expect(p.planned).toBe(true);
    expect(p.range).toMatchObject({ minHours: 100, effectiveMaxHours: 120 });
    expect(p.targetMinutes).toBe(6600);
    expect(p.plannedMinutes).toBe(6600);
    expect(planned(p)).toHaveLength(22); // the weekdays of September 2026
    for (const d of planned(p)) {
      expect(d.plannedMinutes).toBe(300);
      expect(d.windowStartMs).toBe(at(d.date, 8));
      expect(d.windowEndMs).toBe(at(d.date, 16));
    }
    expect(p.assessment.position).toBe('in_range');
    expect(p.discrepancies).toEqual([]);
  });

  it('a second driver with other settings gets other hours; nobody shares a number', () => {
    const bert = { ...ANNA, id: 'bbbbbbbb-0000-4000-8000-000000000002', minSalary: 840, maxSalary: 1120, hourlyRate: 14 };
    const [a, b] = [planDriverMonth(ANNA, inputs()), planDriverMonth(bert, inputs())];
    expect(b.targetMinutes).toBe(4200); // 60–80 h
    expect(b.plannedMinutes).toBe(4200);
    expect(a.plannedMinutes).not.toBe(b.plannedMinutes);
  });
});

describe('class 2: the legacy hour fields are printed and decide nothing (D5)', () => {
  it('changing target_monthly_hours, max_monthly_hours or planning_target_salary moves no minute', () => {
    const a = planDriverMonth(ANNA, inputs());
    const b = planDriverMonth({ ...ANNA, targetMonthlyHours: 20, maxMonthlyHours: 30, targetSalary: 9000 }, inputs());
    expect(b.days).toEqual(a.days);
    expect(b.plannedMinutes).toBe(a.plannedMinutes);
    expect(b.printed).toMatchObject({ targetMonthlyHours: 20, maxMonthlyHours: 30, targetSalary: 9000 });
  });
});

describe('class 3: employment models', () => {
  it('the owner has no ceiling and is planned at his minimum', () => {
    const p = planDriverMonth({ ...ANNA, employmentType: 'company_owner' }, inputs());
    expect(p.isOwner).toBe(true);
    expect(p.range.effectiveMaxHours).toBeNull();
    expect(p.targetMinutes).toBe(6000);
    expect(p.plannedMinutes).toBe(6000);
    expect(p.assessment.position).toBe('owner');
  });

  it('carries the commission and the employment type through unchanged', () => {
    const p = planDriverMonth({ ...ANNA, employmentType: 'minijob', salaryRatio: 0.5 }, inputs());
    expect(p.employmentType).toBe('minijob');
    expect(p.printed.salaryRatio).toBe(0.5);
  });

  it.each([
    [{ status: 'inactive' }, 'inactive'],
    [{ planningEnabled: false }, 'planning_disabled'],
  ] as const)('%o is not planned (%s)', (over, reason) => {
    const p = planDriverMonth({ ...ANNA, ...over }, inputs());
    expect(p).toMatchObject({ planned: false, notPlannedReason: reason, plannedMinutes: 0 });
    expect(p.days.every(d => d.plannedMinutes === 0)).toBe(true);
  });
});

describe('class 4: leave and sickness from confirmed notes', () => {
  it('a confirmed sick week takes those days away and the other days carry the month', () => {
    const notes = new Map([[ANNA.id, [note({ start_date: '2026-09-07', end_date: '2026-09-11' })]]]);
    const p = planDriverMonth(ANNA, inputs({ notes }));
    const sick = p.days.filter(d => d.date >= '2026-09-07' && d.date <= '2026-09-11');
    expect(sick.every(d => d.status === 'absent' && d.blockingNote?.type === 'sick' && d.plannedMinutes === 0)).toBe(true);
    expect(planned(p)).toHaveLength(17);
    expect(p.plannedMinutes).toBe(6120); // 17 × 360: the rest cannot hold 110 h
    expect(p.discrepancies).toEqual([{ kind: 'target_cut_to_capacity', targetMinutes: 6600, capacityMinutes: 6120 }]);
  });

  it('a note dated only by its notice is not a confirmed absence: the day stays and says why', () => {
    const notes = new Map([[ANNA.id, [note({ id: 'n-2', note_type: 'vacation', note_date: '2026-09-15T09:00:00Z' })]]]);
    const p = planDriverMonth(ANNA, inputs({ notes }));
    const day = p.days.find(d => d.date === '2026-09-15')!;
    expect(day.status).toBe('planned');
    expect(day.reviewNotes).toEqual([{ id: 'n-2', type: 'vacation' }]);
  });

  it('a confirmed part-day note cuts the window to what is left', () => {
    const notes = new Map([[ANNA.id, [note({ note_type: 'off', start_date: '2026-09-16', end_date: '2026-09-16', is_full_day: false, start_time: '08:00', end_time: '12:00' })]]]);
    const day = planDriverMonth(ANNA, inputs({ notes })).days.find(d => d.date === '2026-09-16')!;
    expect(day).toMatchObject({ status: 'planned', capacityMinutes: 240, windowStartMs: at('2026-09-16', 12), windowEndMs: at('2026-09-16', 16) });
    expect(day.blockingNote).toEqual({ id: 'n-1', type: 'off' });
  });

  it('a neutral or including note blocks nothing', () => {
    const notes = new Map([[ANNA.id, [note({ note_planning_behavior: 'neutral', start_date: '2026-09-07', end_date: '2026-09-30' })]]]);
    expect(planDriverMonth(ANNA, inputs({ notes })).plannedMinutes).toBe(6600);
  });
});

describe('class 24: a mismatch the configuration cannot resolve is a row, never an invented hour', () => {
  it('a minimum the days cannot hold: the plan takes what they hold and names the shortfall', () => {
    const p = planDriverMonth({ ...ANNA, minSalary: 2100, maxSalary: 2520 }, inputs()); // 150–180 h
    expect(p.discrepancies).toEqual([{ kind: 'capacity_below_minimum', minMinutes: 9000, capacityMinutes: 7920 }]);
    expect(p.plannedMinutes).toBe(7920);
    expect(p.days.every(d => d.plannedMinutes <= MAX_DAY_MINUTES)).toBe(true);
    expect(p.assessment.position).toBe('below');
    expect(p.printed).toMatchObject({ minSalary: 2100, maxSalary: 2520, hourlyRate: 14 });
  });

  it.each([
    [{ hourlyRate: null }, ['missing_hourly_rate']],
    [{ hourlyRate: 0 }, ['invalid_hourly_rate']],
    [{ minSalary: 2000, maxSalary: 1000 }, ['min_salary_above_max']],
    [{ workWindowEnd: null }, ['work_window_incomplete']],
    [{ workWindowStart: '8 Uhr' }, ['work_window_unreadable']],
    [{ workWindowEnd: '08:00' }, ['work_window_empty']],
  ] as const)('%o is CONFIGURATION_REQUIRED and not planned', (over, problems) => {
    const p = planDriverMonth({ ...ANNA, ...over }, inputs());
    expect(p).toMatchObject({ planned: false, notPlannedReason: 'configuration_required', plannedMinutes: 0 });
    expect(p.discrepancies[0]).toEqual({ kind: 'configuration_required', problems });
  });
});

describe('the days Uber shows', () => {
  it('daily Uber data restricts the plan to the days with activity, and names activity on a day the page forbids', () => {
    const active = new Set(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-05']); // 05 is a Saturday
    const p = planDriverMonth(ANNA, inputs({ uberActiveDays: new Map([[ANNA.id, active]]) }));
    expect(p.uberDetail).toBe('daily');
    expect(planned(p).map(d => d.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(p.days.find(d => d.date === '2026-09-04')!.status).toBe('no_uber_activity');
    expect(p.discrepancies).toContainEqual({ kind: 'uber_activity_on_unavailable_day', date: '2026-09-05', dayStatus: 'weekday_not_allowed' });
    expect(p.discrepancies).toContainEqual({ kind: 'capacity_below_minimum', minMinutes: 6000, capacityMinutes: 1080 });
  });

  it('weekly-only data restricts nothing and is said', () => {
    const p = planDriverMonth(ANNA, inputs({ uberWeeklyOnly: new Set([ANNA.id]) }));
    expect(p.uberDetail).toBe('weekly_only');
    expect(planned(p)).toHaveLength(22);
  });

  it('a driver who is not planned but drove for Uber is a row', () => {
    const p = planDriverMonth({ ...ANNA, planningEnabled: false }, inputs({ uberActiveDays: new Map([[ANNA.id, new Set(['2026-09-01', '2026-09-02'])]]) }));
    expect(p.discrepancies).toEqual([{ kind: 'uber_activity_driver_not_planned', reason: 'planning_disabled', days: 2 }]);
  });
});

describe('windows, the clock and real trips', () => {
  it('a window across midnight ends on the next calendar day and is cut to 360 minutes of work', () => {
    const p = planDriverMonth({ ...ANNA, workWindowStart: '20:00', workWindowEnd: '04:00' }, inputs());
    const d = p.days.find(x => x.date === '2026-09-14')!;
    expect(d.windowStartMs).toBe(at('2026-09-14', 20));
    expect(d.windowEndMs).toBe(at('2026-09-15', 4));
    expect(d.capacityMinutes).toBe(360);
  });

  it('a window starting before 04:00 belongs to the operating day before: 1 October 01:00 is 30 September', () => {
    const p = planDriverMonth({ ...ANNA, allowedWeekdays: null, workWindowStart: '01:00', workWindowEnd: '07:00' }, inputs());
    expect(p.days.find(d => d.date === '2026-09-30')!.windowStartMs).toBe(at('2026-10-01', 1));
    expect(p.days.find(d => d.date === '2026-09-01')!.windowStartMs).toBe(at('2026-09-02', 1));
    expect(p.days).toHaveLength(30);
  });

  it('a window that starts in the hour the clocks skip has no instant and is not planned', () => {
    const p = planDriverMonth({ ...ANNA, allowedWeekdays: null, workWindowStart: '02:30', workWindowEnd: '08:30' }, inputs({ year: 2026, month: 3 }));
    expect(p.days.find(d => d.date === '2026-03-28')!.status).toBe('clock_unreadable');
    expect(p.days).toHaveLength(31);
  });

  it('full-day availability is the whole operating day: 23 hours on 28 March 2026, whose day holds the 02:00 jump', () => {
    const p = planDriverMonth({ ...ANNA, allowedWeekdays: null, isFullDayAvailable: true }, inputs({ year: 2026, month: 3 }));
    const d = p.days.find(x => x.date === '2026-03-28')!;
    expect(((d.windowEndMs ?? 0) - (d.windowStartMs ?? 0)) / 3_600_000).toBe(23);
    expect(p.window?.source).toBe('full_day');
  });

  it('a day that holds real trips is not simulated over (section 4)', () => {
    const p = planDriverMonth(ANNA, inputs({ realTripDays: new Map([[ANNA.id, new Set(['2026-09-02'])]]) }));
    expect(p.days.find(d => d.date === '2026-09-02')).toMatchObject({ status: 'real_trips', plannedMinutes: 0 });
  });

  it('every month length gives one day per calendar day', () => {
    for (const [year, month, n] of [[2027, 2, 28], [2028, 2, 29], [2026, 4, 30], [2026, 10, 31]] as const) {
      expect(planDriverMonth(ANNA, inputs({ year, month })).days).toHaveLength(n);
    }
  });
});

describe('spreading minutes', () => {
  it('sums exactly, respects every cap and differs by at most a minute between uncapped days', () => {
    const caps = [360, 120, 360, 90, 360, 360];
    const out = spreadMinutes(caps, 1201);
    expect(out.reduce((s, m) => s + m, 0)).toBe(1201);
    out.forEach((m, i) => expect(m).toBeLessThanOrEqual(caps[i]));
    const free = out.filter((_, i) => out[i] < caps[i]);
    expect(Math.max(...free) - Math.min(...free)).toBeLessThanOrEqual(1);
  });

  it('a small target uses fewer days rather than shifts under an hour', () => {
    const p = planDriverMonth({ ...ANNA, minSalary: 42, maxSalary: 56 }, inputs()); // 3–4 h
    expect(p.plannedMinutes).toBe(210);
    expect(planned(p).every(d => d.plannedMinutes >= MIN_DAY_MINUTES)).toBe(true);
    expect(planned(p).length).toBe(3);
  });
});
