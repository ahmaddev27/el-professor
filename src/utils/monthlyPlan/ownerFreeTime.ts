/**
 * When the owner is free, across the whole month, as blocks.
 *
 * The owner's question of 03.10.2026: *"why could not we pass the not assigned
 * blocks to the owner? if the reason is that he does not have free blocks in the
 * same day, we could move them to another day. do this small task which is to
 * show the owner free time in the whole month as blocks."*
 *
 * This is the **view**, and it is deliberately only a view. It reports the gaps
 * in the owner's own assigned work so a person can see what room there is; it
 * assigns nothing and it moves nothing. Moving a block into one of these windows
 * would make the Fahrtenbuch state that a journey happened at a time it did not,
 * which is this module's recorded boundary (`assign.ts`, *No repair pass,
 * deliberately*, set 22.09.2026).
 *
 * ## What counts as free
 *
 * A window between two of the owner's own blocks, or before the first and after
 * the last of a day, bounded by the day in **local** time — the same local-day
 * reckoning the rest of the pipeline uses, so a night shift that crosses midnight
 * does not silently create a window that is not there.
 *
 * A window shorter than the switch duration is **not free**: the owner cannot
 * take anything in it, because parting two blocks takes that long (§3). Reporting
 * it as free would overstate the room by exactly the amount nobody can use.
 */

import type { PlanBlock } from './blocks';

const MS_PER_MINUTE = 60_000;

/** One stretch in which the owner has nothing assigned. */
export interface FreeWindow {
  /** `YYYY-MM-DD`, the local day the window starts in. */
  day: string;
  startMs: number;
  endMs: number;
  minutes: number;
}

export interface OwnerFreeTime {
  windows: FreeWindow[];
  /** Total free minutes, which is **not** what the owner could actually work. */
  totalMinutes: number;
  /** The owner's assigned minutes, for the contrast the screen needs. */
  assignedMinutes: number;
  /**
   * Windows long enough to hold the longest unassigned block, with that block's
   * length — the figure that answers "could the leftovers fit at all?".
   */
  longestWindowMinutes: number;
  /**
   * How many days were walked at all: the days the fleet drove, not the days in
   * the calendar month.
   *
   * The screen said "free this month" over a figure that covered 21 days of a
   * 30-day November — true of what was counted, and an overstatement of what the
   * sentence claimed. The count travels with the figure so the two cannot drift.
   */
  daysCounted: number;
}

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;
};

/** Local midnight that starts the day `ms` falls in. */
const dayStart = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * The owner's free windows over the days the month actually spans.
 *
 * `allBlocks` sets the month's extent — the owner is "free" on a day the fleet
 * never drove, but saying so is noise, so only days the month covers are walked.
 */
export function ownerFreeTime(
  allBlocks: readonly PlanBlock[],
  ownerBlocks: readonly PlanBlock[],
  switchMinutes: number,
): OwnerFreeTime {
  const assignedMinutes = ownerBlocks.reduce((sum, b) => sum + b.spanMinutes, 0);
  if (allBlocks.length === 0) {
    return {
      windows: [], totalMinutes: 0, assignedMinutes, longestWindowMinutes: 0, daysCounted: 0,
    };
  }

  const floor = switchMinutes > 0 ? switchMinutes : 0;
  const days = new Set(allBlocks.map(b => localDay(b.startMs)));
  const daysCounted = days.size;

  // The owner's work, per local day, so a day with none yields one whole-day
  // window and a day with several yields the gaps between them.
  const mine = new Map<string, { startMs: number; endMs: number }[]>();
  for (const b of ownerBlocks) {
    const key = localDay(b.startMs);
    mine.set(key, [...(mine.get(key) ?? []), { startMs: b.startMs, endMs: b.endMs }]);
  }

  const windows: FreeWindow[] = [];
  for (const day of [...days].sort()) {
    const sample = allBlocks.find(b => localDay(b.startMs) === day)!;
    const from = dayStart(sample.startMs);
    const to = from + 24 * 60 * MS_PER_MINUTE;

    const busy = (mine.get(day) ?? []).sort((a, b) => a.startMs - b.startMs);
    let cursor = from;
    for (const span of busy) {
      // A block running past midnight clips at the day's end; the remainder
      // belongs to the next day and is handled when that day is walked.
      if (span.startMs > cursor) {
        const end = Math.min(span.startMs, to);
        if (end > cursor) windows.push(makeWindow(day, cursor, end));
      }
      cursor = Math.max(cursor, Math.min(span.endMs, to));
    }
    if (cursor < to) windows.push(makeWindow(day, cursor, to));
  }

  const usable = windows.filter(w => w.minutes >= floor);
  return {
    windows: usable,
    totalMinutes: usable.reduce((sum, w) => sum + w.minutes, 0),
    assignedMinutes,
    longestWindowMinutes: usable.reduce((max, w) => Math.max(max, w.minutes), 0),
    daysCounted,
  };
}

function makeWindow(day: string, startMs: number, endMs: number): FreeWindow {
  return { day, startMs, endMs, minutes: Math.round((endMs - startMs) / MS_PER_MINUTE) };
}
