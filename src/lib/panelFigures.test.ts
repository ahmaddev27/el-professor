import { describe, expect, it } from 'vitest';
import { driversAllowance, referralUsageCounts } from './panelFigures';

/*
  Both of these pin a figure the panel used to invent.

  Before this module, `ReferralCodesManagement` wrote
  `usage_count: usageMap[r.ref_code] ?? 0` and `SuperAdminDashboard` wrote
  `drivers_per_car_limit: dpcMap[c.id] ?? 4`. Each substituted a plausible number
  for one it did not have, so there was nothing to assert: the wrong answer and
  the right answer were the same type and both looked ordinary on screen. The two
  "unknown" cases below are what would fail against either old expression —
  `referralUsageCounts(..., false)` returned 0 per code, and
  `driversAllowance(3, null)` returned 12.
*/

describe('referralUsageCounts', () => {
  const companies = [
    { referral_code_used: 'SOMMER' },
    { referral_code_used: 'SOMMER' },
    { referral_code_used: 'HERBST' },
    { referral_code_used: null },
  ];

  it('counts the companies that used each code', () => {
    expect(referralUsageCounts(['SOMMER', 'HERBST'], companies, true))
      .toEqual({ SOMMER: 2, HERBST: 1 });
  });

  it('reports a code nobody used as zero — that zero was read', () => {
    expect(referralUsageCounts(['WINTER'], companies, true)).toEqual({ WINTER: 0 });
  });

  it('reports every code as unknown when the companies were not read', () => {
    // The defect itself: the dashboard's catch leaves `companies` empty, and
    // every code then reported a confident 0 Nutzungen.
    expect(referralUsageCounts(['SOMMER', 'HERBST'], [], false))
      .toEqual({ SOMMER: null, HERBST: null });
  });

  it('is unknown even when a list is present but not vouched for', () => {
    // A stale list from an earlier successful load is still on screen after a
    // failed reload; counting over it would state a figure nothing confirmed.
    expect(referralUsageCounts(['SOMMER'], companies, false)).toEqual({ SOMMER: null });
  });

  it('ignores a company pointing at a code that no longer exists', () => {
    expect(referralUsageCounts(['SOMMER'], [{ referral_code_used: 'GELOESCHT' }], true))
      .toEqual({ SOMMER: 0 });
  });

  it('answers an empty map for no codes', () => {
    expect(referralUsageCounts([], companies, true)).toEqual({});
    expect(referralUsageCounts([], companies, false)).toEqual({});
  });
});

describe('driversAllowance', () => {
  it('multiplies the car limit by the drivers allowed per car', () => {
    expect(driversAllowance(3, 6)).toBe(18);
    expect(driversAllowance(1, 4)).toBe(4);
  });

  it('is unknown when the per-car limit was not read', () => {
    // The defect itself: `?? 4` printed 12 for a company whose settings row the
    // read model did not return, and decided the red "limit reached" colour from
    // that same invented 12.
    expect(driversAllowance(3, null)).toBeNull();
  });

  it('keeps a real zero rather than treating it as missing', () => {
    // parseCompanyRow distinguishes 0 from null on purpose
    // (platformReadModels.test.ts), so zero must survive here too.
    expect(driversAllowance(3, 0)).toBe(0);
  });

  it('is unknown rather than NaN for a car limit that is not a number', () => {
    expect(driversAllowance(Number.NaN, 4)).toBeNull();
    expect(driversAllowance(Number.POSITIVE_INFINITY, 4)).toBeNull();
  });
});
