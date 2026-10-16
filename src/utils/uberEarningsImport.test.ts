import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  centsToDecimal,
  isWeekSegment,
  mondayOf,
  parseCents,
  parseEarningsBody,
  splitIntoBusinessWeeks,
} from '../../supabase/functions/_shared/uber-earnings-core';
import {
  blockingEarners,
  buildImportRows,
  canConfirmImport,
  findExistingIncome,
  findUnlinked,
  groupByBusinessMonth,
  importDescription,
  importRpcArgs,
  readImportAnswer,
  uberWindowLabel,
  readPullAnswer,
  skippedFigureLabel,
  skippedFigures,
  summarizeByDriver,
  weekNumberOf,
  type WeekEarnings,
} from './uberEarningsImport';

const driverWire = (over: Record<string, unknown> = {}) => ({
  driver_id: 139, uber_driver_uuid: 'u-1', name: 'Ahmed Hemaid',
  fare: '664.19', promotion: '0.00', tips: '28.00', cash: '226.26',
  net_outstanding: '465.93', trips: 67, difference: '0.00', ...over,
});
const body = (drivers: unknown[], over: Record<string, unknown> = {}) => ({
  data: { from: '2026-10-06', to: '2026-10-12', currency: 'EUR', drivers, ...over },
  meta: { driver_count: drivers.length },
});

describe('parseCents: money is a strict decimal string', () => {
  it('reads dot decimals into integer cents without a float', () => {
    expect(parseCents('664.19')).toBe(66419);
    expect(parseCents('28')).toBe(2800);
    expect(parseCents('0.5')).toBe(50);
    expect(parseCents('1234.50')).toBe(123450);
  });
  it('refuses a JSON number, a comma, a thousands dot, three places and a sign', () => {
    for (const bad of [664.19, '664,19', '1.234', '1.234,50', '0.001', '-1.00', '', ' 1.00', '1.', '.5', '007.50', null, undefined]) {
      expect(parseCents(bad), String(bad)).toBeNull();
    }
  });
  it('allows a sign only where the field is signed', () => {
    expect(parseCents('-12.5', true)).toBe(-1250);
    expect(parseCents('+12.5', true)).toBeNull();
  });
  it('writes cents back as the same plain decimal', () => {
    expect(centsToDecimal(66419)).toBe('664.19');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-1250)).toBe('-12.50');
  });
});

describe('splitIntoBusinessWeeks', () => {
  const cut = (a: string, b: string) => {
    const r = splitIntoBusinessWeeks(a, b);
    if (!r.ok) throw new Error(r.problem);
    return r.value.map(s => [s.from, s.to, s.monday]);
  };
  it('a Monday to Sunday range is one week', () => {
    expect(cut('2026-10-05', '2026-10-11')).toEqual([['2026-10-05', '2026-10-11', '2026-10-05']]);
  });
  it('cuts at every Sunday and keeps the partial ends', () => {
    expect(cut('2026-09-30', '2026-10-13')).toEqual([
      ['2026-09-30', '2026-10-04', '2026-09-28'],
      ['2026-10-05', '2026-10-11', '2026-10-05'],
      ['2026-10-12', '2026-10-13', '2026-10-12'],
    ]);
  });
  it('a single day is a segment', () => {
    expect(cut('2026-10-04', '2026-10-04')).toEqual([['2026-10-04', '2026-10-04', '2026-09-28']]);
  });
  it('is not shifted by a daylight-saving night', () => {
    expect(cut('2026-10-24', '2026-10-27')).toEqual([
      ['2026-10-24', '2026-10-25', '2026-10-19'],
      ['2026-10-26', '2026-10-27', '2026-10-26'],
    ]);
    expect(mondayOf('2026-03-29')).toBe('2026-03-23');
  });
  it('refuses a reversed range, an impossible date and an over-long range', () => {
    expect(splitIntoBusinessWeeks('2026-10-12', '2026-10-05')).toEqual({ ok: false, problem: 'invalid_range' });
    expect(splitIntoBusinessWeeks('2026-02-30', '2026-03-05')).toEqual({ ok: false, problem: 'invalid_range' });
    expect(splitIntoBusinessWeeks('2026-01-01', '2026-06-30')).toEqual({ ok: false, problem: 'range_too_long' });
  });
  it('a segment must lie inside one week', () => {
    expect(isWeekSegment({ from: '2026-10-05', to: '2026-10-11' })).toBe(true);
    expect(isWeekSegment({ from: '2026-10-11', to: '2026-10-12' })).toBe(false);
  });
});

describe('parseEarningsBody', () => {
  it('reads a valid answer into cents', () => {
    const r = parseEarningsBody(body([driverWire()]), '2026-10-06', '2026-10-12');
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.value.drivers[0]).toMatchObject({
        externalDriverId: '139', fareCents: 66419, tipsCents: 2800, cashCents: 22626,
        netOutstandingCents: 46593, trips: 67, differenceCents: 0,
      });
    }
  });
  it('accepts a null trip count and a signed difference', () => {
    const r = parseEarningsBody(body([driverWire({ trips: null, difference: '-3.40' })]), '2026-10-06', '2026-10-12');
    expect(r.ok && r.value.drivers[0]).toMatchObject({ trips: null, differenceCents: -340 });
  });
  it.each([
    ['a float fare', { fare: 664.19 }, 'amount_invalid'],
    ['a comma fare', { fare: '664,19' }, 'amount_invalid'],
    ['a plus sign', { fare: '+1.00' }, 'amount_invalid'],
    ['a string driver id', { driver_id: '139' }, 'driver_id_invalid'],
    ['a fractional trip count', { trips: 6.5 }, 'trips_invalid'],
    ['a missing difference', { difference: undefined }, 'amount_invalid'],
  ])('refuses the whole answer for %s', (_n, over, problem) => {
    expect(parseEarningsBody(body([driverWire(), driverWire({ driver_id: 2, ...over })]), '2026-10-06', '2026-10-12'))
      .toEqual({ ok: false, problem });
  });
  it('refuses another range, another currency and a repeated driver', () => {
    expect(parseEarningsBody(body([], { to: '2026-10-13' }), '2026-10-06', '2026-10-12')).toEqual({ ok: false, problem: 'range_mismatch' });
    expect(parseEarningsBody(body([], { currency: 'USD' }), '2026-10-06', '2026-10-12')).toEqual({ ok: false, problem: 'currency_unsupported' });
    expect(parseEarningsBody(body([driverWire(), driverWire()]), '2026-10-06', '2026-10-12')).toEqual({ ok: false, problem: 'driver_duplicated' });
    expect(parseEarningsBody({ data: null }, '2026-10-06', '2026-10-12')).toEqual({ ok: false, problem: 'malformed' });
  });
});

function week(from: string, to: string, monday: string, wire: Record<string, unknown>[]): WeekEarnings {
  const parsed = parseEarningsBody(body(wire, { from, to }), from, to);
  if (!parsed.ok) throw new Error(parsed.problem);
  return { segment: { from, to, monday }, drivers: parsed.value.drivers };
}

describe('unmatched earners and the 31-day cap', () => {
  it('reads meta.unmatched by name, with no money', () => {
    const b = { ...body([driverWire()]), meta: { driver_count: 1, unmatched: [{ name: 'Ahmed Hemaid', uber_driver_uuid: 'u-9', trips: 12 }] } };
    const r = parseEarningsBody(b, '2026-10-06', '2026-10-12');
    expect(r.ok && r.value.unmatched).toEqual([{ name: 'Ahmed Hemaid', uberDriverUuid: 'u-9', trips: 12 }]);
  });
  it('an absent list is none; a malformed one refuses the whole answer', () => {
    expect(parseEarningsBody(body([]), '2026-10-06', '2026-10-12')).toMatchObject({ ok: true, value: { unmatched: [] } });
    const bad = { ...body([]), meta: { unmatched: [{ name: '', trips: 1 }] } };
    expect(parseEarningsBody(bad, '2026-10-06', '2026-10-12')).toEqual({ ok: false, problem: 'unmatched_invalid' });
    const bad2 = { ...body([]), meta: { unmatched: 'x' } };
    expect(parseEarningsBody(bad2, '2026-10-06', '2026-10-12')).toEqual({ ok: false, problem: 'unmatched_invalid' });
  });
  it('both causes are named, unmatched first, and either one blocks', () => {
    const list = blockingEarners(
      [{ externalDriverId: '7', name: 'Linked Nowhere' }],
      [{ name: 'Not At Reidey', uberDriverUuid: null, trips: null }],
    );
    expect(list).toEqual([
      { name: 'Not At Reidey', kind: 'unmatched_at_reidey', externalDriverId: null },
      { name: 'Linked Nowhere', kind: 'unlinked_here', externalDriverId: '7' },
    ]);
    expect(blockingEarners([], [])).toEqual([]);
  });
  it('the pull answer carries unmatched through, and refuses a malformed one', () => {
    const w = week('2026-10-06', '2026-10-11', '2026-10-05', [driverWire()]);
    const answer = { ok: true, weeks: [{ ...w.segment, drivers: w.drivers }], links: {}, unmatched: [{ name: 'X', uberDriverUuid: null, trips: null }] };
    expect(readPullAnswer(answer)?.unmatched).toHaveLength(1);
    expect(readPullAnswer({ ...answer, unmatched: [{ trips: 1 }] })).toBeNull();
  });
  it('38 days are accepted and 39 are refused', () => {
    expect(splitIntoBusinessWeeks('2026-10-01', '2026-11-07').ok).toBe(true);
    expect(splitIntoBusinessWeeks('2026-10-01', '2026-11-08')).toEqual({ ok: false, problem: 'range_too_long' });
  });
});

describe('the week number is the screen\'s Woche N', () => {
  it('counts Mondays of the business month', () => {
    expect(weekNumberOf({ from: '2026-10-06', to: '2026-10-11', monday: '2026-10-05' })).toBe(1);
    expect(weekNumberOf({ from: '2026-10-12', to: '2026-10-18', monday: '2026-10-12' })).toBe(2);
  });
  it('a week whose Monday is in September belongs to September', () => {
    // 28.09.2026 is the fourth Monday of September; 1.-4.10. are in that week.
    expect(weekNumberOf({ from: '2026-10-01', to: '2026-10-04', monday: '2026-09-28' })).toBe(4);
  });
  it('keeps the German word first so the screen\'s regex still finds it', () => {
    expect(importDescription(3)).toMatch(/^Woche 3\b/);
    expect(/Woche \d+/i.test(importDescription(3))).toBe(true);
  });
});

describe('buildImportRows', () => {
  const w1 = week('2026-10-06', '2026-10-11', '2026-10-05', [driverWire()]);
  it('maps fare, promotion, tips and cash one to one and drops zero amounts', () => {
    const rows = buildImportRows([w1]);
    expect(rows.map(r => [r.type, r.amount])).toEqual([
      ['umsatz', '664.19'], ['trinkgeld', '28.00'], ['bargeld', '226.26'],
    ]);
  });
  it('puts the trip count on the net-fare row only', () => {
    const rows = buildImportRows([w1]);
    expect(rows.map(r => r.trip_count)).toEqual([67, null, null]);
  });
  it('is dated and keyed by its own stretch of days, one set per week', () => {
    const w2 = week('2026-10-12', '2026-10-13', '2026-10-12', [driverWire({ fare: '10.00', tips: '0.00', cash: '0.00' })]);
    const rows = buildImportRows([w1, w2]);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({
      type: 'umsatz', date: '2026-10-12', period_start: '2026-10-12', period_end: '2026-10-13',
      week: 2, description: 'Woche 2 - Uber', external_driver_id: '139',
    });
  });
  it('never carries Reidey\'s name to the database', () => {
    expect(JSON.stringify(buildImportRows([w1]))).not.toContain('Hemaid');
  });
  it('a driver with nothing to write produces no row', () => {
    const idle = week('2026-10-06', '2026-10-11', '2026-10-05',
      [driverWire({ fare: '0.00', tips: '0.00', cash: '0.00', trips: 0 })]);
    expect(buildImportRows([idle])).toEqual([]);
  });
});

describe('the link decides who may be imported', () => {
  const w = week('2026-10-06', '2026-10-11', '2026-10-05', [
    driverWire(),
    driverWire({ driver_id: 7, name: 'Nobody Linked' }),
    driverWire({ driver_id: 8, name: 'Idle', fare: '0.00', tips: '0.00', cash: '0.00', trips: null }),
  ]);
  const links = { '139': { driverId: 'd-1', driverName: 'Ahmed Hemaid GmbH-Name' } };
  it('names each unlinked driver that would produce a row, once', () => {
    expect(findUnlinked([w, w], links)).toEqual([{ externalDriverId: '7', name: 'Nobody Linked' }]);
  });
  it('nothing is unlinked when every driver with rows has a link', () => {
    expect(findUnlinked([w], { ...links, '7': { driverId: 'd-2', driverName: 'X' } })).toEqual([]);
  });
  it('the preview shows our name beside theirs and flags a non-zero difference', () => {
    const wd = week('2026-10-06', '2026-10-11', '2026-10-05', [driverWire({ difference: '-2.50' })]);
    const [line] = summarizeByDriver([wd], links);
    expect(line).toMatchObject({
      uberName: 'Ahmed Hemaid', ourName: 'Ahmed Hemaid GmbH-Name',
      differenceCents: -250, hasDifference: true, rowCount: 3,
    });
  });
  it('two weeks of opposite differences still flag the driver', () => {
    const a = week('2026-10-06', '2026-10-11', '2026-10-05', [driverWire({ difference: '1.00' })]);
    const b = week('2026-10-12', '2026-10-13', '2026-10-12', [driverWire({ difference: '-1.00' })]);
    const [line] = summarizeByDriver([a, b], links);
    expect(line.differenceCents).toBe(0);
    expect(line.hasDifference).toBe(true);
  });
});

describe('readPullAnswer: the screen trusts the function\'s reply only in full shape', () => {
  const good = () => {
    const w = week('2026-10-06', '2026-10-11', '2026-10-05', [driverWire()]);
    return { ok: true, weeks: [{ ...w.segment, drivers: w.drivers }], links: { '139': { driverId: 'd-1', driverName: 'Ahmed' } } };
  };
  it('reads a well-formed answer', () => {
    const read = readPullAnswer(good());
    expect(read?.weeks[0].segment).toEqual({ from: '2026-10-06', to: '2026-10-11', monday: '2026-10-05' });
    expect(read?.links['139'].driverName).toBe('Ahmed');
  });
  it('refuses a refusal, a NaN figure and a segment across two weeks', () => {
    expect(readPullAnswer({ ok: false, reason: 'not_connected' })).toBeNull();
    expect(readPullAnswer(null)).toBeNull();
    const nan = good(); (nan.weeks[0].drivers[0] as { fareCents: number }).fareCents = NaN;
    expect(readPullAnswer(nan)).toBeNull();
    const frac = good(); (frac.weeks[0].drivers[0] as { fareCents: number }).fareCents = 1.5;
    expect(readPullAnswer(frac)).toBeNull();
    const across = good(); (across.weeks[0] as { to: string }).to = '2026-10-12';
    expect(readPullAnswer(across)).toBeNull();
  });
});

describe('figures below zero: read, reported, never a row', () => {
  const NEG = { fare: '-3.00', promotion: '-12.00', tips: '-1.50', cash: '-20.00' };

  it.each([['fare', 'fareCents', -300], ['promotion', 'promotionCents', -1200],
           ['tips', 'tipsCents', -150], ['cash', 'cashCents', -2000]])(
    'a negative %s parses (Reidey signs all four)', (field, key, cents) => {
      const r = parseEarningsBody(body([driverWire({ [field]: NEG[field as keyof typeof NEG] })]), '2026-10-06', '2026-10-12');
      expect(r.ok && (r.value.drivers[0] as unknown as Record<string, number>)[key as string]).toBe(cents);
    });

  it('a signed zero is a plain zero', () => {
    expect(parseCents('-0.00', true)).toBe(0);
    expect(Object.is(parseCents('-0.00', true), 0)).toBe(true);
  });

  it('still refuses an amount that is not a decimal string', () => {
    expect(parseEarningsBody(body([driverWire({ promotion: '--1.00' })]), '2026-10-06', '2026-10-12'))
      .toEqual({ ok: false, problem: 'amount_invalid' });
  });

  it('writes no row for a negative figure and keeps the driver\'s other rows', () => {
    const w = week('2026-10-12', '2026-10-13', '2026-10-12', [driverWire({ fare: '10.00', tips: '0.00', cash: '0.00', promotion: '-12.00' })]);
    expect(buildImportRows([w]).map(r => [r.type, r.amount])).toEqual([['umsatz', '10.00']]);
  });

  it('lists every negative figure with its day, and the preview totals equal the rows', () => {
    const w = week('2026-10-12', '2026-10-13', '2026-10-12', [driverWire({ promotion: '-12.00', cash: '-20.00' })]);
    const listed = skippedFigures([w]);
    expect(listed.map(f => [f.type, f.cents, f.day])).toEqual([
      ['aktionen', -1200, '2026-10-12'], ['bargeld', -2000, '2026-10-12']]);
    const total = summarizeByDriver([w], {})[0];
    expect([total.promotionCents, total.cashCents]).toEqual([0, 0]);
  });

  it('labels a skipped figure in German money and date', () => {
    const f = { externalDriverId: '1', name: 'Anna', type: 'aktionen' as const, cents: -1200, day: '2026-08-14' };
    expect(skippedFigureLabel(f, c => `${c / 100} EUR`)).toBe('Anna: Aktionen -12 EUR (14.08.2026)');
  });
});

describe('findExistingIncome: typed rows warn, imported rows refuse', () => {
  const links = { '139': { driverId: 'd-1', driverName: 'Ahmed Hemaid' } };
  const w = week('2026-10-06', '2026-10-11', '2026-10-05', [driverWire()]);
  const row = (over: Partial<import('./uberEarningsImport').ExistingIncome> = {}) => ({
    driver_name: 'Ahmed Hemaid', date: '2026-10-07', type: 'umsatz', amount: 100,
    source: null, source_period_start: null, source_period_end: null, ...over,
  });
  it('a hand-entered row in the week is reported as manual, naming driver and week', () => {
    expect(findExistingIncome([w], links, [row(), row({ type: 'bargeld' })])).toEqual([
      { driverName: 'Ahmed Hemaid', segment: w.segment, manualCount: 2, importedCount: 0 },
    ]);
  });
  it('nothing is reported for another driver, another week or another spelling', () => {
    expect(findExistingIncome([w], links, [
      row({ driver_name: 'Someone Else' }), row({ date: '2026-10-12' }), row({ driver_name: 'ahmed hemaid' }),
    ])).toEqual([]);
  });
  it('an earlier import that overlaps by its period is imported, not manual, even dated before the range', () => {
    const imported = row({ source: 'uber', date: '2026-10-04', source_period_start: '2026-10-04', source_period_end: '2026-10-08' });
    expect(findExistingIncome([w], links, [imported])).toEqual([
      { driverName: 'Ahmed Hemaid', segment: w.segment, manualCount: 0, importedCount: 1 },
    ]);
  });
  it('both at once are counted apart', () => {
    const imported = row({ source: 'uber', source_period_start: '2026-10-06', source_period_end: '2026-10-11' });
    expect(findExistingIncome([w], links, [row(), imported])[0]).toMatchObject({ manualCount: 1, importedCount: 1 });
  });
  it('a driver the import would write nothing for is not warned about', () => {
    const idle = week('2026-10-06', '2026-10-11', '2026-10-05',
      [driverWire({ fare: '0.00', tips: '0.00', cash: '0.00', trips: null })]);
    expect(findExistingIncome([idle], links, [row()])).toEqual([]);
  });
});

describe('uberWindowLabel: the window runs 04:00 to 04:00', () => {
  const week = (monday: string) => ({ from: monday, to: addDaysIso(monday, 6), monday });
  it('ends on the FOLLOWING Monday, not the Sunday', () => {
    expect(uberWindowLabel(week('2026-10-05'))).toBe('[05.10.2026 04:00 – 12.10.2026 04:00]');
  });
  it('crosses a month end', () => {
    expect(uberWindowLabel(week('2026-09-28'))).toBe('[28.09.2026 04:00 – 05.10.2026 04:00]');
  });
  it('crosses a year end', () => {
    expect(uberWindowLabel(week('2026-12-28'))).toBe('[28.12.2026 04:00 – 04.01.2027 04:00]');
  });
  it('a piece cut by the chosen range ends the day after its own last day', () => {
    expect(uberWindowLabel({ from: '2026-10-07', to: '2026-10-11', monday: '2026-10-05' }))
      .toBe('[07.10.2026 04:00 – 12.10.2026 04:00]');
  });
});

describe('groupByBusinessMonth', () => {
  const links = { '1': { driverId: 'd1', driverName: 'Ahmed' } };
  const driver = (id: string, fare: number, trips: number | null = 1, difference = 0) => ({
    externalDriverId: id, uberDriverUuid: null, name: `Fahrer ${id}`,
    fareCents: fare, promotionCents: 10, tipsCents: 5, cashCents: 100,
    netOutstandingCents: 0, differenceCents: difference, trips,
  });
  const weekOf = (monday: string, drivers = [driver('1', 1000), driver('2', 500)]): WeekEarnings => ({
    segment: { from: monday, to: addDaysIso(monday, 6), monday }, drivers,
  });
  const total = (lines: ReadonlyArray<{ fareCents: number; promotionCents: number; tipsCents: number; cashCents: number; differenceCents: number }>) =>
    lines.reduce((a, l) => a + l.fareCents + l.promotionCents + l.tipsCents + l.cashCents + l.differenceCents, 0);

  it('puts a week in the month of its MONDAY: 4 weeks in October 2026, 5 in November', () => {
    const mondays = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26',
      '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'];
    const groups = groupByBusinessMonth(mondays.map(m => weekOf(m)), links);
    expect(groups.map(g => [g.year, g.month, g.weeks.length])).toEqual([[2026, 10, 4], [2026, 11, 5]]);
    expect(groups[0].weeks.map(w => w.weekNumber)).toEqual([1, 2, 3, 4]);
    expect(groups[1].weeks.map(w => w.weekNumber)).toEqual([1, 2, 3, 4, 5]);
  });
  it('a week crossing the month end stays with the month of its Monday', () => {
    const groups = groupByBusinessMonth([weekOf('2026-09-28'), weekOf('2026-10-05')], links);
    expect(groups.map(g => [g.month, g.weeks.length])).toEqual([[9, 1], [10, 1]]);
    expect(groups[0].weeks[0].weekNumber).toBe(weekNumberOf(weekOf('2026-09-28').segment));
  });
  it('a range starting mid-month yields a first month with fewer weeks and keeps the real numbering', () => {
    const groups = groupByBusinessMonth([weekOf('2026-10-19'), weekOf('2026-10-26'), weekOf('2026-11-02')], links);
    expect(groups[0].weeks.map(w => w.weekNumber)).toEqual([3, 4]);
    expect(groups[1].weeks.map(w => w.weekNumber)).toEqual([1]);
  });
  it('the monthly figures are the sum of exactly the weekly ones, and both views total alike', () => {
    const weeks = ['2026-10-05', '2026-10-12', '2026-11-02'].map((m, i) =>
      weekOf(m, [driver('1', 1000 + i, 3, i === 1 ? 7 : 0), driver('2', 500 * (i + 1), null)]));
    const groups = groupByBusinessMonth(weeks, links);
    const weekly = weeks.flatMap(w => summarizeByDriver([w], links));
    const monthly = groups.flatMap(g => g.drivers);
    expect(total(monthly)).toBe(total(weekly));
    expect(total(monthly)).toBe(total(summarizeByDriver(weeks, links)));
    for (const g of groups) {
      expect(g.drivers).toEqual(summarizeByDriver(g.weeks.map(w => weeks.find(x => x.segment.monday === w.segment.monday)!), links));
    }
    const october = groups[0].drivers.find(d => d.externalDriverId === '1')!;
    expect(october.trips).toBe(6);
    expect(october.hasDifference).toBe(true);
    expect(groups[0].drivers.find(d => d.externalDriverId === '2')!.trips).toBeNull();
  });
  it('does not mutate the per-week lines when it sums them', () => {
    const groups = groupByBusinessMonth([weekOf('2026-10-05'), weekOf('2026-10-12')], links);
    expect(groups[0].weeks[0].drivers[0].fareCents).toBe(1000);
    expect(groups[0].drivers[0].fareCents).toBe(2000);
  });
});

describe('replacing an earlier Uber import', () => {
  const ok = { rowCount: 3, blockingCount: 0, importedWeekCount: 0, replaceChosen: false };

  it('confirms an ordinary import with nothing already imported', () => {
    expect(canConfirmImport(ok)).toBe(true);
  });

  it('holds an earlier import until the operator has chosen to replace it', () => {
    expect(canConfirmImport({ ...ok, importedWeekCount: 2 })).toBe(false);
    expect(canConfirmImport({ ...ok, importedWeekCount: 2, replaceChosen: true })).toBe(true);
  });

  it('never lets the choice override a driver that cannot be placed or an empty import', () => {
    expect(canConfirmImport({ ...ok, importedWeekCount: 2, replaceChosen: true, blockingCount: 1 })).toBe(false);
    expect(canConfirmImport({ ...ok, importedWeekCount: 2, replaceChosen: true, rowCount: 0 })).toBe(false);
  });

  it('sends the replace flag only when chosen AND there is something to replace', () => {
    const rows = buildImportRows([]);
    expect(importRpcArgs(rows, 2, true).p_replace).toBe(true);
    expect(importRpcArgs(rows, 2, false).p_replace).toBe(false);
    expect(importRpcArgs(rows, 0, true).p_replace).toBe(false);
  });

  it('reads the replaced count, and treats its absence as none', () => {
    expect(readImportAnswer({ ok: true, inserted: 3, drivers: 1, deleted: 3 }, 9))
      .toEqual({ inserted: 3, drivers: 1, deleted: 3 });
    expect(readImportAnswer({ ok: true, inserted: 3, drivers: 1 }, 9).deleted).toBe(0);
    expect(readImportAnswer(null, 9)).toEqual({ inserted: 9, drivers: 0, deleted: 0 });
  });
});

describe('a day as an import piece', () => {
  const day: WeekEarnings = {
    segment: { from: '2026-10-07', to: '2026-10-07', monday: '2026-10-05' },
    drivers: [{
      externalDriverId: '139', uberDriverUuid: 'u-1', name: 'Ahmed Hemaid', fareCents: 10000, promotionCents: 0,
      tipsCents: 0, cashCents: 0, netOutstandingCents: 0, differenceCents: 0, trips: 4,
    }],
  };
  it('carries its own date and period, and the week number of the Monday\'s week', () => {
    const [row] = buildImportRows([day]);
    expect(row).toMatchObject({
      date: '2026-10-07', period_start: '2026-10-07', period_end: '2026-10-07',
      week: 1, description: 'Woche 1 - Uber', type: 'umsatz',
    });
  });
  it('is the same row a week would write, only with a one-day period', () => {
    const week: WeekEarnings = { ...day, segment: { from: '2026-10-05', to: '2026-10-11', monday: '2026-10-05' } };
    const [dayRow] = buildImportRows([day]);
    const [weekRow] = buildImportRows([week]);
    expect(dayRow!.week).toBe(weekRow!.week);
    expect(dayRow!.description).toBe(weekRow!.description);
    expect(weekRow!.period_end).toBe('2026-10-11');
  });
});
