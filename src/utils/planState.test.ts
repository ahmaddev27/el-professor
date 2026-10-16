import { describe, expect, it } from 'vitest';
import {
  buildPlanState,
  effectivePlanOf,
  planAllows,
  subscriptionIsActive,
  UNRESOLVED_PLAN_STATE,
  type CompanyPlanRow,
} from './planState';
import { SEED_PLAN_FEATURES } from '../lib/appConfigSeed';
import type { FeatureKey } from '../contexts/PlanContext';

/**
 * The plan state machine, cell by cell.
 *
 * The reference is `public.get_active_company_id()`: for a member of an approved
 * company it answers a company id only for `status = 'active' AND
 * subscription_status = 'active' AND (subscription_expires_at IS NULL OR >
 * now())`. Approval and the account's own status are App.tsx's gates and not
 * this module's, so every case below assumes an approved company and a good
 * account, and asks what the browser adds.
 *
 * The rule these tests hold: **the browser is never more permissive than the
 * server.** There is no carve-out any more: the free trial went on 15.10.2026
 * (`20261015170000`) and with it the one cell where the browser opened what the
 * server refused.
 */

// The clock every case is judged against. Fixed, so a case cannot pass because
// the suite ran at a convenient moment.
const NOW = new Date('2026-09-17T12:00:00Z');
const PAST = '2026-08-01T00:00:00Z';
const FUTURE = '2026-12-01T00:00:00Z';

// Two features from the seeded map: one every plan has, one only premium has.
const BASIC_FEATURE: FeatureKey = 'belege';
const PREMIUM_FEATURE: FeatureKey = 'stundennachweis';

const row = (over: CompanyPlanRow): CompanyPlanRow => ({
  plan: 'basic',
  status: 'active',
  subscription_status: 'active',
  subscription_expires_at: FUTURE,
  subscription_car_limit: 3,
  billing_cycle: 'monthly',
  ...over,
});

const can = (r: CompanyPlanRow, feature: FeatureKey, isSuperAdmin = false) =>
  planAllows(buildPlanState(r, NOW), SEED_PLAN_FEATURES, feature, isSuperAdmin);

describe('the seeded feature map the cases are read against', () => {
  it('has the two features these tests rely on at the plans they assume', () => {
    expect(SEED_PLAN_FEATURES[BASIC_FEATURE]).toBe('basic');
    expect(SEED_PLAN_FEATURES[PREMIUM_FEATURE]).toBe('premium');
  });
});

describe('subscriptionIsActive — the server\'s last two terms', () => {
  it('is true for an active subscription with a future expiry', () => {
    expect(subscriptionIsActive('active', FUTURE, NOW)).toBe(true);
  });

  it('is true for an active subscription with no expiry, as `IS NULL` is on the server', () => {
    expect(subscriptionIsActive('active', null, NOW)).toBe(true);
    expect(subscriptionIsActive('active', undefined, NOW)).toBe(true);
  });

  it('is false once the expiry has passed', () => {
    expect(subscriptionIsActive('active', PAST, NOW)).toBe(false);
  });

  it('is false for every status but active, and for an unreadable date', () => {
    expect(subscriptionIsActive('inactive', FUTURE, NOW)).toBe(false);
    expect(subscriptionIsActive('expired', FUTURE, NOW)).toBe(false);
    expect(subscriptionIsActive('suspended', FUTURE, NOW)).toBe(false);
    expect(subscriptionIsActive(null, null, NOW)).toBe(false);
    expect(subscriptionIsActive('active', 'not-a-date', NOW)).toBe(false);
  });
});

describe('a company the old release left on status `trial`', () => {
  // `20261015170000` moves every such row to `active`. A row that still says
  // `trial` (a rolled-back database, a stale cache) is a status this build does
  // not know, and the server refuses it too.
  const legacy = row({ status: 'trial', subscription_status: 'active', subscription_expires_at: FUTURE });

  it('locks, as the server does', () => {
    const state = buildPlanState(legacy, NOW);
    expect(state.status).toBe('inactive');
    expect(state.isActive).toBe(false);
    expect(can(legacy, BASIC_FEATURE)).toBe(false);
  });
});

describe('a paying company on the stored plan', () => {
  const paying = row({ status: 'active', subscription_status: 'active', subscription_expires_at: FUTURE });

  it('is active on the stored plan', () => {
    const state = buildPlanState(paying, NOW);
    expect(state.status).toBe('active');
    expect(state.isActive).toBe(true);
    expect(effectivePlanOf(state)).toBe('basic');
  });

  it('opens the features the stored plan pays for, and no more', () => {
    expect(can(paying, BASIC_FEATURE)).toBe(true);
    expect(can(paying, 'overview')).toBe(true);
    expect(can(paying, PREMIUM_FEATURE)).toBe(false);
  });

  it('opens a premium feature to a company that bought premium', () => {
    const premium = row({ ...paying, plan: 'premium' });
    expect(effectivePlanOf(buildPlanState(premium, NOW))).toBe('premium');
    expect(can(premium, PREMIUM_FEATURE)).toBe(true);
  });

  it('also holds for the legacy open subscription with no expiry', () => {
    const openEnded = row({ ...paying, subscription_expires_at: null });
    expect(buildPlanState(openEnded, NOW).status).toBe('active');
    expect(can(openEnded, BASIC_FEATURE)).toBe(true);
  });
});

describe('a company whose status is `active`', () => {
  it('with a future expiry is active on its stored plan', () => {
    const state = buildPlanState(row({ plan: 'advanced', status: 'active', subscription_expires_at: FUTURE }), NOW);
    expect(state.status).toBe('active');
    expect(state.isActive).toBe(true);
    expect(effectivePlanOf(state)).toBe('advanced');
  });

  it('with a past expiry is not shown as active — the server refuses it too', () => {
    const lapsed = row({ status: 'active', subscription_expires_at: PAST });
    const state = buildPlanState(lapsed, NOW);
    expect(state.status).toBe('inactive');
    expect(state.isActive).toBe(false);
    expect(can(lapsed, 'overview')).toBe(true);
    expect(can(lapsed, BASIC_FEATURE)).toBe(false);
  });

  it('with no subscription at all is not shown as active either', () => {
    const never = row({ status: 'active', subscription_status: 'inactive', subscription_expires_at: null });
    expect(buildPlanState(never, NOW).isActive).toBe(false);
    expect(can(never, BASIC_FEATURE)).toBe(false);
  });
});

describe('the four blocked company states keep their meaning', () => {
  const states = ['suspended', 'inactive', 'archived', 'deleted'] as const;

  for (const companyStatus of states) {
    it(`${companyStatus} is blocked even with an active subscription`, () => {
      const blocked = row({ status: companyStatus, subscription_status: 'active', subscription_expires_at: FUTURE });
      const state = buildPlanState(blocked, NOW);
      expect(state.status).toBe(companyStatus);
      expect(state.isActive).toBe(false);
      expect(can(blocked, BASIC_FEATURE)).toBe(false);
      expect(can(blocked, PREMIUM_FEATURE)).toBe(false);
    });
  }

  it('archived and deleted close the overview as well; suspended and inactive keep it', () => {
    const closed = (s: 'archived' | 'deleted' | 'suspended' | 'inactive') =>
      can(row({ status: s }), 'overview');
    expect(closed('archived')).toBe(false);
    expect(closed('deleted')).toBe(false);
    expect(closed('suspended')).toBe(true);
    expect(closed('inactive')).toBe(true);
  });
});

describe('the short circuits', () => {
  it('a super admin passes every gate, whatever the company row says', () => {
    for (const companyStatus of ['trial', 'active', 'suspended', 'inactive', 'archived', 'deleted']) {
      const blocked = row({ status: companyStatus, subscription_status: 'inactive', subscription_expires_at: null });
      expect(can(blocked, PREMIUM_FEATURE, true)).toBe(true);
      expect(can(blocked, 'overview', true)).toBe(true);
    }
  });

  it('an unread company row keeps the permissive placeholder, so no screen flashes as locked', () => {
    expect(buildPlanState(null, NOW)).toEqual(UNRESOLVED_PLAN_STATE);
    expect(buildPlanState(undefined, NOW).isActive).toBe(true);
    expect(planAllows(buildPlanState(null, NOW), SEED_PLAN_FEATURES, BASIC_FEATURE, false)).toBe(true);
    expect(planAllows(buildPlanState(null, NOW), SEED_PLAN_FEATURES, PREMIUM_FEATURE, false)).toBe(false);
  });

  it('a status this build does not know locks, as an unknown plan does', () => {
    // Unreachable while `companies_status_check` pins the column to five values.
    // It is here so that a seventh status added by a later migration — which
    // `get_active_company_id()` would refuse — cannot open the screens instead.
    const unknown = row({ status: 'dormant', subscription_status: 'active', subscription_expires_at: FUTURE });
    const state = buildPlanState(unknown, NOW);
    expect(state.status).toBe('inactive');
    expect(state.isActive).toBe(false);
    expect(can(unknown, BASIC_FEATURE)).toBe(false);
  });

  it('a row with no status at all is still read as `active`, as it always was', () => {
    const noStatus = row({ status: null, subscription_status: 'active', subscription_expires_at: FUTURE });
    expect(buildPlanState(noStatus, NOW).status).toBe('active');
    expect(buildPlanState(row({ status: null, subscription_status: 'inactive', subscription_expires_at: null }), NOW).status).toBe('inactive');
  });

  it('a feature the map does not name needs premium', () => {
    const paying = row({ status: 'active', plan: 'advanced' });
    expect(planAllows(buildPlanState(paying, NOW), {}, BASIC_FEATURE, false)).toBe(false);
    expect(planAllows(buildPlanState(paying, NOW), {}, 'overview', false)).toBe(false);
  });
});

/**
 * The table the PR body carries, as an assertion: for every combination of
 * company status, subscription status and expiry, the browser must not open
 * what `get_active_company_id()` closes.
 *
 * **What this does and does not prove.** The oracle transcribes the server's
 * `status = 'active'` itself, but for the server's last two terms it calls
 * `subscriptionIsActive()` — the very function under test. For that half the
 * cases assert `f(x) === f(x)`: they pin the *shape* of the state machine, not
 * the subscription rule. **The rule is pinned by the hardcoded assertions in
 * `describe('subscriptionIsActive …')` above.**
 */
describe('the browser is never more permissive than the server', () => {
  const companyStatuses = ['trial', 'active', 'suspended', 'inactive', 'archived', 'deleted'];
  const subscriptions: Array<[string | null, string | null]> = [
    ['active', FUTURE],
    ['active', null],
    ['active', PAST],
    ['inactive', null],
    ['expired', PAST],
    ['suspended', FUTURE],
    [null, null],
  ];

  /** `get_active_company_id()` for an approved company and a good account. */
  const serverAdmits = (companyStatus: string, subStatus: string | null, expiry: string | null) =>
    companyStatus === 'active' && subscriptionIsActive(subStatus, expiry, NOW);

  for (const status of companyStatuses) {
    for (const [subStatus, expiry] of subscriptions) {
      const label = `${status} / ${subStatus ?? 'none'} / expiry ${expiry === FUTURE ? 'future' : expiry === PAST ? 'past' : 'none'}`;
      it(label, () => {
        const r = row({ status, subscription_status: subStatus, subscription_expires_at: expiry });
        expect(buildPlanState(r, NOW).isActive).toBe(serverAdmits(status, subStatus, expiry));
      });
    }
  }
});
