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
 * The boundary is `public.get_active_company_id()` (20260917130000, kept by
 * 20260917140000). For a member of a company it answers a company id only when
 *
 *   company.approval_status = 'approved'
 *   AND company.status IN ('active', 'trial')
 *   AND company.subscription_status = 'active'
 *   AND (company.subscription_expires_at IS NULL OR … > now())
 *
 * — and NULL otherwise, which no `company_id` equals, so every business table
 * reads and writes nothing. Approval and the account's own status are App.tsx's
 * gates 3 and 5 and are not this module's business; the last two lines are.
 *
 * Until today this module's ancestor read `status` and `trial_end` and never
 * the subscription, which broke the normal path: signup writes `status =
 * 'trial'` with `subscription_status = 'inactive'`
 * (`app_private.signup_insert_company`), approval changes only
 * `approval_status`, and `redeem_activation_code` writes the five
 * `subscription_*` columns and never `status`. So a paying customer keeps
 * `status = 'trial'` for ever, and on the day the trial window closed the
 * browser — and only the browser — locked every screen but the overview, while
 * the server went on answering. The owner approved the fix on 17.09.2026 as
 * class 3 of the subscription decision sheet: **a company whose subscription is
 * active and unexpired is active on its stored plan, whatever `status` still
 * says.**
 *
 * ─── Never more permissive than the server ───────────────────────────────────
 *
 * The subscription term is therefore part of `active` as well, not only of the
 * expired trial: a company the server refuses is not shown as active. The one
 * deliberate exception is a *running* trial, which the owner kept as it is
 * (premium, unlocked) even though a fresh company's `subscription_status` is
 * `inactive` and the server refuses it. Nothing is reachable through that gap:
 * `SubscriptionGuard` in App.tsx sends a company without an active subscription
 * to `/abo-aktivieren` and lets only that page, `/aktivierung` and `/billing`
 * through.
 */

import type { FeatureKey, Plan, PlanState, SubscriptionStatus } from '../contexts/PlanContext';
import type { BillingCycle } from './pricing';
import { planHasFeature, type PlanFeatureMap } from './planFeatures';

/** The columns of `companies` the plan state is built from. */
export interface CompanyPlanRow {
  plan?: string | null;
  status?: string | null;
  trial_start?: string | null;
  trial_end?: string | null;
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
  trialStart: null,
  trialEnd: null,
  trialDaysLeft: 0,
  isInTrial: false,
  isTrialExpired: false,
  isActive: true,
  carLimit: 3,
  billingCycle: 'monthly',
};

function daysLeft(end: Date, now: Date): number {
  const ms = end.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / (1000 * 60 * 60 * 24)) : 0;
}

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
  const trialEnd = raw.trial_end ? new Date(raw.trial_end) : null;
  const trialStart = raw.trial_start ? new Date(raw.trial_start) : null;

  const isInTrial = !!(trialEnd && trialEnd > now);
  const trialIsOver = !!(trialEnd && trialEnd <= now);
  const subscribed = subscriptionIsActive(raw.subscription_status, raw.subscription_expires_at, now);
  const rawStatus = raw.status ?? 'active';

  let status: SubscriptionStatus;
  if (rawStatus === 'trial') {
    // A running trial is unchanged. Past it, the subscription decides: this is
    // the defect's cell — `status` stays `trial` for ever, so without the
    // subscription term a paying customer is `trial_expired` for ever too.
    status = isInTrial ? 'trial' : subscribed ? 'active' : 'trial_expired';
  } else if (rawStatus === 'suspended') {
    status = 'suspended';
  } else if (rawStatus === 'inactive') {
    status = 'inactive';
  } else if (rawStatus === 'archived') {
    status = 'archived';
  } else if (rawStatus === 'deleted') {
    status = 'deleted';
  } else {
    // `active`, and anything the CHECK constraint might add later. The server
    // asks for a live subscription here too, so the browser does not say
    // `active` where `get_active_company_id()` answers NULL.
    status = subscribed ? 'active' : 'inactive';
  }

  // `isActive` reads as it always did; what changed is that `active` and
  // `trial` are now reached only where the server agrees.
  const isActive = status === 'trial' || status === 'active';

  // "The trial ended and nothing replaced it." The two screens that read it —
  // TrialBanner and the overview's plan card — say *Testphase abgelaufen · nur
  // Basic-Features*, which is the wrong sentence to show someone who is paying.
  const isTrialExpired = trialIsOver && !subscribed;

  const carLimit = raw.subscription_car_limit ?? 3;
  const billingCycle: BillingCycle = raw.billing_cycle === 'yearly' ? 'yearly' : 'monthly';

  return {
    plan,
    status,
    trialStart,
    trialEnd,
    trialDaysLeft: isInTrial && trialEnd ? daysLeft(trialEnd, now) : 0,
    isInTrial,
    isTrialExpired,
    isActive,
    carLimit,
    billingCycle,
  };
}

/** Premium for as long as the trial runs, the stored plan afterwards. */
export function effectivePlanOf(planState: PlanState): Plan {
  return planState.isInTrial ? 'premium' : planState.plan;
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
