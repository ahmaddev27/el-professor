/**
 * Half-open interval arithmetic [start, end) on epoch milliseconds.
 *
 * Half-open is the rule of the whole engine: a trip ending at 10:00 and one
 * starting at 10:00 share no instant, so they neither overlap nor double count.
 * An interval with end ≤ start is empty and contributes nothing.
 */

export interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * Sorted, disjoint union of the intervals. Empty intervals are dropped; two
 * that touch ([a, b) and [b, c)) merge into [a, c), since the union has no gap.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const nonEmpty = intervals.filter(i => i.end > i.start);
  nonEmpty.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const current of nonEmpty) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      if (current.end > last.end) merged[merged.length - 1] = { start: last.start, end: current.end };
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

/** Total length of a merged (sorted, disjoint) list. */
export function totalLength(merged: readonly Interval[]): number {
  let sum = 0;
  for (const i of merged) sum += i.end - i.start;
  return sum;
}

/** Index of the first merged interval whose end lies after `time`. */
function firstEndingAfter(merged: readonly Interval[], time: number): number {
  let low = 0;
  let high = merged.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (merged[mid].end <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** How much of `interval` the merged list covers. */
export function coveredLength(interval: Interval, merged: readonly Interval[]): number {
  if (interval.end <= interval.start) return 0;
  let covered = 0;
  for (let k = firstEndingAfter(merged, interval.start); k < merged.length; k += 1) {
    const cover = merged[k];
    if (cover.start >= interval.end) break;
    covered += Math.min(cover.end, interval.end) - Math.max(cover.start, interval.start);
  }
  return covered;
}

/** Length of the merged list `a` that the merged list `b` does not cover. */
export function uncoveredLength(a: readonly Interval[], b: readonly Interval[]): number {
  let uncovered = 0;
  for (const interval of a) uncovered += interval.end - interval.start - coveredLength(interval, b);
  return uncovered;
}

/** Overlap length of two intervals under the half-open rule; 0 when they only touch. */
export function overlapLength(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Every pair of items whose intervals overlap: max(startA, startB) <
 * min(endA, endB). A sweep over the items sorted by start (then id) keeps the
 * set of intervals still open, so a long interval is compared with every
 * shorter one it covers, not only with its neighbour.
 *
 * Deterministic: pairs come out as [earlier, later] in sweep order.
 */
export function overlappingPairs<T>(
  items: readonly T[],
  intervalOf: (item: T) => Interval,
  idOf: (item: T) => string,
): Array<[T, T]> {
  const sorted = [...items].sort((a, b) => {
    const byStart = intervalOf(a).start - intervalOf(b).start;
    if (byStart !== 0) return byStart;
    return compareIds(idOf(a), idOf(b));
  });
  const pairs: Array<[T, T]> = [];
  let open: T[] = [];
  for (const current of sorted) {
    const { start, end } = intervalOf(current);
    open = open.filter(item => intervalOf(item).end > start);
    if (end <= start) continue;
    for (const item of open) pairs.push([item, current]);
    open.push(current);
  }
  return pairs;
}

/** Locale-independent id order, so a result never depends on the runtime's collation. */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
