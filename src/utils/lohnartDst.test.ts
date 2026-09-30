/**
 * `computeLohnartSeconds` across the two DST transitions — the defect, measured.
 *
 * `lohnart.golden.test.ts` pins 26 snapshots and **none of them covers a
 * transition day**, which is exactly why this defect survived: the suite that
 * exists to make premium changes visible could not see it. Those 26 must stay
 * byte-identical after this fix, and this file is the other half — the days they
 * do not reach.
 *
 * ## The negative control, and why it is in the file
 *
 * Each case below states what the **old** arithmetic produced as well as what
 * the new code produces, and computes the old figure here rather than quoting it
 * from a report. A test that only asserts today's numbers cannot tell a fixed
 * defect from a defect that was never there: `oldLohnart` reproduces the exact
 * shape the engine shipped — `dayMs + N * 3600000` bands over a `getDate() + 1`
 * walk — so every `expect(old).not.toEqual(new)` below is a live demonstration
 * that the fix changes precisely the days it claims to and nothing else.
 *
 * `vitest.config.ts` pins `TZ=Europe/Berlin`; the transitions in 2026 are
 * **29.03** (02:00 → 03:00, 23 hours) and **25.10** (03:00 → 02:00, 25 hours).
 */

import { describe, it, expect } from 'vitest';
import { computeLohnartSeconds } from './historicalWorkingHoursCleanEngine';

const H = 3_600_000;
const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
  Date.UTC(y, m - 1, d, h, min);

/**
 * The engine's band arithmetic **as it shipped before this fix**: local-midnight
 * day walk (which was already right) plus fixed millisecond band offsets (which
 * were not). Holidays are left out — no transition day is one, and the Sunday
 * and holiday buckets read the whole day-overlap either way, so they cannot
 * move.
 */
function oldLohnart(startMs: number, endMs: number) {
  const overlap = (aS: number, aE: number, bS: number, bE: number) =>
    Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));

  let baseSec = 0, night25Sec = 0, night40Sec = 0, sundaySec = 0;
  const first = new Date(startMs);
  let d = new Date(first.getFullYear(), first.getMonth(), first.getDate());

  while (d.getTime() < endMs) {
    const dMs = d.getTime();
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const nextMs = next.getTime();

    night40Sec += overlap(startMs, endMs, dMs, dMs + 4 * H) / 1000;
    night25Sec += (overlap(startMs, endMs, dMs + 4 * H, dMs + 6 * H)
                 + overlap(startMs, endMs, dMs + 20 * H, nextMs)) / 1000;
    baseSec    += overlap(startMs, endMs, dMs + 6 * H, dMs + 20 * H) / 1000;
    if (d.getDay() === 0) sundaySec += overlap(startMs, endMs, dMs, nextMs) / 1000;

    d = next;
  }
  return { baseSec, night25Sec, night40Sec, sundaySec };
}

const fresh = (startMs: number, endMs: number) =>
  computeLohnartSeconds(startMs, endMs, new Set<string>());

describe('the spring-forward night — 28./29.03.2026, a 23-hour day', () => {
  // 22:00 local on the 28th to 06:00 local on the 29th. Real elapsed time is
  // **7** hours, because 02:00–03:00 never happened.
  const startMs = utc(2026, 3, 28, 21);   // local 22:00 (+01:00)
  const endMs   = utc(2026, 3, 29, 4);    // local 06:00 (+02:00)

  it('is 7 real hours, and the buckets add up to exactly that', () => {
    expect(endMs - startMs).toBe(7 * H);
    const r = fresh(startMs, endMs);
    expect(r.totalSec).toBe(7 * 3600);
    expect(r.baseSec + r.night25Sec + r.night40Sec).toBe(r.totalSec);
  });

  it('credits the 40 % band the 3 hours that exist between 00:00 and 04:00', () => {
    // Local 00:00 → 04:00 on a 23-hour day is 3 real hours. The 40 % band gets
    // those; the 25 % band gets 22:00–24:00 on the 28th plus 04:00–06:00 on the
    // 29th, i.e. 2 + 2 = 4 hours.
    const r = fresh(startMs, endMs);
    expect(r.night40Sec).toBe(3 * 3600);
    expect(r.night25Sec).toBe(4 * 3600);
    expect(r.baseSec).toBe(0);
  });

  it('OLD CODE over-paid: an hour sat in the 40 % band that belongs in the 25 %', () => {
    const old = oldLohnart(startMs, endMs);
    const now = fresh(startMs, endMs);

    // `midnight + 4h` was local 05:00, so the 40 % band ran an hour long and
    // took it from the 25 % band. One hour moved from 25 % to 40 %.
    expect(old.night40Sec).toBe(4 * 3600);
    expect(old.night25Sec).toBe(3 * 3600);
    expect(now.night40Sec).toBe(old.night40Sec - 3600);
    expect(now.night25Sec).toBe(old.night25Sec + 3600);

    // The total was right before and after — which is why nothing caught it.
    expect(old.baseSec + old.night25Sec + old.night40Sec)
      .toBe(now.baseSec + now.night25Sec + now.night40Sec);
  });
});

describe('the fall-back night — 24./25.10.2026, a 25-hour day', () => {
  // 22:00 local on the 24th to 06:00 local on the 25th. Real elapsed time is
  // **9** hours, because 02:00–03:00 happened twice.
  const startMs = utc(2026, 10, 24, 20);  // local 22:00 (+02:00)
  const endMs   = utc(2026, 10, 25, 5);   // local 06:00 (+01:00)

  it('is 9 real hours, and the buckets add up to exactly that', () => {
    expect(endMs - startMs).toBe(9 * H);
    const r = fresh(startMs, endMs);
    expect(r.totalSec).toBe(9 * 3600);
    expect(r.baseSec + r.night25Sec + r.night40Sec).toBe(r.totalSec);
  });

  it('credits the 40 % band both occurrences of 02:00–03:00', () => {
    // Local 00:00 → 04:00 on a 25-hour day is 5 real hours, and the driver was
    // present for all five. 25 % gets 22:00–24:00 plus 04:00–06:00 = 4 hours.
    const r = fresh(startMs, endMs);
    expect(r.night40Sec).toBe(5 * 3600);
    expect(r.night25Sec).toBe(4 * 3600);
    expect(r.baseSec).toBe(0);
  });

  /**
   * The hour moves from **Grundlohn to the 40 % band**, not from 25 % to 40 %,
   * and the difference matters: the driver was paid a base hour for night work
   * inside 00:00-04:00. Worked out by hand against the shipped arithmetic after
   * the first version of this test asserted the 25 % band and was wrong — the
   * old bands did not merely shrink, they all slid an hour earlier, so the 25 %
   * band kept its **size** while changing its **position** and the hour fell out
   * of the bottom of the day's night work into the base band.
   */
  it('OLD CODE under-paid: an hour of 00:00-04:00 night work was paid as Grundlohn', () => {
    const old = oldLohnart(startMs, endMs);
    const now = fresh(startMs, endMs);

    // `midnight + 4h` was local 03:00, so the 40 % band stopped an hour early;
    // `midnight + 6h` was local 05:00, so the base band opened an hour early and
    // took it. **This is the transition of 25.10.2026.**
    expect(old.night40Sec).toBe(4 * 3600);
    expect(old.baseSec).toBe(1 * 3600);
    expect(old.night25Sec).toBe(4 * 3600);

    expect(now.night40Sec).toBe(old.night40Sec + 3600);
    expect(now.baseSec).toBe(old.baseSec - 3600);
    expect(now.night25Sec).toBe(old.night25Sec);   // same size, right position

    expect(old.baseSec + old.night25Sec + old.night40Sec)
      .toBe(now.baseSec + now.night25Sec + now.night40Sec);
  });
});

describe('the boundary of the fix: ordinary days do not move', () => {
  /**
   * The negative control's other direction, and the assertion that matters most
   * for trusting the 26 golden snapshots: over **every** shift of every day in
   * 2026 that does not touch a transition, the old and new arithmetic agree
   * exactly. If this failed, the fix would have broken an ordinary day and the
   * golden suite — which covers none of these days either — would have been the
   * wrong place to find out.
   */
  it('old and new agree on every day of 2026 outside the two transitions', () => {
    const TRANSITIONS = new Set(['2026-03-29', '2026-10-25']);
    const key = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    let compared = 0;
    for (let day = 1; day <= 365; day++) {
      // A shift per day, deliberately spanning midnight so both calendar days
      // and all four bands are exercised.
      const start = new Date(2026, 0, day, 21, 30).getTime();
      const end   = new Date(2026, 0, day + 1, 7, 15).getTime();
      if (TRANSITIONS.has(key(start)) || TRANSITIONS.has(key(end))) continue;

      const old = oldLohnart(start, end);
      const now = fresh(start, end);
      expect({ d: key(start), ...old }).toEqual({
        d: key(start),
        baseSec: now.baseSec,
        night25Sec: now.night25Sec,
        night40Sec: now.night40Sec,
        sundaySec: now.sundaySec,
      });
      compared++;
    }
    // The loop must actually have run; a filter that excluded everything would
    // make this test pass vacuously.
    expect(compared).toBeGreaterThan(355);
  });

  it('and disagree on exactly the two transition days, in opposite directions', () => {
    const spring = {
      start: new Date(2026, 2, 28, 21, 30).getTime(),
      end:   new Date(2026, 2, 29, 7, 15).getTime(),
    };
    const autumn = {
      start: new Date(2026, 9, 24, 21, 30).getTime(),
      end:   new Date(2026, 9, 25, 7, 15).getTime(),
    };

    // Spring: 40 % loses an hour. Autumn: 40 % gains one.
    expect(fresh(spring.start, spring.end).night40Sec
         - oldLohnart(spring.start, spring.end).night40Sec).toBe(-3600);
    expect(fresh(autumn.start, autumn.end).night40Sec
         - oldLohnart(autumn.start, autumn.end).night40Sec).toBe(+3600);
  });
});

describe('the mutually exclusive split survives a transition', () => {
  /**
   * CLAUDE.md's rule, on the days it was never tested: `1500 = nightSec −
   * night0to4Sec` and `1501 = night0to4Sec`, and never a minute in both. The
   * bands are built from `localHourMs`, whose edges are monotone and closed over
   * the day, so this holds by construction — asserted because "by construction"
   * is what the old code's author believed too.
   */
  it('never double-counts a minute on either transition day', () => {
    for (const [y, m, d] of [[2026, 3, 29], [2026, 10, 25]] as const) {
      for (let hour = 0; hour < 24; hour++) {
        const start = new Date(y, m - 1, d - 1, hour).getTime();
        const end   = new Date(y, m - 1, d + 1, hour).getTime();
        const r = fresh(start, end);
        expect(r.baseSec + r.night25Sec + r.night40Sec).toBe(r.totalSec);
        expect(r.totalSec).toBe((end - start) / 1000);
      }
    }
  });
});
