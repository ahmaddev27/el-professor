import { describe, expect, it } from 'vitest';
import { readUberMonth, type UberDriverRef, type UberIncomeRow, type UberPartnerLink } from './uberImport';

const ANNA: UberDriverRef = { id: '11111111-1111-4111-8111-111111111111', name: 'Anna Beispiel' };
const BERT: UberDriverRef = { id: '22222222-2222-4222-8222-222222222222', name: 'Bert Nachtfahrt' };
const LINKS: UberPartnerLink[] = [
  { external_driver_id: 'ext-anna', driver_id: ANNA.id, status: 'linked' },
  { external_driver_id: 'ext-bert', driver_id: BERT.id, status: 'linked' },
];

let nextId = 1;
function daily(driver: 'anna' | 'bert', day: string, type: string, amount: number | string, extra: Partial<UberIncomeRow> = {}): UberIncomeRow {
  return {
    id: nextId++, type, amount, date: day, driver_name: driver === 'anna' ? ANNA.name : BERT.name,
    source: 'uber', source_driver_key: `ext-${driver}`, source_period_start: day, source_period_end: day,
    trip_count: type === 'umsatz' ? 9 : null, ...extra,
  };
}
function weekly(driver: 'anna' | 'bert', start: string, end: string, type: string, amount: number): UberIncomeRow {
  return { ...daily(driver, start, type, amount), source_period_start: start, source_period_end: end, date: start };
}
const read = (year: number, month: number, rows: UberIncomeRow[], drivers = [ANNA, BERT], links = LINKS) =>
  readUberMonth(year, month, rows, drivers, links);

describe('daily rows: the only shape with a per-day figure (test class 12)', () => {
  it('reads each driver-day in integer cents, by the partner link, with the trip count from the umsatz row', () => {
    const r = read(2026, 9, [
      daily('anna', '2026-09-03', 'umsatz', '187.40'),
      daily('anna', '2026-09-03', 'trinkgeld', 6.5),
      daily('anna', '2026-09-03', 'aktionen', '12.00'),
      daily('anna', '2026-09-03', 'bargeld', '40.10'),
    ]);
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({
      driverId: ANNA.id, date: '2026-09-03', identity: 'partner_link', overlapsPeriod: false, negativeTypes: [],
      figures: { umsatzCents: 18_740, trinkgeldCents: 650, aktionenCents: 1200, bargeldCents: 4010, tripCount: 9 },
    });
    expect(r.dailyDetail).toBe('available');
    expect(r.dailyTotals.umsatzCents).toBe(18_740);
  });

  it('keeps a refund with its sign and names it; nothing is netted away', () => {
    const r = read(2026, 10, [daily('bert', '2026-10-14', 'umsatz', '-23.50'), daily('bert', '2026-10-14', 'trinkgeld', '-2.00')]);
    expect(r.days[0].figures.umsatzCents).toBe(-2350);
    expect(r.days[0].figures.trinkgeldCents).toBe(-200);
    expect(r.days[0].negativeTypes.sort()).toEqual(['trinkgeld', 'umsatz']);
  });
});

describe('calendar month boundaries (test classes 10 and 11)', () => {
  it.each([
    [2027, 2, 28], [2028, 2, 29], [2026, 4, 30], [2026, 10, 31], [2026, 12, 31],
  ])('%i-%i: the first and last day count, the days either side do not', (year, month, last) => {
    const p = (n: number) => String(n).padStart(2, '0');
    const prevMonth = month === 1 ? `${year - 1}-12-31` : `${year}-${p(month - 1)}-${p(new Date(Date.UTC(year, month - 1, 0)).getUTCDate())}`;
    const nextDay = month === 12 ? `${year + 1}-01-01` : `${year}-${p(month + 1)}-01`;
    const r = read(year, month, [
      daily('anna', prevMonth, 'umsatz', 1),
      daily('anna', `${year}-${p(month)}-01`, 'umsatz', 2),
      daily('anna', `${year}-${p(month)}-${p(last)}`, 'umsatz', 3),
      daily('anna', nextDay, 'umsatz', 4),
    ]);
    expect(r.days.map(d => d.date)).toEqual([`${year}-${p(month)}-01`, `${year}-${p(month)}-${p(last)}`]);
    expect(r.dailyTotals.umsatzCents).toBe(500);
  });

  it('a week wholly inside the month counts for the month, never for a day', () => {
    const r = read(2026, 9, [weekly('anna', '2026-09-07', '2026-09-13', 'umsatz', 900), weekly('anna', '2026-09-07', '2026-09-13', 'trinkgeld', 31.5)]);
    expect(r.days).toEqual([]);
    expect(r.periods).toHaveLength(1);
    expect(r.periods[0]).toMatchObject({ placement: 'inside_month', days: 7, figures: { umsatzCents: 90_000, trinkgeldCents: 3150 } });
    expect(r.insidePeriodTotals.umsatzCents).toBe(90_000);
    expect(r.dailyTotals.umsatzCents).toBe(0);
    expect(r.dailyDetail).toBe('unavailable');
  });

  it('an Uber week across the month boundary is listed in both months and counted in neither', () => {
    const rows = [weekly('bert', '2026-09-28', '2026-10-04', 'umsatz', 700)];
    for (const [year, month] of [[2026, 9], [2026, 10]] as const) {
      const r = read(year, month, rows);
      expect(r.periods).toHaveLength(1);
      expect(r.periods[0].placement).toBe('crosses_month_boundary');
      expect(r.insidePeriodTotals.umsatzCents).toBe(0);
      expect(r.dailyTotals.umsatzCents).toBe(0);
    }
  });
});

describe('no double counting (test class 18)', () => {
  it('a second row on the database\'s own unique key is reported, not added', () => {
    const a = daily('anna', '2026-09-03', 'umsatz', 100);
    const b = { ...a, id: 'dup-1', amount: 100 };
    const r = read(2026, 9, [a, b]);
    expect(r.days[0].figures.umsatzCents).toBe(10_000);
    expect(r.issues).toEqual([{ rowId: 'dup-1', issue: 'duplicate_row', detail: expect.stringContaining('ext-anna|2026-09-03|umsatz') }]);
  });

  it('a daily row and a week of the same driver covering that day are flagged on both sides', () => {
    const r = read(2026, 9, [daily('anna', '2026-09-08', 'umsatz', 50), weekly('anna', '2026-09-07', '2026-09-13', 'umsatz', 300)]);
    expect(r.days[0].overlapsPeriod).toBe(true);
    expect(r.periods[0].overlappingDailyDates).toEqual(['2026-09-08']);
    expect(r.dailyDetail).toBe('partial');
  });

  it('another driver\'s week does not flag a day', () => {
    const r = read(2026, 9, [daily('anna', '2026-09-08', 'umsatz', 50), weekly('bert', '2026-09-07', '2026-09-13', 'umsatz', 300)]);
    expect(r.days[0].overlapsPeriod).toBe(false);
    expect(r.periods[0].overlappingDailyDates).toEqual([]);
  });
});

describe('driver identity', () => {
  it('falls back to the exact name when the link is gone, and says so', () => {
    const r = read(2026, 9, [daily('anna', '2026-09-03', 'umsatz', 10)], [ANNA, BERT], []);
    expect(r.days[0]).toMatchObject({ driverId: ANNA.id, identity: 'name_only' });
  });

  it('refuses to choose between two drivers of one name', () => {
    const twin: UberDriverRef = { id: '33333333-3333-4333-8333-333333333333', name: ANNA.name };
    const r = read(2026, 9, [daily('anna', '2026-09-03', 'umsatz', 10)], [ANNA, twin], []);
    expect(r.days).toEqual([]);
    expect(r.issues[0].issue).toBe('driver_ambiguous');
  });

  it('reports a row whose driver nobody knows', () => {
    const r = read(2026, 9, [daily('anna', '2026-09-03', 'umsatz', 10, { driver_name: 'Niemand', source_driver_key: 'ext-x' })]);
    expect(r.issues[0]).toMatchObject({ issue: 'driver_unresolved', detail: 'ext-x' });
  });

  it('a link that is not `linked` does not resolve', () => {
    const r = read(2026, 9, [daily('anna', '2026-09-03', 'umsatz', 10, { driver_name: 'Niemand' })], [ANNA], [
      { external_driver_id: 'ext-anna', driver_id: ANNA.id, status: 'proposed' },
    ]);
    expect(r.issues[0].issue).toBe('driver_unresolved');
  });
});

describe('rows that are not Uber figures', () => {
  it('keeps hand-typed rows apart and out of every total', () => {
    const hand: UberIncomeRow = { ...daily('anna', '2026-09-10', 'umsatz', 500), source: null, source_driver_key: null, source_period_start: null, source_period_end: null };
    const r = read(2026, 9, [hand]);
    expect(r.handRows).toEqual([{ rowId: String(hand.id), date: '2026-09-10', driverName: ANNA.name, type: 'umsatz', amountCents: 50_000 }]);
    expect(r.days).toEqual([]);
    expect(r.dailyTotals.umsatzCents + r.insidePeriodTotals.umsatzCents).toBe(0);
  });

  it('names an unknown type, an unreadable amount, a missing and an invalid period', () => {
    const r = read(2026, 9, [
      daily('anna', '2026-09-03', 'sonstiges', 1),
      daily('anna', '2026-09-04', 'umsatz', 'zwölf'),
      { ...daily('anna', '2026-09-05', 'umsatz', 1), source_period_start: null },
      { ...daily('anna', '2026-09-06', 'umsatz', 1), source_period_start: '2026-09-07', source_period_end: '2026-09-06' },
    ]);
    expect(r.issues.map(i => i.issue)).toEqual(['type_unknown', 'amount_invalid', 'period_missing', 'period_invalid']);
    expect(r.days).toEqual([]);
  });

  it('puts every row of the month in exactly one place', () => {
    const rows = [
      daily('anna', '2026-09-01', 'umsatz', 1), daily('bert', '2026-09-02', 'trinkgeld', 2),
      weekly('anna', '2026-09-14', '2026-09-20', 'umsatz', 3), weekly('bert', '2026-09-28', '2026-10-04', 'umsatz', 4),
      { ...daily('anna', '2026-09-09', 'umsatz', 5), source: null },
      daily('anna', '2026-09-01', 'umsatz', 6), // duplicate key
      daily('anna', '2026-09-03', 'umsatz', 7, { driver_name: 'X', source_driver_key: 'ext-x' }),
    ];
    const r = read(2026, 9, rows);
    const placed = [...r.days.flatMap(d => d.rowIds), ...r.periods.flatMap(p => p.rowIds), ...r.handRows.map(h => h.rowId), ...r.issues.map(i => i.rowId)];
    expect(placed.sort()).toEqual(rows.map(x => String(x.id)).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });
});

describe('the loader', async () => {
  const { createFakeSupabase } = await import('../../test-utils/fakeSupabase');
  const { loadUberMonth, uberReadWindow, UBER_PARTNER } = await import('./uberImportLoader');
  type Client = import('./uberImportLoader').UberLoaderClient;

  it('reads a window that reaches every Uber week touching the month, at both ends', () => {
    expect(uberReadWindow(2026, 10)).toEqual({ from: '2026-09-25', to: '2026-11-06' });
    expect(uberReadWindow(2028, 2)).toEqual({ from: '2028-01-26', to: '2028-03-06' });
  });

  it('pages every read, scopes it to the company and the partner, and writes nothing', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => daily('anna', '2026-09-01', i === 0 ? 'umsatz' : 'trinkgeld', 1, { id: 10_000 + i, source_period_start: '2026-08-01', source_period_end: '2026-08-01' }));
    const tail = [daily('anna', '2026-09-02', 'umsatz', '12.34')];
    const { client, calls } = createFakeSupabase(call => {
      if (call.table === 'income') return { data: call.filters.includes('range:0') ? big : tail, error: null };
      if (call.table === 'drivers') return { data: [ANNA], error: null };
      if (call.table === 'partner_driver_links') return { data: LINKS, error: null };
      return { data: null, error: { message: 'unexpected table' } };
    });
    const r = await loadUberMonth('company-1', 2026, 9, client as unknown as Client);
    expect(r.days.map(d => [d.date, d.figures.umsatzCents])).toEqual([['2026-09-02', 1234]]);
    const income = calls.filter(c => c.table === 'income');
    expect(income).toHaveLength(2);
    expect(income[0].filters).toEqual(expect.arrayContaining(['eq:company_id', 'gte:date', 'lte:date', 'order:id', 'range:0']));
    expect(income[1].filters).toContain('range:1000');
    expect(calls.find(c => c.table === 'partner_driver_links')!.filters).toEqual(expect.arrayContaining(['eq:company_id', 'eq:partner']));
    expect(calls.every(c => c.op === 'select')).toBe(true);
    expect(UBER_PARTNER).toBe('reidey');
  });

  it('a failed read fails the load; it never answers an empty month', async () => {
    const { client } = createFakeSupabase(call =>
      call.table === 'income' ? { data: null, error: { message: 'boom' } } : { data: [], error: null });
    await expect(loadUberMonth('company-1', 2026, 9, client as unknown as Client)).rejects.toThrow(/boom/);
  });
});
