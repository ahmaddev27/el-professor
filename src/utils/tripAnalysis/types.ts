/**
 * Trip analysis engine — the public API (slice B of the Fahrtenbuch analysis).
 *
 * The engine READS AND REPORTS. It takes the trips of a period as they
 * happened, groups them into analytical blocks, measures them, and lists
 * findings. It never returns a reassignment, a new driver for a trip, a
 * shifted time or a cut trip, it has no function that "fixes" an overlap or
 * distributes surplus hours, and it never changes a price or a currency: every
 * output trip is the very input object it was given.
 *
 * Pure TypeScript: no database, no UI, no clock (no Date.now()), no randomness,
 * so the same input always yields the same result.
 *
 * Naming: the two row-shaped inputs (AnalysisTrip, AnalysisShift) keep column
 * style snake_case, matching `start_at`/`end_at` beside them in the database;
 * settings, budgets and everything the engine computes are camelCase.
 *
 * Times are absolute epoch milliseconds. Intervals are half-open [start, end):
 * a trip ending at 10:00 and another starting at 10:00 do not overlap.
 *
 * Entry points (import from 'src/utils/tripAnalysis'):
 *   analyzeTrips(input: TripAnalysisInput): TripAnalysisResult
 *   computeBudget(input: BudgetInput): BudgetResult
 *   analysisTripFromRow(row: TripRowForAnalysis): AnalysisTrip
 *   noRoutingEstimator: TravelTimeEstimator          (the default)
 *   listTravelRequests(input: TripAnalysisInput): TravelEstimateRequest[]
 */

/** Stored with every result; bump it whenever a rule below changes meaning. */
export const TRIP_ANALYSIS_ALGORITHM_VERSION = 'trip-analysis/1.0.0';

// ── Inputs ────────────────────────────────────────────────────────────────────

/**
 * How a trip counts:
 *  - completed  → analysed: blocks, time metrics, overlap, travel and shift checks.
 *  - cancelled  → kept and counted, never in time metrics (a cancelled Uber row
 *                 carries no start or end), never a review item by itself.
 *  - unknown    → kept, never in time metrics, always a review item: its
 *                 contribution cannot be judged until the status is resolved.
 */
export type TripStatus = 'completed' | 'cancelled' | 'unknown';

/**
 * Where start_ms / end_ms came from. It sets the confidence of every finding
 * the trip takes part in.
 *  - absolute            timestamptz columns with an explicit offset (high)
 *  - raw_local_datetime  full local date-times out of raw_data_json, read in the
 *                        runtime's zone, which is Europe/Berlin (high)
 *  - trip_date_hhmm      trip_date + HH:MM, no seconds, overnight inferred (medium)
 * Omitted means 'absolute'.
 */
export type TripTimeSource = 'absolute' | 'raw_local_datetime' | 'trip_date_hhmm';

/**
 * A local wall-clock time the DST switch makes ambiguous (it occurs twice on
 * the last Sunday of October) or nonexistent (it never occurs on the last
 * Sunday of March). Such a trip is kept and sent to review, never resolved
 * silently. Only the legacy-row adapter can detect it; absolute timestamps
 * cannot be ambiguous.
 */
export type LocalTimeAmbiguity = 'dst_ambiguous' | 'dst_nonexistent';

export interface AnalysisTrip {
  /** Stable internal id; must be unique within one analysis. */
  readonly id: string;
  /** The driver who actually drove (`original_driver_id`). Null → review. */
  readonly driver_id: string | null;
  readonly driver_name: string | null;
  /** Plate or vehicle identifier as in the source. Null → review. */
  readonly vehicle: string | null;
  /** Absolute start, or null when the source has none. */
  readonly start_ms: number | null;
  /** Absolute end, or null. A trip without an end is kept and flagged; it never takes part in an overlap "pass". */
  readonly end_ms: number | null;
  readonly status: TripStatus;
  /** Passed through untouched: never read for time, never rounded in place. */
  readonly price: number | string | null;
  /** Passed through untouched. */
  readonly currency: string | null;
  /** Row number in the source file, for tracing a finding back to the sheet. */
  readonly source_row: number | null;
  /** Pickup address; the travel check needs both addresses. */
  readonly pickup_address?: string | null;
  /** Drop-off address. */
  readonly dropoff_address?: string | null;
  readonly time_source?: TripTimeSource;
  readonly time_ambiguity?: LocalTimeAmbiguity | null;
}

/** One recorded working period (Stundennachweis row or similar). */
export interface AnalysisShift {
  /** Stable id, unique within one analysis; findings cite it. */
  readonly id: string;
  readonly driver_id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  /** Where the period was recorded, e.g. 'saved_stundennachweis'. Reported, never interpreted. */
  readonly source: string;
}

/**
 * Per-company settings (`trip_analysis_settings`, slice C). There is no
 * product default: the owner has not chosen one, so the caller always passes
 * both values. The tests use 30 as a trial value only.
 */
export interface TripAnalysisSettings {
  /** A gap GREATER than this starts a new block; an equal gap stays. Finite, ≥ 0. */
  readonly blockGapMinutes: number;
  /** Operational buffer added to an estimated travel time. Finite, ≥ 0. */
  readonly travelMarginMinutes: number;
}

/**
 * The budget inputs of one driver and month. Each may be missing: a missing
 * or invalid value makes the budget "not computable" and never blocks the
 * analysis. Amounts may arrive as numbers or as the decimal strings a numeric
 * column returns; they are computed exactly, never through a float division.
 */
export interface BudgetInput {
  /** `drivers.planning_min_salary`, monthly. */
  readonly salaryMin?: number | string | null;
  /** `drivers.planning_max_salary`, monthly. */
  readonly salaryMax?: number | string | null;
  /** `drivers.planning_hourly_rate`, same financial basis as the salaries. */
  readonly hourlyRate?: number | string | null;
  /** Hours held back for manual Stundennachweis additions. Missing = "not set", never 0. */
  readonly reservedHours?: number | string | null;
}

export interface TripAnalysisInput {
  readonly trips: readonly AnalysisTrip[];
  /** Recorded working periods. A driver with none gets "no shift records", and the outside-shift metric is null for them. */
  readonly shifts?: readonly AnalysisShift[];
  readonly settings: TripAnalysisSettings;
  /** Budget inputs by driver id. A driver without an entry has no budget result. */
  readonly budgets?: Readonly<Record<string, BudgetInput>>;
  /** Defaults to `noRoutingEstimator`: every travel check is 'unverifiable'. */
  readonly travelEstimator?: TravelTimeEstimator;
}

// ── Travel time estimation (injected) ─────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

/** What the engine asks for: the move from one trip's drop-off to the next trip's pickup. */
export interface TravelEstimateRequest {
  readonly fromTripId: string;
  readonly toTripId: string;
  /** Drop-off of the earlier trip; always non-empty (a missing address is 'unverifiable' without asking). */
  readonly fromAddress: string;
  /** Pickup of the later trip; always non-empty. */
  readonly toAddress: string;
  /** End of the earlier trip. A routing service's traffic of today is no proof of a move in the past. */
  readonly departureMs: number;
}

export type TravelEstimate =
  | {
      readonly kind: 'estimated';
      /** Estimated driving time in minutes, ≥ 0. */
      readonly minutes: number;
      /** Which service or table produced it, e.g. 'osrm@2026-10'. */
      readonly source: string;
      readonly confidence: Confidence;
      /** When the estimate was computed (ISO 8601), if the estimator knows. */
      readonly computedAt?: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly source: string;
      /** Machine-readable reason, e.g. 'no_routing_service', 'service_error'. */
      readonly reason: string;
    };

/**
 * Synchronous on purpose: the engine stays deterministic and testable. A
 * routing service (release 2) prefetches the pairs `listTravelRequests()`
 * names and hands the engine a lookup over its answers.
 */
export interface TravelTimeEstimator {
  readonly source: string;
  estimate(request: TravelEstimateRequest): TravelEstimate;
}

// ── Findings ──────────────────────────────────────────────────────────────────

/** 'passed' = checked and fine, 'conflict' = checked and not fine, 'unverifiable' = could not be checked. */
export type IssueStatus = 'passed' | 'conflict' | 'unverifiable';

export type IssueSeverity = 'error' | 'warning' | 'info';

/**
 * Every finding the engine can produce, and the keys of its `values`
 * (minutes are exact, not rounded; ms values are epoch milliseconds).
 *
 * Overlaps (half-open intervals, all pairs, across blocks and vehicles):
 *  - driver_overlap    one driver in two trips at once.
 *                      values: overlapMinutes, overlapStartMs, overlapEndMs,
 *                      vehicleA, vehicleB, identicalInterval
 *  - vehicle_overlap   one vehicle driven by two drivers at once. Pairs of the
 *                      same driver are driver_overlap, never repeated here; a
 *                      pair with an unknown driver is 'unverifiable'.
 *                      values: overlapMinutes, overlapStartMs, overlapEndMs, driverA, driverB
 * Travel (consecutive trips of one driver; "previous" is the trip that reached
 * the running maximum end, the same end the block gap is measured from):
 *  - travel_gap        values: availableMinutes, marginMinutes, estimateMinutes,
 *                      requiredMinutes, shortByMinutes, estimateSource,
 *                      estimateConfidence, estimateComputedAt, reason,
 *                      belowMargin, vehicleChange
 * Shifts:
 *  - activity_outside_shift  the part of a trip no recorded shift covers.
 *                      values: outsideMinutes, tripMinutes
 *  - shift_without_activity  a shift no analysed trip touches.
 *                      values: shiftMinutes, source
 *  - shift_overlap     two shift records of one driver overlap. values: overlapMinutes
 *  - shift_invalid     a shift whose end is not after its start. values: startMs, endMs
 *  - no_shift_records  a driver with trips but no shift at all. values: tripCount
 * Row quality (review list; the row is always kept):
 *  - missing_driver, missing_vehicle, missing_start, missing_end,
 *    end_before_start (values: startMs, endMs), status_unknown,
 *    ambiguous_local_time (values: ambiguity)
 *  - driver_name_mismatch  one driver id under several names. values: names
 * Budget (per driver; nothing is ever moved or cut):
 *  - activity_over_budget  values: activityMinutes, maxMinutes, overByMinutes
 *  - shifts_over_budget    values: shiftMinutes, maxMinutes, overByMinutes
 *  - budget_not_computable values: problems (comma-separated BudgetProblem), rangeComputable
 *  - cap_below_hours_min   values: capHours, hoursMin
 */
export type IssueType =
  | 'driver_overlap'
  | 'vehicle_overlap'
  | 'travel_gap'
  | 'activity_outside_shift'
  | 'shift_without_activity'
  | 'shift_overlap'
  | 'shift_invalid'
  | 'no_shift_records'
  | 'missing_driver'
  | 'missing_vehicle'
  | 'missing_start'
  | 'missing_end'
  | 'end_before_start'
  | 'status_unknown'
  | 'ambiguous_local_time'
  | 'driver_name_mismatch'
  | 'activity_over_budget'
  | 'shifts_over_budget'
  | 'budget_not_computable'
  | 'cap_below_hours_min';

export type IssueValue = string | number | boolean | null;

export interface Issue {
  /** Deterministic: the type plus the evidence ids, e.g. 'driver_overlap:t1+t2'. */
  readonly id: string;
  readonly type: IssueType;
  readonly severity: IssueSeverity;
  readonly status: IssueStatus;
  readonly driverId?: string;
  readonly vehicle?: string;
  /** The trips that produced the finding (the evidence), sorted. May be empty for driver-level findings. */
  readonly tripIds: readonly string[];
  /** The shifts that produced the finding, sorted, when shifts are evidence. */
  readonly shiftIds?: readonly string[];
  /** The values used, keyed as documented on IssueType. */
  readonly values: Readonly<Record<string, IssueValue>>;
  /** German, the product's source language; a screen may render its own text from type + values. */
  readonly explanation: string;
  readonly confidence: Confidence;
}

// ── Budget ────────────────────────────────────────────────────────────────────

export type BudgetProblem =
  | 'salary_min_missing'
  | 'salary_min_invalid'
  | 'salary_min_negative'
  | 'salary_max_missing'
  | 'salary_max_invalid'
  | 'salary_max_negative'
  | 'salary_min_above_max'
  | 'hourly_rate_missing'
  | 'hourly_rate_invalid'
  | 'hourly_rate_not_positive'
  | 'reserve_not_set'
  | 'reserve_invalid'
  | 'reserve_negative'
  | 'reserve_above_hours_max';

/**
 *   hoursMin = salaryMin / hourlyRate
 *   hoursMax = salaryMax / hourlyRate
 *   cap      = hoursMax − reservedHours          (automatic_plan_cap)
 *
 * Hours keep full precision (1000 / 13.9 = 71.942446…). Minutes are floored,
 * never rounded up past the budget: 71.942446… h → 4316 min.
 */
export interface BudgetResult {
  /** 'ok' only when both the range and the cap are computable. */
  readonly status: 'ok' | 'not_computable';
  /** Needs 0 ≤ salaryMin ≤ salaryMax and hourlyRate > 0. */
  readonly rangeStatus: 'ok' | 'not_computable';
  /** Needs the range and 0 ≤ reservedHours ≤ hoursMax. */
  readonly capStatus: 'ok' | 'not_computable';
  readonly problems: readonly BudgetProblem[];
  readonly hoursMin: number | null;
  readonly hoursMax: number | null;
  /** floor(hoursMax × 60): the conservative whole-minute ceiling. */
  readonly hoursMaxMinutes: number | null;
  /** The reserve as given, or null when not set or invalid. */
  readonly reservedHours: number | null;
  readonly capHours: number | null;
  /** floor(capHours × 60). */
  readonly capMinutes: number | null;
  /** True when the reserve pushes the cap below hoursMin: reaching the minimum then depends on other planned activity. */
  readonly capBelowHoursMin: boolean | null;
}

/**
 * Past activity against the budget. The reserve is NOT deducted from past
 * activity; the basis is hoursMax. Over budget is a warning to review: no trip
 * is cut, moved or reassigned.
 */
export interface BudgetComparison {
  /** hoursMax × 60, exact. */
  readonly maxMinutes: number;
  /** hoursMin × 60, exact. */
  readonly minMinutes: number;
  /** Union of the driver's analysed trips, in minutes. */
  readonly activityMinutes: number;
  /** Union of the driver's valid shifts, in minutes, or null without shift records. */
  readonly shiftMinutes: number | null;
  /** activityMinutes − maxMinutes: positive = over budget, negative = remaining capacity. */
  readonly activityVsMaxMinutes: number;
  readonly shiftVsMaxMinutes: number | null;
}

// ── Results ───────────────────────────────────────────────────────────────────

/**
 * Time metrics, all in milliseconds, never labelled "working hours":
 *  - durationSumMs   Σ (end − start); counts overlapping trips twice
 *  - unionMs         length of the union of the trip intervals (no double counting)
 *  - spanMs          block: last end − first start, gaps included;
 *                    driver: the sum of its blocks' spans
 *  - outsideShiftMs  the part of the union no shift covers; null without shift records
 */
export interface TimeMetrics {
  readonly durationSumMs: number;
  readonly unionMs: number;
  readonly spanMs: number;
  readonly outsideShiftMs: number | null;
}

export interface PriceTotal {
  readonly currency: string | null;
  readonly status: TripStatus;
  /** Exact integer cents, summed without floats. */
  readonly totalCents: number;
  readonly tripCount: number;
}

/** Derived sums for display. The trips' own prices are never changed. */
export interface PriceSummary {
  /** Sorted by currency, then status. */
  readonly totals: readonly PriceTotal[];
  /** Trips whose price is null or not a decimal amount, sorted. */
  readonly unpricedTripIds: readonly string[];
}

/** Why a new block started: the driver's first, a gap greater than the setting, or another vehicle. */
export type BlockStartReason = 'first' | 'gap' | 'vehicle_change';

/**
 * An analytical group of close trips of one driver on one vehicle. Not a
 * record of working time, and no licence to reassign anything in it.
 */
export interface TripBlock {
  /** Deterministic: `${driverId}#${index}`. */
  readonly id: string;
  readonly driverId: string;
  /** 0-based within the driver, in time order. */
  readonly index: number;
  readonly vehicle: string | null;
  readonly startReason: BlockStartReason;
  /** Start of this block − the previous block's running maximum end; null for the first. Negative = overlap across the split. */
  readonly gapBeforeMs: number | null;
  /** Sorted by start, then id. */
  readonly tripIds: readonly string[];
  readonly startMs: number;
  /** The running maximum end, not the last trip's end. */
  readonly endMs: number;
  readonly metrics: TimeMetrics;
  readonly prices: PriceSummary;
  /** Every finding that cites one of the block's trips. */
  readonly issueIds: readonly string[];
}

/** Why a row is outside the blocks and time metrics. Empty = analysed. */
export type TripExclusionReason =
  | 'cancelled'
  | 'status_unknown'
  | 'missing_driver'
  | 'missing_start'
  | 'missing_end'
  | 'end_before_start'
  | 'ambiguous_local_time';

/** One per input row, in input order: no row is ever dropped. */
export interface AnalyzedTrip {
  /** The input object itself, untouched: same driver, times, price and currency. */
  readonly trip: AnalysisTrip;
  readonly blockId: string | null;
  readonly excludedBecause: readonly TripExclusionReason[];
  /** The part of this trip no shift covers; null when not analysed or no shift records. */
  readonly outsideShiftMs: number | null;
  readonly issueIds: readonly string[];
}

export interface DriverAnalysis {
  readonly driverId: string;
  /** Every spelling seen for this id, sorted. More than one → driver_name_mismatch. */
  readonly driverNames: readonly string[];
  /** Every row carrying this driver id, any status, sorted. */
  readonly tripIds: readonly string[];
  readonly statusCounts: Readonly<Record<TripStatus, number>>;
  /** The rows in blocks and time metrics, sorted by start, then id. */
  readonly analysedTripIds: readonly string[];
  readonly blockIds: readonly string[];
  readonly metrics: TimeMetrics;
  /** Every shift with this driver id, valid or not, sorted. */
  readonly shiftIds: readonly string[];
  /** Union of the valid shifts; null when there are none. */
  readonly shiftUnionMs: number | null;
  readonly shiftsWithoutActivityIds: readonly string[];
  readonly prices: PriceSummary;
  /** Null when no budget input was given for this driver. */
  readonly budget: BudgetResult | null;
  /** Null unless the budget range is computable. */
  readonly budgetComparison: BudgetComparison | null;
  readonly issueIds: readonly string[];
}

export interface CheckTally {
  readonly passed: number;
  readonly conflict: number;
  readonly unverifiable: number;
}

/**
 * How complete each check is, for the dashboard's completion figure. Units:
 *  - driverOverlap   non-cancelled rows with a driver: analysed rows pass or
 *                    conflict, rows missing a usable interval are unverifiable
 *  - vehicleOverlap  analysed rows: rows with a vehicle pass or conflict (a
 *                    pair with an unknown driver is unverifiable), rows without
 *                    a vehicle are unverifiable
 *  - travelGap       consecutive pairs of analysed trips of one driver
 *  - shiftCoverage   analysed rows: fully covered pass, partly outside conflict,
 *                    driver without shift records unverifiable
 *  - budget          drivers: within hoursMax pass, over conflict, budget
 *                    missing or not computable unverifiable
 */
export interface CheckTallies {
  readonly driverOverlap: CheckTally;
  readonly vehicleOverlap: CheckTally;
  readonly travelGap: CheckTally;
  readonly shiftCoverage: CheckTally;
  readonly budget: CheckTally;
}

export interface TripCounts {
  /** Every input row. */
  readonly rows: number;
  readonly byStatus: Readonly<Record<TripStatus, number>>;
  /** Rows in blocks and time metrics. */
  readonly analysed: number;
  /** Rows on the review list. */
  readonly needsReview: number;
}

export interface TripAnalysisResult {
  readonly algorithmVersion: string;
  /** The settings the result was computed with, copied. */
  readonly settings: TripAnalysisSettings;
  readonly travelEstimatorSource: string;
  readonly counts: TripCounts;
  /** One per input row, input order. */
  readonly trips: readonly AnalyzedTrip[];
  /** By driver id, then index. */
  readonly blocks: readonly TripBlock[];
  /** Drivers seen in trips, shifts or budgets, by id. */
  readonly drivers: readonly DriverAnalysis[];
  /** Deterministic order: by type, then id. */
  readonly issues: readonly Issue[];
  /** Non-cancelled rows with a row-quality finding, input order. Never removed from counts or reports. */
  readonly reviewTripIds: readonly string[];
  readonly checks: CheckTallies;
}

// ── Legacy row adapter ────────────────────────────────────────────────────────

/**
 * The fields of a `fahrtenbuch_trips` row the adapter reads. Rows written
 * before slice A lack start_at / end_at / currency / trip_status; the adapter
 * then derives times through resolveActualRideWindow.
 */
export interface TripRowForAnalysis {
  readonly id: string;
  readonly trip_date: string | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly original_driver_id: string | null;
  readonly original_driver_name: string | null;
  readonly car_identifier: string | null;
  readonly route_start: string | null;
  readonly route_end: string | null;
  readonly price_amount: number | string | null;
  readonly is_canceled: boolean;
  readonly source_status?: string | null;
  readonly source_row_index: number | null;
  readonly raw_data_json: Readonly<Record<string, unknown>> | null;
  /** timestamptz from slice A (migration 20260922100000). */
  readonly start_at?: string | null;
  readonly end_at?: string | null;
  readonly currency?: string | null;
  /** Slice A's explicit status, if it stores one under this name. */
  readonly trip_status?: TripStatus | null;
}
