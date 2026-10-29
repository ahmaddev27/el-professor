import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types/receipt';
import { toCents } from './money';
import {
  clockSeconds,
  measuredSortValue,
  MEASURED_SORT_FIELDS,
  sortReceipts,
  type MeasuredSortField,
} from './receiptSort';

/**
 * The five columns the owner marked on the Belege list (27.10.2026): the time
 * printed on the Beleg, the litres, the price per litre, the odometer and the
 * range left.
 *
 * The fixture is **deliberately out of order on all five** and is built around
 * the four things that make this sort different from sorting a name:
 *
 *   - a German decimal (`9,50` sorts AFTER `10,20` as text, before it as a
 *     number),
 *   - a thousands dot (`172.884` sorts BEFORE `80.284` as text),
 *   - an absent figure, on two rows, which the old comparator left wherever the
 *     previous order had put it,
 *   - a **zero**, which is a reading and not an absence: `range_km >= 0` is what
 *     the CHECK in 20261012100000 allows, so a car that can go no further has a
 *     0 and a Beleg that is not a refuel has nothing, and the two must not land
 *     in the same place.
 *
 * Every name here is invented.
 */

const beleg = (over: Partial<Receipt> & { receiptNumber: string }): Receipt => ({
  id: over.receiptNumber,
  date: '2026-03-01',
  description: 'Tanken',
  driverName: 'Fahrer Beispiel',
  expense: 0,
  ...over,
});

/** The amounts, kept awkward on purpose — see the last test in this file. */
const ROWS: Receipt[] = [
  beleg({ receiptNumber: 'BEL-0001', expense: 18.47, receiptTime: '21:05:00', litres: 9.5, pricePerLitre: 1.789, odometerKm: 80284, rangeKm: 410 }),
  beleg({ receiptNumber: 'BEL-0002', expense: 72.30, receiptTime: '05:26:00', litres: 10.2, pricePerLitre: 1.659, odometerKm: 172884, rangeKm: 95 }),
  // Entered by hand: no time, no fuel figures at all.
  beleg({ receiptNumber: 'BEL-0003', expense: 12.00, description: 'Autowäsche' }),
  beleg({ receiptNumber: 'BEL-0004', expense: 103.55, receiptTime: '00:04:00', litres: 1250.75, pricePerLitre: 2.009, odometerKm: 9999, rangeKm: 1105 }),
  // rangeKm 0 is a reading. odometerKm 100 is the smallest the CHECK admits.
  beleg({ receiptNumber: 'BEL-0005', expense: 0.01, receiptTime: '23:59:59', litres: 55.1, pricePerLitre: 1.009, odometerKm: 100, rangeKm: 0 }),
  // A time but no fuel figures, and a time that prints as BEL-0002's does.
  beleg({ receiptNumber: 'BEL-0006', expense: 5.55, receiptTime: '05:26:30', description: 'Parkgebühr' }),
  // Equal to BEL-0001 on all four figures: the ties the stable sort must keep.
  beleg({ receiptNumber: 'BEL-0007', expense: 33.33, receiptTime: '12:00', litres: 9.5, pricePerLitre: 1.789, odometerKm: 80284, rangeKm: 410 }),
];

const order = (field: MeasuredSortField, direction: 'asc' | 'desc'): string[] =>
  sortReceipts(ROWS, field, direction).map(row => row.receiptNumber);

/** The two rows that carry no figure for any of the four fuel columns. */
const NO_FUEL = ['BEL-0003', 'BEL-0006'];

/**
 * Whether a row carries a figure at all, read **off the row and not through
 * `measuredSortValue`**.
 *
 * A mutation control is what put this here. The empty-value probe below first
 * asked `measuredSortValue(row, field) === null` which rows were empty, and an
 * implementation that returns `0` for an absent figure then has no empty rows
 * by its own account — so the probe passed on exactly the defect it exists to
 * catch (measured: with `?? 0` spliced into `measuredSortValue`, ten assertions
 * in these two files failed and that one still passed). The probe now defines
 * "empty" from the stored shape, independently of the function under test.
 */
const carriesFigure = (row: Receipt, field: MeasuredSortField): boolean =>
  field === 'receiptTime' ? typeof row.receiptTime === 'string' : typeof row[field] === 'number';

describe('clockSeconds', () => {
  it('reads a Postgres time column, with or without its seconds', () => {
    // receipt_time is `time` (20261011100000), so PostgREST sends "05:26:00".
    expect(clockSeconds('00:00:00')).toBe(0);
    expect(clockSeconds('05:26:00')).toBe(5 * 3600 + 26 * 60);
    expect(clockSeconds('05:26:30')).toBe(5 * 3600 + 26 * 60 + 30);
    expect(clockSeconds('12:00')).toBe(12 * 3600);
    expect(clockSeconds('23:59:59')).toBe(86399);
    expect(clockSeconds('07:15:30.5')).toBe(7 * 3600 + 15 * 60 + 30.5);
  });

  /**
   * Null, never NaN. NaN compares false against every number in both
   * directions, which is the exact failure this module was written to close —
   * such a row would stay wherever the previous order left it.
   */
  it('answers null for anything that is not a clock time, and never NaN', () => {
    for (const value of ['', ' ', 'kein Wert', '24:00:00', '12:60', '12:30:60', '5:7', '05-26', '2026-03-01', undefined]) {
      expect(clockSeconds(value as string | undefined)).toBeNull();
    }
  });

  /**
   * The one shape where the sort could disagree with the cell about whether a
   * row HAS a time. `clockTime` matches `\d{2}`, so it draws nothing for a
   * one-digit hour; ranking such a row at 05:26 would wedge a blank-looking
   * cell into the middle of the ranking. Both halves read two digits, which is
   * also what the form's own validator accepts (`([01]\d|2[0-3])`).
   */
  it('reads the hour as two digits, exactly as the cell and the form do', async () => {
    const { clockTime } = await import('./receiptDisplay');
    for (const value of ['5:26', '5:26:00', '0:00']) {
      expect(clockTime(value), value).toBeNull();
      expect(clockSeconds(value), value).toBeNull();
    }
    // And the zero-padded form every real row carries is read by both.
    expect(clockTime('05:26:00')).toBe('05:26');
    expect(clockSeconds('05:26:00')).toBe(5 * 3600 + 26 * 60);
  });
});

describe('measuredSortValue', () => {
  it('gives the number the row holds, and null where it holds none', () => {
    expect(measuredSortValue(ROWS[3], 'litres')).toBe(1250.75);
    expect(measuredSortValue(ROWS[3], 'pricePerLitre')).toBe(2.009);
    expect(measuredSortValue(ROWS[3], 'odometerKm')).toBe(9999);
    expect(measuredSortValue(ROWS[3], 'rangeKm')).toBe(1105);
    expect(measuredSortValue(ROWS[3], 'receiptTime')).toBe(4 * 60);
    for (const field of MEASURED_SORT_FIELDS) {
      expect(measuredSortValue(ROWS[2], field)).toBeNull();
    }
  });

  /** A zero is a reading. It must not read as "no reading". */
  it('keeps a zero a zero', () => {
    expect(measuredSortValue(ROWS[4], 'rangeKm')).toBe(0);
    expect(measuredSortValue(ROWS[4], 'rangeKm')).not.toBeNull();
  });
});

describe('the five measured columns sort on their value', () => {
  it('orders the litres as numbers — 9,5 before 10,2, not after it', () => {
    expect(order('litres', 'asc')).toEqual([
      'BEL-0001', 'BEL-0007', // 9.5, tied, in the order they arrived
      'BEL-0002',             // 10.2  — after 9,5 although "10,20" < "9,50" as text
      'BEL-0005',             // 55.1
      'BEL-0004',             // 1250.75
      ...NO_FUEL,
    ]);
    expect(order('litres', 'desc')).toEqual([
      'BEL-0004', 'BEL-0005', 'BEL-0002', 'BEL-0001', 'BEL-0007', ...NO_FUEL,
    ]);
  });

  it('orders the price per litre at its three decimals', () => {
    expect(order('pricePerLitre', 'asc')).toEqual([
      'BEL-0005', 'BEL-0002', 'BEL-0001', 'BEL-0007', 'BEL-0004', ...NO_FUEL,
    ]);
    expect(order('pricePerLitre', 'desc')).toEqual([
      'BEL-0004', 'BEL-0001', 'BEL-0007', 'BEL-0002', 'BEL-0005', ...NO_FUEL,
    ]);
  });

  it('orders the odometer as a number — 80.284 before 172.884, not after it', () => {
    expect(order('odometerKm', 'asc')).toEqual([
      'BEL-0005',             // 100
      'BEL-0004',             // 9.999
      'BEL-0001', 'BEL-0007', // 80.284, tied
      'BEL-0002',             // 172.884 — last, although "172.884" < "80.284" as text
      ...NO_FUEL,
    ]);
    expect(order('odometerKm', 'desc')).toEqual([
      'BEL-0002', 'BEL-0001', 'BEL-0007', 'BEL-0004', 'BEL-0005', ...NO_FUEL,
    ]);
  });

  it('orders the range left, and ranks the 0 km reading rather than setting it aside', () => {
    expect(order('rangeKm', 'asc')).toEqual([
      'BEL-0005',             // 0 km — a reading, and the lowest one
      'BEL-0002', 'BEL-0001', 'BEL-0007', 'BEL-0004',
      ...NO_FUEL,
    ]);
    // Descending, the 0 is still ranked: it is the last row that HAS a reading,
    // and it comes before the two that have none.
    expect(order('rangeKm', 'desc')).toEqual([
      'BEL-0004', 'BEL-0001', 'BEL-0007', 'BEL-0002', 'BEL-0005', ...NO_FUEL,
    ]);
  });

  /**
   * The time is compared as seconds since midnight, so BEL-0002 (05:26:00) and
   * BEL-0006 (05:26:30) are ordered although the cell prints `05:26` for both —
   * `clockTime` truncates for display and this does not read the display.
   */
  it('orders the printed time by the clock, seconds included', () => {
    expect(order('receiptTime', 'asc')).toEqual([
      'BEL-0004', // 00:04
      'BEL-0002', // 05:26:00
      'BEL-0006', // 05:26:30
      'BEL-0007', // 12:00
      'BEL-0001', // 21:05
      'BEL-0005', // 23:59:59
      'BEL-0003', // no time
    ]);
    expect(order('receiptTime', 'desc')).toEqual([
      'BEL-0005', 'BEL-0001', 'BEL-0007', 'BEL-0006', 'BEL-0002', 'BEL-0004', 'BEL-0003',
    ]);
  });
});

describe('the empty-value rule', () => {
  /**
   * Empties last in BOTH directions. A Beleg with no odometer is not a Beleg
   * for a car that has driven 0 km, so it has no rank; and letting empties lead
   * a descending sort would open "highest reading first" onto a screenful of
   * blank cells, since most Belege are not refuels.
   */
  it('puts every row without a figure at the end, whichever way the sort runs', () => {
    for (const field of MEASURED_SORT_FIELDS) {
      for (const direction of ['asc', 'desc'] as const) {
        const sorted = sortReceipts(ROWS, field, direction);
        const empties = sorted
          .map((row, index) => (carriesFigure(row, field) ? -1 : index))
          .filter(index => index >= 0);
        // How many rows are empty is a fact about the fixture, not about the
        // sort: counted here so a run cannot pass by finding none.
        expect(empties.length, `${field} ${direction}`)
          .toBe(ROWS.filter(row => !carriesFigure(row, field)).length);
        const ranked = sorted.length - empties.length;
        expect(empties, `${field} ${direction}`).toEqual(
          Array.from({ length: empties.length }, (_, i) => ranked + i),
        );
      }
    }
  });

  it('keeps the empties in the order they arrived in, rather than shuffling them', () => {
    expect(order('litres', 'asc').slice(-2)).toEqual(NO_FUEL);
    expect(order('litres', 'desc').slice(-2)).toEqual(NO_FUEL);
  });
});

describe('sorting is a permutation and nothing else', () => {
  /**
   * The structural half of "a sort must not change a total". Both figures in the
   * header — Ausgaben gesamt and MwSt. 19 % gesamt — are reduced over this
   * list, so they cannot move if the list always holds the same rows. The
   * figures themselves are asserted in ReceiptList.sort.test.ts, against what
   * the screen prints.
   */
  it('returns the same rows, every field and both directions', () => {
    const expected = [...ROWS].map(row => row.receiptNumber).sort();
    for (const field of MEASURED_SORT_FIELDS) {
      for (const direction of ['asc', 'desc'] as const) {
        const sorted = sortReceipts(ROWS, field, direction);
        expect(sorted, `${field} ${direction}`).toHaveLength(ROWS.length);
        expect(sorted.map(row => row.receiptNumber).sort(), `${field} ${direction}`).toEqual(expected);
      }
    }
  });

  it('does not reorder the caller’s array', () => {
    const before = ROWS.map(row => row.receiptNumber);
    sortReceipts(ROWS, 'odometerKm', 'desc');
    expect(ROWS.map(row => row.receiptNumber)).toEqual(before);
  });

  /**
   * WHY THE TOTALS ARE ASSERTED AS CENTS AND NEVER AS DOUBLES.
   *
   * `totalExpenses` is `rows.reduce((sum, r) => sum + r.expense, 0)`, and
   * IEEE-754 addition is not associative, so **re-ordering the rows does change
   * the double**. Measured over all 5040 orderings of this fixture's seven
   * amounts: four distinct sums — 245.20999999999995, 245.20999999999998,
   * 245.21 and 245.21000000000004 — and two distinct VAT sums. A test that
   * asserted the raw `reduce` was unchanged by sorting would be asserting
   * something that is not true in general and passes only on the orderings it
   * happens to try.
   *
   * Every one of those rounds to the same 24521 cents, which is what the screen
   * prints, and `toCents` is the rounding the screen's `formatEuro` applies.
   */
  it('shows that the double moves with the order while the cent figure does not', () => {
    const amounts = ROWS.map(row => row.expense);
    const forward = amounts.reduce((sum, amount) => sum + amount, 0);
    const backward = [...amounts].reverse().reduce((sum, amount) => sum + amount, 0);
    expect(forward).not.toBe(backward);
    expect(toCents(forward)).toBe(toCents(backward));
    expect(toCents(forward)).toBe(24521);
  });
});

/**
 * The date column (29.10.2026): `date` is a day, not an instant, so a month's
 * Belege are full of ties — and "newest first" used to leave every same-day
 * row in arrival order, which is the fetch's `date, id` and not the order the
 * papers were printed in. The day now ranks with the printed sale time inside
 * it, a Beleg without a time sorts last within its day in both directions
 * (the module's empty-value rule), and the id is the final key — always
 * ascending, so equal rows hold ONE order whichever way the ranking runs.
 */
describe('the date column ranks by day, sale time and id', () => {
  const rows: Receipt[] = [
    beleg({ receiptNumber: 'BEL-0101', date: '2026-03-02', receiptTime: '08:00:00' }),
    beleg({ receiptNumber: 'BEL-0102', date: '2026-03-02', receiptTime: '12:30:00' }),
    // Entered by hand: a day but no printed sale time.
    beleg({ receiptNumber: 'BEL-0103', date: '2026-03-02' }),
    beleg({ receiptNumber: 'BEL-0104', date: '2026-03-01', receiptTime: '23:59:00' }),
    // The same day and minute as BEL-0102: only the id separates them.
    beleg({ receiptNumber: 'BEL-0105', date: '2026-03-02', receiptTime: '12:30:00' }),
  ];
  const ordered = (direction: 'asc' | 'desc'): string[] =>
    sortReceipts(rows, 'date', direction).map(row => row.receiptNumber);

  it('newest first is the latest day and, inside it, the latest sale time', () => {
    expect(ordered('desc')).toEqual(['BEL-0102', 'BEL-0105', 'BEL-0101', 'BEL-0103', 'BEL-0104']);
  });

  it('oldest first flips the day and the time, never the empty rule', () => {
    expect(ordered('asc')).toEqual(['BEL-0104', 'BEL-0101', 'BEL-0102', 'BEL-0105', 'BEL-0103']);
  });

  it('holds one id order for a full tie in both directions', () => {
    const asc = ordered('asc');
    const desc = ordered('desc');
    expect(asc.indexOf('BEL-0102')).toBeLessThan(asc.indexOf('BEL-0105'));
    expect(desc.indexOf('BEL-0102')).toBeLessThan(desc.indexOf('BEL-0105'));
  });
});
