import { describe, expect, it } from 'vitest';
import type { StructuredNote } from '../monatsplanungPhase3';
import { wallTimeToInstant } from '../fahrtenbuchImportParser';
import {
  BREAK_MINUTES,
  capByWeek,
  dayCapacityMinutes,
  isoWeekStart,
  MAX_DAY_WORK_MINUTES,
  MAX_PART_MINUTES,
  MAX_WEEK_WORK_MINUTES,
  MIN_DAY_MINUTES,
  planDriverMonth,
  splitDutyMinutes,
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
    // 17 days × 450 (an 8-hour window holds 7:30 of work and the break) now hold the 110 h.
    expect(p.plannedMinutes).toBe(6600);
    expect(p.discrepancies).toEqual([]);
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
    const p = planDriverMonth({ ...ANNA, minSalary: 2800, maxSalary: 3360 }, inputs()); // 200–240 h
    expect(p.discrepancies).toEqual([{ kind: 'capacity_below_minimum', minMinutes: 12000, capacityMinutes: 9900 }]);
    expect(p.plannedMinutes).toBe(9900);
    expect(p.days.every(d => d.plannedMinutes <= MAX_DAY_WORK_MINUTES)).toBe(true);
    expect(p.assessment.position).toBe('below');
    expect(p.printed).toMatchObject({ minSalary: 2800, maxSalary: 3360, hourlyRate: 14 });
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
    expect(p.discrepancies).toContainEqual({ kind: 'capacity_below_minimum', minMinutes: 6000, capacityMinutes: 1350 });
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
  it('a window across midnight ends on the next calendar day; 8 hours of window hold 7:30 of work and the break', () => {
    const p = planDriverMonth({ ...ANNA, workWindowStart: '20:00', workWindowEnd: '04:00' }, inputs());
    const d = p.days.find(x => x.date === '2026-09-14')!;
    expect(d.windowStartMs).toBe(at('2026-09-14', 20));
    expect(d.windowEndMs).toBe(at('2026-09-15', 4));
    expect(d.capacityMinutes).toBe(450);
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


describe('Round 8: the statutory day and week (§ 3, § 4 ArbZG)', () => {
  it('names the limits', () => {
    expect([MAX_PART_MINUTES, MAX_DAY_WORK_MINUTES, BREAK_MINUTES, MAX_WEEK_WORK_MINUTES]).toEqual([360, 480, 30, 2880]);
  });

  it.each([
    [60, 60], [360, 360], [389, 360], [390, 360], [420, 390], [509, 479], [510, 480], [1440, 480],
  ])('a free window of %i minutes holds %i minutes of work', (window, work) => {
    expect(dayCapacityMinutes(window)).toBe(work);
  });

  it('a day over 360 minutes always fits its window with the 30-minute break', () => {
    for (let w = 361; w <= 700; w++) {
      const work = dayCapacityMinutes(w);
      if (work > MAX_PART_MINUTES) expect(work + BREAK_MINUTES).toBeLessThanOrEqual(w);
    }
  });

  it('splits 361 to 480 minutes into two parts of 180 to 300 minutes each, on a quarter hour for part 1', () => {
    for (let m = 361; m <= 480; m++) {
      const { part1, part2 } = splitDutyMinutes(m);
      expect(part1 + part2).toBe(m);
      expect(part1 % 15).toBe(0);
      expect(part1).toBeGreaterThanOrEqual(180);
      expect(part1).toBeLessThanOrEqual(300);
      expect(part2).toBeGreaterThanOrEqual(180);
      expect(part2).toBeLessThanOrEqual(300);
    }
  });

  it('a month whose goal fits under 360 a day plans exactly the minutes it planned before the cap was raised', () => {
    // 10-hour window, every day: the old cap was 360 on all 30 days. Water-filling is untouched by the higher cap.
    const driver = { ...ANNA, allowedWeekdays: null, workWindowStart: '08:00', workWindowEnd: '18:00', minSalary: 2100, maxSalary: 2100 }; // 150 h
    const p = planDriverMonth(driver, inputs());
    const old = spreadMinutes(p.days.map(() => 360), 9000);
    expect(old.every(m => m <= 360)).toBe(true);
    expect(p.days.map(d => d.plannedMinutes)).toEqual(old);
  });

  it('a short month now reaches its minimum on 8-hour days, split into two parts', () => {
    const driver = { ...ANNA, workWindowStart: '06:00', workWindowEnd: '16:00', minSalary: 1946, maxSalary: 1946 }; // 139 h
    const p = planDriverMonth(driver, inputs());
    expect(p.discrepancies).toEqual([]);
    expect(p.plannedMinutes).toBe(Math.ceil(139 * 60));
    expect(Math.max(...p.days.map(d => d.plannedMinutes))).toBeGreaterThan(MAX_PART_MINUTES);
    expect(Math.max(...p.days.map(d => d.plannedMinutes))).toBeLessThanOrEqual(MAX_DAY_WORK_MINUTES);
  });

  it('puts no more than 48 hours in an ISO week, and a cut is a discrepancy row', () => {
    // Seven 480-minute days a week would be 3360: the week is cut to 2880.
    const driver = { ...ANNA, allowedWeekdays: null, isFullDayAvailable: true, workWindowStart: null, workWindowEnd: null, minSalary: 5600, maxSalary: 5600 }; // 400 h
    const p = planDriverMonth(driver, inputs());
    const byWeek = new Map<string, number>();
    for (const d of p.days) byWeek.set(isoWeekStart(d.date), (byWeek.get(isoWeekStart(d.date)) ?? 0) + d.plannedMinutes);
    for (const minutes of byWeek.values()) expect(minutes).toBeLessThanOrEqual(MAX_WEEK_WORK_MINUTES);
    expect(p.plannedMinutes).toBeLessThan(400 * 60);
    expect(p.discrepancies.some(d => d.kind === 'capacity_below_minimum')).toBe(true);
  });

  it('capByWeek lowers only the weeks over the cap, longest days first', () => {
    const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'];
    const caps = [480, 480, 480, 480, 480, 480, 480, 100];
    const out = capByWeek(dates, caps);
    expect(out.slice(0, 7).reduce((a, b) => a + b, 0)).toBe(MAX_WEEK_WORK_MINUTES);
    expect(out[7]).toBe(100);
    expect(capByWeek(dates.slice(0, 5), [480, 480, 480, 480, 480])).toEqual([480, 480, 480, 480, 480]);
  });
});
