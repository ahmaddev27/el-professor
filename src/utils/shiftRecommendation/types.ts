/**
 * Shift recommendation — the public contract (the monthly plan's "Typ 2").
 *
 * ## What this is
 *
 * It reads the rides a company has already imported, learns from them when a
 * vehicle on the road earns well and when it does not, and recommends for a
 * month that has not happened yet **when each vehicle should be on the road**:
 * a list of shifts (vehicle, day, from–to) with the revenue the history leads
 * one to expect. The aim is fewer, stronger hours: a vehicle out in a window
 * whose history earns less than the operator's threshold is not recommended.
 *
 * ## What this is not, and must never become
 *
 * It produces **no rides**. Not a planned ride, not a projected ride, not an
 * address, a fare, a tip, a cancellation or a GPS position — a Mietwagen cannot
 * know next month's rides, so any such list could only ever be used as a
 * record of something that did not happen. Its output is a shift and an
 * expected figure, labelled as an estimate, and nothing in it is shaped like a
 * Fahrtenbuch row. It never reads or writes a trip's driver, and it never
 * assigns a driver to a shift: who drives is the standard monthly plan's job.
 *
 * Pure TypeScript: no database, no UI, no clock, no randomness, so the same
 * input always yields the same result. Money is integer cents at every
 * boundary; the per-slot attribution in between is an estimate and is carried
 * as a fractional cent until it is rounded once, for display.
 *
 * Entry points (import from 'src/utils/shiftRecommendation'):
 *   buildDemandProfile(input: DemandProfileInput): DemandProfile
 *   recommendShifts(input: RecommendInput): ShiftRecommendation
 *   validateProfileSettings / validatePlanSettings
 *   DEFAULT_PROFILE_SETTINGS / DEFAULT_PLAN_SETTINGS
 */
import type { AnalysisTrip } from '../tripAnalysis/types';

/** Stored with every result; bump it whenever a rule below changes meaning. */
export const SHIFT_RECOMMENDATION_ALGORITHM_VERSION = 'shift-recommendation/1.0.0';

/** 1-based month, as `fahrtenbuch_imports.month` stores it. */
export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

/**
 * The day a demand pattern belongs to: Monday 0 … Sunday 6. A public holiday
 * is read as a Sunday, in the history and in the target month alike — a
 * holiday's demand looks like a Sunday's, and a holiday has too few
 * occurrences to carry a profile of its own.
 */
export type DayType = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Confidence = 'high' | 'medium' | 'low';

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * How the history is read. Changing one of these rebuilds the profile.
 *
 * An **operating day** runs from `operatingDayStartHour` local time to the same
 * hour the next day, so a Friday night shift from 22:00 to 02:00 belongs to
 * Friday and is one shift rather than two half-shifts on two calendar days.
 */
export interface ProfileSettings {
  /** 15, 30 or 60. Divides an hour, so every slot boundary is a whole multiple of it in UTC as well, DST included. */
  readonly slotMinutes: number;
  /** 0–23. */
  readonly operatingDayStartHour: number;
  /**
   * Rides of one vehicle whose gap is at most this belong to one period on the
   * road; a longer gap ends it. The time in between counts as on the road.
   * Finite, ≥ 0.
   */
  readonly blockGapMinutes: number;
  /** A slot needs on-road time on at least this many distinct operating days before its rate counts. Integer ≥ 1. */
  readonly minEvidenceDays: number;
}

/** How the month is planned. Changing one of these re-plans from the same profile. */
export interface PlanSettings {
  /** A multiple of the profile's slot, ≥ one slot. */
  readonly minShiftMinutes: number;
  /**
   * A multiple of the profile's slot, at most `MAX_SHIFT_MINUTES_LIMIT`. Longer
   * work needs a break inside it (§4 ArbZG: 30 minutes beyond six hours), which
   * this recommendation does not plan, so it does not recommend such a shift.
   */
  readonly maxShiftMinutes: number;
  /** Between two shifts of one vehicle, across midnight and across operating days too. A multiple of the slot, ≥ 0. */
  readonly minBreakMinutes: number;
  /** Integer 1–4. */
  readonly maxShiftsPerVehiclePerDay: number;
  /**
   * The rate a shift has to beat, integer cents per vehicle hour, ≥ 0. A slot
   * contributes (its expected rate − this) × its length, so a window below the
   * threshold costs a shift and the planner leaves it out.
   */
  readonly minRevenuePerHourCents: number;
}

/** Six hours: §4 ArbZG requires a break of 30 minutes in work of more than six hours. */
export const MAX_SHIFT_MINUTES_LIMIT = 360;

export type SettingsProblem =
  | 'slot_minutes_unsupported'
  | 'operating_day_start_invalid'
  | 'block_gap_invalid'
  | 'min_evidence_days_invalid'
  | 'min_shift_invalid'
  | 'max_shift_invalid'
  | 'max_shift_above_limit'
  | 'min_shift_above_max'
  | 'shift_not_slot_multiple'
  | 'min_break_invalid'
  | 'max_shifts_per_day_invalid'
  | 'min_revenue_per_hour_invalid';

// ── The profile (what the history says) ──────────────────────────────────────

export interface DemandProfileInput {
  /** The history, as `analysisTripFromRow` maps `fahrtenbuch_trips` rows. Only completed rides with a vehicle, a start and an end are learnt from. */
  readonly trips: readonly AnalysisTrip[];
  /** The months the trips stand for; the per-month figures are divided by their number. At least one. */
  readonly historyMonths: readonly YearMonth[];
  /** Local dates 'YYYY-MM-DD' that are public holidays; read as Sunday. */
  readonly holidays: ReadonlySet<string>;
  readonly settings: ProfileSettings;
}

/** Why a row taught the profile nothing. A row is counted under its first reason only. */
export type ProfileExclusionReason =
  | 'cancelled'
  | 'status_unknown'
  | 'missing_vehicle'
  | 'missing_start'
  | 'missing_end'
  | 'end_before_start'
  /** No length at all, or longer than `MAX_RIDE_MINUTES`: a mistyped end, which would smear one ride across days. */
  | 'implausible_duration'
  | 'ambiguous_local_time'
  | 'unpriced';

/** Twelve hours. A longer ride is a mistyped date, not a ride, and is not learnt from. */
export const MAX_RIDE_MINUTES = 720;

/** One weekday × one slot of the operating day, pooled over every historical occurrence. */
export interface DemandCell {
  readonly dayType: DayType;
  /** 0-based slot within the operating day. */
  readonly position: number;
  /** Revenue attributed to this cell, in (fractional) cents, summed over all occurrences. */
  readonly revenueCents: number;
  /** Vehicle-minutes on the road in this cell, summed over all occurrences. */
  readonly vehicleMinutes: number;
  /** Distinct historical operating days with any on-road time in this cell. */
  readonly activeDays: number;
  /** The most vehicles ever on the road at once in this cell: the planner never recommends more. */
  readonly maxVehicles: number;
  /** revenue / vehicle-hours, in cents; null when `activeDays < minEvidenceDays` or there is no on-road time. */
  readonly revenuePerHourCents: number | null;
}

/** Historical figures for one vehicle, averaged per history month. */
export interface VehicleHistory {
  readonly vehicle: string;
  readonly rides: number;
  readonly vehicleMinutesPerMonth: number;
  readonly revenueCentsPerMonth: number;
  /** null without on-road time. */
  readonly revenuePerHourCents: number | null;
}

export interface DemandProfile {
  readonly algorithmVersion: string;
  /** 'ok', or 'invalid_settings' (see problems) / 'no_history' (no ride could be learnt from). */
  readonly status: 'ok' | 'invalid_settings' | 'no_history';
  readonly problems: readonly SettingsProblem[];
  readonly settings: ProfileSettings;
  readonly historyMonths: readonly YearMonth[];
  /** Slots per operating day: 1440 / slotMinutes. */
  readonly positions: number;
  /** 7 × positions cells, ordered by dayType, then position. Empty unless status is 'ok'. */
  readonly cells: readonly DemandCell[];
  /** Every vehicle seen in the usable history, sorted. */
  readonly vehicles: readonly VehicleHistory[];
  readonly coverage: {
    readonly rows: number;
    /** Rides the profile learnt from. */
    readonly usedRides: number;
    readonly excluded: Readonly<Record<ProfileExclusionReason, number>>;
    /** Revenue of the usable rides, integer cents. */
    readonly usedRevenueCents: number;
    /** Priced revenue the profile could not place in time (missing vehicle or time, unknown status), integer cents. */
    readonly unplacedRevenueCents: number;
    /** Cancellation fees, integer cents: real revenue with no time on the road. */
    readonly cancelledRevenueCents: number;
  };
  /** Averages per history month, over the whole fleet. */
  readonly perMonth: {
    readonly rides: number;
    readonly vehicleMinutes: number;
    readonly revenueCents: number;
    /** null without on-road time. */
    readonly revenuePerHourCents: number | null;
  };
}

// ── The recommendation (what the month should look like) ────────────────────

export interface RecommendInput {
  readonly profile: DemandProfile;
  readonly target: YearMonth;
  /** The vehicles to plan, as identifiers the history uses. A vehicle with no history is planned like any other. */
  readonly vehicles: readonly string[];
  /** Local dates 'YYYY-MM-DD' that are public holidays in the target month. */
  readonly holidays: ReadonlySet<string>;
  readonly settings: PlanSettings;
}

/** A local wall-clock moment, for display: 'YYYY-MM-DD' and 'HH:MM'. */
export interface LocalMoment {
  readonly date: string;
  readonly time: string;
}

export interface RecommendedShift {
  /** Deterministic: `${vehicle}|${operatingDate}|${index}`. */
  readonly id: string;
  readonly vehicle: string;
  /** The operating day the shift belongs to, 'YYYY-MM-DD'. */
  readonly operatingDate: string;
  readonly dayType: DayType;
  readonly isHoliday: boolean;
  /** Half-open slot range within the operating day. */
  readonly startPosition: number;
  readonly endPosition: number;
  readonly start: LocalMoment;
  readonly end: LocalMoment;
  /** Wall-clock length. On the two DST nights a shift across 02:00–03:00 lasts an hour less or more than this. */
  readonly minutes: number;
  /** Expected revenue, integer cents: the history's rate × the shift's slots, within the vehicles the history ever put out at once. */
  readonly expectedRevenueCents: number;
  readonly expectedRevenuePerHourCents: number;
  /**
   * The fewest distinct historical operating days any of the shift's rated
   * slots was seen on: the expectation is only as good as its thinnest slot.
   */
  readonly evidenceDays: number;
  readonly confidence: Confidence;
}

export interface VehiclePlanSummary {
  readonly vehicle: string;
  readonly shifts: number;
  readonly minutes: number;
  readonly expectedRevenueCents: number;
  /** null without a shift. */
  readonly expectedRevenuePerHourCents: number | null;
  /** Operating days with two shifts or more. */
  readonly daysWithSecondShift: number;
}

export interface ShiftRecommendation {
  readonly algorithmVersion: string;
  /** 'ok', 'invalid_settings' (see problems), 'profile_unusable' (the profile is not 'ok'), 'invalid_target', 'no_vehicles'. */
  readonly status: 'ok' | 'invalid_settings' | 'profile_unusable' | 'invalid_target' | 'no_vehicles';
  readonly problems: readonly SettingsProblem[];
  readonly settings: PlanSettings;
  readonly target: YearMonth;
  /** By operating date, then vehicle, then start. */
  readonly shifts: readonly RecommendedShift[];
  /** One per planned vehicle, in the order given. */
  readonly perVehicle: readonly VehiclePlanSummary[];
  readonly totals: {
    readonly shifts: number;
    readonly minutes: number;
    readonly expectedRevenueCents: number;
    readonly expectedRevenuePerHourCents: number | null;
    readonly daysWithSecondShift: number;
    readonly vehiclesUsed: number;
  };
  /**
   * The history's on-road time in windows whose rate is below the threshold
   * (or that carry too little evidence to have one), averaged per history
   * month: the hours the recommendation leaves out.
   */
  readonly weakHistory: {
    readonly vehicleMinutesPerMonth: number;
    readonly revenueCentsPerMonth: number;
    readonly revenuePerHourCents: number | null;
  };
}
