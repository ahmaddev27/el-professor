/**
 * Wall-clock boundaries inside a local calendar day, and the calendar-day step.
 *
 * ## The defect this exists to remove
 *
 * Every premium window in this product was built as a fixed millisecond offset
 * from local midnight — `dayMs + 4 * 3600000` for local 04:00 — and every
 * day-by-day walk stepped `d += 24 * 60 * 60 * 1000`. Both are exactly one hour
 * wrong on each of the two days a year the offset changes, and in opposite
 * directions:
 *
 * - **Spring forward** (last Sunday in March, 02:00 → 03:00 local): the day is
 *   **23** hours. `midnight + 4h` lands on local **05:00**, so the 00:00–04:00
 *   band swallows the 04:00–05:00 hour that belongs to the next band. In
 *   Lohnart terms an hour moves from 1500 (25 %) up into 1501 (40 %) — paid too
 *   generously, and the two columns stop being the split CLAUDE.md states.
 * - **Fall back** (last Sunday in October, 03:00 → 02:00 local): the day is
 *   **25** hours. `midnight + 4h` lands on local **03:00**, so the last hour of
 *   the 00:00–04:00 band is credited as 1500 instead of 1501 — paid too little,
 *   on a night shift, on the night the driver worked an hour longer than the
 *   clock suggests.
 *
 * A fixed-offset *day step* is worse than the boundaries, because it does not
 * recover: once the walk is an hour off local midnight it stays off for every
 * later day of the same shift, so the bands of an ordinary Monday are shifted
 * too.
 *
 * **26 production trips already sit on 29.03.2026, and the next transition is
 * 25.10.2026.**
 *
 * ## What this module is, and deliberately is not
 *
 * Three primitives with no policy in them: which instant is local hour *N* on a
 * given calendar day, and which instant begins the next calendar day. It holds
 * **no** premium hours, no rates and no bucket names, because this product
 * carries four competing premium models and picking between them is the owner's
 * decision, not a side effect of a timezone fix. Each caller keeps its own hours
 * — the clean engine's night band opens at 20:00 and the Stundennachweis
 * preview's at 23:00, and they still disagree after this change exactly as they
 * did before it.
 *
 * It is a module rather than a helper copied into both callers because the two
 * copies would be byte-identical and this repository already pays for that
 * pattern twice over: two holiday tables that disagree about Ostersonntag, and
 * two block builders that split on 60 and 90 minutes.
 */

/**
 * Local midnight of the calendar day containing `ms`.
 *
 * `new Date(y, m, d)` is the only construction that means "local midnight" on
 * every day of the year; `Date.UTC` and `toISOString()` both answer for a
 * different day for anyone east or west of UTC, which is the defect
 * `parseLocalIsoMs` carried until 28.09.2026.
 */
export function localMidnightMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The instant local midnight of the **next** calendar day begins.
 *
 * `getDate() + 1` overflows into the next month and year on its own, so no
 * month-length or leap-year arithmetic is needed — and unlike `+ 86400000` it is
 * right on a 23- and a 25-hour day.
 */
export function nextLocalMidnightMs(dayMs: number): number {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * The instant local hour `hour` begins on the calendar day that starts at
 * `dayMs`, clamped into that day.
 *
 * `hour` is a wall-clock hour, 0–24, where 24 means the day's end. The result is
 * clamped into `[dayMs, nextLocalMidnightMs(dayMs)]` for two reasons, and both
 * are about keeping a sum honest rather than about defending against a bad
 * argument:
 *
 * - **The bands must stay monotone**, so that a set of them partitions the day
 *   and the seconds they measure add up to the block's real elapsed time. On a
 *   spring-forward day local 02:00 does not exist and `new Date(y, m, d, 2)`
 *   normalises *forward* to 03:00, so a model whose bands met at 02:00 and 03:00
 *   would get a band of negative width without the clamp. None of the hours this
 *   product uses today (0, 4, 6, 20, 23, 24) falls in the skipped hour, so the
 *   clamp changes nothing now — it is what keeps a future band from silently
 *   subtracting time.
 * - **Nothing may escape the day**, or an hour would be counted on two days and
 *   the mutually exclusive Lohnart split would double-count it.
 *
 * On a fall-back day 02:00 happens twice and `new Date` answers the **first**
 * occurrence. That is the right one for a band boundary: a band opening at
 * 02:00 should contain both occurrences, which it does, because the band runs to
 * its own upper boundary.
 */
export function localHourMs(dayMs: number, hour: number): number {
  const dayEnd = nextLocalMidnightMs(dayMs);
  if (hour <= 0) return dayMs;
  if (hour >= 24) return dayEnd;
  const d = new Date(dayMs);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour).getTime();
  return Math.min(Math.max(at, dayMs), dayEnd);
}

/** `YYYY-MM-DD` for the local calendar day containing `ms`. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One calendar day's share of an interval. */
export interface LocalDayPiece {
  startMs: number;
  endMs: number;
  /** The piece's own local calendar day. */
  dateKey: string;
  /**
   * Whole minutes of this piece, apportioned so the pieces **sum to exactly**
   * `Math.floor((endMs - startMs) / 60000)` of the interval they came from. See
   * `splitAtLocalMidnight` for why that is not `Math.floor` per piece.
   */
  minutes: number;
}

/**
 * Cut `[startMs, endMs)` at every local midnight it crosses.
 *
 * ## Why the minutes are apportioned rather than floored per piece
 *
 * Rides carry seconds, so a block's length is rarely a whole number of minutes.
 * Flooring each piece independently loses up to one minute **per extra piece**:
 * a 90.5-minute block cut into 30.7 + 59.8 floors to 30 + 59 = 89, where the
 * whole block floors to 90. A Stundennachweis whose day rows no longer add up to
 * its own monthly total is worse than the attribution defect the split exists to
 * fix, and the first version of that split had exactly this bug — it is recorded
 * here because the property reads as obviously true and is not.
 *
 * So each piece takes the difference of the **cumulative** floor from the
 * interval's start, which makes the pieces sum to the interval's own floored
 * minutes by construction, whatever the seconds are and however many days it
 * spans.
 *
 * An empty or reversed interval yields no pieces.
 */
export function splitAtLocalMidnight(startMs: number, endMs: number): LocalDayPiece[] {
  const pieces: LocalDayPiece[] = [];
  if (!(endMs > startMs)) return pieces;

  let elapsedBefore = 0;
  for (let from = startMs; from < endMs; ) {
    const to = Math.min(endMs, nextLocalMidnightMs(localMidnightMs(from)));
    const elapsedAfter = to - startMs;
    pieces.push({
      startMs: from,
      endMs: to,
      dateKey: localDateKey(from),
      minutes: Math.floor(elapsedAfter / 60000) - Math.floor(elapsedBefore / 60000),
    });
    elapsedBefore = elapsedAfter;
    from = to;
  }
  return pieces;
}
