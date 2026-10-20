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
}

export interface GeneratorOptions {
  /** Hard ceiling per vehicle and operating day. Never above 3. */
  maxShiftsPerVehicleDay: number;
  /** Share of vehicle-days with 1, 2 and 3 shifts. */
  shiftCountWeights: readonly [number, number, number];
  minShiftMinutes: number;
  maxShiftMinutes: number;
  /** Idle time between two shifts of one vehicle. */
  minVehicleGapMinutes: number;
  /** A driver starts no shift sooner than this after his last one ended. */
  minDriverRestMinutes: number;
  /** Share of vehicle-days that run at all. */
  activeDayShare: number;
  cancellationShare: number;
  tipShare: number;
  /** Share paid through the app; the rest is cash ("Bar"). */
  appPaymentShare: number;
  prebookedShare: number;
}

export interface GeneratorInput {
  year: number;
  /** 1 = January. */
  month: number;
  base: GeoPoint;
  pool: readonly PoolAddress[];
  vehicles: readonly SimVehicle[];
  drivers: readonly SimDriver[];
  seed: number;
  options?: Partial<GeneratorOptions>;
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

export interface SimRide {
  shiftId: string;
  vehicle: SimVehicle;
  driver: SimDriver;
  status: 'completed' | 'cancelled';
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
