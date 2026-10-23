/**
 * The Inhaber shift's **same-day window** across the two DST transitions.
 *
 * ## What this covers, and what already covered the rest
 *
 * `lohnartDst.test.ts` pins `computeLohnartSeconds` on both transition days —
 * the premium *bands*, fixed in #170 when `localDayWindow.ts` was introduced.
 * This file is the other half of that defect class, and the half #170 did not
 * reach: the **slot search** that decides where an overlapping Inhaber block is
 * moved to. It built its day window as `localMidnight + 24 h`, which names the
 * wrong instant on both transition days, and the window decides which
 * candidates are offered as "same day".
 *
 * That matters because selection treats `sameDay` as **strictly dominant**:
 *
 *     if (cand.sameDay && !best.sameDay) { best = cand; continue; }
 *     if (!cand.sameDay && best.sameDay) continue;
 *     // only now is the offset compared
 *
 * So a slot mislabelled by the window does not merely sort differently — it
 * wins or loses outright against slots many hours away, and the block's final
 * time is what the Stundennachweis and the Lohnart actuals are computed from.
 * Both scenarios below therefore end by computing the premium seconds of the
 * slot that is chosen and of the slot the old arithmetic chose, so the payroll
 * consequence is **measured here** rather than asserted in a commit message.
 *
 * ## Why the inputs are fixed UTC instants
 *
 * Every instant below is written as `Date.UTC(...)` and every expectation is a
 * fixed instant too. `new Date(y, m, d, hh, mm)` would be read in whatever zone
 * the runner is in, and because the engine reads local time the same way, the
 * two cancel: an assessment run put the whole golden suite through four foreign
 * zones and all four stayed green for exactly that reason. These cases do not —
 * they fail under any zone but Europe/Berlin, which `vitest.config.ts` pins
 * (there, not in the npm script, because **node on Windows ignores the `TZ`
 * environment variable** — measured on this machine, which resolves
 * `Asia/Riyadh` whatever `TZ` says).
 *
 * The local↔UTC pairs below were read from the zone itself with
 * `toLocaleString(..., { timeZone: 'Europe/Berlin' })`, not derived by hand:
 *
 *   25.10.2026 — 25 hours.  local 00:00 = 24T22:00Z · 10:00 = 25T09:00Z
 *                           local 22:00 = 25T21:00Z · 23:00 = 25T22:00Z
 *                           local 24:00 = 25T23:00Z   (= 26.10 00:00)
 *   29.03.2026 — 23 hours.  local 00:00 = 28T23:00Z · 04:00 = 29T02:00Z
 *                           local 20:00 = 29T18:00Z
 *                           local 24:00 = 29T22:00Z   (= 30.03 00:00)
 *
 * Both dates are **Sundays**, which is why the spring case costs a premium and
 * not merely an hour.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  shiftOverlappingInhaberBlocks,
  computeLohnartSeconds,
  type BuildVehicleBlocksResult,
  type RegularDriverAssignmentResult,
  type InhaberAssignmentResult,
  type InhaberBlockAssignment,
} from './historicalWorkingHoursCleanEngine';
import { nextLocalMidnightMs } from './localDayWindow';

const UTC = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const MS_PER_FIXED_DAY = 86_400_000;
const VEHICLE = 'SG-TEST1';

/** A minimal owner assignment. The engine reads only these fields. */
function ownerBlock(blockId: string, startMs: number, endMs: number): InhaberBlockAssignment {
  return {
    blockId,
    driverId: 'owner-1',
    driverName: 'Inhaber',
    vehicle: VEHICLE,
    startMs,
    endMs,
    durationSec: (endMs - startMs) / 1000,
    sourceRowIndices: [null],
    originalStatus: 'valid',
    needsTimeShift: true,
    assignmentType: 'owner_surplus_needs_shift_preview',
  };
}

/**
 * Run the real engine on one block that must move, against a set of occupied
 * envelopes. `phase1Result.blocks` is deliberately empty: with no rides
 * registered the engine falls back to each assignment's envelope, which is what
 * a single-ride block amounts to and keeps the fixture to the fields under test.
 */
function shiftOne(opts: {
  block: InhaberBlockAssignment;
  occupied: InhaberBlockAssignment[];
  month: number;
  year: number;
}) {
  const phase1 = { blocks: [] } as unknown as BuildVehicleBlocksResult;
  const regular = { assignments: [] } as unknown as RegularDriverAssignmentResult;
  const inhaber = {
    ownerNeedsShiftAssignments: [opts.block],
    ownerOriginalTimeAssignments: opts.occupied,
    ownerInvalidOriginalDataBlocks: [],
  } as unknown as InhaberAssignmentResult;

  const result = shiftOverlappingInhaberBlocks(phase1, regular, inhaber, {
    month: opts.month,
    year: opts.year,
    slotIncrementMinutes: 15,
  });
  return result;
}

const lohnart = (startMs: number, endMs: number) =>
  computeLohnartSeconds(startMs, endMs, new Set<string>());

describe('the premise: these two days are not 24 hours long', () => {
  // If this block fails, the runner is not in Europe/Berlin and nothing below
  // means anything. It is the positive control the four foreign-zone runs
  // lacked.
  it('25.10.2026 is 25 hours and 29.03.2026 is 23', () => {
    const autumn = UTC(2026, 10, 24, 22);   // local midnight 25.10
    const spring = UTC(2026, 3, 28, 23);    // local midnight 29.03
    expect(nextLocalMidnightMs(autumn) - autumn).toBe(25 * 3_600_000);
    expect(nextLocalMidnightMs(spring) - spring).toBe(23 * 3_600_000);
  });

  it('a fixed day length names the wrong instant on both, in opposite directions', () => {
    const autumn = UTC(2026, 10, 24, 22);
    const spring = UTC(2026, 3, 28, 23);
    // Autumn: an hour SHORT of the day's end — local 23:00 instead of 24:00.
    expect(autumn + MS_PER_FIXED_DAY).toBe(UTC(2026, 10, 25, 22));
    expect(nextLocalMidnightMs(autumn) - (autumn + MS_PER_FIXED_DAY)).toBe(3_600_000);
    // Spring: an hour PAST it — local 01:00 on the 30th.
    expect(spring + MS_PER_FIXED_DAY).toBe(UTC(2026, 3, 29, 23));
    expect(nextLocalMidnightMs(spring) - (spring + MS_PER_FIXED_DAY)).toBe(-3_600_000);
  });

  it('both transition days are Sundays', () => {
    expect(new Date(UTC(2026, 10, 24, 22)).getDay()).toBe(0);
    expect(new Date(UTC(2026, 3, 28, 23)).getDay()).toBe(0);
  });
});

describe('autumn — 25.10.2026, the 25th hour is part of the same day', () => {
  /**
   * The block sits at local 22:00–23:00 and must move. Exactly two windows are
   * free on its own day: local 10:00–11:00 and local 23:00–24:00 — the hour the
   * old window could not see.
   *
   *   old: 23:00 is outside `midnight + 24 h`, so it is offered only by the
   *        rest-of-month pass, as `sameDay: false`, and loses outright to the
   *        10:00 slot twelve hours away.
   *   new: 23:00 is inside the day, so the offset decides and the one-hour move
   *        wins over the twelve-hour one.
   */
  const dayStart = UTC(2026, 10, 24, 22);     // local 00:00 25.10
  const blockStart = UTC(2026, 10, 25, 21);   // local 22:00
  const blockEnd = UTC(2026, 10, 25, 22);     // local 23:00
  const freeAt2300 = UTC(2026, 10, 25, 22);   // local 23:00 → 24:00
  const freeAt1000 = UTC(2026, 10, 25, 9);    // local 10:00 → 11:00

  const run = () =>
    shiftOne({
      block: ownerBlock('B-autumn', blockStart, blockEnd),
      occupied: [
        // local 00:00 → 10:00
        ownerBlock('fill-a', dayStart, UTC(2026, 10, 25, 9)),
        // local 11:00 → 23:00  (also covers the block's own position)
        ownerBlock('fill-b', UTC(2026, 10, 25, 10), UTC(2026, 10, 25, 22)),
      ],
      month: 10,
      year: 2026,
    });

  it('places the block in the 25th hour, not twelve hours earlier', () => {
    const r = run();
    expect(r.shiftedAssignments).toHaveLength(1);
    expect(r.noSlotBlocks).toHaveLength(0);
    const got = r.shiftedAssignments[0];
    expect(got.finalStartMs).toBe(freeAt2300);
    expect(got.finalEndMs).toBe(UTC(2026, 10, 25, 23));   // local 26.10 00:00
    // The slot the old window forced instead.
    expect(got.finalStartMs).not.toBe(freeAt1000);
    // One hour, not twelve.
    expect(got.offsetSec).toBe(3600);
  });

  it('keeps the block on its own local calendar day', () => {
    const got = run().shiftedAssignments[0];
    expect(new Date(got.finalStartMs).getDate()).toBe(25);
    expect(got.finalStartMs).toBeGreaterThanOrEqual(dayStart);
    expect(got.finalEndMs).toBeLessThanOrEqual(nextLocalMidnightMs(dayStart));
  });

  it('the payroll figures differ: a night hour instead of a base hour', () => {
    const got = run().shiftedAssignments[0];
    const now = lohnart(got.finalStartMs, got.finalEndMs);
    const old = lohnart(freeAt1000, freeAt1000 + 3_600_000);

    // local 23:00-24:00 is inside this engine's 20:00 night band.
    expect(now.night25Sec).toBe(3600);
    expect(now.baseSec).toBe(0);
    // local 10:00-11:00 is Grundlohn.
    expect(old.baseSec).toBe(3600);
    expect(old.night25Sec).toBe(0);
    // Same hour of work, same Sunday, a different premium column.
    expect(now.totalSec).toBe(old.totalSec);
    expect(now.sundaySec).toBe(old.sundaySec);
    expect(now.night25Sec - old.night25Sec).toBe(3600);
  });
});

describe('spring — 29.03.2026, the same-day window must not reach into Monday', () => {
  /**
   * The block sits at local 20:00–20:30 on Sunday 29.03 and must move. The only
   * free window on its own day is local 04:00–04:30; 30.03 is wide open.
   *
   *   old: `midnight + 24 h` was local 01:00 on the **30th**, so the four slots
   *        at 30.03 00:00–00:45 were offered as `sameDay: true`. 30.03 00:00 is
   *        four hours away and 04:00 is sixteen, so the block was moved onto
   *        **Monday** — and the Sonntagszuschlag follows the day it lands on.
   *   new: the window ends at the real end of Sunday, so only 04:00 is same-day
   *        and the block stays on Sunday.
   */
  const dayStart = UTC(2026, 3, 28, 23);      // local 00:00 29.03
  const nextDay00 = UTC(2026, 3, 29, 22);     // local 00:00 30.03
  const blockStart = UTC(2026, 3, 29, 18);    // local 20:00
  const blockEnd = UTC(2026, 3, 29, 18, 30);  // local 20:30
  const freeAt0400 = UTC(2026, 3, 29, 2);     // local 04:00 → 04:30

  const run = () =>
    shiftOne({
      block: ownerBlock('B-spring', blockStart, blockEnd),
      occupied: [
        // local 00:00 → 04:00
        ownerBlock('fill-a', dayStart, UTC(2026, 3, 29, 2)),
        // local 04:30 → 24:00  (also covers the block's own position)
        ownerBlock('fill-b', UTC(2026, 3, 29, 2, 30), nextDay00),
      ],
      month: 3,
      year: 2026,
    });

  it('keeps the block on Sunday instead of moving it onto Monday', () => {
    const r = run();
    expect(r.shiftedAssignments).toHaveLength(1);
    const got = r.shiftedAssignments[0];
    expect(got.finalStartMs).toBe(freeAt0400);
    expect(got.finalEndMs).toBe(UTC(2026, 3, 29, 2, 30));
    // The slot the old window reached and called same-day.
    expect(got.finalStartMs).not.toBe(nextDay00);
    expect(new Date(got.finalStartMs).getDate()).toBe(29);
    expect(new Date(got.finalStartMs).getDay()).toBe(0);     // still Sunday
  });

  it('the payroll figures differ: the Sonntagszuschlag is kept, not lost', () => {
    const got = run().shiftedAssignments[0];
    const now = lohnart(got.finalStartMs, got.finalEndMs);
    const old = lohnart(nextDay00, nextDay00 + 30 * 60_000);

    expect(now.totalSec).toBe(1800);
    expect(old.totalSec).toBe(1800);

    // Sunday 04:00-04:30 → the 25 % band, and a Sunday half-hour.
    expect(now.night25Sec).toBe(1800);
    expect(now.night40Sec).toBe(0);
    expect(now.sundaySec).toBe(1800);

    // Monday 00:00-00:30 → the 40 % band, and NO Sunday second at all.
    expect(old.night40Sec).toBe(1800);
    expect(old.night25Sec).toBe(0);
    expect(old.sundaySec).toBe(0);

    // The half hour of Sunday premium the old window gave away.
    expect(now.sundaySec - old.sundaySec).toBe(1800);
  });
});

describe('both shift searches ask for the calendar day, and neither steps a fixed one', () => {
  /**
   * `shiftInhaberBlocks` in `historicalRowLevelEngine.ts` is module-local, so it
   * cannot be called from a test, and its public entry point
   * (`runHistoricalArbeitsstundenRowLevelEngine`) needs a whole month of trips
   * to reach it. It carries the identical window slot for slot, so it is held to
   * the rule as text instead — the shape `noteWindowSingleSource.test.ts` uses
   * for the note window, for the same reason: a type cannot say "do not write
   * this again".
   *
   * The scan is scoped to the slot-search function, not the whole module, so it
   * fails on a new copy of this defect rather than on every piece of date
   * arithmetic in a 1200-line engine.
   */
  const ROOT = join(__dirname, '..');
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

  const SEARCHES = [
    ['utils/historicalWorkingHoursCleanEngine.ts', 'export function shiftOverlappingInhaberBlocks'],
    ['utils/historicalRowLevelEngine.ts', 'function shiftInhaberBlocks'],
  ] as const;

  /**
   * The slice must reach the window declaration, which in the clean engine sits
   * some ninety lines into the function behind its occupancy set-up. 9000 is
   * past that and still short of either function's end — the `origDayStart`
   * anchor in both assertions is what keeps the scan pointed at the window
   * rather than at anything else in range.
   */
  const BODY_CHARS = 9000;

  it.each(SEARCHES)('%s derives its day end from the calendar', (rel, fn) => {
    const src = read(rel);
    const at = src.indexOf(fn);
    expect(at, `${fn} not found in ${rel}`).toBeGreaterThan(-1);
    const body = src.slice(at, at + BODY_CHARS);
    expect(body).toContain('nextLocalMidnightMs(origDayStart)');
  });

  it.each(SEARCHES)('%s does not add a fixed day length to a day start', (rel, fn) => {
    const src = read(rel);
    const at = src.indexOf(fn);
    const body = src.slice(at, at + BODY_CHARS);
    // Both spellings the two engines used: `86_400_000` and `24 * 60 * 60 * 1000`.
    // Comments are stripped first — the fix documents the old shape by name, and
    // the rule is about what executes.
    const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code, `${rel} / ${fn}`).not.toMatch(/origDayStart\s*\+\s*(86[_]?400[_]?000|24\s*\*)/);
  });
});
