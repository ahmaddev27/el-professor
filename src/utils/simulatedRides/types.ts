export interface GeoPoint {
  lat: number;
  lon: number;
}

/** A real address from the pool, formatted the way the Uber export writes it. */
export interface PoolAddress extends GeoPoint {
  label: string;
}

export interface SimVehicle {
  plate: string;
  type: string;
}

export interface SimDriver {
  name: string;
  /**
   * `drivers.id`, when the caller knew it.
   *
   * It was always **present at runtime** — `runShift` spreads its `owner` onto
   * every ride, and `generateFullMonth` passes a driver object that carries its
   * id — but the type did not say so, so every reader grouped rides by the
   * driver's **name**. Two drivers of one company with the same name therefore
   * merged into one row of a per-driver total, and the external audit's section
   * 5 is explicit that a driver is matched on the UUID and never on the name
   * alone. Declaring it is what lets a reader group by the id and fall back to
   * the name only when there is none.
   *
   * Optional, because `generateFromFigures` resolves its drivers out of the
   * company's income rows by name and genuinely has no id for some of them —
   * and `undefined` says that, where an empty string would not.
   */
  id?: string;
}

export interface GeneratorOptions {
  minShiftMinutes: number;
  maxShiftMinutes: number;
  /** Idle time between two shifts of one vehicle. */
  minVehicleGapMinutes: number;
  /** A driver starts no shift sooner than this after his last one ended. */
  minDriverRestMinutes: number;
  cancellationShare: number;
  tipShare: number;
  /** Share paid through the app; the rest is cash ("Bar"). */
  appPaymentShare: number;
  prebookedShare: number;
}

export interface SimShift {
  id: string;
  vehicle: SimVehicle;
  driver: SimDriver;
  /** The operating day (starts 04:00), YYYY-MM-DD. */
  operatingDay: string;
  startMs: number;
  /** The last ride's end: the shift's real end. */
  endMs: number;
}

/**
 * What became of an order.
 *
 * `declined` is the external audit's section 3 and it is **distinct from
 * `cancelled`**: a cancellation is an accepted ride that did not happen, a
 * decline is an order the driver turned down. The audit is explicit that the
 * two must not be conflated and that a cancellation earns no decline fee
 * unless company policy says so, which is why `chargeDeclinedFeeOnCancelled`
 * defaults to false and the sheet writes a third word.
 *
 * Every existing reader branches on `=== 'completed'`, so a declined ride is
 * already excluded from fares, tips, kilometres and the shift's own counts —
 * `figures.ts` zeroes the fare of any ride that is not completed. The fee is
 * therefore never inside a fare, and the two cannot double count.
 */
export type SimRideStatus = 'completed' | 'cancelled' | 'declined';

export interface SimRide {
  shiftId: string;
  vehicle: SimVehicle;
  driver: SimDriver;
  status: SimRideStatus;
  /**
   * The decline fee, in **integer cents**, and only for a declined ride.
   *
   * It is a field of its own, as section 3 requires ("خزّن الرسوم كحقل مستقل
   * عن أجرة الرحلات المكتملة"), and it is optional so that a ride built before
   * the feature existed carries **no fee** rather than a zero one — the two
   * are different statements, and no construction site had to change.
   */
  declinedFeeCents?: number;
  /**
   * The rule that made a declined order fee-eligible (`idle_in_shift`): the
   * audit asks that a decline record why it earns its fee, and a fee whose
   * rule is not on the row cannot be checked.
   */
  declineRule?: string;
  orderReceivedMs: number;
  orderTransmittedMs: number;
  plannedPickupMs: number | null;
  /** Null for a cancelled ride: it kept no clock times. */
  startMs: number | null;
  endMs: number | null;
  /** The vehicle's position when the order was transmitted. */
  vehiclePosition: GeoPoint;
  pickup: PoolAddress;
  dropoff: PoolAddress;
  fare: number;
  tip: number;
  km: number;
  payment: 'App' | 'Bar';
  prebooked: boolean;
}

export interface GeneratedMonth {
  shifts: SimShift[];
  rides: SimRide[];
  /** Shifts planned but dropped (no free driver, or a clock reading that is not unique). */
  droppedShifts: number;
}
