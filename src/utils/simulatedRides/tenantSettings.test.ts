import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMULATION_TENANT_SETTINGS as D,
  isKnownTimeZone,
  resolveSettings,
  settingsProblem,
  type SimulationTenantSettings,
} from './tenantSettings';

const with_ = (o: Partial<SimulationTenantSettings>): SimulationTenantSettings => ({ ...D, ...o });

describe('defaults', () => {
  it('ship both scenario features off, so an unconfigured month is unchanged', () => {
    expect(D.declinedRidesEnabled).toBe(false);
    expect(D.monthlyRevenueShareEnabled).toBe(false);
    expect(D.chargeDeclinedFeeOnCancelled).toBe(false);
  });

  it('carry the declared values', () => {
    expect(D).toEqual({
      timeZone: 'Europe/Berlin',
      operatingDayStartHour: 4,
      declinedRidesEnabled: false,
      declinedShare: 0.04,
      declinedFeeCents: 600,
      chargeDeclinedFeeOnCancelled: false,
      monthlyRevenueShareEnabled: false,
      basisIncludesTips: false,
      basisIncludesDeclinedFees: true,
    });
  });

  it('are themselves valid', () => {
    expect(settingsProblem(D)).toBeNull();
  });
});

describe('settingsProblem', () => {
  it('names an unknown zone', () => {
    expect(settingsProblem(with_({ timeZone: 'Not/AZone' }))).toBe('time_zone_unknown');
  });
  it.each([-1, 24, 3.5, NaN])('names cutoff hour %s', hour => {
    expect(settingsProblem(with_({ operatingDayStartHour: hour }))).toBe('operating_day_start_hour_out_of_range');
  });
  it('accepts the cutoff bounds 0 and 23', () => {
    expect(settingsProblem(with_({ operatingDayStartHour: 0 }))).toBeNull();
    expect(settingsProblem(with_({ operatingDayStartHour: 23 }))).toBeNull();
  });
  it.each([-0.01, 1.01, NaN])('names a share of %s', declinedShare => {
    expect(settingsProblem(with_({ declinedShare }))).toBe('declined_share_out_of_range');
  });
  it('names a fractional fee', () => {
    expect(settingsProblem(with_({ declinedFeeCents: 600.5 }))).toBe('declined_fee_not_whole_cents');
  });
  it('names a negative fee', () => {
    expect(settingsProblem(with_({ declinedFeeCents: -1 }))).toBe('declined_fee_negative');
  });
});

describe('isKnownTimeZone', () => {
  it('accepts real zones', () => {
    expect(isKnownTimeZone('Europe/Berlin')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
  });
  it('rejects empty, unknown and non-string input without throwing', () => {
    expect(isKnownTimeZone('')).toBe(false);
    expect(isKnownTimeZone('   ')).toBe(false);
    expect(isKnownTimeZone('Not/AZone')).toBe(false);
    expect(isKnownTimeZone(42 as unknown as string)).toBe(false);
    expect(isKnownTimeZone(undefined as unknown as string)).toBe(false);
  });
});

describe('resolveSettings', () => {
  it('returns the defaults with no override', () => {
    expect(resolveSettings()).toEqual({ ok: true, settings: D });
  });
  it('merges a partial override over the defaults', () => {
    const r = resolveSettings({ declinedRidesEnabled: true, declinedFeeCents: 750 });
    expect(r).toEqual({ ok: true, settings: { ...D, declinedRidesEnabled: true, declinedFeeCents: 750 } });
  });
  it('refuses an invalid override as a return value', () => {
    expect(resolveSettings({ timeZone: 'Not/AZone' })).toEqual({ ok: false, problem: 'time_zone_unknown' });
    expect(resolveSettings({ declinedFeeCents: -5 })).toEqual({ ok: false, problem: 'declined_fee_negative' });
  });
});
