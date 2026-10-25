/**
 * A note's window must survive the two days the clocks move.
 *
 * `noteExclusionIntervals` builds every boundary from its own day's calendar
 * parts, and its docblock says why. Three other copies of that arithmetic have
 * existed in this codebase; two were corrected after a measured incident (11
 * real rides on staging given to drivers marked sick, because the window was
 * built at `Date.UTC` and ran one to two hours late), and the fourth — the
 * transfer check in `MonatsplanungStundennachweisPreview` — started at local
 * midnight but then advanced a fixed 86_400_000 ms per day.
 *
 * Measured in Europe/Berlin, which `vitest.config.ts` pins:
 *
 *   25.10.2026 is a 25-hour day. start + 86_400_000 lands on 25.10 at 23:00,
 *   so the last hour of that Sunday fell outside the day's window.
 *   29.03.2026 is a 23-hour day. The same step lands on 30.03 at 01:00, so the
 *   first hour of that day fell outside it.
 *
 * The drift was cumulative: every later day of a note's range was an hour off.
 * 25.10.2026 is a Sunday, which is also when the Sunday premium applies, so a
 * transfer wrongly validated there reaches the Stundennachweis.
 *
 * These cases are written against the helper rather than the screen, because
 * the helper is what every caller must now use. The screen is held to it by
 * `noteWindowSingleSource.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { noteExclusionIntervals, type NoteWindowFields } from './driverNoteValidation';

const MS_PER_DAY = 86_400_000;

const fullDay = (from: string, to = from): NoteWindowFields => ({
  is_full_day: true,
  start_date: from,
  end_date: to,
  note_date: null,
  start_time: null,
  end_time: null,
});

const timed = (from: string, to: string, start: string, end: string): NoteWindowFields => ({
  is_full_day: false,
  start_date: from,
  end_date: to,
  note_date: null,
  start_time: start,
  end_time: end,
});

/** Local midnight of a `YYYY-MM-DD`, built the way the engine builds it. */
const midnight = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

describe('the clocks move and the window does not drift', () => {
  it('confirms the premise: Berlin, and two days that are not 24 hours long', () => {
    // If this fails, the rest of the file is measuring a different timezone.
    expect(new Date(2026, 0, 15).toLocaleString('de-DE', { timeZoneName: 'short' })).toContain('MEZ');
    expect(midnight('2026-10-26') - midnight('2026-10-25')).toBe(25 * 3_600_000);
    expect(midnight('2026-03-30') - midnight('2026-03-29')).toBe(23 * 3_600_000);
  });

  it('covers all 25 hours of 25.10.2026, including the last one', () => {
    const [iv] = noteExclusionIntervals(fullDay('2026-10-25'));
    expect(iv.start).toBe(midnight('2026-10-25'));
    expect(iv.end).toBe(midnight('2026-10-26'));
    // The hour the fixed step dropped: 23:00–24:00 local on the Sunday.
    const lastHour = midnight('2026-10-26') - 3_600_000;
    expect(lastHour).toBeGreaterThanOrEqual(iv.start);
    expect(lastHour).toBeLessThan(iv.end);
    // And it is not the naive 24-hour end.
    expect(iv.end).not.toBe(iv.start + MS_PER_DAY);
  });

  it('covers all 23 hours of 29.03.2026 and stops before the next day', () => {
    const [iv] = noteExclusionIntervals(fullDay('2026-03-29'));
    expect(iv.start).toBe(midnight('2026-03-29'));
    expect(iv.end).toBe(midnight('2026-03-30'));
    // The fixed step reached 30.03 01:00 and so claimed an hour it should not,
    // which left the real first hour of the 30th uncovered by its own day.
    expect(iv.end).toBeLessThan(iv.start + MS_PER_DAY);
  });

  it('does not drift across a range that spans the October transition', () => {
    const ivs = noteExclusionIntervals(fullDay('2026-10-23', '2026-10-27'));
    expect(ivs).toHaveLength(5);
    for (const [i, day] of ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'].entries()) {
      expect(ivs[i].start, day).toBe(midnight(day));
    }
    // Contiguous: each day ends exactly where the next begins, 25-hour day included.
    for (let i = 1; i < ivs.length; i++) expect(ivs[i].start).toBe(ivs[i - 1].end);
  });

  it('keeps a timed note at the same wall clock on both sides of the transition', () => {
    const ivs = noteExclusionIntervals(timed('2026-10-24', '2026-10-26', '08:00', '12:00'));
    expect(ivs).toHaveLength(3);
    for (const [i, day] of ['2026-10-24', '2026-10-25', '2026-10-26'].entries()) {
      expect(new Date(ivs[i].start).getHours(), day).toBe(8);
      expect(new Date(ivs[i].end).getHours(), day).toBe(12);
    }
  });
});
