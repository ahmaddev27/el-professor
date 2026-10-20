/**
 * A seeded random source (mulberry32). The generator is a pure function of its
 * input and a seed: the same seed gives the same month, which is what makes a
 * generated file reproducible in a test and a duplicate refusable by hash.
 */
export interface Rng {
  next(): number;
  /** Whole number in [min, max], both included. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => items[Math.floor(next() * items.length)],
    chance: probability => next() < probability,
  };
}
