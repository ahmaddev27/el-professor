import { SOURCE_TIME_ZONE } from '../fahrtenbuchImportParser';

/**
 * The per-tenant settings of the simulation scenario (external audit round 3,
 * sections 2, 3 and 4). Every one of them is a setting because the audit asked
 * for one; none of them reaches a ledger table, a payroll figure or a
 * statutory document.
 *
 * ## Why this object exists at all, and what it deliberately is not
 *
 * `src/utils/simulatedRides/` writes a **generated** month: a file marked
 * SIMULIERT in four places, imported with `is_simulated = true`, refused by a
 * trigger from mixing with a real driver-week. The audit's sections 3 and 4 ask
 * for a declined-ride fee and a monthly revenue share. Both are **scenario
 * features**, and section 3 says so itself ("في سيناريو المحاكاة الجديد" — in
 * the new simulation scenario).
 *
 * So neither one is a column on `fahrtenbuch_trips`, neither is a new
 * `trip_status`, and neither changes a figure any existing screen or document
 * shows. Teaching the ledger a third ride status is a migration plus a CHECK
 * plus an owner's decision about what a word in a customer's file means — the
 * header of `CANCELLED_STATUS_WORDS` states that rule — and it is not taken
 * here under an audit's name.
 *
 * ## Both features ship off
 *
 * `declinedRidesEnabled` and `monthlyRevenueShareEnabled` default to `false`.
 * A month generated with the defaults is byte-identical to one generated
 * before this file existed: `declinedShare` is applied only when the first is
 * on, and the share report is produced only when the second is.
 */
export interface SimulationTenantSettings {
  // ── Section 2: the period ────────────────────────────────────────────────
  /**
   * The zone the generated wall-clock times are read in. It defaults to
   * `SOURCE_TIME_ZONE` and every shipped caller leaves it there.
   *
   * **It is a setting of the simulation only.** `Europe/Berlin` is a constant
   * in some thirty source files and eighteen migrations, and the payroll code
   * walks local calendar days — night, Sunday and holiday classification all
   * depend on the zone. Threading a tenant zone into *those* would move
   * Lohnart buckets and the two holiday tables, which is a change to a
   * statutory document and is not made here. What this zone reaches is the
   * generator's own clock arithmetic and nothing else.
   */
  timeZone: string;
  /**
   * The hour a working day starts, for dating a ride. 4 is the Uber export's
   * rule and the shift recommendation's.
   *
   * The repository holds four different cuts of "operating day" (04:00 in the
   * simulation's own clock, 04:00 settable but unstored in the shift
   * recommendation, 04:00 for the Uber day, 00:00 in the planning phases) and
   * the only stored one is per plan, not per company. This value is the
   * simulation's, passed as an argument, so the generated month says which cut
   * built it instead of leaving it to a constant.
   */
  operatingDayStartHour: number;

  // ── Section 3: declined rides ───────────────────────────────────────────
  /** Off by default. On, a share of the generated rides is DECLINED. */
  declinedRidesEnabled: boolean;
  /** Share of a shift's rides that are declined, when the feature is on. */
  declinedShare: number;
  /**
   * The fee a declined ride earns, in **integer cents**. The audit's figure is
   * 6.00 EUR; it is a setting because the audit asked for one per tenant.
   */
  declinedFeeCents: number;
  /**
   * Whether a CANCELLED ride earns the same fee. **False by default, and the
   * audit is explicit**: "لا تفرض 6 € تلقائيًا على CANCELLED ما لم تنص سياسة
   * الشركة على ذلك" — do not charge it on a cancellation unless company policy
   * says so. A cancellation keeps the separate `CANCELLATION_FEES` the
   * generator has always drawn from, which is a different quantity.
   */
  chargeDeclinedFeeOnCancelled: boolean;

  // ── Section 4: the monthly revenue share ────────────────────────────────
  /** Off by default. On, the month's report carries the share figure. */
  monthlyRevenueShareEnabled: boolean;
  /** Whether tips enter the eligible-revenue basis. Configurable, per section 4. */
  basisIncludesTips: boolean;
  /** Whether declined fees enter the eligible-revenue basis. Configurable. */
  basisIncludesDeclinedFees: boolean;
}

export const DEFAULT_SIMULATION_TENANT_SETTINGS: SimulationTenantSettings = {
  timeZone: SOURCE_TIME_ZONE,
  operatingDayStartHour: 4,
  declinedRidesEnabled: false,
  declinedShare: 0.04,
  declinedFeeCents: 600,
  chargeDeclinedFeeOnCancelled: false,
  monthlyRevenueShareEnabled: false,
  basisIncludesTips: false,
  basisIncludesDeclinedFees: true,
};

/** A reason a settings object is refused. One code per rule, stable. */
export type SettingsProblem =
  | 'time_zone_unknown'
  | 'operating_day_start_hour_out_of_range'
  | 'declined_share_out_of_range'
  | 'declined_fee_not_whole_cents'
  | 'declined_fee_negative';

/**
 * The first rule a settings object breaks, or null.
 *
 * Validated at the boundary rather than trusted: a fee that is not whole cents
 * makes every later integer-cent sum a float, and an unknown zone makes
 * `Intl.DateTimeFormat` throw deep inside the clock arithmetic where the
 * failure reads as a generator bug.
 */
export function settingsProblem(s: SimulationTenantSettings): SettingsProblem | null {
  if (!isKnownTimeZone(s.timeZone)) return 'time_zone_unknown';
  if (!Number.isInteger(s.operatingDayStartHour) || s.operatingDayStartHour < 0 || s.operatingDayStartHour > 23) {
    return 'operating_day_start_hour_out_of_range';
  }
  if (!Number.isFinite(s.declinedShare) || s.declinedShare < 0 || s.declinedShare > 1) return 'declined_share_out_of_range';
  if (!Number.isInteger(s.declinedFeeCents)) return 'declined_fee_not_whole_cents';
  if (s.declinedFeeCents < 0) return 'declined_fee_negative';
  return null;
}

/** True when `Intl` can resolve the name. The one place the zone is checked. */
export function isKnownTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Settings with the defaults filled in, refusing an override that breaks a rule. */
export function resolveSettings(
  overrides?: Partial<SimulationTenantSettings>,
): { ok: true; settings: SimulationTenantSettings } | { ok: false; problem: SettingsProblem } {
  const settings: SimulationTenantSettings = { ...DEFAULT_SIMULATION_TENANT_SETTINGS, ...overrides };
  const problem = settingsProblem(settings);
  return problem ? { ok: false, problem } : { ok: true, settings };
}
