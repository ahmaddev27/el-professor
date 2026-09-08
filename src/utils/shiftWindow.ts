// Driver planned shift window utilities.
//
// Shift window is stored on the driver as:
//   work_window_start  : "HH:MM" or null
//   work_window_end    : "HH:MM" or null
//   allowed_weekdays   : integer[] using ISO 1=Mon..7=Sun, or null
//
// If start > end, the window crosses midnight (e.g. 22:00 → 06:00).

export type ShiftCheckReason =
  | 'no_window'
  | 'inside_window'
  | 'outside_window'
  | 'wrong_weekday';

export interface ShiftWindowCheck {
  ok: boolean;
  reason: ShiftCheckReason;
  windowStartMin: number | null;
  windowEndMin: number | null;
  isoWeekday: number;
  weekdayAllowed: boolean;
}

interface DriverWindowFields {
  work_window_start?: string | null;
  work_window_end?: string | null;
  allowed_weekdays?: number[] | null;
}

function timeToMin(t: string | null | undefined): number | null {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

// ISO 8601 weekday: Monday=1..Sunday=7
export function isoWeekdayFromDate(d: Date): number {
  const js = d.getDay(); // 0=Sun..6=Sat
  return js === 0 ? 7 : js;
}

export function isoWeekdayFromDateString(dateStr: string): number {
  // dateStr "YYYY-MM-DD". Parse as local date.
  const [y, m, d] = dateStr.split('-').map(Number);
  return isoWeekdayFromDate(new Date(y, (m ?? 1) - 1, d ?? 1));
}

// Returns true if a [blockStartMin, blockEndMin] segment lies inside the
// driver's shift window for the given date.
// Handles cross-midnight windows and treats null work_window_* as "no window
// configured" → returns ok=true with reason='no_window'.
export function checkShiftWindow(
  driver: DriverWindowFields,
  dateStr: string,
  blockStartMin: number,
  blockEndMin: number,
): ShiftWindowCheck {
  const startMin = timeToMin(driver.work_window_start);
  const endMin = timeToMin(driver.work_window_end);
  const isoDay = isoWeekdayFromDateString(dateStr);

  const weekdays = Array.isArray(driver.allowed_weekdays) && driver.allowed_weekdays.length > 0
    ? driver.allowed_weekdays
    : null;
  const weekdayAllowed = weekdays === null ? true : weekdays.includes(isoDay);

  if (startMin == null || endMin == null) {
    // No window configured → only weekday rule applies.
    return {
      ok: weekdayAllowed,
      reason: weekdayAllowed ? 'no_window' : 'wrong_weekday',
      windowStartMin: null,
      windowEndMin: null,
      isoWeekday: isoDay,
      weekdayAllowed,
    };
  }

  if (!weekdayAllowed) {
    return { ok: false, reason: 'wrong_weekday', windowStartMin: startMin, windowEndMin: endMin, isoWeekday: isoDay, weekdayAllowed: false };
  }

  // Non-cross-midnight window
  if (startMin <= endMin) {
    const inside = blockStartMin >= startMin && blockEndMin <= endMin;
    return {
      ok: inside,
      reason: inside ? 'inside_window' : 'outside_window',
      windowStartMin: startMin,
      windowEndMin: endMin,
      isoWeekday: isoDay,
      weekdayAllowed: true,
    };
  }

  // Cross-midnight: window covers [start..1440) on serviceDay and [0..end] on next day.
  // Block runs from blockStartMin..blockEndMin (within the same date).
  // The block fits if every minute is in [start..1440) or in [0..end].
  // For a block within one calendar day [blockStartMin, blockEndMin],
  // inside = (blockStartMin >= startMin && blockEndMin <= 1440)
  //       || (blockEndMin <= endMin)
  // Cross-midnight blocks (start>end) are not supported here (planner splits at midnight).
  const inLate = blockStartMin >= startMin && blockEndMin <= 24 * 60;
  const inEarly = blockEndMin <= endMin;
  const inside = inLate || inEarly;
  return {
    ok: inside,
    reason: inside ? 'inside_window' : 'outside_window',
    windowStartMin: startMin,
    windowEndMin: endMin,
    isoWeekday: isoDay,
    weekdayAllowed: true,
  };
}

export function minutesOutsideWindow(
  windowStartMin: number | null,
  windowEndMin: number | null,
  blockStartMin: number,
  blockEndMin: number,
): number {
  if (windowStartMin == null || windowEndMin == null) return 0;
  const blockSpan = Math.max(0, blockEndMin - blockStartMin);
  if (blockSpan === 0) return 0;
  if (windowStartMin <= windowEndMin) {
    // inside window: clamp(blockEnd, win) - clamp(blockStart, win)
    const inStart = Math.max(blockStartMin, windowStartMin);
    const inEnd = Math.min(blockEndMin, windowEndMin);
    const inside = Math.max(0, inEnd - inStart);
    return blockSpan - inside;
  }
  // cross-midnight: union of [start..1440) and [0..end]
  const lateStart = Math.max(blockStartMin, windowStartMin);
  const lateEnd = Math.min(blockEndMin, 24 * 60);
  const lateInside = Math.max(0, lateEnd - lateStart);
  const earlyStart = Math.max(blockStartMin, 0);
  const earlyEnd = Math.min(blockEndMin, windowEndMin);
  const earlyInside = Math.max(0, earlyEnd - earlyStart);
  return blockSpan - lateInside - earlyInside;
}

export function timeStringFromMinutes(m: number): string {
  const mm = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(mm / 60);
  const r = mm % 60;
  return `${String(h).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
