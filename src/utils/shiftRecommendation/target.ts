/**
 * Planning towards a revenue target — by searching the threshold, never by
 * bending a figure.
 *
 * `recommendShifts` takes a threshold (cents per vehicle hour a shift has to
 * beat) and returns the shifts worth driving. Lowering the threshold admits
 * more slots, so the plan's expected revenue does not fall as the threshold
 * does. `planForTarget` therefore looks for the **smallest threshold whose
 * plan does not exceed the target**, which is the plan closest to the target
 * from below: a binary search over whole cents per hour, each step one honest
 * `recommendShifts`.
 *
 * ## What it deliberately does not do
 *
 * It never adjusts a shift's figure to make a sum come out. Every expected
 * revenue in the result is the company's own measured rate times the shift's
 * slots, exactly as `recommendShifts` computed it, so the returned shifts are
 * byte-identical to a direct call at the chosen threshold. A plan that lands
 * short says so and says why; it is never padded.
 *
 * ## When the target cannot be reached
 *
 * At threshold 0 every slot with a positive, evidenced rate and a free vehicle
 * is already taken. If that plan is still below the target, the result is
 * `unreachable`, carries the plan's maximum, and names what bounded it:
 *
 *   - `history_ceiling`: even with unlimited vehicles, the history never had
 *     enough vehicles out in rated slots to earn the target;
 *   - `fleet_size`: more vehicles than the ones selected would reach it;
 *   - `shift_rules`: the vehicles chosen could earn it in principle, but the
 *     shift window, the break and the shifts-per-day limit keep them from
 *     being on the road in the right slots. `levers` then says how much each
 *     of those rules costs, measured by re-planning with that one rule relaxed
 *     (the six-hour ceiling, §4 ArbZG, is never widened).
 *
 * Slots without usable history carry no rate, so they cannot be priced; they
 * are reported in minutes instead of being guessed at.
 *
 * Monotonicity is assumed, not relied on for safety: the search keeps the
 * invariant that the plan it returns is at or below the target, whatever the
 * greedy vehicle order does to the curve.
 */
import { recommendShifts } from './recommend';
import { dateKeyOf, dayTypeOf, daysInMonth } from './timeline';
import {
  MAX_SHIFT_MINUTES_LIMIT,
  type DemandProfile,
  type PlanSettings,
  type RecommendInput,
  type ShiftRecommendation,
} from './types';

export type TargetPlanSettings = Omit<PlanSettings, 'minRevenuePerHourCents'>;

export interface TargetPlanInput {
  readonly profile: DemandProfile;
  readonly target: RecommendInput['target'];
  readonly vehicles: readonly string[];
  readonly holidays: ReadonlySet<string>;
  readonly settings: TargetPlanSettings;
  /** The month's revenue the operator wants, integer cents ≥ 0. */
  readonly targetRevenueCents: number;
}

/**
 * reached = on the target; below_target = as close as a threshold gets, from
 * below; over_target = the operator chose the next plan up instead (see
 * `swapToAlternative`); unreachable = the maximum falls short.
 */
export type TargetOutcome = 'reached' | 'below_target' | 'over_target' | 'unreachable';
export type ShortfallBinding = 'history_ceiling' | 'fleet_size' | 'shift_rules';
export type ShortfallLeverName = 'break' | 'shifts_per_day' | 'min_shift' | 'max_shift';

export interface ShortfallLever {
  readonly lever: ShortfallLeverName;
  /** The plan's revenue at threshold 0 with only this rule relaxed. */
  readonly revenueCents: number;
  /** revenueCents minus the real plan's: what the rule costs. */
  readonly gainCents: number;
}

export interface TargetShortfall {
  readonly binding: ShortfallBinding;
  /** Rated slots × the most vehicles the history had out (unlimited fleet), integer cents. */
  readonly ceilingByHistoryCents: number;
  /** The same, limited to the vehicles selected. */
  readonly ceilingByFleetCents: number;
  readonly levers: readonly ShortfallLever[];
  /** Slot minutes in the month where vehicles were seen but too rarely for a rate. */
  readonly unratedSlotMinutes: number;
  /** Slot minutes in the month where the history never had a vehicle out: a wall for everyone. */
  readonly neverDrivenSlotMinutes: number;
}

/**
 * The plan on the other side of the target. The expected revenue moves in
 * steps — a window either clears the threshold or it does not, and a whole
 * shift goes with it — so the plan just under the target can be far from it
 * (an empty plan when one step carries all the revenue). The next plan up is
 * kept so the operator sees both and chooses; neither is adjusted.
 */
export interface TargetAlternative {
  readonly thresholdCents: number;
  readonly achievedCents: number;
  /** achieved minus target when the alternative lies above it, target minus achieved when below; ≥ 0. */
  readonly distanceCents: number;
  readonly recommendation: ShiftRecommendation;
}

export interface TargetPlan {
  /** 'ok', or why no plan was made: the recommendation's own refusal, or an unreadable target. */
  readonly status: 'ok' | 'invalid_target_amount' | 'recommendation_failed';
  readonly targetRevenueCents: number;
  /** null unless status is 'ok'. */
  readonly outcome: TargetOutcome | null;
  /** The plan's expected revenue, integer cents. */
  readonly achievedCents: number;
  /** target − achieved, ≥ 0: what the plan is short of the target. */
  readonly gapCents: number;
  /** The chosen threshold, integer cents per vehicle hour. */
  readonly thresholdCents: number;
  /** Exactly `recommendShifts` at `thresholdCents`. */
  readonly recommendation: ShiftRecommendation;
  /** Set when the outcome is 'unreachable'. */
  readonly shortfall: TargetShortfall | null;
  /** Set when the target lies strictly between two plans: the one on the other side of it. */
  readonly alternative: TargetAlternative | null;
  /** How many plans the search computed. */
  readonly evaluations: number;
}

function isTargetAmount(cents: number): boolean {
  return Number.isInteger(cents) && cents >= 0;
}

/** One more than the best rate in the profile: at that threshold no slot is worth a shift. */
function thresholdAboveEveryRate(profile: DemandProfile): number {
  let top = 0;
  for (const cell of profile.cells) {
    if (cell.revenuePerHourCents !== null) top = Math.max(top, cell.revenuePerHourCents);
  }
  return Math.ceil(top) + 1;
}

interface Ceilings {
  readonly byHistory: number;
  readonly byFleet: number;
  readonly unratedMinutes: number;
  readonly neverDrivenMinutes: number;
}

/** What the profile allows at most, day by day, before any shift rule applies. */
function ceilings(input: TargetPlanInput, vehicleCount: number): Ceilings {
  const { profile } = input;
  const slotMinutes = profile.settings.slotMinutes;
  const slotHours = slotMinutes / 60;
  let byHistory = 0;
  let byFleet = 0;
  let unrated = 0;
  let neverDriven = 0;
  const days = daysInMonth(input.target.year, input.target.month);
  for (let day = 1; day <= days; day += 1) {
    const dayType = dayTypeOf(dateKeyOf(input.target.year, input.target.month, day), input.holidays);
    for (const cell of profile.cells.slice(dayType * profile.positions, (dayType + 1) * profile.positions)) {
      if (cell.maxVehicles === 0) neverDriven += slotMinutes;
      else if (cell.revenuePerHourCents === null) unrated += slotMinutes;
      else {
        byHistory += cell.maxVehicles * cell.revenuePerHourCents * slotHours;
        byFleet += Math.min(cell.maxVehicles, vehicleCount) * cell.revenuePerHourCents * slotHours;
      }
    }
  }
  return { byHistory: Math.round(byHistory), byFleet: Math.round(byFleet), unratedMinutes: unrated, neverDrivenMinutes: neverDriven };
}

function bindingOf(target: number, ceil: Ceilings): ShortfallBinding {
  if (target > ceil.byHistory) return 'history_ceiling';
  if (target > ceil.byFleet) return 'fleet_size';
  return 'shift_rules';
}

type Runner = (threshold: number, relax?: Partial<TargetPlanSettings>) => ShiftRecommendation;

function leversOf(settings: TargetPlanSettings, slotMinutes: number, achieved: number, run: Runner): ShortfallLever[] {
  const candidates: [ShortfallLeverName, Partial<TargetPlanSettings>, boolean][] = [
    ['break', { minBreakMinutes: 0 }, settings.minBreakMinutes > 0],
    ['shifts_per_day', { maxShiftsPerVehiclePerDay: 4 }, settings.maxShiftsPerVehiclePerDay < 4],
    ['min_shift', { minShiftMinutes: slotMinutes }, settings.minShiftMinutes > slotMinutes],
    ['max_shift', { maxShiftMinutes: MAX_SHIFT_MINUTES_LIMIT }, settings.maxShiftMinutes < MAX_SHIFT_MINUTES_LIMIT],
  ];
  return candidates
    .filter(([, , applies]) => applies)
    .map(([lever, relax]) => {
      const revenueCents = run(0, relax).totals.expectedRevenueCents;
      return { lever, revenueCents, gainCents: revenueCents - achieved };
    });
}

export function planForTarget(input: TargetPlanInput): TargetPlan {
  let evaluations = 0;
  const vehicles = [...new Set(input.vehicles.map(v => v.trim()).filter(Boolean))];
  const run: Runner = (threshold, relax = {}) => {
    evaluations += 1;
    return recommendShifts({
      profile: input.profile,
      target: input.target,
      vehicles: input.vehicles,
      holidays: input.holidays,
      settings: { ...input.settings, ...relax, minRevenuePerHourCents: threshold },
    });
  };
  const target = input.targetRevenueCents;
  const atZero = run(0);
  const refused = (status: TargetPlan['status']): TargetPlan => ({
    status, targetRevenueCents: target, outcome: null, achievedCents: 0, gapCents: target,
    thresholdCents: 0, recommendation: atZero, shortfall: null, alternative: null, evaluations,
  });
  if (!isTargetAmount(target)) return refused('invalid_target_amount');
  if (atZero.status !== 'ok') return refused('recommendation_failed');

  const finish = (threshold: number, plan: ShiftRecommendation, above: ShiftRecommendation | null, aboveThreshold: number): TargetPlan => {
    const achieved = plan.totals.expectedRevenueCents;
    const base = {
      status: 'ok' as const, targetRevenueCents: target, achievedCents: achieved,
      gapCents: target - achieved, thresholdCents: threshold, recommendation: plan,
    };
    if (achieved === target) return { ...base, outcome: 'reached', shortfall: null, alternative: null, evaluations };
    if (threshold > 0 && above) {
      const alternative: TargetAlternative = {
        thresholdCents: aboveThreshold,
        achievedCents: above.totals.expectedRevenueCents,
        distanceCents: above.totals.expectedRevenueCents - target,
        recommendation: above,
      };
      return { ...base, outcome: 'below_target', shortfall: null, alternative, evaluations };
    }
    const ceil = ceilings(input, vehicles.length);
    const shortfall: TargetShortfall = {
      binding: bindingOf(target, ceil),
      ceilingByHistoryCents: ceil.byHistory,
      ceilingByFleetCents: ceil.byFleet,
      levers: leversOf(input.settings, input.profile.settings.slotMinutes, achieved, run),
      unratedSlotMinutes: ceil.unratedMinutes,
      neverDrivenSlotMinutes: ceil.neverDrivenMinutes,
    };
    return { ...base, outcome: 'unreachable', shortfall, alternative: null, evaluations };
  };

  if (atZero.totals.expectedRevenueCents <= target) return finish(0, atZero, null, 0);

  // f(low) > target ≥ f(high): the smallest threshold at or under the target lies between them.
  let low = 0;
  let high = thresholdAboveEveryRate(input.profile);
  let plan = run(high);
  let above = atZero;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const candidate = run(middle);
    if (candidate.totals.expectedRevenueCents <= target) {
      high = middle;
      plan = candidate;
    } else {
      low = middle;
      above = candidate;
    }
  }
  return finish(high, plan, above, low);
}

/**
 * The same result with the other side of the target made the plan: from
 * 'below_target' to 'over_target' and back. Pure, and nothing is recomputed —
 * both plans were computed by the search.
 */
export function swapToAlternative(plan: TargetPlan): TargetPlan {
  const other = plan.alternative;
  if (plan.status !== 'ok' || !other) return plan;
  const back: TargetAlternative = {
    thresholdCents: plan.thresholdCents,
    achievedCents: plan.achievedCents,
    distanceCents: Math.abs(plan.targetRevenueCents - plan.achievedCents),
    recommendation: plan.recommendation,
  };
  const over = other.achievedCents > plan.targetRevenueCents;
  return {
    ...plan,
    outcome: over ? 'over_target' : 'below_target',
    achievedCents: other.achievedCents,
    gapCents: over ? 0 : plan.targetRevenueCents - other.achievedCents,
    thresholdCents: other.thresholdCents,
    recommendation: other.recommendation,
    alternative: back,
  };
}
