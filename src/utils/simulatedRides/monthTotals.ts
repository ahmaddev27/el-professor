import type { FullMonthResult } from './fullMonth';
import { countRevenue, inExportScope, type RevenueBreakdown } from './revenue';
import type { SimulationTenantSettings } from './tenantSettings';
import type { SimRide } from './types';

/**
 * The totals of the Fahrtenbuch report: per day, per driver, per vehicle and
 * for the month, all over **one scope** (round 6: "all within the same report
 * scope"). The scope is the report's own rides — completed and cancelled.
 * A declined order is in none of these figures; its fee is counted apart,
 * for the internal operational report (`FullMonthResult.internal`).
 *
 * Each ride lands in exactly one row of each breakdown, and the month total is
 * taken from `result.revenue`, counted over the whole scope in one pass. The
 * breakdowns are therefore independent of the total, so "the parts sum to the
 * total" is a real check and not a restatement. Money is integer cents and
 * kilometres hundredths all the way.
 */

export const TOTAL_LABEL = 'Summe';

/** Everything one group of rides adds up to, in integer cents and hundredths of a km. */
export interface Totals {
  /** The group's identity: a driver's UUID, a plate, a day. */
  key: string;
  /** What a reader sees: the driver's name, the plate, the day. */
  label: string;
  rides: number;
  completed: number;
  cancelled: number;
  fareCents: number;
  tipCents: number;
  cancelledFeeCents: number;
  appFareCents: number;
  cashFareCents: number;
  kmHundredths: number;
}

export type DriverTotals = Totals;
export type VehicleTotals = Totals;

export function fromBreakdown(key: string, label: string, b: RevenueBreakdown): Totals {
  return {
    key,
    label,
    rides: b.counts.completed + b.counts.cancelled,
    completed: b.counts.completed,
    cancelled: b.counts.cancelled,
    fareCents: b.fareCents,
    tipCents: b.tipCents,
    cancelledFeeCents: b.cancelledFeeCents,
    appFareCents: b.appFareCents,
    cashFareCents: b.cashFareCents,
    kmHundredths: Math.round(b.km * 100),
  };
}

const ADDITIVE: ReadonlyArray<Exclude<keyof Totals, 'key' | 'label'>> = [
  'rides', 'completed', 'cancelled', 'fareCents', 'tipCents', 'cancelledFeeCents', 'appFareCents',
  'cashFareCents', 'kmHundredths',
];

/** One ride counted through the same function as the month, so the rules exist once. */
function groupTotals(
  rides: readonly SimRide[],
  settings: SimulationTenantSettings,
  keyOf: (ride: SimRide) => string,
  labelOf: (ride: SimRide) => string,
): Totals[] {
  const groups = new Map<string, Totals>();
  for (const ride of rides) {
    if (!inExportScope(ride)) continue;
    const key = keyOf(ride);
    const one = fromBreakdown(key, labelOf(ride), countRevenue([ride], settings));
    const acc = groups.get(key) ?? fromBreakdown(key, labelOf(ride), countRevenue([], settings));
    for (const field of ADDITIVE) acc[field] += one[field];
    groups.set(key, acc);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'de') || a.key.localeCompare(b.key));
}

/** Per driver, keyed by the driver's UUID: two drivers of one name are two rows. */
export function totalsByDriver(rides: readonly SimRide[], settings: SimulationTenantSettings): DriverTotals[] {
  return groupTotals(rides, settings, r => r.driver.id ?? `name:${r.driver.name}`, r => r.driver.name);
}

export function totalsByVehicle(rides: readonly SimRide[], settings: SimulationTenantSettings): VehicleTotals[] {
  return groupTotals(rides, settings, r => r.vehicle.plate, r => r.vehicle.plate);
}

/** The month total, from the report's whole scope in one pass, independent of every breakdown. */
export function monthTotals(result: FullMonthResult): Totals {
  return fromBreakdown(TOTAL_LABEL, TOTAL_LABEL, result.revenue);
}

export interface ReconciliationRow {
  /** What was added up, e.g. "Fahrpreise (Cent) je Tag". */
  label: string;
  partsSum: number;
  total: number;
}

interface Measure {
  name: string;
  of: (t: Totals) => number;
}

const MEASURES: readonly Measure[] = [
  { name: 'Fahrten', of: t => t.rides },
  { name: 'Fahrpreise (Cent)', of: t => t.fareCents },
  { name: 'Trinkgeld (Cent)', of: t => t.tipCents },
  { name: 'Stornogebuehren (Cent)', of: t => t.cancelledFeeCents },
  { name: 'Kilometer (Hundertstel)', of: t => t.kmHundredths },
];

function dayAsTotals(d: FullMonthResult['days'][number]): Totals {
  return {
    key: d.day, label: d.day, rides: d.rides, completed: d.completed, cancelled: d.cancelled,
    fareCents: d.fareCents, tipCents: d.tipCents, cancelledFeeCents: d.cancelledFeeCents,
    appFareCents: 0, cashFareCents: 0, kmHundredths: Math.round(d.km * 100),
  };
}

function reconcileGroup(dimension: string, parts: readonly Totals[], total: Totals): ReconciliationRow[] {
  return MEASURES.map(m => ({
    label: `${m.name} je ${dimension}`,
    partsSum: parts.reduce((n, p) => n + m.of(p), 0),
    total: m.of(total),
  }));
}

/** Every measure, summed per day, per driver and per vehicle, against the month total. */
export function reconcile(result: FullMonthResult): ReconciliationRow[] {
  const s = result.provenance.settings;
  const total = monthTotals(result);
  return [
    ...reconcileGroup('Tag', result.days.map(dayAsTotals), total),
    ...reconcileGroup('Fahrer', totalsByDriver(result.month.rides, s), total),
    ...reconcileGroup('Fahrzeug', totalsByVehicle(result.month.rides, s), total),
  ];
}
