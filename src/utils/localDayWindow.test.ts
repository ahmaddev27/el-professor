/**
 * The wall-clock day primitives, and the two days a year they exist for.
 *
 * `vitest.config.ts` pins `TZ=Europe/Berlin`, which is what makes these
 * assertions mean anything: they are about the product's own zone, and the two
 * transitions in it are **29.03.2026** (02:00 → 03:00, a 23-hour day) and
 * **25.10.2026** (03:00 → 02:00, a 25-hour day).
 *
 * Every expectation below is written as an **instant in UTC** and not as a
 * local-time string, because a local string is exactly the ambiguity under test:
 * on 25.10.2026 "02:30" names two different moments. `Date.UTC(...)` names one.
 */

import { describe, it, expect } from 'vitest';
import {
  localDateKey,
  localHourMs,
  localMidnightMs,
  nextLocalMidnightMs,
  splitAtLocalMidnight,
} from './localDayWindow';

const H = 3_600_000;

/** Europe/Berlin is +01:00 in winter and +02:00 in summer. */
const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
  Date.UTC(y, m - 1, d, h, min);

describe('the timezone premise these tests rest on', () => {
  // If this fails, nothing below means what it says — so it is asserted rather
  // than assumed. The kit's own lesson: an instrument that transforms its
  // subject proves nothing.
  it('runs in Europe/Berlin', () => {
    expect(new Date(utc(2026, 1, 15)).getHours()).toBe(1);  // winter, +01:00
    expect(new Date(utc(2026, 7, 15)).getHours()).toBe(2);  // summer, +02:00
  });

  it('agrees that 29.03.2026 is 23 hours and 25.10.2026 is 25', () => {
    const spring = localMidnightMs(utc(2026, 3, 29, 12));
    expect(nextLocalMidnightMs(spring) - spring).toBe(23 * H);

    const autumn = localMidnightMs(utc(2026, 10, 25, 12));
    expect(nextLocalMidnightMs(autumn) - autumn).toBe(25 * H);
  });
});

describe('localMidnightMs', () => {
  it('answers local midnight, not UTC midnight', () => {
    // 15.01.2026 00:30 local is 14.01 23:30 UTC. A UTC-based answer would give
    // the 14th; this is the mistake `FinalizePlanningModal` made every day of
    // the year with `Math.floor(ms / 86400000) * 86400000`.
    expect(localMidnightMs(utc(2026, 1, 14, 23, 30))).toBe(utc(2026, 1, 14, 23));
    expect(new Date(localMidnightMs(utc(2026, 1, 14, 23, 30))).getDate()).toBe(15);
  });

  it('is idempotent, so a day base can be re-derived from itself', () => {
    for (const ms of [utc(2026, 3, 29, 12), utc(2026, 10, 25, 12), utc(2026, 6, 1, 8)]) {
      const day = localMidnightMs(ms);
      expect(localMidnightMs(day)).toBe(day);
    }
  });
});

describe('nextLocalMidnightMs', () => {
  it('is a calendar step, not a 24-hour step, on both transition days', () => {
    // The whole defect in one pair of assertions: `+ 24h` from local midnight
    // lands an hour past the next day's midnight in spring and an hour short of
    // it in autumn, and it never recovers on the days that follow.
    const spring = localMidnightMs(utc(2026, 3, 29, 12));
    expect(nextLocalMidnightMs(spring)).not.toBe(spring + 24 * H);
    expect(new Date(nextLocalMidnightMs(spring)).getDate()).toBe(30);
    expect(new Date(nextLocalMidnightMs(spring)).getHours()).toBe(0);

    const autumn = localMidnightMs(utc(2026, 10, 25, 12));
    expect(nextLocalMidnightMs(autumn)).not.toBe(autumn + 24 * H);
    expect(new Date(nextLocalMidnightMs(autumn)).getDate()).toBe(26);
    expect(new Date(nextLocalMidnightMs(autumn)).getHours()).toBe(0);
  });

  it('crosses a month, a year and a leap day without arithmetic of its own', () => {
    const cases: [number, [number, number]][] = [
      [utc(2026, 1, 31, 12), [2, 1]],
      [utc(2026, 12, 31, 12), [1, 1]],
      [utc(2024, 2, 28, 12), [2, 29]],   // 2024 is a leap year
      [utc(2026, 2, 28, 12), [3, 1]],    // 2026 is not
    ];
    for (const [ms, [month, day]] of cases) {
      const next = new Date(nextLocalMidnightMs(localMidnightMs(ms)));
      expect([next.getMonth() + 1, next.getDate()]).toEqual([month, day]);
    }
  });
});

describe('localHourMs', () => {
  it('answers the wall-clock hour on an ordinary day', () => {
    const day = localMidnightMs(utc(2026, 6, 15, 12));
    for (const hour of [0, 4, 6, 20, 23]) {
      expect(new Date(localHourMs(day, hour)).getHours()).toBe(hour);
    }
    expect(localHourMs(day, 24)).toBe(nextLocalMidnightMs(day));
  });

  /**
   * The spring-forward assertion, and the reason an hour used to be paid at the
   * wrong rate: `midnight + 4h` is local **05:00** on a 23-hour day, so the
   * 00:00–04:00 band (Lohnart 1501, 40 %) swallowed the 04:00–05:00 hour that
   * belongs to 1500 (25 %).
   */
  it('does not drift on the 23-hour day, where the old arithmetic over-paid', () => {
    const day = localMidnightMs(utc(2026, 3, 29, 12));   // 28.03 23:00 UTC
    expect(day).toBe(utc(2026, 3, 28, 23));

    expect(localHourMs(day, 4)).toBe(utc(2026, 3, 29, 2));       // local 04:00 = 02:00 UTC
    expect(new Date(localHourMs(day, 4)).getHours()).toBe(4);
    expect(day + 4 * H).toBe(utc(2026, 3, 29, 3));               // what it used to be
    expect(new Date(day + 4 * H).getHours()).toBe(5);            // …local 05:00

    // The band is 3 real hours on this day, and that is correct: local 02:00 to
    // 03:00 never happened, so nobody worked it.
    expect(localHourMs(day, 4) - day).toBe(3 * H);
  });

  /**
   * The fall-back assertion: `midnight + 4h` is local **03:00** on a 25-hour
   * day, so the last hour of the 00:00–04:00 band was credited as 1500 (25 %)
   * instead of 1501 (40 %) — under-paid, on a night shift, on the night the
   * driver worked an hour longer than the clock suggests.
   */
  it('does not drift on the 25-hour day, where the old arithmetic under-paid', () => {
    const day = localMidnightMs(utc(2026, 10, 24, 22));  // 24.10 22:00 UTC
    expect(day).toBe(utc(2026, 10, 24, 22));

    expect(localHourMs(day, 4)).toBe(utc(2026, 10, 25, 3));      // local 04:00 = 03:00 UTC
    expect(new Date(localHourMs(day, 4)).getHours()).toBe(4);
    expect(day + 4 * H).toBe(utc(2026, 10, 25, 2));              // what it used to be
    expect(new Date(day + 4 * H).getHours()).toBe(3);            // …local 03:00

    // 5 real hours, and both occurrences of 02:00–03:00 are inside the band, so
    // both earn the 40 % rate. The driver was there for both.
    expect(localHourMs(day, 4) - day).toBe(5 * H);
  });

  /**
   * The property the Lohnart split depends on: a set of bands built from these
   * boundaries partitions the day, so the seconds they measure add up to the
   * block's real elapsed time and no minute lands in two mutually exclusive
   * buckets.
   */
  it('is monotone and closed over the day, on every day of 2026', () => {
    const hours = [0, 4, 6, 20, 23, 24];
    for (let t = utc(2026, 1, 1, 12); t < utc(2027, 1, 1, 12); t += 24 * H) {
      const day = localMidnightMs(t);
      const end = nextLocalMidnightMs(day);
      const edges = hours.map(h => localHourMs(day, h));

      expect(edges[0]).toBe(day);
      expect(edges[edges.length - 1]).toBe(end);
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1]);
      }
      // The bands tile the day exactly.
      expect(edges[edges.length - 1] - edges[0]).toBe(end - day);
    }
  });

  it('clamps an hour outside the day rather than escaping it', () => {
    // Nothing in the product asks for these, and the clamp is what stops a
    // future band from measuring time on a neighbouring day — which would put
    // one minute in two mutually exclusive Lohnart buckets.
    const day = localMidnightMs(utc(2026, 6, 15, 12));
    expect(localHourMs(day, -1)).toBe(day);
    expect(localHourMs(day, 0)).toBe(day);
    expect(localHourMs(day, 25)).toBe(nextLocalMidnightMs(day));
  });

  /**
   * The skipped hour, asserted rather than assumed.
   *
   * `new Date(2026, 2, 29, 2)` names a local time that does not exist and JS
   * normalises it forward to 03:00. None of the product's own band hours falls
   * there, so this changes no figure today — it is recorded because a model that
   * put a boundary at 02:00 would otherwise get a band of negative width, and
   * the clamp is the only thing preventing it.
   */
  it('keeps the skipped hour from producing a negative band', () => {
    const day = localMidnightMs(utc(2026, 3, 29, 12));
    const two   = localHourMs(day, 2);
    const three = localHourMs(day, 3);
    expect(new Date(two).getHours()).toBe(3);   // normalised forward
    expect(three).toBeGreaterThanOrEqual(two);  // never negative width
    expect(three - two).toBe(0);
  });
});

describe('splitAtLocalMidnight', () => {
  /**
   * The load-bearing claim of the whole day-split fix, and the one that reads as
   * obviously true. **It is not**, and the first version of the split in
   * `FinalizePlanningModal` got it wrong: flooring each piece independently
   * loses up to one minute per extra piece, so a Stundennachweis's day rows
   * would no longer add up to its own monthly total.
   *
   * The control is written out rather than described: `naive` is the arithmetic
   * that shipped first, and the assertion is that it disagrees while the real
   * one does not.
   */
  it('apportions minutes so the pieces sum to the interval, where per-piece flooring does not', () => {
    const naive = (from: number, to: number) =>
      splitAtLocalMidnight(from, to)
        .reduce((sum, p) => sum + Math.floor((p.endMs - p.startMs) / 60000), 0);
    const whole = (from: number, to: number) => Math.floor((to - from) / 60000);
    const apportioned = (from: number, to: number) =>
      splitAtLocalMidnight(from, to).reduce((sum, p) => sum + p.minutes, 0);

    // The control is SEARCHED for, not hand-picked. A chosen example is a
    // liability here: the first one written for this test happened to have
    // fractions that summed below a minute, so per-piece flooring got the right
    // answer and the control silently proved nothing. Sweeping every
    // second-of-minute pair over a midnight-crossing shift finds the cases that
    // lose a minute and the cases that do not, and asserts both.
    let lost = 0, exact = 0;
    for (let ss = 0; ss < 60; ss++) {
      for (let es = 0; es < 60; es++) {
        const from = new Date(2026, 5, 15, 22, 0, ss).getTime();
        const to   = new Date(2026, 5, 16, 1, 30, es).getTime();
        if (naive(from, to) === whole(from, to) - 1) lost++;
        else if (naive(from, to) === whole(from, to)) exact++;
        else throw new Error(`unexpected naive deficit at ${ss}/${es}`);
        // Whatever the seconds are, the apportioned sum is the interval's own.
        expect(apportioned(from, to)).toBe(whole(from, to));
      }
    }

    // Both halves must be non-empty, or the control is vacuous in one direction:
    // "flooring is sometimes wrong" and "flooring is sometimes right" are each
    // needed for the fix to be the thing under test.
    expect(lost).toBeGreaterThan(0);
    expect(exact).toBeGreaterThan(0);
    expect(lost + exact).toBe(3600);
  });

  it('is minute-preserving over every start second and every span, single or multi-day', () => {
    for (let sec = 0; sec < 60; sec++) {
      for (const hours of [1, 3, 9, 26, 50]) {
        const from = new Date(2026, 5, 15, 21, 17, sec).getTime();
        const to = from + hours * 3_600_000 + 37_000;
        const pieces = splitAtLocalMidnight(from, to);
        expect(pieces.reduce((s2, p) => s2 + p.minutes, 0))
          .toBe(Math.floor((to - from) / 60000));
        // And the pieces tile the interval with no gap and no overlap.
        expect(pieces[0].startMs).toBe(from);
        expect(pieces[pieces.length - 1].endMs).toBe(to);
        for (let i = 1; i < pieces.length; i++) {
          expect(pieces[i].startMs).toBe(pieces[i - 1].endMs);
        }
      }
    }
  });

  it('gives each piece its own calendar day, which is the attribution being fixed', () => {
    // 23:30 Saturday to 01:15 Sunday: the defect filed all of this under
    // Saturday, so the 75 Sunday minutes earned no Sonntag premium.
    const sat = new Date(2026, 5, 13, 23, 30).getTime();   // 13.06.2026 is a Saturday
    const sun = new Date(2026, 5, 14, 1, 15).getTime();
    expect(new Date(sat).getDay()).toBe(6);

    const pieces = splitAtLocalMidnight(sat, sun);
    expect(pieces.map(p => p.dateKey)).toEqual(['2026-06-13', '2026-06-14']);
    expect(pieces.map(p => p.minutes)).toEqual([30, 75]);
    expect(new Date(pieces[1].startMs).getDay()).toBe(0);   // Sunday
  });

  it('is one piece for a block inside a day, and none for an empty or reversed one', () => {
    const from = new Date(2026, 5, 15, 9).getTime();
    expect(splitAtLocalMidnight(from, from + 3_600_000)).toHaveLength(1);
    expect(splitAtLocalMidnight(from, from)).toHaveLength(0);
    expect(splitAtLocalMidnight(from, from - 1)).toHaveLength(0);
  });

  it('splits by calendar day across both DST transitions, not by 24 hours', () => {
    // Fall back: the middle day is 25 hours, so a 48-hour block spans 3 days.
    const autumn = new Date(2026, 9, 24, 12).getTime();
    const aPieces = splitAtLocalMidnight(autumn, autumn + 48 * 3_600_000);
    expect(aPieces.map(p => p.dateKey)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(aPieces[1].endMs - aPieces[1].startMs).toBe(25 * 3_600_000);

    // Spring forward: the middle day is 23 hours.
    const spring = new Date(2026, 2, 28, 12).getTime();
    const sPieces = splitAtLocalMidnight(spring, spring + 48 * 3_600_000);
    expect(sPieces.map(p => p.dateKey)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(sPieces[1].endMs - sPieces[1].startMs).toBe(23 * 3_600_000);
  });
});

describe('localDateKey', () => {
  it('answers the local day, which is a different day from the UTC one at night', () => {
    // 15.06.2026 00:30 local is 14.06 22:30 UTC.
    expect(localDateKey(Date.UTC(2026, 5, 14, 22, 30))).toBe('2026-06-15');
  });
});
