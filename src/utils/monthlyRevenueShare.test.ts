import { describe, expect, it } from 'vitest';
import {
  PRODUCT_MAX_BASIS_CENTS,
  PRODUCT_RATE_MAX_BP,
  PRODUCT_RATE_MIN_BP,
  computeStoredShare,
  describeShare,
  formatRateBasisPointsDe,
  rateProblem,
} from './monthlyRevenueShare';
import { applyMonthlyShare } from './simulatedRides/monthlyRate';

function share(basis: number, bp: number) {
  const r = computeStoredShare(basis, { rate_basis_points: bp });
  if (!r.ok) throw new Error(`unexpected problem ${r.problem}`);
  return r.result;
}

/** Exact reference: round half away from zero with BigInt, no float anywhere. */
function reference(basis: bigint, bp: bigint): bigint {
  const sign = basis < 0n ? -1n : 1n;
  const n = (basis < 0n ? -basis : basis) * bp;
  return sign * ((2n * n + 10_000n) / 20_000n);
}

describe('the audit worked example through the product path', () => {
  it('10.000,00 EUR x 31,42 % = 3.142,00 EUR, remainder 6.858,00 EUR', () => {
    const r = share(1_000_000, 3142);
    expect(r.amountCents).toBe(314_200);
    expect(r.remainderCents).toBe(685_800);
    expect(r.basisCents).toBe(1_000_000);
    expect(r.rateBasisPoints).toBe(3142);
  });

  it('is described in German notation', () => {
    expect(describeShare(share(1_000_000, 3142))).toEqual({
      basis: '10.000,00',
      rate: '31,42 %',
      amount: '3.142,00',
      remainder: '6.858,00',
    });
  });

  it('formats a rate with its hundredths', () => {
    expect(formatRateBasisPointsDe(0)).toBe('0,00 %');
    expect(formatRateBasisPointsDe(5)).toBe('0,05 %');
    expect(formatRateBasisPointsDe(10_000)).toBe('100,00 %');
  });
});

describe('amount + remainder = basis, exactly', () => {
  it('holds over a grid of bases and rates', () => {
    const bases = [0, 1, 2, 99, 100, 101, 12_345, 999_999, 1_000_000, -1, -12_345, 987_654_321];
    for (const basis of bases) {
      for (let bp = 0; bp <= PRODUCT_RATE_MAX_BP; bp += 137) {
        const r = share(basis, bp);
        expect(r.amountCents + r.remainderCents).toBe(basis);
      }
    }
  });
});

describe('the product range', () => {
  it('accepts 0 and 10000 basis points', () => {
    expect(rateProblem(PRODUCT_RATE_MIN_BP)).toBeNull();
    expect(rateProblem(PRODUCT_RATE_MAX_BP)).toBeNull();
    expect(share(500_000, 0).amountCents).toBe(0);
  });

  it('refuses -1 and 10001 by name, without throwing', () => {
    expect(rateProblem(-1)).toBe('rate_below_minimum');
    expect(rateProblem(10_001)).toBe('rate_above_maximum');
    expect(computeStoredShare(1000, { rate_basis_points: -1 })).toEqual({ ok: false, problem: 'rate_below_minimum' });
    expect(computeStoredShare(1000, { rate_basis_points: 10_001 })).toEqual({ ok: false, problem: 'rate_above_maximum' });
  });

  it('refuses a non-integer rate and a non-integer or oversized basis', () => {
    expect(rateProblem(3142.5)).toBe('rate_not_whole_basis_points');
    expect(rateProblem(Number.NaN)).toBe('rate_not_whole_basis_points');
    expect(computeStoredShare(1000, { rate_basis_points: 3142.5 })).toEqual({
      ok: false,
      problem: 'rate_not_whole_basis_points',
    });
    expect(computeStoredShare(10.5, { rate_basis_points: 3000 })).toEqual({ ok: false, problem: 'basis_not_whole_cents' });
    expect(computeStoredShare(PRODUCT_MAX_BASIS_CENTS + 1, { rate_basis_points: 3000 })).toEqual({
      ok: false,
      problem: 'basis_too_large_for_exact_cents',
    });
  });

  it('a rate of 100 % takes the whole basis and leaves nothing', () => {
    for (const basis of [0, 1, 99, 1_000_000, -777]) {
      const r = share(basis, 10_000);
      expect(r.amountCents).toBe(basis);
      expect(r.remainderCents).toBe(0);
    }
  });
});

describe('one formula, two rate sources: the simulator cross-check', () => {
  it('gives the identical amountCents for every rate in [3000, 3300] over several bases', () => {
    const bases = [0, 1, 7, 99, 12_345, 1_000_000, 987_654_321, -12_345];
    let pairs = 0;
    for (const basis of bases) {
      for (let bp = 3000; bp <= 3300; bp += 7) {
        const sim = applyMonthlyShare(basis, bp);
        if (!sim.ok) throw new Error(`simulator refused ${bp}`);
        const prod = share(basis, bp);
        expect(prod.amountCents).toBe(sim.result.amountCents);
        expect(prod.remainderCents).toBe(sim.result.remainderCents);
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(50);
  });

  it('agrees on every single rate in the band for one awkward basis', () => {
    for (let bp = 3000; bp <= 3300; bp += 1) {
      const sim = applyMonthlyShare(33_333_333, bp);
      if (!sim.ok) throw new Error('simulator refused');
      expect(share(33_333_333, bp).amountCents).toBe(sim.result.amountCents);
    }
  });
});

describe('exact decimal, measured against BigInt', () => {
  it('matches a BigInt reference on large bases at several rates', () => {
    const bases = [123_456_789_012, PRODUCT_MAX_BASIS_CENTS, 500_000_000_001, -555_555_555_555];
    for (const basis of bases) {
      for (const bp of [1, 3142, 3333, 6667, 9999, 10_000]) {
        expect(share(basis, bp).amountCents).toBe(Number(reference(BigInt(basis), BigInt(bp))));
      }
    }
  });

  it('rounds a half cent away from zero', () => {
    // 5 cents x 10 % = 0.5 cent -> 1; the mirror -5 -> -1.
    expect(share(5, 1000).amountCents).toBe(1);
    expect(share(-5, 1000).amountCents).toBe(-1);
    expect(share(4, 1000).amountCents).toBe(0);
  });
});
