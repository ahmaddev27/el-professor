import { describe, expect, it } from 'vitest';
import {
  MAX_BASIS_CENTS,
  SHARE_PERCENT_CHOICES,
  SHARE_RATE_CHOICES_BP,
  SIMULATOR_RATE_RANGE,
  applyMonthlyShare,
  isShareRateAllowed,
  resolveShareRate,
  selectDailyShareRate,
  selectMonthlyShareRate,
  shareSettingProblem,
  type ShareRateRange,
  type ShareSetting,
} from './monthlyRate';

// The arithmetic is the same for every caller; only which rates are admitted
// differs. These tests exercise the arithmetic over the whole 30-33 band, so
// they pass a band with no list of allowed values. The simulator's own range,
// which admits only the four values, has its own tests below.
const ARITHMETIC_BAND: ShareRateRange = { minBp: 3000, maxBp: 3300 };

const share = (basis: number, bp: number) => {
  const r = applyMonthlyShare(basis, bp, ARITHMETIC_BAND);
  if (!r.ok) throw new Error(`refused: ${r.problem}`);
  return r.result;
};

// Independent reference in BigInt, half away from zero, so a float slip in the
// module cannot also be a slip in the oracle.
const bigShare = (basis: number, bp: number): bigint => {
  const n = BigInt(basis) * BigInt(bp);
  const d = 10_000n;
  const abs = n < 0n ? -n : n;
  const q = abs / d;
  const r = abs % d;
  const rounded = 2n * r >= d ? q + 1n : q;
  return n < 0n ? -rounded : rounded;
};

describe('the Round 8 worked example (section 5)', () => {
  it('500.00 EUR x 32 % = 160.00 EUR, a percentage and not a multiplier', () => {
    const r = applyMonthlyShare(50_000, 3200);
    expect(r).toEqual({ ok: true, result: { basisCents: 50_000, rateBasisPoints: 3200, amountCents: 16_000, remainderCents: 34_000 } });
  });
});

describe('the four rates (section 5, test class 14)', () => {
  it('are exactly 30, 31, 32 and 33 %, in basis points and in percent', () => {
    expect([...SHARE_RATE_CHOICES_BP]).toEqual([3000, 3100, 3200, 3300]);
    expect([...SHARE_PERCENT_CHOICES]).toEqual([30, 31, 32, 33]);
  });

  it('the simulator refuses every rate between them by name, and the old continuous values with it', () => {
    for (const bp of [3001, 3050, 3099, 3101, 3142, 3150, 3199, 3250, 3299]) {
      expect(applyMonthlyShare(1000, bp)).toEqual({ ok: false, problem: 'rate_not_allowed' });
      expect(applyMonthlyShare(1000, bp, SIMULATOR_RATE_RANGE)).toEqual({ ok: false, problem: 'rate_not_allowed' });
      expect(isShareRateAllowed(bp)).toBe(false);
    }
    for (const bp of SHARE_RATE_CHOICES_BP) {
      expect(applyMonthlyShare(1000, bp).ok).toBe(true);
      expect(isShareRateAllowed(bp)).toBe(true);
    }
  });

  it('refuses a rate outside the band before asking whether it is one of the four', () => {
    expect(applyMonthlyShare(1000, 2900)).toEqual({ ok: false, problem: 'rate_out_of_range' });
    expect(applyMonthlyShare(1000, 3400)).toEqual({ ok: false, problem: 'rate_out_of_range' });
    // 32 read as a multiplier would be 320000 bp: refused, never computed.
    expect(applyMonthlyShare(1000, 320_000)).toEqual({ ok: false, problem: 'rate_out_of_range' });
  });
});

describe('selectMonthlyShareRate', () => {
  it('is reproducible for the same (seed, year, month)', () => {
    const a = selectMonthlyShareRate(12345, 2026, 3);
    const b = selectMonthlyShareRate(12345, 2026, 3);
    expect(b).toEqual(a);
  });

  it('lets the month enter the sub-seed: a year of months is not one rate', () => {
    const rates = new Set<number>();
    for (let m = 1; m <= 12; m++) rates.add(selectMonthlyShareRate(777, 2026, m).rateBasisPoints);
    expect(rates.size).toBeGreaterThan(1);
  });

  it('draws only the four values, and every one of them', () => {
    const seen = new Map<number, number>();
    for (let seed = 1; seed <= 2000; seed++) {
      const { rateBasisPoints, ratePercent } = selectMonthlyShareRate(seed, 2026, 1 + (seed % 12));
      expect(isShareRateAllowed(rateBasisPoints)).toBe(true);
      expect(ratePercent).toBe(rateBasisPoints / 100);
      seen.set(rateBasisPoints, (seen.get(rateBasisPoints) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual([3000, 3100, 3200, 3300]);
    // A draw stuck on one value, or biased far from even, would not land here.
    for (const count of seen.values()) expect(count).toBeGreaterThan(350);
  });
});

describe('selectDailyShareRate', () => {
  it('is reproducible for the same (seed, date) and draws only the four values', () => {
    for (let d = 1; d <= 31; d++) {
      const a = selectDailyShareRate(42, 2026, 10, d);
      expect(selectDailyShareRate(42, 2026, 10, d)).toEqual(a);
      expect(isShareRateAllowed(a.rateBasisPoints)).toBe(true);
    }
  });

  it('lets the day enter the sub-seed: a month of days is not one rate, and no two dates of a year share a stream', () => {
    const rates = new Set<number>();
    for (let d = 1; d <= 30; d++) rates.add(selectDailyShareRate(42, 2026, 9, d).rateBasisPoints);
    expect(rates.size).toBeGreaterThan(1);
    const streams = new Set<number>();
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++) streams.add(selectDailyShareRate(42, 2026, m, d).streamSeed);
    expect(streams.size).toBe(12 * 31);
  });
});

describe('resolveShareRate: the company setting', () => {
  const dates = Array.from({ length: 30 }, (_, i) => ({ year: 2026, month: 9, day: i + 1 }));

  it('a fixed percent is that percent on every date, with no seed', () => {
    for (const percent of SHARE_PERCENT_CHOICES) {
      for (const date of dates) {
        expect(resolveShareRate({ mode: 'fixed', percent }, date)).toEqual({
          rateBasisPoints: percent * 100, ratePercent: percent, mode: 'fixed', scope: null, seed: null, streamSeed: null,
        });
      }
    }
  });

  it('random with scope month is the month draw on every day of that month', () => {
    const month = selectMonthlyShareRate(9001, 2026, 9);
    for (const date of dates) {
      const r = resolveShareRate({ mode: 'random', scope: 'month', seed: 9001 }, date);
      expect(r.rateBasisPoints).toBe(month.rateBasisPoints);
      expect(r).toMatchObject({ mode: 'random', scope: 'month', seed: 9001, streamSeed: month.streamSeed });
    }
  });

  it('random with scope day is each date\'s own draw', () => {
    for (const date of dates) {
      const r = resolveShareRate({ mode: 'random', scope: 'day', seed: 9001 }, date);
      const own = selectDailyShareRate(9001, date.year, date.month, date.day);
      expect(r).toMatchObject({ rateBasisPoints: own.rateBasisPoints, scope: 'day', streamSeed: own.streamSeed });
    }
  });

  it('is stable under regeneration with the same setting, and moves with the seed', () => {
    const setting: ShareSetting = { mode: 'random', scope: 'day', seed: 5 };
    const first = dates.map(d => resolveShareRate(setting, d).rateBasisPoints);
    const again = dates.map(d => resolveShareRate({ ...setting }, d).rateBasisPoints);
    expect(again).toEqual(first);
    const other = dates.map(d => resolveShareRate({ ...setting, seed: 6 }, d).rateBasisPoints);
    expect(other).not.toEqual(first);
  });
});

describe('shareSettingProblem: a setting a person typed', () => {
  it('accepts the four fixed percents and both random scopes', () => {
    for (const percent of SHARE_PERCENT_CHOICES) expect(shareSettingProblem({ mode: 'fixed', percent })).toBeNull();
    expect(shareSettingProblem({ mode: 'random', scope: 'month', seed: 1 })).toBeNull();
    expect(shareSettingProblem({ mode: 'random', scope: 'day', seed: 0 })).toBeNull();
  });

  it.each([29, 34, 30.5, 0.32, 3200, 3.2, NaN])('refuses the fixed percent %s', percent => {
    expect(shareSettingProblem({ mode: 'fixed', percent } as unknown as ShareSetting)).toBe('percent_not_allowed');
  });

  it('refuses a random setting without a scope, or with a seed that is not a whole number', () => {
    expect(shareSettingProblem({ mode: 'random', scope: 'week', seed: 1 } as unknown as ShareSetting)).toBe('scope_missing');
    expect(shareSettingProblem({ mode: 'random', seed: 1 } as unknown as ShareSetting)).toBe('scope_missing');
    expect(shareSettingProblem({ mode: 'random', scope: 'day', seed: 1.5 })).toBe('seed_not_integer');
    expect(shareSettingProblem({ mode: 'random', scope: 'day', seed: Number.NaN })).toBe('seed_not_integer');
    expect(shareSettingProblem({ mode: 'other' } as unknown as ShareSetting)).toBe('mode_unknown');
  });
});

describe('applyMonthlyShare: arithmetic', () => {
  const bases = [0, 1, 7, 99, 100, 12_345, 999_999, 1_000_000, 123_456_789];
  const rates = [3000, 3001, 3142, 3150, 3299, 3300];

  it('amount + remainder is exactly the basis', () => {
    for (const b of bases) for (const r of rates) {
      const res = share(b, r);
      expect(res.amountCents + res.remainderCents).toBe(b);
      expect(res.basisCents).toBe(b);
      expect(res.rateBasisPoints).toBe(r);
    }
  });

  it('rounds exact halves away from zero on both signs', () => {
    // 50 c x 31.00 % = 50 * 3100 / 10000 = 15.5 exactly -> 16, and -15.5 -> -16.
    expect(share(50, 3100).amountCents).toBe(16);
    expect(share(-50, 3100).amountCents).toBe(-16);
    // 150 c x 33.00 % = 49.5 exactly -> 50 / -50.
    expect(share(150, 3300).amountCents).toBe(50);
    expect(share(-150, 3300).amountCents).toBe(-50);
    // Just below a half stays down: 49 c x 31.00 % = 15.19 -> 15.
    expect(share(49, 3100).amountCents).toBe(15);
  });

  it('is symmetric about zero for a negative basis', () => {
    for (const b of bases) for (const r of rates) {
      const pos = share(b, r).amountCents;
      const neg = share(-b, r).amountCents;
      // `+ 0` normalises -0, which toBe (Object.is) would otherwise tell apart.
      expect(neg + 0).toBe(-pos + 0);
    }
  });

  it('stays exact at MAX_BASIS_CENTS and matches an independent BigInt result', () => {
    const top = share(MAX_BASIS_CENTS, 3300);
    expect(Number.isSafeInteger(top.amountCents)).toBe(true);
    expect(BigInt(top.amountCents)).toBe(bigShare(MAX_BASIS_CENTS, 3300));

    const large = [MAX_BASIS_CENTS, MAX_BASIS_CENTS - 1, MAX_BASIS_CENTS - 9_999, 2 ** 40 + 12_345, 999_999_999_999_999];
    for (const b of large) {
      for (const r of [3000, 3142, 3299, 3300]) {
        if (Math.abs(b) > MAX_BASIS_CENTS) continue;
        expect(BigInt(share(b, r).amountCents)).toBe(bigShare(b, r));
        expect(BigInt(share(-b, r).amountCents)).toBe(bigShare(-b, r));
      }
    }
  });

  it('matches BigInt over a dense run near the bound (every remainder class)', () => {
    for (let i = 0; i < 400; i++) {
      const b = MAX_BASIS_CENTS - i;
      for (const r of [3000, 3137, 3300]) {
        expect(BigInt(share(b, r).amountCents)).toBe(bigShare(b, r));
      }
    }
  });
});

describe('applyMonthlyShare: refusals are return values', () => {
  it('refuses a basis above the bound by name', () => {
    expect(applyMonthlyShare(MAX_BASIS_CENTS + 1, 3000)).toEqual({ ok: false, problem: 'basis_too_large_for_exact_cents' });
    expect(applyMonthlyShare(-(MAX_BASIS_CENTS + 1), 3000)).toEqual({ ok: false, problem: 'basis_too_large_for_exact_cents' });
  });

  it('refuses a non-integer or out-of-range rate', () => {
    expect(applyMonthlyShare(1000, 3142.5)).toEqual({ ok: false, problem: 'rate_not_whole_basis_points' });
    expect(applyMonthlyShare(1000, 3200.5)).toEqual({ ok: false, problem: 'rate_not_whole_basis_points' });
    expect(applyMonthlyShare(1000, 2999)).toEqual({ ok: false, problem: 'rate_out_of_range' });
    expect(applyMonthlyShare(1000, 3301)).toEqual({ ok: false, problem: 'rate_out_of_range' });
  });

  it('refuses a non-integer basis, NaN and Infinity without throwing', () => {
    expect(applyMonthlyShare(10.5, 3100)).toEqual({ ok: false, problem: 'basis_not_whole_cents' });
    expect(() => applyMonthlyShare(NaN, 3100)).not.toThrow();
    expect(applyMonthlyShare(NaN, 3100)).toEqual({ ok: false, problem: 'basis_not_whole_cents' });
    expect(applyMonthlyShare(Infinity, 3100)).toEqual({ ok: false, problem: 'basis_not_whole_cents' });
    expect(applyMonthlyShare(-Infinity, 3100)).toEqual({ ok: false, problem: 'basis_not_whole_cents' });
  });
});
