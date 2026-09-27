/**
 * The max-3-Schichten compression, and the shift/day duration limits, as one
 * pure function so both screens compute them the same way and a test can pin them.
 *
 * ## The rule this preserves, stated before the change, per CLAUDE.md
 *
 * "Schicht compression (max 3 shifts/day) is display- and export-only. It must
 * not alter stored minutes, premium buckets, or Brutto figures." So the count of
 * three is **not a limit to enforce** — compression is the intended behaviour and
 * `compressedDays` is a note. Measured on staging, 26.09.2026: 1090 of 1178
 * driver-days (92.5%) merge to more than three shifts, so blocking on it would
 * stop almost every month from being finalized. That measurement is why it is a
 * note and not a gate.
 *
 * The two duration constants are a different rule and were never enforced
 * anywhere. `MAX_SHIFT = 270` (4:30) and `MAX_DAY = 510` (8:30) are declared in
 * both FinalizePlanningModal and MonatsplanungAssignmentPreview, and in both the
 * condition that would have used them was unreachable: the compression loop exits
 * at `<= 3`, and each then asked whether the count was `> 3`. So the limits have
 * never blocked anything. Measured on the same data: 2 of 1178 driver-days exceed
 * 8:30, and none has a single merged shift over 4:30 — a gate with a real but
 * small blast radius, which is why this one does block.
 *
 * ## Absolute instants, never time-of-day
 *
 * CLAUDE.md: "Build intervals from date-midnight-ms + secondOfDay * 1000, never
 * from a bare HH:MM:SS string." FinalizePlanningModal's check used `toMins()` on
 * HH:MM, so a ride from 23:00 to 01:00 produced `end < start`. Measured: two
 * genuinely overlapping shifts that both cross midnight (23:00-01:00 and
 * 23:30-02:00) merged to **two** rows, where the same overlap in daylight
 * (13:00-15:00 and 13:30-16:00) correctly merged to one.
 */
export const MAX_SHIFT_MINUTES = 270  // 4:30
export const MAX_DAY_MINUTES = 510    // 8:30

export interface DayWindow {
  /** Absolute start instant, ms since epoch. */
  startMs: number
  /** Absolute end instant, ms since epoch. Must be greater than startMs. */
  endMs: number
}

export interface DayLimitResult {
  /** The windows after overlapping ones are merged, before any compression. */
  merged: DayWindow[]
  /** True when the day needs compressing for display — a note, never a block. */
  needsCompression: boolean
  /** Total worked minutes across the merged windows. */
  dayMinutes: number
  /** The longest single merged window, in minutes. */
  longestShiftMinutes: number
  /** The day exceeds MAX_DAY_MINUTES — this is a real violation. */
  exceedsDayLimit: boolean
  /** Some merged shift exceeds MAX_SHIFT_MINUTES — a real violation. */
  exceedsShiftLimit: boolean
}

/** Merge overlapping or touching windows, then measure the day. */
export function assessDay(windows: DayWindow[]): DayLimitResult {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs)
  const merged: DayWindow[] = []
  for (const w of sorted) {
    const last = merged[merged.length - 1]
    if (!last || w.startMs > last.endMs) merged.push({ ...w })
    else last.endMs = Math.max(last.endMs, w.endMs)
  }
  const minutes = merged.map(m => (m.endMs - m.startMs) / 60000)
  const dayMinutes = minutes.reduce((a, b) => a + b, 0)
  const longestShiftMinutes = minutes.length ? Math.max(...minutes) : 0
  return {
    merged,
    needsCompression: merged.length > 3,
    dayMinutes,
    longestShiftMinutes,
    exceedsDayLimit: dayMinutes > MAX_DAY_MINUTES,
    exceedsShiftLimit: longestShiftMinutes > MAX_SHIFT_MINUTES,
  }
}

/**
 * The display compression: keep merging the closest adjacent pair until at most
 * three windows remain. Display only — it changes no stored figure.
 */
export function compressToThree(merged: DayWindow[]): DayWindow[] {
  const out = merged.map(m => ({ ...m }))
  while (out.length > 3) {
    let minGap = Infinity
    let minIdx = 0
    for (let i = 0; i < out.length - 1; i++) {
      const gap = out[i + 1].startMs - out[i].endMs
      if (gap < minGap) { minGap = gap; minIdx = i }
    }
    out[minIdx] = { startMs: out[minIdx].startMs, endMs: Math.max(out[minIdx].endMs, out[minIdx + 1].endMs) }
    out.splice(minIdx + 1, 1)
  }
  return out
}
