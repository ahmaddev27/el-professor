/**
 * Defaults and validation for the shift recommendation's two settings groups.
 *
 * The defaults are the owner's working shape (08.10.2026): shifts of three to
 * four and three-quarter hours, so always under five, at most two per vehicle
 * and day, and half an hour between two shifts of one vehicle. The threshold
 * has no product default on purpose — the screen proposes the history's own
 * average rate, so "recommend only what beats our average" is where an
 * operator starts, and a number in euros is never invented here.
 */
import {
  MAX_SHIFT_MINUTES_LIMIT,
  type PlanSettings,
  type ProfileSettings,
  type SettingsProblem,
} from './types';

export const SUPPORTED_SLOT_MINUTES: readonly number[] = [15, 30, 60];

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  slotMinutes: 15,
  operatingDayStartHour: 4,
  blockGapMinutes: 30,
  minEvidenceDays: 2,
};

/** Without `minRevenuePerHourCents`, which the screen takes from the profile. */
export const DEFAULT_PLAN_SETTINGS: Omit<PlanSettings, 'minRevenuePerHourCents'> = {
  minShiftMinutes: 180,
  maxShiftMinutes: 285,
  minBreakMinutes: 30,
  maxShiftsPerVehiclePerDay: 2,
};

function isWholeNumber(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value);
}

export function validateProfileSettings(settings: ProfileSettings): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  if (!SUPPORTED_SLOT_MINUTES.includes(settings.slotMinutes)) problems.push('slot_minutes_unsupported');
  if (!isWholeNumber(settings.operatingDayStartHour) || settings.operatingDayStartHour < 0 || settings.operatingDayStartHour > 23) {
    problems.push('operating_day_start_invalid');
  }
  if (!Number.isFinite(settings.blockGapMinutes) || settings.blockGapMinutes < 0) problems.push('block_gap_invalid');
  if (!isWholeNumber(settings.minEvidenceDays) || settings.minEvidenceDays < 1) problems.push('min_evidence_days_invalid');
  return problems;
}

/** `slotMinutes` is the profile's: a shift is a whole number of its slots. */
export function validatePlanSettings(settings: PlanSettings, slotMinutes: number): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const minValid = isWholeNumber(settings.minShiftMinutes) && settings.minShiftMinutes >= slotMinutes;
  const maxValid = isWholeNumber(settings.maxShiftMinutes) && settings.maxShiftMinutes >= slotMinutes;
  if (!minValid) problems.push('min_shift_invalid');
  if (!maxValid) problems.push('max_shift_invalid');
  if (maxValid && settings.maxShiftMinutes > MAX_SHIFT_MINUTES_LIMIT) problems.push('max_shift_above_limit');
  if (minValid && maxValid && settings.minShiftMinutes > settings.maxShiftMinutes) problems.push('min_shift_above_max');
  const breakValid = isWholeNumber(settings.minBreakMinutes) && settings.minBreakMinutes >= 0;
  if (!breakValid) problems.push('min_break_invalid');
  const multiples = [
    minValid ? settings.minShiftMinutes : 0,
    maxValid ? settings.maxShiftMinutes : 0,
    breakValid ? settings.minBreakMinutes : 0,
  ];
  if (slotMinutes > 0 && multiples.some(value => value % slotMinutes !== 0)) problems.push('shift_not_slot_multiple');
  if (
    !isWholeNumber(settings.maxShiftsPerVehiclePerDay) ||
    settings.maxShiftsPerVehiclePerDay < 1 ||
    settings.maxShiftsPerVehiclePerDay > 4
  ) {
    problems.push('max_shifts_per_day_invalid');
  }
  if (!isWholeNumber(settings.minRevenuePerHourCents) || settings.minRevenuePerHourCents < 0) {
    problems.push('min_revenue_per_hour_invalid');
  }
  return problems;
}
