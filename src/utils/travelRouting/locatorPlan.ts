/**
 * Whether the Fahrtenanalyse looks up addresses at all, and whether it may keep
 * what it finds. Pure, so the rules can be read and tested apart from the hook that
 * feeds them.
 *
 * The locator is OFF unless the owner turns it on: the `travel_estimator` feature
 * flag of the platform settings (useFlag), which stays off until both services
 * exist (the routing container and the geocoder gateway) and the geocode_cache
 * migration is applied. Off, nothing is asked of anybody and every travel check
 * says "nicht prüfbar", exactly as before this feature.
 *
 * Writing the cache is a narrower right than reading it:
 *   - the company's administrator may (the policy says so: the same rule as the
 *     other two Fahrtenanalyse tables), and no other role, so nobody else tries;
 *   - a platform account inside a company's context may not, on purpose: a support
 *     session's writes are recorded row by row in the audit log with their values,
 *     and a passenger's coordinates have no business in it. It still reads.
 * Both are the browser's copy of rules the database enforces on its own.
 */

export const TRAVEL_ESTIMATOR_FLAG = 'travel_estimator';

export interface LocatorContext {
  /** The `travel_estimator` flag. */
  readonly flagOn: boolean;
  /** The company whose data the screen shows: the membership, or the open context of a platform account. */
  readonly effectiveCompanyId: string | null;
  /** The account's own company; null for a platform account. */
  readonly membershipCompanyId: string | null;
  /** Whether the account is an administrator of its own company. */
  readonly isAdmin: boolean;
}

export type LocatorPlan =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly companyId: string; readonly canWrite: boolean };

export function locatorPlan(context: LocatorContext): LocatorPlan {
  if (!context.flagOn || !context.effectiveCompanyId) return { enabled: false };
  const ownCompany = context.membershipCompanyId !== null && context.membershipCompanyId === context.effectiveCompanyId;
  return { enabled: true, companyId: context.effectiveCompanyId, canWrite: context.isAdmin && ownCompany };
}
