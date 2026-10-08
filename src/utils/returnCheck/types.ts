/**
 * Rückkehrpflicht and address checks — the public contract.
 *
 * ## What this is
 *
 * It reads the rides a company has already imported and reports, ride by ride,
 * what the Fahrtenbuch itself shows about two things:
 *
 *   1. **Where each order reached the vehicle.** A Mietwagen returns to its
 *      Betriebssitz after a ride unless the next order reached it before or
 *      during that ride (§49 Abs. 4 PBefG). The Uber export carries, per ride,
 *      the moment the order was transmitted (`Uhrzeit der Auftragsuebermittlung`)
 *      and where the vehicle was then (`Standort des Fahrzeugs bei
 *      Auftragsuebermittlung`). So for each ride this says whether the order
 *      arrived during the previous ride, at the Betriebssitz, or somewhere else
 *      after the previous ride had ended.
 *   2. **Rides whose own data does not add up**: the same address twice, the
 *      same street with another house number, a speed no car drives, no
 *      kilometres at all, a position that is not a position, an order
 *      transmitted after the ride had already begun.
 *
 * ## What this is not
 *
 * **It is a list to review, never a verdict.** An order that reached the
 * vehicle away from the Betriebssitz after a ride had ended is lawful while the
 * vehicle is on its way back, and the export holds no position at the moment a
 * ride ended — so "away from the base" says only that the file does not show
 * the return, not that there was none. Distances are straight lines between
 * two coordinates, never road kilometres. Nothing here changes, moves, re-times
 * or reassigns a ride, and nothing here is written anywhere: the screen shows
 * the findings so the operator can act on the operation, not on the record.
 *
 * Pure TypeScript: no database, no UI, no clock, no randomness.
 */
import type { TripStatus } from '../tripAnalysis/types';

/** Stored with every result; bump it whenever a rule below changes meaning. */
export const RETURN_CHECK_ALGORITHM_VERSION = 'return-check/1.0.0';

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** An Uber address split into what the checks compare. Every part may be missing. */
export interface ParsedAddress {
  /** As in the file. */
  readonly raw: string;
  /** Lower case, ß → ss, "straße"/"strasse"/"str." → "str", whitespace collapsed, country dropped: what "the same address" compares. */
  readonly normalized: string;
  /** Normalised street without its number, or null when the address names no street with a number. */
  readonly street: string | null;
  /** Normalised house number ("12a", "12-14"), or null. */
  readonly houseNumber: string | null;
  /** Five digits, or null. */
  readonly postalCode: string | null;
  /** Normalised city, or null. */
  readonly city: string | null;
}

/** Why a ride's position at the order cannot be used. */
export type PositionProblem = 'missing' | 'unparsed' | 'outside_germany';

/** Why a ride's order time cannot be used. */
export type OrderTimeProblem = 'missing' | 'unparsed';

/** One imported ride, as the checks read it. */
export interface CheckRide {
  readonly id: string;
  readonly vehicle: string | null;
  readonly driverName: string | null;
  readonly status: TripStatus;
  readonly startMs: number | null;
  readonly endMs: number | null;
  /** `Uhrzeit der Auftragsuebermittlung`, read as local wall time. */
  readonly orderMs: number | null;
  readonly orderProblem: OrderTimeProblem | null;
  /** `Standort des Fahrzeugs bei Auftragsuebermittlung`, "lat lon". */
  readonly position: LatLon | null;
  readonly positionProblem: PositionProblem | null;
  /** `Kilometer`, or null when missing or unreadable. */
  readonly km: number | null;
  /** `Vorreservierte Fahrt`: true for "Ja", false for "Nein", null otherwise. */
  readonly prebooked: boolean | null;
  readonly pickup: ParsedAddress | null;
  readonly dropoff: ParsedAddress | null;
  readonly sourceRow: number | null;
}

export interface ReturnCheckSettings {
  /** The Betriebssitz. Without it no order can be placed at or away from it, and those rides are unverifiable. */
  readonly base: LatLon | null;
  /** A position this close to the base (straight line) counts as at the base. Finite, > 0. */
  readonly baseRadiusKm: number;
  /** A ride starting more than this after the vehicle's previous ride ended opens a new block. Finite, ≥ 0. */
  readonly blockGapMinutes: number;
  /** An average speed above this is implausible. Finite, > 0. */
  readonly maxSpeedKmh: number;
}

/**
 * How one ride's order reached its vehicle.
 *
 *   - during_previous     transmitted before the vehicle's previous ride ended: a
 *                         follow-up order, which the Rückkehrpflicht allows.
 *   - at_base             transmitted after the previous ride ended, with the
 *                         vehicle within the radius of the Betriebssitz.
 *   - away_from_base      transmitted after the previous ride ended, with the
 *                         vehicle outside the radius. **To review**: lawful on
 *                         the way back, not lawful while waiting elsewhere, and
 *                         the file cannot tell the two apart.
 *   - block_start_at_base the first ride of a block (or of the vehicle in the
 *                         data), ordered at the Betriebssitz.
 *   - block_start_away    the first ride of a block, ordered away from it: the
 *                         vehicle began work elsewhere. To review.
 *   - unverifiable        a time or position needed above is missing, or the ride
 *                         itself has no vehicle or no usable start and end
 *                         (`no_ride_times`); `reason` says which.
 */
export type OrderPlacement =
  | 'during_previous'
  | 'at_base'
  | 'away_from_base'
  | 'block_start_at_base'
  | 'block_start_away'
  | 'unverifiable';

export type UnverifiableReason = 'no_order_time' | 'no_position' | 'no_base' | 'no_ride_times';

export interface OrderCheck {
  readonly rideId: string;
  readonly vehicle: string;
  /** The vehicle's previous completed ride, or null for its first. */
  readonly previousRideId: string | null;
  readonly placement: OrderPlacement;
  readonly reason: UnverifiableReason | null;
  /** Order time − previous ride's end, in minutes; negative when the order came during it; null without both. */
  readonly waitMinutes: number | null;
  /** Straight line from the position at the order to the base, km; null without both. */
  readonly distanceKm: number | null;
  readonly prebooked: boolean | null;
  /** The previous ride's destination and this pickup share a postal code: the vehicle may have stayed where it was left. Null without both codes. */
  readonly samePostalCodeAsPreviousDestination: boolean | null;
  readonly orderMs: number | null;
  readonly previousEndMs: number | null;
}

/**
 *   - same_address       pickup and destination are the same address.
 *   - same_street        same street and postal code, another house number.
 *   - implausible_speed  km / duration above `maxSpeedKmh`. values: km, minutes, speedKmh
 *   - zero_distance      0 km for a completed ride of at least three minutes. values: minutes
 *   - position_invalid   a position that is missing, unreadable or outside Germany. values: problem
 *   - order_after_start  the order was transmitted more than a minute after the ride began. values: minutes
 */
export type AnomalyType =
  | 'same_address'
  | 'same_street'
  | 'implausible_speed'
  | 'zero_distance'
  | 'position_invalid'
  | 'order_after_start';

export interface RideAnomaly {
  readonly rideId: string;
  readonly type: AnomalyType;
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
}

/** The densest place the vehicles were when a block began: a proposal for the Betriebssitz, never a fact. */
export interface BaseSuggestion {
  readonly position: LatLon;
  /** Block starts within about a kilometre of it. */
  readonly blockStarts: number;
  /** Of all block starts with a usable position. */
  readonly ofBlockStarts: number;
}

export interface ReturnCheckResult {
  readonly algorithmVersion: string;
  readonly settings: ReturnCheckSettings;
  /** 'invalid_settings' when a setting is out of range; nothing is checked then. */
  readonly status: 'ok' | 'invalid_settings';
  readonly rides: number;
  /** Completed rides: the population the order checks run over, the unverifiable ones included. */
  readonly checkedRides: number;
  /** One per completed ride: by vehicle, then start; rides that cannot be sequenced (`no_ride_times`) last. */
  readonly orders: readonly OrderCheck[];
  /** By ride (input order), then type. */
  readonly anomalies: readonly RideAnomaly[];
  readonly counts: {
    readonly byPlacement: Readonly<Record<OrderPlacement, number>>;
    readonly byAnomaly: Readonly<Record<AnomalyType, number>>;
  };
}
