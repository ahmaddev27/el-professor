import { describe, it, expect } from 'vitest';
import {
  PAYROLL_SUMMARY_COLUMNS,
  buildPayrollSummary,
  computePlanDriverHours,
  payrollSummaryFileName,
  planungNotice,
  type PayrollSummaryBlock,
  type PayrollSummaryDriver,
  type PayrollDriverHours,
} from './monthlyPlanPayrollSummary';
import { ARBEITSTAGE_INDEX, FAHRERUEBERSICHT_COLUMNS } from './fahreruebersichtColumns';

/**
 * §12's sheet, and what each assertion would have caught before it existed.
 *
 * `vitest.config.ts` pins `TZ=Europe/Berlin`, and it has to: every figure here
 * is classified by the **local** calendar day, so the night, Saturday, Sunday
 * and holiday buckets are timezone-dependent and these numbers only mean
 * anything in the product's own zone. The instants below are therefore written
 * as local wall-clock times.
 */

/** Berlin local wall clock as epoch ms. The test's only time construction. */
function berlin(
  year: number, month: number, day: number, hour: number, minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const HOUR = 3600;

function block(startMs: number, endMs: number, driverId = 'd1', rideMinutes = 0): PayrollSummaryBlock {
  return { driverId, startMs, endMs, rideMinutes };
}

const DRIVERS: PayrollSummaryDriver[] = [
  { driverId: 'd1', driverName: 'Özcan, Ali', personalnummer: '4711' },
  { driverId: 'd2', driverName: 'Abel, Bert', personalnummer: null },
];

/** 30.09.2026, a Wednesday, 12:00 Berlin — the fixed clock for every sheet below. */
const GENERATED_AT = berlin(2026, 9, 30, 12);

// ── The columns ───────────────────────────────────────────────────────────────

describe('PAYROLL_SUMMARY_COLUMNS — §12 adds exactly one column', () => {
  /**
   * §12 names the total hours in so many words ("إجمالي الساعات"), and the
   * 25-column Fahrerübersicht has no such column: it prints Arbeitstage and the
   * seven premium buckets and no sum. Before this, §12's own required figure was
   * simply absent from the sheet built for §12.
   */
  it('inserts Std. Gesamt and leaves the other 25 alone', () => {
    expect(PAYROLL_SUMMARY_COLUMNS).toHaveLength(FAHRERUEBERSICHT_COLUMNS.length + 1);
    expect(PAYROLL_SUMMARY_COLUMNS.map(c => c.label)).toContain('Std. Gesamt');
    const withoutTotal = PAYROLL_SUMMARY_COLUMNS
      .filter(c => c.label !== 'Std. Gesamt')
      .map(c => c.label);
    expect(withoutTotal).toEqual(FAHRERUEBERSICHT_COLUMNS.map(c => c.label));
  });

  /**
   * The position is load-bearing. Samstag, Sonntag, Feiertag and Weihnachten
   * classify the same hours the first three buckets partition, so a total in the
   * **last** position reads as the sum of everything before it — which is the
   * double count `totalMins()` in `stundennachweisArchiveExport.ts` makes. Fifth
   * position, beside Arbeitstage, reads as what it is.
   */
  it('puts the total directly after Arbeitstage, before the breakdown', () => {
    expect(FAHRERUEBERSICHT_COLUMNS[ARBEITSTAGE_INDEX].label).toBe('Arbeitstage');
    expect(PAYROLL_SUMMARY_COLUMNS[ARBEITSTAGE_INDEX].label).toBe('Arbeitstage');
    expect(PAYROLL_SUMMARY_COLUMNS[ARBEITSTAGE_INDEX + 1].label).toBe('Std. Gesamt');
    expect(PAYROLL_SUMMARY_COLUMNS[ARBEITSTAGE_INDEX + 2].label).toBe('Std. Grundlohn');
    // The last computed column, after which every cell is blank for the adviser.
    expect(PAYROLL_SUMMARY_COLUMNS[11].label).toBe('Std. Weihnachten');
  });
});

// ── The disjointness ──────────────────────────────────────────────────────────

describe('computePlanDriverHours — the three disjoint buckets', () => {
  /**
   * CLAUDE.md states it as a rule: Lohnart 1500 and 1501 are mutually exclusive,
   * `1500 = nightSec − night0to4Sec`, never double-counted. With 06–20 as
   * Grundlohn the three partition the clock, so they must sum to the total
   * exactly. A bucket that started overlapping another — or a `totalSec`
   * computed from something other than the same interval — fails here.
   */
  it('grundlohn + nacht(20-06) + nacht(00-04) === total, exactly', () => {
    // A block that touches all three windows: 18:00 Thursday → 05:00 Friday.
    const hours = computePlanDriverHours([
      block(berlin(2026, 10, 15, 18), berlin(2026, 10, 16, 5)),
    ]).get('d1')!;

    expect(hours.grundlohnSec + hours.night2006Sec + hours.night0004Sec)
      .toBe(hours.totalSec);
    expect(hours.totalSec).toBe(11 * HOUR);
    // 18:00–20:00 base; 20:00–24:00 + 04:00–05:00 night25; 00:00–04:00 night40.
    expect(hours.grundlohnSec).toBe(2 * HOUR);
    expect(hours.night2006Sec).toBe(5 * HOUR);
    expect(hours.night0004Sec).toBe(4 * HOUR);
  });

  /**
   * The cross-midnight case the whole codebase warns about twice. Read as clock
   * strings, `"05:00" < "18:00"` and the block is negative or empty; built from
   * absolute milliseconds it is eleven hours over two calendar days. The working
   * day count is what makes the split visible.
   */
  it('counts a cross-midnight block as two working days', () => {
    const hours = computePlanDriverHours([
      block(berlin(2026, 10, 15, 18), berlin(2026, 10, 16, 5)),
    ]).get('d1')!;
    expect(hours.workingDays).toBe(2);
  });

  it('counts two blocks on one day as one working day', () => {
    const hours = computePlanDriverHours([
      block(berlin(2026, 10, 15, 6), berlin(2026, 10, 15, 10)),
      block(berlin(2026, 10, 15, 14), berlin(2026, 10, 15, 18)),
    ]).get('d1')!;
    expect(hours.workingDays).toBe(1);
    expect(hours.totalSec).toBe(8 * HOUR);
    expect(hours.blockCount).toBe(2);
  });
});

describe('computePlanDriverHours — the premium classifications', () => {
  /**
   * Saturday, Sunday, holiday and the 150% band classify hours already counted
   * in the three buckets; they are not further parts of the day. If a later
   * change made one of them additive, the sum below would exceed the total and
   * the sheet's footer note would be a false statement.
   */
  it('classifies rather than partitions: a Sunday block is both base and Sunday', () => {
    // 18.10.2026 is a Sunday.
    const hours = computePlanDriverHours([
      block(berlin(2026, 10, 18, 8), berlin(2026, 10, 18, 16)),
    ]).get('d1')!;
    expect(hours.totalSec).toBe(8 * HOUR);
    expect(hours.grundlohnSec).toBe(8 * HOUR);
    expect(hours.sundaySec).toBe(8 * HOUR);
    expect(hours.saturdaySec).toBe(0);
    expect(hours.holidaySec).toBe(0);
  });

  /**
   * Saturday has no bucket in `computeLohnartSeconds` at all, so it is derived
   * here — per minute, by local calendar day, the same shape that function uses
   * for Sunday. A Saturday-night block into Sunday must split between the two
   * columns; `MonatsplanungStundennachweisPreview` would put all of it under
   * Saturday, because it reads the shift's `service_date`.
   */
  it('splits a Saturday-into-Sunday block between the two day columns', () => {
    // 17.10.2026 is a Saturday, 18.10.2026 a Sunday.
    const hours = computePlanDriverHours([
      block(berlin(2026, 10, 17, 22), berlin(2026, 10, 18, 2)),
    ]).get('d1')!;
    expect(hours.saturdaySec).toBe(2 * HOUR);
    expect(hours.sundaySec).toBe(2 * HOUR);
    expect(hours.totalSec).toBe(4 * HOUR);
  });

  /**
   * §3b Abs. 3 EStG's 150% band is 25.12, 26.12 **and the 1. Mai**, which is
   * what the live Stundennachweis reads and what looks like a bug until the
   * statute is read. Reproducing it is deliberate; this test is what stops the
   * next reader "correcting" it. Both days are also public holidays, so the 150%
   * seconds are a subset of the holiday seconds.
   */
  it('puts 25.12, 26.12 and 01.05 in the 150% band, as a subset of the holidays', () => {
    const xmas = computePlanDriverHours([
      block(berlin(2026, 12, 25, 10), berlin(2026, 12, 25, 16)),
    ]).get('d1')!;
    expect(xmas.xmas150Sec).toBe(6 * HOUR);
    expect(xmas.holidaySec).toBe(6 * HOUR);

    const mayDay = computePlanDriverHours([
      block(berlin(2026, 5, 1, 10), berlin(2026, 5, 1, 16)),
    ]).get('d1')!;
    expect(mayDay.xmas150Sec).toBe(6 * HOUR);
    expect(mayDay.holidaySec).toBe(6 * HOUR);

    // 03.10 (Tag der Deutschen Einheit) is a holiday and NOT in the 150% band.
    const unity = computePlanDriverHours([
      block(berlin(2026, 10, 3, 10), berlin(2026, 10, 3, 16)),
    ]).get('d1')!;
    expect(unity.holidaySec).toBe(6 * HOUR);
    expect(unity.xmas150Sec).toBe(0);
  });

  /**
   * The clean engine's own call site passes `getGermanNationalHolidays(startYear)`
   * alone, so a block from 31.12 into 01.01 sees no Neujahr and loses six hours
   * of holiday premium. This module unions both years.
   */
  it('sees Neujahr in a block that starts on 31.12', () => {
    const hours = computePlanDriverHours([
      block(berlin(2026, 12, 31, 22), berlin(2027, 1, 1, 4)),
    ]).get('d1')!;
    expect(hours.totalSec).toBe(6 * HOUR);
    // 00:00–04:00 of 01.01.2027 is the holiday part.
    expect(hours.holidaySec).toBe(4 * HOUR);
  });
});

describe('computePlanDriverHours — what it refuses to count', () => {
  it('skips an unassigned block rather than attributing it to anyone', () => {
    const result = computePlanDriverHours([
      { driverId: null, startMs: berlin(2026, 10, 15, 8), endMs: berlin(2026, 10, 15, 16) },
    ]);
    expect(result.size).toBe(0);
  });

  it('skips a block whose end is not after its start', () => {
    const at = berlin(2026, 10, 15, 8);
    expect(computePlanDriverHours([block(at, at)]).size).toBe(0);
    expect(computePlanDriverHours([block(at, at - 1000)]).size).toBe(0);
  });

  it('carries ride minutes without letting them into an hour figure', () => {
    const hours = computePlanDriverHours([
      block(berlin(2026, 10, 15, 8), berlin(2026, 10, 15, 16), 'd1', 300),
    ]).get('d1')!;
    // The span is eight hours; the rides inside it are five. The difference is
    // §3's idle time, kept separate rather than folded into either figure.
    expect(hours.totalSec).toBe(8 * HOUR);
    expect(hours.rideMinutes).toBe(300);
  });

  it('keeps one driver’s figures off another driver', () => {
    const result = computePlanDriverHours([
      block(berlin(2026, 10, 15, 8), berlin(2026, 10, 15, 16), 'd1'),
      block(berlin(2026, 10, 15, 8), berlin(2026, 10, 15, 12), 'd2'),
    ]);
    expect(result.get('d1')!.totalSec).toBe(8 * HOUR);
    expect(result.get('d2')!.totalSec).toBe(4 * HOUR);
  });
});

// ── The sheet ─────────────────────────────────────────────────────────────────

describe('buildPayrollSummary — the proposal label', () => {
  /**
   * The owner's decision: this plans a month that has not happened, so every
   * output says so. Without these three, a forecast reaches a Steuerberater
   * looking exactly like the month's actuals and wages are paid for work nobody
   * did.
   */
  it('names itself a plan in the header, the footer and the filename', () => {
    const sheet = buildPayrollSummary({
      month: 10, year: 2026, companyName: 'Y&A Mobility',
      drivers: DRIVERS, hoursByDriverId: new Map(), generatedAtMs: GENERATED_AT,
    });
    expect(sheet.planungNotice).toContain('PLANUNG / VORSCHAU — kein Arbeitszeitnachweis');
    expect(sheet.footerNote).toContain('PLANUNG / VORSCHAU — kein Arbeitszeitnachweis');
    expect(sheet.fileName).toContain('_PLANUNG_');
    expect(sheet.title).toContain('Planung');
  });

  it('dates the notice DD.MM.YYYY, never a US order', () => {
    // 30.09.2026. A US order would read 09.30.2026 and 09 is a valid day.
    expect(planungNotice(GENERATED_AT)).toContain('Erstellt: 30.09.2026');
    expect(planungNotice(GENERATED_AT)).not.toContain('09.30');
  });

  it('carries the month and the year in the filename, zero-padded', () => {
    expect(payrollSummaryFileName(1, 2026)).toBe('Lohn_Stundenuebersicht_PLANUNG_01_2026.xlsx');
    expect(payrollSummaryFileName(12, 2026)).toBe('Lohn_Stundenuebersicht_PLANUNG_12_2026.xlsx');
  });

  it('names the month in German', () => {
    const sheet = buildPayrollSummary({
      month: 3, year: 2026, companyName: '', drivers: [],
      hoursByDriverId: new Map(), generatedAtMs: GENERATED_AT,
    });
    expect(sheet.periodLabel).toBe('März 2026');
    // A broken month argument must not print "undefined" on a tax document.
    const broken = buildPayrollSummary({
      month: 13, year: 2026, companyName: '', drivers: [],
      hoursByDriverId: new Map(), generatedAtMs: GENERATED_AT,
    });
    expect(broken.periodLabel).toBe('2026');
  });
});

describe('buildPayrollSummary — the rows', () => {
  const hours: PayrollDriverHours = {
    totalSec: 11 * HOUR,
    grundlohnSec: 2 * HOUR,
    night2006Sec: 5 * HOUR,
    night0004Sec: 4 * HOUR,
    saturdaySec: 0,
    sundaySec: 0,
    holidaySec: 0,
    xmas150Sec: 0,
    workingDays: 2,
    rideMinutes: 480,
    blockCount: 1,
  };

  function sheet(map: Map<string, PayrollDriverHours>) {
    return buildPayrollSummary({
      month: 10, year: 2026, companyName: 'Y&A Mobility',
      drivers: DRIVERS, hoursByDriverId: map, generatedAtMs: GENERATED_AT,
    });
  }

  it('gives every row exactly one cell per column', () => {
    for (const row of sheet(new Map([['d1', hours]])).rows) {
      expect(row.cells).toHaveLength(PAYROLL_SUMMARY_COLUMNS.length);
    }
  });

  /**
   * A row whose figures come from the map must not be recomputed here. The
   * arithmetic is one division by 60; the formatting is `fmtHours`, the German
   * decimal comma. 11 h prints `11,00`, not `11.00` and not `660`.
   */
  it('formats hours with a decimal comma and never as minutes', () => {
    const row = sheet(new Map([['d1', hours]])).rows.find(r => r.driverId === 'd1')!;
    expect(row.cells[ARBEITSTAGE_INDEX]).toBe(2);
    expect(row.cells[ARBEITSTAGE_INDEX + 1]).toBe('11,00');
    expect(row.cells[ARBEITSTAGE_INDEX + 2]).toBe('2,00');
    expect(row.cells[ARBEITSTAGE_INDEX + 3]).toBe('5,00');
    expect(row.cells[ARBEITSTAGE_INDEX + 4]).toBe('4,00');
  });

  /**
   * §12 asks for the employee number "if there is one". `monthly_plan_drivers`
   * has no `personalnummer` column at all, so it is a live read that can come
   * back empty — and `fahreruebersichtExport.ts` folds `personalnummer ??
   * driver_id` into one `ID` column, printing a UUID where a Steuerberater reads
   * an employee number. A blank is the only honest cell.
   */
  it('prints a blank employee number, never the driver id', () => {
    const rows = sheet(new Map([['d1', hours]])).rows;
    const withNumber = rows.find(r => r.driverId === 'd1')!;
    const without = rows.find(r => r.driverId === 'd2')!;
    expect(withNumber.cells[1]).toBe('4711');
    expect(without.cells[1]).toBe('');
    expect(without.cells[1]).not.toContain('d2');
  });

  /**
   * "A figure whose load failed must not be shown." A driver in the plan with no
   * assigned block has no measured hours, and a printed 0,00 reads as a
   * measurement — that the driver was scheduled and worked nothing, rather than
   * that nothing was scheduled. The row stays, because §23 forbids dropping
   * anything silently.
   */
  it('leaves a driver without assigned work blank, not zero, and keeps the row', () => {
    const built = sheet(new Map([['d1', hours]]));
    const idle = built.rows.find(r => r.driverId === 'd2')!;
    expect(idle.hours).toBeNull();
    // Arbeitstage through Std. Weihnachten: nine cells, all empty.
    expect(idle.cells.slice(ARBEITSTAGE_INDEX, ARBEITSTAGE_INDEX + 9)).toEqual(
      ['', '', '', '', '', '', '', '', ''],
    );
    expect(built.rows).toHaveLength(2);
    expect(built.driversWithoutWork).toBe(1);
  });

  it('leaves the fourteen manual columns blank rather than zero', () => {
    const row = sheet(new Map([['d1', hours]])).rows[0];
    const manual = row.cells.slice(12);
    expect(manual).toHaveLength(14);
    expect(manual.every(cell => cell === '')).toBe(true);
  });

  /** German collation, so the sheet reads in the order the Fahrer screen lists. */
  it('orders drivers by name and numbers them from 1 in that order', () => {
    const rows = sheet(new Map([['d1', hours]])).rows;
    expect(rows.map(r => r.cells[2])).toEqual(['Abel, Bert', 'Özcan, Ali']);
    expect(rows.map(r => r.cells[0])).toEqual([1, 2]);
  });

  /**
   * A bucket a driver genuinely worked zero of prints blank too — `fmtHours(0)`
   * is `''` by contract, inherited unchanged from the sheet this one shares its
   * columns with. Stated as a test because it is the one place where "blank"
   * does not mean "unknown", and a reader comparing the two sheets needs both to
   * behave the same way.
   */
  it('prints a worked zero as a blank cell, as the sibling sheet does', () => {
    const row = sheet(new Map([['d1', hours]])).rows.find(r => r.driverId === 'd1')!;
    // Samstag, Sonntag, Feiertag, Weihnachten are all zero for this driver.
    expect(row.cells.slice(ARBEITSTAGE_INDEX + 5, ARBEITSTAGE_INDEX + 9))
      .toEqual(['', '', '', '']);
  });
});

describe('buildPayrollSummary — end to end from blocks', () => {
  /**
   * The whole chain: plan blocks → `computePlanDriverHours` → the sheet. The
   * point of the assertion is that the sheet's `Std. Gesamt` equals the sum of
   * the three disjoint columns printed beside it, and that the footer's claim
   * about the other four is true of the numbers actually printed.
   */
  it('prints a total that equals its own three parts', () => {
    const blocks: PayrollSummaryBlock[] = [
      block(berlin(2026, 10, 15, 18), berlin(2026, 10, 16, 5)),
      block(berlin(2026, 10, 17, 22), berlin(2026, 10, 18, 2)),
    ];
    const built = buildPayrollSummary({
      month: 10, year: 2026, companyName: 'Y&A Mobility', drivers: DRIVERS,
      hoursByDriverId: computePlanDriverHours(blocks), generatedAtMs: GENERATED_AT,
    });
    const row = built.rows.find(r => r.driverId === 'd1')!;
    const h = row.hours!;

    expect(h.totalSec).toBe(15 * HOUR);
    expect(h.grundlohnSec + h.night2006Sec + h.night0004Sec).toBe(h.totalSec);
    expect(row.cells[ARBEITSTAGE_INDEX + 1]).toBe('15,00');
    // Saturday and Sunday two hours each, on top of the same fifteen.
    expect(h.saturdaySec).toBe(2 * HOUR);
    expect(h.sundaySec).toBe(2 * HOUR);
    expect(h.workingDays).toBe(4);
  });
});
