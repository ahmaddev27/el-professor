/**
 * The plan state machine: the company row the browser reads → what the screens
 * may open.
 *
 * It lives outside `PlanContext` so it can be tested without a renderer (vitest
 * runs in node here, with no DOM), the way `planFeatures.ts` and `adminGate.ts`
 * already do.
 *
 * ─── The rule it has to mirror ───────────────────────────────────────────────
 *
 * The boundary is `public.get_active_company_id()`. For a member of a company
 * it answers a company id only when
 *
 *   company.approval_status = 'approved'
 *   AND company.status = 'active'
 *   AND company.subscription_status = 'active'
 *   AND (company.subscription_expires_at IS NULL OR … > now())
 *
 * — and NULL otherwise, which no `company_id` equals, so every business table
 * reads and writes nothing. Approval and the account's own status are App.tsx's
 * gates 3 and 5 and are not this module's business; the last two lines are.
 *
 * ─── There is no trial (owner, 15.10.2026) ───────────────────────────────────
 *
 * "There is no 14 day try for free version." A company has access while its
 * subscription is live — an activation code or a period an operator recorded —
 * and not otherwise. `20261015170000` moved every `status = 'trial'` row to
 * `'active'` and narrowed the server's `status IN ('active','trial')` to
 * `status = 'active'`, so this module no longer has a running trial that
 * unlocks premium, a trial that expires, or a `trial_end` to read.
 *
 * A `status` of `'trial'` that still reaches the browser (a rolled-back
 * database, a stale cache) is a status this build does not know, and an unknown
 * status locks: the server refuses it too, and a browser more permissive than
 * the server shows empty screens.
 *
 * ─── Never more permissive than the server ───────────────────────────────────
 *
 * The subscription term is part of `active`: a company the server refuses is
 * not shown as active. `SubscriptionGuard` in App.tsx sends a company without
 * an active subscription to `/abo-aktivieren` and lets only that page,
 * `/aktivierung` and `/billing` through.
 */

import type { FeatureKey, Plan, PlanState, SubscriptionStatus } from '../contexts/PlanContext';
import type { BillingCycle } from './pricing';
import { planHasFeature, type PlanFeatureMap } from './planFeatures';

/** The columns of `companies` the plan state is built from. */
export interface CompanyPlanRow {
  plan?: string | null;
  status?: string | null;
  subscription_status?: string | null;
  subscription_expires_at?: string | null;
  subscription_car_limit?: number | null;
  billing_cycle?: string | null;
}

/**
 * The state before the company row has been read, and the state for a row the
 * caller could not read at all.
 *
 * It stays permissive on purpose, exactly as it has been: `PlanProvider` reports
 * `loading` alongside it, `PlanGate` does not wait for that, and a restrictive
 * placeholder would flash `LockedFeaturePage` over every screen on every page
 * load. It is not a state machine cell — no company is ever in it — and nothing
 * is unlocked by it that the server would not check again on the first query.
 */
export const UNRESOLVED_PLAN_STATE: PlanState = {
  plan: 'basic',
  status: 'active',
  isActive: true,
  carLimit: 3,
  billingCycle: 'monthly',
};

/**
 * The server's last two terms, and the only place the browser spells them.
 *
 * A missing expiry is an open subscription, as `subscription_expires_at IS NULL`
 * is on the server — that is what the 2026-06-21 backfill left on every company
 * that predates the column. A date that does not parse is not a subscription.
 */
export function subscriptionIsActive(
  status: string | null | undefined,
  expiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (status !== 'active') return false;
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return true;
  const end = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return false;
  return end.getTime() > now.getTime();
}

/**
 * The company row → the plan state the screens read.
 *
 * `plan` is passed through unvalidated, as it always has been: a value this
 * build does not know ranks below every feature in `planFeatures.ts` and so
 * locks rather than opens.
 */
export function buildPlanState(
  raw: CompanyPlanRow | null | undefined,
  now: Date = new Date(),
): PlanState {
  if (!raw) return { ...UNRESOLVED_PLAN_STATE };

  const plan: Plan = (raw.plan as Plan) ?? 'basic';
  const subscribed = subscriptionIsActive(raw.subscription_status, raw.subscription_expires_at, now);
  const rawStatus = raw.status ?? 'active';

  let status: SubscriptionStatus;
  if (rawStatus === 'suspended') {
    status = 'suspended';
  } else if (rawStatus === 'inactive') {
    status = 'inactive';
  } else if (rawStatus === 'archived') {
    status = 'archived';
  } else if (rawStatus === 'deleted') {
    status = 'deleted';
  } else if (rawStatus === 'active') {
    // The server asks for a live subscription here too, so the browser does not
    // say `active` where `get_active_company_id()` answers NULL.
    status = subscribed ? 'active' : 'inactive';
  } else {
    // A status this build does not know — `trial` included, since
    // 20261015170000 — locks rather than opens, for the same reason an unknown
    // *plan* ranks below every feature: the server admits `active` and nothing
    // else.
    status = 'inactive';
  }

  const isActive = status === 'active';

  const carLimit = raw.subscription_car_limit ?? 3;
  const billingCycle: BillingCycle = raw.billing_cycle === 'yearly' ? 'yearly' : 'monthly';

  return {
    plan,
    status,
    isActive,
    carLimit,
    billingCycle,
  };
}

/** The plan the company holds. Since the trial went, nothing lifts it. */
export function effectivePlanOf(planState: PlanState): Plan {
  return planState.plan;
}

/**
 * What `usePlan().can()` answers.
 *
 * Not a boundary — the database checks every read and write again — but the
 * difference between a screen and `LockedFeaturePage`.
 */
export function planAllows(
  planState: PlanState,
  planFeatures: PlanFeatureMap,
  feature: FeatureKey,
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return true;
  if (planState.status === 'archived' || planState.status === 'deleted') return false;
  if (!planState.isActive && feature !== 'overview') return false;
  return planHasFeature(planFeatures, effectivePlanOf(planState), feature);
}
