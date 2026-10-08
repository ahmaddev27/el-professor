import { describe, it, expect } from 'vitest';
import {
  PLANNING_TYPES,
  addMonths,
  defaultHistoryKeys,
  defaultPlanForm,
  defaultThresholdText,
  effectiveBlockGap,
  exclusionRows,
  filterShiftRows,
  formatDuration,
  germanDate,
  heatClass,
  historyMonthOptions,
  holidaySet,
  minuteRange,
  parseMonthKey,
  parsePlanningType,
  planSettingsFromForm,
  selectedHistory,
  shiftExportOptions,
  shiftRows,
  targetMonthOptions,
  timeLabel,
  thresholdCents,
  yearsTouched,
  attempt,
  type ShiftExportLabels,
} from './shiftRecommendationScreens';
import type { RecommendedShift } from './shiftRecommendation';

const imp = (id: string, year: number, month: number, imported_at: string, status = 'confirmed') => ({
  id, year, month, imported_at, status, file_name: `${id}.xlsx`, row_count: 10,
});

describe('parsePlanningType', () => {
  it('knows the two values and nothing else', () => {
    expect(parsePlanningType('standard')).toBe(PLANNING_TYPES.standard);
    expect(parsePlanningType('schichten')).toBe(PLANNING_TYPES.shifts);
    expect(parsePlanningType(null)).toBeNull();
    expect(parsePlanningType('Standard')).toBeNull();
    expect(parsePlanningType('x')).toBeNull();
  });
});

describe('months', () => {
  it('rolls the year over', () => {
    expect(addMonths({ year: 2026, month: 11 }, 2)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, 12)).toEqual({ year: 2027, month: 1 });
  });

  it('offers the twelve months after the newest import, nearest first', () => {
    const options = targetMonthOptions({ year: 2026, month: 10 });
    expect(options).toHaveLength(12);
    expect(options[0]).toEqual({ year: 2026, month: 11 });
    expect(options[11]).toEqual({ year: 2027, month: 10 });
  });

  it('parses a month key strictly', () => {
    expect(parseMonthKey('2026-09')).toEqual({ year: 2026, month: 9 });
    expect(parseMonthKey('2026-13')).toBeNull();
    expect(parseMonthKey('2026-9')).toBeNull();
  });
});

describe('historyMonthOptions', () => {
  const rows = [
    imp('a-old', 2026, 8, '2026-09-01T10:00:00Z'),
    imp('a-new', 2026, 8, '2026-09-05T10:00:00Z'),
    imp('b', 2026, 9, '2026-10-02T10:00:00Z'),
    imp('c', 2026, 7, '2026-08-02T10:00:00Z'),
    imp('d', 2026, 6, '2026-07-02T10:00:00Z'),
    imp('gone', 2026, 10, '2026-10-05T10:00:00Z', 'archived'),
  ];

  it('takes the newest import per month, newest month first, without archived imports', () => {
    const options = historyMonthOptions(rows);
    expect(options.map(o => o.key)).toEqual(['2026-09', '2026-08', '2026-07', '2026-06']);
    expect(options.find(o => o.key === '2026-08')?.importId).toBe('a-new');
    // The older August file is not read, and the option says so.
    expect(options.find(o => o.key === '2026-08')?.otherImports).toBe(1);
    expect(options.find(o => o.key === '2026-09')?.otherImports).toBe(0);
  });

  it('selects the newest three by default and returns them oldest first', () => {
    const options = historyMonthOptions(rows);
    const keys = defaultHistoryKeys(options);
    expect(keys).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(selectedHistory(options, new Set(keys)).map(o => o.key)).toEqual(['2026-07', '2026-08', '2026-09']);
  });
});

describe('holidays', () => {
  it('collects every year the history and the target touch', () => {
    expect(yearsTouched([{ year: 2026, month: 11 }, { year: 2026, month: 12 }], { year: 2027, month: 1 })).toEqual([2026, 2027]);
  });

  it('unions the years; a region adds its own days', () => {
    const federal = holidaySet([2026, 2027], '');
    expect(federal.has('2026-12-25')).toBe(true);
    expect(federal.has('2027-01-01')).toBe(true);
    expect(federal.has('2026-11-01')).toBe(false);
    expect(holidaySet([2026], 'NW').has('2026-11-01')).toBe(true);
  });
});

describe('durations and the plan form', () => {
  it('writes h:mm', () => {
    expect(formatDuration(180)).toBe('3:00');
    expect(formatDuration(285)).toBe('4:45');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
  });

  it('steps in quarters of an hour, ends included', () => {
    expect(minuteRange(60, 120)).toEqual([60, 75, 90, 105, 120]);
  });

  it('proposes the history rate in whole euros, rounded down', () => {
    expect(defaultThresholdText(2799)).toBe('27');
    expect(defaultThresholdText(2800)).toBe('28');
    expect(defaultThresholdText(null)).toBe('0');
  });

  it('starts from the engine defaults', () => {
    const form = defaultPlanForm(3050);
    expect(form).toMatchObject({ thresholdText: '30', minShiftMinutes: 180, maxShiftMinutes: 285, maxShiftsPerVehiclePerDay: 2, minBreakMinutes: 30 });
  });

  it('reads the threshold with a German decimal comma, and refuses what is not an amount', () => {
    expect(thresholdCents('25,50')).toBe(2550);
    expect(thresholdCents(' 25 ')).toBe(2500);
    expect(thresholdCents('abc')).toBeNull();
    expect(thresholdCents('')).toBeNull();
    expect(thresholdCents('1,234.56')).toBeNull();
  });

  it('builds plan settings, or none when the threshold is unreadable', () => {
    const form = defaultPlanForm(3050);
    expect(planSettingsFromForm(form)?.minRevenuePerHourCents).toBe(3000);
    expect(planSettingsFromForm({ ...form, thresholdText: 'x' })).toBeNull();
  });

  it('falls back to the default gap unless the stored one is usable', () => {
    expect(effectiveBlockGap(45, 30)).toBe(45);
    expect(effectiveBlockGap(0, 30)).toBe(0);
    expect(effectiveBlockGap(null, 30)).toBe(30);
    expect(effectiveBlockGap(-5, 30)).toBe(30);
    expect(effectiveBlockGap(Number.NaN, 30)).toBe(30);
  });
});

describe('exclusionRows', () => {
  it('lists only reasons that occurred, most frequent first', () => {
    const rows = exclusionRows({
      cancelled: 3, status_unknown: 0, missing_vehicle: 7, missing_start: 0,
      missing_end: 0, end_before_start: 0, implausible_duration: 1, ambiguous_local_time: 0, unpriced: 3,
    });
    expect(rows.map(r => r.reason)).toEqual(['missing_vehicle', 'cancelled', 'unpriced', 'implausible_duration']);
  });
});

describe('heatClass', () => {
  it('is neutral without evidence and darker with the rate', () => {
    expect(heatClass(null, 2000)).toBe('bg-sunken');
    expect(heatClass(500, 2000)).toBe('bg-brand/10');
    expect(heatClass(1500, 2000)).toBe('bg-brand/25');
    expect(heatClass(2000, 2000)).toBe('bg-brand/40');
    expect(heatClass(2600, 2000)).toBe('bg-brand/60');
    expect(heatClass(5000, 2000)).toBe('bg-brand/80');
  });

  it('treats every rated hour as above a zero threshold', () => {
    expect(heatClass(0, 0)).toBe('bg-brand/80');
  });
});

const shift = (over: Partial<RecommendedShift>): RecommendedShift => ({
  id: 'V1|2026-11-06|0', vehicle: 'V1', operatingDate: '2026-11-06', dayType: 4, isHoliday: false,
  startPosition: 72, endPosition: 80,
  start: { date: '2026-11-06', time: '22:00' }, end: { date: '2026-11-07', time: '02:00' },
  minutes: 240, expectedRevenueCents: 10050, expectedRevenuePerHourCents: 2513,
  evidenceDays: 6, confidence: 'high', ...over,
});

describe('shift rows', () => {
  it('marks a shift that ends on the next calendar day', () => {
    const [row] = shiftRows([shift({})]);
    expect(row).toMatchObject({ date: '2026-11-06', startsNextDay: false, endsNextDay: true });
    const [same] = shiftRows([shift({ end: { date: '2026-11-06', time: '23:30' } })]);
    expect(same.endsNextDay).toBe(false);
  });

  it('keeps a shift after midnight on its operating day, so the date and the weekday agree', () => {
    // Friday's operating day, 01:00–04:00 on Saturday's calendar date.
    const late = shift({
      id: 'V1|2026-11-06|1', startPosition: 84, endPosition: 96,
      start: { date: '2026-11-07', time: '01:00' }, end: { date: '2026-11-07', time: '04:00' },
    });
    const [row] = shiftRows([late]);
    expect(row).toMatchObject({ date: '2026-11-06', dayType: 4, startsNextDay: true, endsNextDay: true });
    expect(timeLabel(row.startTime, row.startsNextDay)).toBe('01:00 (+1)');
    // And it sorts after the same day's 22:00 shift, as it happens.
    const sorted = shiftRows([late, shift({})]).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    expect(sorted.map(r => r.startTime)).toEqual(['22:00', '01:00']);
  });

  it('filters by vehicle, and "" keeps all', () => {
    const rows = shiftRows([shift({}), shift({ id: 'V2|x|0', vehicle: 'V2' })]);
    expect(filterShiftRows(rows, '')).toHaveLength(2);
    expect(filterShiftRows(rows, 'V2').map(r => r.vehicle)).toEqual(['V2']);
  });

  it('writes dates as DD.MM.YYYY', () => {
    expect(germanDate('2026-11-06')).toBe('06.11.2026');
    expect(germanDate('nonsense')).toBe('nonsense');
  });
});

describe('shiftExportOptions', () => {
  const labels: ShiftExportLabels = {
    sheetTitle: 'Schichtempfehlung November 2026', moduleName: 'Schichtempfehlung', total: 'Gesamt (2 Schichten, Schätzung)',
    date: 'Datum', weekday: 'Wochentag', vehicle: 'Fahrzeug', from: 'Von', to: 'Bis', hours: 'Dauer (h)',
    revenue: 'Erwarteter Umsatz', rate: 'Erwartet pro Stunde', evidence: 'Beleg', confidence: 'Sicherheit',
    weekdays: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
    confidences: { high: 'hoch', medium: 'mittel', low: 'niedrig' }, holiday: 'Feiertag',
  };

  it('writes numbers as numbers and totals them; the first column carries no figure', () => {
    const rows = shiftRows([shift({}), shift({ id: 'b', isHoliday: true, minutes: 180, expectedRevenueCents: 5000, dayType: 6 })]);
    const options = shiftExportOptions(rows, { year: 2026, month: 11 }, labels);
    expect(options.filename).toBe('schichtempfehlung_2026-11');
    expect(options.rows[0]).toMatchObject({ date: '06.11.2026', weekday: 'Fr', to: '02:00 (+1)', hours: 4, revenue: 100.5, confidence: 'hoch' });
    expect(options.rows[1].date).toBe('06.11.2026 (Feiertag)');
    expect(options.rows[0].from).toBe('22:00');
    expect(options.totals).toEqual({ hours: 7, revenue: 150.5 });
    expect(Object.keys(options.totals ?? {})).not.toContain(options.columns[0].key);
  });
});

describe('attempt', () => {
  it('turns a throw into a failed attempt', () => {
    expect(attempt(() => 1)).toEqual({ ok: true, value: 1 });
    const quiet = () => { throw new Error('x'); };
    expect(attempt(quiet).ok).toBe(false);
  });
});
