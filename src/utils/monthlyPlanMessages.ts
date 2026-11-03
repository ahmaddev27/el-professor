/**
 * The monthly plan's findings, in words a person can act on.
 *
 * `validate.ts` writes a `detail` for each finding, and that text stays what it
 * is: it is stored with the plan, in the engine's own terms, for whoever audits
 * it later. It holds block ids, driver ids and codes such as
 * `invalid_hourly_rate`, so it is never shown. The screen words a finding here,
 * from the facts `validate.ts` carries beside the text, in the language of the UI.
 *
 * Every code has a `Record` over its union, so a new one fails to compile rather
 * than reaching a screen raw. A plan stored before the facts existed still gets a
 * sentence: only the part the facts would have filled in is missing.
 */

import type { TranslationKey } from '../i18n';
import type { AssignRefusal } from './monthlyPlan/assign';
import type { UnmetInclusionReason } from './monthlyPlan/availability';
import type { TripProblem } from './monthlyPlan/blocks';
import type { HoursRangeProblem } from './monthlyPlan/hoursRange';
import type { PlanViolation, PlanWarning } from './monthlyPlan/validate';

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export interface PlanMessageContext {
  t: Translate;
  /** The driver's name; the caller decides what an unknown id reads as. */
  driverName: (driverId: string | null | undefined) => string;
  /** A block as a person reads it, such as "B-DEMO-1 · 05.10.2026 08:23". */
  blockLabel: (blockId: string | null | undefined) => string;
  /** A vehicle's plate, or null when only an id is known. */
  vehicleLabel: (vehicleId: string | null | undefined) => string | null;
}

export const REFUSAL_KEYS: Record<AssignRefusal, TranslationKey> = {
  driver_overlap: 'mplan.refusal.driverOverlap',
  exceeds_hours_cap: 'mplan.refusal.exceedsHoursCap',
  excluded_by_note: 'mplan.refusal.excludedByNote',
  vehicle_switch_gap: 'mplan.refusal.vehicleSwitchGap',
  no_usable_range: 'mplan.refusal.noUsableRange',
};

export const UNMET_REASON_KEYS: Record<UnmetInclusionReason, TranslationKey> = {
  no_matching_block: 'mplan.unmet.noMatchingBlock',
  ambiguous_vehicles: 'mplan.unmet.ambiguousVehicles',
  conflicts_with_exclusion: 'mplan.unmet.conflictsWithExclusion',
  driver_not_selected: 'mplan.unmet.driverNotSelected',
  block_contested: 'mplan.unmet.blockContested',
};

export const TRIP_PROBLEM_KEYS: Record<TripProblem, TranslationKey> = {
  missing_vehicle: 'mplan.tripProblem.missingVehicle',
  missing_start: 'mplan.tripProblem.missingStart',
  missing_end: 'mplan.tripProblem.missingEnd',
  end_before_start: 'mplan.tripProblem.endBeforeStart',
  unparsable_time: 'mplan.tripProblem.unparsableTime',
};

export const RANGE_PROBLEM_KEYS: Record<HoursRangeProblem, TranslationKey> = {
  missing_hourly_rate: 'mplan.rangeProblem.missingHourlyRate',
  invalid_hourly_rate: 'mplan.rangeProblem.invalidHourlyRate',
  missing_min_salary: 'mplan.rangeProblem.missingMinSalary',
  missing_max_salary: 'mplan.rangeProblem.missingMaxSalary',
  min_salary_above_max: 'mplan.rangeProblem.minSalaryAboveMax',
};

/** The group's heading. Exhaustive, so a new kind cannot reach the screen as a code. */
export const WARNING_KEYS: Record<PlanWarning['kind'], TranslationKey> = {
  unassigned_block: 'mplan.warn.unassignedBlock',
  unmet_mandatory_note: 'mplan.warn.unmetMandatoryNote',
  note_conflict: 'mplan.warn.noteConflict',
  contested_block: 'mplan.warn.contestedBlock',
  pin_conflict: 'mplan.warn.pinConflict',
  rejected_trip: 'mplan.warn.rejectedTrip',
  source_overlap: 'mplan.warn.sourceOverlap',
  driver_without_range: 'mplan.warn.driverWithoutRange',
  driver_without_work: 'mplan.warn.driverWithoutWork',
};

/** `2026-10-05` as `05.10.2026`; anything else was not a date worth repeating. */
const germanDate = (value: string | null | undefined): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : null;
};

export function describePlanWarning(warning: PlanWarning, context: PlanMessageContext): string {
  const { t, driverName, blockLabel, vehicleLabel } = context;
  const facts = warning.facts ?? {};
  const driver = driverName(warning.driverId);
  const block = blockLabel(warning.blockId);

  switch (warning.kind) {
    case 'unassigned_block': {
      if (!facts.refusals || facts.refusals.length === 0) return t('mplan.warnDetail.unassignedNobody', { block });
      const list = facts.refusals
        .map(r => t('mplan.warnDetail.driverAndRefusal', { driver: driverName(r.driverId), refusal: t(REFUSAL_KEYS[r.refusal]) }))
        .join(', ');
      return t('mplan.warnDetail.unassigned', { block, list });
    }
    case 'unmet_mandatory_note':
      return facts.unmetReason
        ? t('mplan.warnDetail.unmet', { driver, reason: t(UNMET_REASON_KEYS[facts.unmetReason]) })
        : t('mplan.warnDetail.unmetUnknown', { driver });
    case 'note_conflict':
      return t('mplan.warnDetail.noteConflict', { driver });
    case 'contested_block':
      return t('mplan.warnDetail.contested', { block, drivers: (facts.driverIds ?? []).map(driverName).join(', ') });
    case 'pin_conflict':
      return facts.brokenRule
        ? t('mplan.warnDetail.pinConflict', { block, driver, rule: t(REFUSAL_KEYS[facts.brokenRule]) })
        : t('mplan.warnDetail.pinConflictUnknown', { block, driver });
    case 'rejected_trip':
      if (!facts.tripProblem) return t('mplan.warnDetail.rejectedTripUnknown');
      return germanDate(facts.tripDate)
        ? t('mplan.warnDetail.rejectedTrip', { problem: t(TRIP_PROBLEM_KEYS[facts.tripProblem]), date: germanDate(facts.tripDate)! })
        : t('mplan.warnDetail.rejectedTripNoDate', { problem: t(TRIP_PROBLEM_KEYS[facts.tripProblem]) });
    case 'source_overlap': {
      const vehicle = vehicleLabel(facts.vehicleId);
      const minutes = facts.minutes ?? 0;
      return vehicle
        ? t('mplan.warnDetail.sourceOverlap', { vehicle, minutes })
        : t('mplan.warnDetail.sourceOverlapNoVehicle', { minutes });
    }
    case 'driver_without_work':
      return t('mplan.warnDetail.driverWithoutWork', { driver });
    case 'driver_without_range': {
      const problems = (facts.rangeProblems ?? []).map(p => t(RANGE_PROBLEM_KEYS[p])).join(', ');
      return problems
        ? t('mplan.warnDetail.driverWithoutRange', { driver, problems })
        : t('mplan.warnDetail.driverWithoutRangeUnknown', { driver });
    }
  }
}

export function describePlanViolation(violation: PlanViolation, context: PlanMessageContext): string {
  const { t, driverName, blockLabel } = context;
  const facts = violation.facts ?? {};
  const driver = driverName(violation.driverId);
  const block = blockLabel(violation.blockId);
  const otherBlock = blockLabel(facts.otherBlockId);

  switch (violation.rule) {
    case 'block_assigned_twice':
      return t('mplan.violationDetail.blockAssignedTwice', { block });
    case 'unknown_block':
      return t('mplan.violationDetail.unknownBlock', { driver });
    case 'driver_not_in_pool':
      return t('mplan.violationDetail.driverNotInPool', { block });
    case 'assigned_inside_exclusion':
      return t('mplan.violationDetail.assignedInsideExclusion', { driver, block });
    case 'vehicle_switch_gap':
      return t('mplan.violationDetail.vehicleSwitchGap', {
        driver, first: otherBlock, second: block, minutes: facts.minutes ?? 0, required: facts.switchMinutes ?? 0,
      });
    case 'driver_overlap':
      return t('mplan.violationDetail.driverOverlap', { driver, first: otherBlock, second: block });
    case 'exceeds_hours_cap':
      return t('mplan.violationDetail.exceedsHoursCap', { driver, minutes: facts.minutes ?? 0, cap: facts.capMinutes ?? 0 });
    case 'pin_ignored':
      return facts.assignedDriverId
        ? t('mplan.violationDetail.pinIgnoredOther', { block, driver, other: driverName(facts.assignedDriverId) })
        : t('mplan.violationDetail.pinIgnoredNobody', { block, driver });
  }
}
