import { describe, expect, it } from 'vitest';
import { coveredLength, mergeIntervals, overlappingPairs, totalLength, uncoveredLength } from './intervals';

const i = (start: number, end: number) => ({ start, end });

describe('half-open intervals', () => {
  it('merges overlapping and touching intervals and drops empty ones', () => {
    expect(mergeIntervals([i(5, 8), i(0, 2), i(2, 4), i(7, 10), i(12, 12), i(14, 13)])).toEqual([i(0, 4), i(5, 10)]);
    expect(totalLength(mergeIntervals([i(0, 10), i(5, 15)]))).toBe(15);
  });

  it('measures coverage by a merged list', () => {
    const shifts = mergeIntervals([i(10, 20), i(30, 40)]);
    expect(coveredLength(i(15, 35), shifts)).toBe(10);
    expect(coveredLength(i(20, 30), shifts)).toBe(0);
    expect(coveredLength(i(0, 50), shifts)).toBe(20);
    expect(uncoveredLength(mergeIntervals([i(0, 50)]), shifts)).toBe(30);
  });

  it('finds every overlapping pair, and none for intervals that only touch', () => {
    const items = [
      { id: 'long', ...i(0, 100) },
      { id: 'a', ...i(10, 20) },
      { id: 'b', ...i(20, 30) },
      { id: 'c', ...i(100, 110) },
      { id: 'empty', ...i(50, 50) },
    ];
    const pairs = overlappingPairs(items, x => x, x => x.id).map(([p, q]) => `${p.id}+${q.id}`);
    expect(pairs).toEqual(['long+a', 'long+b']);
  });
});
