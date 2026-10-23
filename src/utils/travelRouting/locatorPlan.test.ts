import { describe, expect, it } from 'vitest';
import { TRAVEL_ESTIMATOR_FLAG, locatorPlan, type LocatorContext } from './locatorPlan';

const member: LocatorContext = { flagOn: true, effectiveCompanyId: 'co-1', membershipCompanyId: 'co-1', isAdmin: true };

describe('locatorPlan', () => {
  it('is off unless the flag is on, whoever asks', () => {
    expect(locatorPlan({ ...member, flagOn: false })).toEqual({ enabled: false });
    expect(locatorPlan({ ...member, flagOn: false, isAdmin: false })).toEqual({ enabled: false });
  });

  it('is off while there is no company to look up for', () => {
    expect(locatorPlan({ ...member, effectiveCompanyId: null })).toEqual({ enabled: false });
  });

  it('lets the company\'s administrator read and keep what it finds', () => {
    expect(locatorPlan(member)).toEqual({ enabled: true, companyId: 'co-1', canWrite: true });
  });

  it('lets every other role of the company read and not write', () => {
    expect(locatorPlan({ ...member, isAdmin: false })).toEqual({ enabled: true, companyId: 'co-1', canWrite: false });
  });

  it('lets a platform account inside a company\'s context read and never write, an administrator\'s rights included', () => {
    const staff: LocatorContext = { flagOn: true, effectiveCompanyId: 'co-1', membershipCompanyId: null, isAdmin: true };
    expect(locatorPlan(staff)).toEqual({ enabled: true, companyId: 'co-1', canWrite: false });
  });

  it('does not let an administrator of one company write into another company\'s cache', () => {
    expect(locatorPlan({ ...member, membershipCompanyId: 'co-2' })).toEqual({ enabled: true, companyId: 'co-1', canWrite: false });
  });

  it('names the flag the owner switches in the platform settings', () => {
    expect(TRAVEL_ESTIMATOR_FLAG).toBe('travel_estimator');
  });
});
