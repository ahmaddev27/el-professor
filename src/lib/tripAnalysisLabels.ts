/**
 * The translation keys for the engine's vocabulary, one map per union.
 *
 * Typed `Record<Union, TranslationKey>`, so a type the engine adds and nobody
 * labelled fails to compile instead of showing a raw key on screen or in the
 * report.
 */
import type { TranslationKey } from '../i18n';
import type {
  BlockStartReason,
  BudgetProblem,
  IssueSeverity,
  IssueStatus,
  IssueType,
  TripExclusionReason,
  TripStatus,
} from '../utils/tripAnalysis/types';

export const ISSUE_TYPE_KEYS: Record<IssueType, TranslationKey> = {
  driver_overlap: 'ta.issue.driver_overlap',
  vehicle_overlap: 'ta.issue.vehicle_overlap',
  travel_gap: 'ta.issue.travel_gap',
  activity_outside_shift: 'ta.issue.activity_outside_shift',
  shift_without_activity: 'ta.issue.shift_without_activity',
  shift_overlap: 'ta.issue.shift_overlap',
  shift_invalid: 'ta.issue.shift_invalid',
  no_shift_records: 'ta.issue.no_shift_records',
  missing_driver: 'ta.issue.missing_driver',
  missing_vehicle: 'ta.issue.missing_vehicle',
  missing_start: 'ta.issue.missing_start',
  missing_end: 'ta.issue.missing_end',
  end_before_start: 'ta.issue.end_before_start',
  status_unknown: 'ta.issue.status_unknown',
  ambiguous_local_time: 'ta.issue.ambiguous_local_time',
  driver_name_mismatch: 'ta.issue.driver_name_mismatch',
  activity_over_budget: 'ta.issue.activity_over_budget',
  shifts_over_budget: 'ta.issue.shifts_over_budget',
  budget_not_computable: 'ta.issue.budget_not_computable',
  cap_below_hours_min: 'ta.issue.cap_below_hours_min',
};

export const ISSUE_STATUS_KEYS: Record<IssueStatus, TranslationKey> = {
  passed: 'ta.status.passed',
  conflict: 'ta.status.conflict',
  unverifiable: 'ta.status.unverifiable',
};

export const ISSUE_SEVERITY_KEYS: Record<IssueSeverity, TranslationKey> = {
  error: 'ta.severity.error',
  warning: 'ta.severity.warning',
  info: 'ta.severity.info',
};

export const TRIP_STATUS_KEYS: Record<TripStatus, TranslationKey> = {
  completed: 'ta.tripStatus.completed',
  cancelled: 'ta.tripStatus.cancelled',
  unknown: 'ta.tripStatus.unknown',
};

export const EXCLUSION_KEYS: Record<TripExclusionReason, TranslationKey> = {
  cancelled: 'ta.exclusion.cancelled',
  status_unknown: 'ta.exclusion.status_unknown',
  missing_driver: 'ta.exclusion.missing_driver',
  missing_start: 'ta.exclusion.missing_start',
  missing_end: 'ta.exclusion.missing_end',
  end_before_start: 'ta.exclusion.end_before_start',
  ambiguous_local_time: 'ta.exclusion.ambiguous_local_time',
};

export const BUDGET_PROBLEM_KEYS: Record<BudgetProblem, TranslationKey> = {
  salary_min_missing: 'ta.budgetProblem.salary_min_missing',
  salary_min_invalid: 'ta.budgetProblem.salary_min_invalid',
  salary_min_negative: 'ta.budgetProblem.salary_min_negative',
  salary_max_missing: 'ta.budgetProblem.salary_max_missing',
  salary_max_invalid: 'ta.budgetProblem.salary_max_invalid',
  salary_max_negative: 'ta.budgetProblem.salary_max_negative',
  salary_min_above_max: 'ta.budgetProblem.salary_min_above_max',
  hourly_rate_missing: 'ta.budgetProblem.hourly_rate_missing',
  hourly_rate_invalid: 'ta.budgetProblem.hourly_rate_invalid',
  hourly_rate_not_positive: 'ta.budgetProblem.hourly_rate_not_positive',
  reserve_not_set: 'ta.budgetProblem.reserve_not_set',
  reserve_invalid: 'ta.budgetProblem.reserve_invalid',
  reserve_negative: 'ta.budgetProblem.reserve_negative',
  reserve_above_hours_max: 'ta.budgetProblem.reserve_above_hours_max',
};

export const START_REASON_KEYS: Record<BlockStartReason, TranslationKey> = {
  first: 'ta.startReason.first',
  gap: 'ta.startReason.gap',
  vehicle_change: 'ta.startReason.vehicle_change',
};
