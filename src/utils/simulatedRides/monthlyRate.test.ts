import { describe, expect, it } from 'vitest';
import {
  MAX_BASIS_CENTS,
  MONTHLY_SHARE_MAX_BP,
  MONTHLY_SHARE_MIN_BP,
  applyMonthlyShare,
  selectMonthlyShareRate,
} from './monthlyRate';

const share = (basis: number, bp: number) => {
  const r = applyMonthlyShare(basis, bp);
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

describe('applyMonthlyShare: the audit worked example', () => {
  it('10,000.00 EUR x 31.42 % = 3,142.00 EUR with 6,858.00 EUR remainder', () => {
    const r = share(1_000_000, 3142);
    expect(r.amountCents).toBe(314_200);
    expect(r.remainderCents).toBe(685_800);
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

  it('always draws a whole rate in [3000, 3300] and reaches both ends of it', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let seed = 1; seed <= 3000; seed++) {
      const { rateBasisPoints, ratePercent } = selectMonthlyShareRate(seed, 2026, 1 + (seed % 12));
      expect(Number.isInteger(rateBasisPoints)).toBe(true);
      expect(rateBasisPoints).toBeGreaterThanOrEqual(MONTHLY_SHARE_MIN_BP);
      expect(rateBasisPoints).toBeLessThanOrEqual(MONTHLY_SHARE_MAX_BP);
      expect(ratePercent).toBe(rateBasisPoints / 100);
      min = Math.min(min, rateBasisPoints);
      max = Math.max(max, rateBasisPoints);
    }
    // 301 possible values over 3000 draws: a stuck draw would not get this close.
    expect(min).toBeLessThanOrEqual(3010);
    expect(max).toBeGreaterThanOrEqual(3290);
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
