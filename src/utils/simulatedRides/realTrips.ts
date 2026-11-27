import { toCents } from '../money';
import { operatingDayIn } from './period';

/**
 * The month's real trips (FleetBook round 8, §4 and §12 classes 16 and 17).
 *
 * A trip imported from a real Fahrtenbuch is a record. The simulation reads it
 * and changes nothing about it: id, date, times, driver, vehicle, places, fare,
 * tip and status are carried as they were stored. The driver-day it falls on
 * is actual, and no simulated shift is placed on it. Nothing here bends a
 * fare, and no row is added: a trip the reader cannot attribute to a driver
 * stays a real trip, and the month says that it could not be attributed.
 *
 * A trip whose import is marked simulated is never read as real, whatever the
 * query returned.
 */

/** The columns the loader selects. Every one is read; none is written. */
export const REAL_TRIP_COLUMNS = [
  'id', 'import_id', 'trip_date', 'start_at', 'end_at', 'start_time', 'end_time',
  'original_driver_id', 'original_driver_name', 'car_identifier', 'route_start', 'route_end',
  'price_amount', 'tip_amount', 'cash_amount', 'online_amount', 'action_amount',
  'is_canceled', 'trip_status', 'declined_fee_cents', 'source_row_key', 'is_simulated',
].join(', ');

type Amount = number | string | null;

export interface RealTripRow {
  id: string;
  import_id: string;
  trip_date: string;
  start_at: string | null;
  end_at: string | null;
  start_time: string | null;
  end_time: string | null;
  original_driver_id: string | null;
  original_driver_name: string | null;
  car_identifier: string | null;
  route_start: string | null;
  route_end: string | null;
  price_amount: Amount;
  tip_amount: Amount;
  cash_amount: Amount;
  online_amount: Amount;
  action_amount: Amount;
  is_canceled: boolean | null;
  trip_status: string | null;
  /** Integer cents (`20261027170000`): the fee of a declined order, never a fare. */
  declined_fee_cents: number | null;
  source_row_key: string | null;
  is_simulated: boolean | null;
}

export interface RealTripDriverRef {
  id: string;
  name: string;
}

/**
 * How the trip's driver was named: by the stored driver id, by an exact name
 * when the id names nobody, or not at all (two drivers of that name, or none).
 */
export type RealTripIdentity = 'driver_id' | 'name_only' | 'ambiguous' | 'unresolved';

export interface RealTrip {
  /** Always: the row is a record, not a simulation. */
  label: 'IMPORTIERT';
  tripId: string;
  importId: string;
  /** The stored "Datum der Fahrt", unchanged. */
  tripDate: string;
  startMs: number | null;
  endMs: number | null;
  startTime: string | null;
  endTime: string | null;
  /** The operating day the trip belongs to, from its start instant, else from `trip_date`. */
  operatingDay: string;
  dayFrom: 'start_at' | 'trip_date';
  driverId: string | null;
  /** The stored name, unchanged. */
  driverName: string;
  identity: RealTripIdentity;
  plate: string | null;
  pickup: string | null;
  destination: string | null;
  /** Integer cents, exactly as stored; null when the stored value is not an amount. */
  fareCents: number | null;
  tipCents: number | null;
  cashCents: number | null;
  onlineCents: number | null;
  actionCents: number | null;
  /** The stored status, unchanged; `unknown` when the row names none. */
  status: string;
  canceled: boolean;
  /** The stored fee of a declined order, in cents; 0 when the row names none. */
  declinedFeeCents: number;
  sourceRowKey: string | null;
}

export interface RealTripsRead {
  /** The month's real trips, by operating day, start and id. */
  trips: RealTrip[];
  /** Operating days that hold a real trip, by driver UUID: never simulated over. */
  days: Map<string, Set<string>>;
  /** Trips whose driver could not be named: their day may be a real driver's day. */
  unattributed: RealTrip[];
  /** Trips with an amount that is not one: the trip is kept, the figure is not guessed. */
  unreadableAmounts: { tripId: string; column: string }[];
  /** Rows of a simulated import that reached the reader and were left out. */
  simulatedSkipped: number;
  /** Rows of the read window whose operating day is not in the month. */
  outsideMonth: number;
}

type AmountColumn = 'price_amount' | 'tip_amount' | 'cash_amount' | 'online_amount' | 'action_amount';

function cents(row: RealTripRow, column: AmountColumn, bad: RealTripsRead['unreadableAmounts']): number | null {
  const value = row[column];
  if (value === null || value === undefined) return 0;
  try {
    return toCents(value);
  } catch {
    bad.push({ tripId: row.id, column });
    return null;
  }
}

const instant = (text: string | null): number | null => {
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
};

/** The driver behind a trip: its stored id when that names a driver, otherwise one exact name. */
function resolverFor(drivers: readonly RealTripDriverRef[]) {
  const byId = new Map(drivers.map(d => [d.id, d]));
  const byName = new Map<string, RealTripDriverRef[]>();
  for (const d of drivers) {
    const name = String(d.name ?? '').trim();
    byName.set(name, [...(byName.get(name) ?? []), d]);
  }
  return (row: RealTripRow): { driverId: string | null; identity: RealTripIdentity } => {
    if (row.original_driver_id && byId.has(row.original_driver_id)) return { driverId: row.original_driver_id, identity: 'driver_id' };
    const named = byName.get((row.original_driver_name ?? '').trim()) ?? [];
    if (named.length === 1) return { driverId: named[0].id, identity: 'name_only' };
    return { driverId: null, identity: named.length > 1 ? 'ambiguous' : 'unresolved' };
  };
}

export function readRealTrips(args: {
  year: number;
  month: number;
  rows: readonly RealTripRow[];
  drivers: readonly RealTripDriverRef[];
  timeZone: string;
  operatingDayStartHour: number;
}): RealTripsRead {
  const prefix = `${args.year}-${String(args.month).padStart(2, '0')}-`;
  const resolve = resolverFor(args.drivers);
  const unreadableAmounts: RealTripsRead['unreadableAmounts'] = [];
  const trips: RealTrip[] = [];
  let simulatedSkipped = 0;
  let outsideMonth = 0;

  for (const row of args.rows) {
    if (row.is_simulated !== false) {
      // A simulated ride is not a record, and a row that does not say is not one either.
      simulatedSkipped += 1;
      continue;
    }
    const startMs = instant(row.start_at);
    const operatingDay = startMs !== null ? operatingDayIn(startMs, args.timeZone, args.operatingDayStartHour) : row.trip_date;
    if (!operatingDay.startsWith(prefix)) {
      outsideMonth += 1;
      continue;
    }
    const who = resolve(row);
    trips.push({
      label: 'IMPORTIERT',
      tripId: row.id,
      importId: row.import_id,
      tripDate: row.trip_date,
      startMs,
      endMs: instant(row.end_at),
      startTime: row.start_time,
      endTime: row.end_time,
      operatingDay,
      dayFrom: startMs !== null ? 'start_at' : 'trip_date',
      driverId: who.driverId,
      driverName: row.original_driver_name ?? '',
      identity: who.identity,
      plate: row.car_identifier,
      pickup: row.route_start,
      destination: row.route_end,
      fareCents: cents(row, 'price_amount', unreadableAmounts),
      tipCents: cents(row, 'tip_amount', unreadableAmounts),
      cashCents: cents(row, 'cash_amount', unreadableAmounts),
      onlineCents: cents(row, 'online_amount', unreadableAmounts),
      actionCents: cents(row, 'action_amount', unreadableAmounts),
      status: row.trip_status ?? 'unknown',
      canceled: row.is_canceled === true,
      declinedFeeCents: Number.isSafeInteger(row.declined_fee_cents) ? row.declined_fee_cents as number : 0,
      sourceRowKey: row.source_row_key,
    });
  }

  trips.sort((a, b) => a.operatingDay.localeCompare(b.operatingDay)
    || (a.startMs ?? Infinity) - (b.startMs ?? Infinity)
    || a.tripId.localeCompare(b.tripId));
  const days = new Map<string, Set<string>>();
  for (const t of trips) {
    if (t.driverId === null) continue;
    days.set(t.driverId, (days.get(t.driverId) ?? new Set()).add(t.operatingDay));
  }
  return {
    trips,
    days,
    unattributed: trips.filter(t => t.driverId === null),
    unreadableAmounts,
    simulatedSkipped,
    outsideMonth,
  };
}

/** A plate as two systems write it: case, spaces and hyphens do not distinguish one. */
export const plateKey = (plate: string): string => plate.toUpperCase().replace(/[\s-]+/g, '');

/** The minutes a real trip holds its vehicle, where both ends are known instants. */
export function realVehicleWindows(trips: readonly RealTrip[]): Map<string, { start: number; end: number; tripId: string }[]> {
  const out = new Map<string, { start: number; end: number; tripId: string }[]>();
  for (const t of trips) {
    if (!t.plate || t.startMs === null || t.endMs === null || t.endMs <= t.startMs) continue;
    const key = plateKey(t.plate);
    out.set(key, [...(out.get(key) ?? []), { start: t.startMs, end: t.endMs, tripId: t.tripId }]);
  }
  return out;
}

/** The month's real trips were read and there were none: not the same as never having looked. */
export function noRealTrips(): RealTripsRead {
  return { trips: [], days: new Map(), unattributed: [], unreadableAmounts: [], simulatedSkipped: 0, outsideMonth: 0 };
}
