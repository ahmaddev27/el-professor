import * as XLSX from 'xlsx';
import { formatCentsDe } from '../money';
import type { FullMonthResult } from './fullMonth';
import { addSimulatedNotice, SIMULATED_NOTICE, simulatedFileName } from './marker';
import { operatingDayIn } from './period';
import { countRevenue, declineFeeOf, type RevenueBreakdown } from './revenue';
import type { SimulationTenantSettings } from './tenantSettings';
import { formatStamp } from './time';
import type { SimRide } from './types';

/**
 * The seven sheets of the external audit's section 8, as one .xlsx file.
 *
 * Every sheet is built by a pure function returning rows, and the XLSX
 * assembly at the bottom is thin, so a test reads the data without parsing a
 * binary and a second test reads the real bytes back.
 *
 * ## No double counting
 *
 * Each ride lands in exactly one row of each breakdown (its day, its driver,
 * its vehicle), and the month total is taken from `result.revenue`, which is
 * counted over the whole ride list in one pass. The breakdowns are therefore
 * independent of the total, so "the parts sum to the total" is a real check
 * and not a restatement. Sheet F prints that check for every measure.
 *
 * Money is integer cents all the way; euros appear only in the cells, where
 * `cents / 100` is exact to two decimals. Kilometres are summed in hundredths,
 * because adding the sheet's two-decimal floats would drift.
 */

export type Cell = string | number;
export type Row = Cell[];

export interface MonthWorkbookFile {
  fileName: string;
  bytes: Uint8Array;
}

export const SHEET_RIDES = 'A Fahrten';
export const SHEET_DAYS = 'B Monatsuebersicht';
export const SHEET_DRIVERS = 'C Summe je Fahrer';
export const SHEET_VEHICLES = 'D Summe je Fahrzeug';
export const SHEET_DECLINED = 'E Abgelehnt und storniert';
export const SHEET_CHECKS = 'F Pruefung und Grenzen';
export const SHEET_SOURCE = 'G Quelle und Einstellungen';

export const SHEET_ORDER: readonly string[] = [
  SHEET_RIDES, SHEET_DAYS, SHEET_DRIVERS, SHEET_VEHICLES, SHEET_DECLINED, SHEET_CHECKS, SHEET_SOURCE,
];

/** The label of the total row in sheets B, C and D. */
export const TOTAL_LABEL = 'Summe';

/** Everything one group of rides adds up to, in integer cents and hundredths of a km. */
export interface Totals {
  key: string;
  orders: number;
  completed: number;
  cancelled: number;
  declined: number;
  fareCents: number;
  tipCents: number;
  declinedFeeCents: number;
  cancelledFeeCents: number;
  appFareCents: number;
  cashFareCents: number;
  kmHundredths: number;
}

export type DriverTotals = Totals;
export type VehicleTotals = Totals;

const euro = (cents: number): number => cents / 100;
const yesNo = (v: boolean): string => (v ? 'Ja' : 'Nein');

function fromBreakdown(key: string, b: RevenueBreakdown): Totals {
  return {
    key,
    orders: b.counts.total,
    completed: b.counts.completed,
    cancelled: b.counts.cancelled,
    declined: b.counts.declined,
    fareCents: b.fareCents,
    tipCents: b.tipCents,
    declinedFeeCents: b.declinedFeeCents,
    cancelledFeeCents: b.cancelledFeeCents,
    appFareCents: b.appFareCents,
    cashFareCents: b.cashFareCents,
    kmHundredths: Math.round(b.km * 100),
  };
}

const ADDITIVE: ReadonlyArray<Exclude<keyof Totals, 'key'>> = [
  'orders', 'completed', 'cancelled', 'declined', 'fareCents', 'tipCents',
  'declinedFeeCents', 'cancelledFeeCents', 'appFareCents', 'cashFareCents', 'kmHundredths',
];

/** One ride counted through the same function as the month, so the rules exist once. */
function groupTotals(
  rides: readonly SimRide[],
  settings: SimulationTenantSettings,
  keyOf: (ride: SimRide) => string,
): Totals[] {
  const groups = new Map<string, Totals>();
  for (const ride of rides) {
    const key = keyOf(ride);
    const one = fromBreakdown(key, countRevenue([ride], settings));
    const acc = groups.get(key) ?? fromBreakdown(key, countRevenue([], settings));
    for (const field of ADDITIVE) acc[field] += one[field];
    groups.set(key, acc);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, 'de'));
}

export function totalsByDriver(rides: readonly SimRide[], settings: SimulationTenantSettings): DriverTotals[] {
  return groupTotals(rides, settings, r => r.driver.name);
}

export function totalsByVehicle(rides: readonly SimRide[], settings: SimulationTenantSettings): VehicleTotals[] {
  return groupTotals(rides, settings, r => r.vehicle.plate);
}

/** The month total, from the whole ride list in one pass, independent of every breakdown. */
export function monthTotals(result: FullMonthResult): Totals {
  return fromBreakdown(TOTAL_LABEL, result.revenue);
}

const dayOfRide = (ride: SimRide, s: SimulationTenantSettings): string =>
  operatingDayIn(ride.startMs ?? ride.orderTransmittedMs, s.timeZone, s.operatingDayStartHour);

const stampOrEmpty = (ms: number | null, millis = false): string => (ms === null ? '' : formatStamp(ms, millis));

// ── Sheet A: every ride ────────────────────────────────────────────────────

export const RIDE_HEADERS: readonly string[] = [
  'Nr', 'Datum der Fahrt', 'Status', 'Fahrer', 'Kennzeichen', 'Schicht', 'Auftragsuebermittlung',
  'Fahrtbeginn', 'Fahrtende', 'Fahrpreis (EUR)', 'Trinkgeld (EUR)', 'Gebuehr (EUR)', 'Kilometer',
  'Zahlungsart', 'Abholort', 'Zielort',
];

const STATUS_WORD: Record<SimRide['status'], string> = {
  completed: 'abgeschlossen', cancelled: 'storniert', declined: 'abgelehnt',
};

/** Fare, tip and km count only for a completed ride; the others read 0 here by rule. */
function rideRow(ride: SimRide, nr: number, s: SimulationTenantSettings): Row {
  const done = ride.status === 'completed';
  return [
    nr, dayOfRide(ride, s), STATUS_WORD[ride.status], ride.driver.name, ride.vehicle.plate, ride.shiftId,
    stampOrEmpty(ride.orderTransmittedMs, true), stampOrEmpty(ride.startMs), stampOrEmpty(ride.endMs),
    done ? ride.fare : 0, done ? ride.tip : 0, euro(declineFeeOf(ride, s) ?? 0), done ? ride.km : 0,
    ride.payment, ride.pickup.label, ride.dropoff.label,
  ];
}

export function ridesSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  return [[...RIDE_HEADERS], ...result.month.rides.map((r, i) => rideRow(r, i + 1, s))];
}

// ── Sheets B, C, D: the breakdowns ─────────────────────────────────────────

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

const REASON_TEXT: Record<string, string> = {
  no_vehicle_in_fleet: 'kein Fahrzeug im Bestand',
  no_driver_in_pool: 'kein Fahrer im Pool',
  operating_day_has_no_start_instant: 'Betriebstag hat keinen Startzeitpunkt (Zeitumstellung)',
  no_driver_available: 'kein Fahrer verfuegbar',
  no_vehicle_free: 'kein Fahrzeug frei',
  driver_blocked_by_note: 'Fahrer durch Notiz gesperrt',
  driver_weekday_not_allowed: 'Wochentag fuer Fahrer nicht erlaubt',
  driver_resting: 'Fahrer in Ruhezeit',
  shift_produced_no_ride: 'Schicht ohne Fahrt',
};

export const DAY_HEADERS: readonly string[] = [
  'Datum', 'Wochentag', 'Stunden', 'Schichten', 'Fahrer im Einsatz', 'Auftraege', 'Abgeschlossen',
  'Abgelehnt', 'Storniert', 'Fahrpreise (EUR)', 'Ablehnungsgebuehren (EUR)', 'Trinkgeld (EUR)',
  'Kilometer', 'Tag ohne Fahrt', 'Grund',
];

function emptyDayReason(result: FullMonthResult, day: string): string {
  const reasons = new Set(result.refusals.filter(r => r.day === day).map(r => REASON_TEXT[r.reason] ?? r.reason));
  return reasons.size > 0 ? [...reasons].join('; ') : 'keine Fahrt erzeugt, kein Grund erfasst';
}

export function daysSheetRows(result: FullMonthResult): Row[] {
  const body = result.days.map((d): Row => [
    d.day, WEEKDAYS[d.isoWeekday - 1] ?? '', d.hours, d.shifts, d.driversWorked, d.rides, d.completed,
    d.declined, d.cancelled, euro(d.fareCents), euro(d.declinedFeeCents), euro(d.tipCents), d.km,
    yesNo(d.zeroRideDay), d.zeroRideDay ? emptyDayReason(result, d.day) : '',
  ]);
  const t = result.revenue;
  const hours = result.days.reduce((n, d) => n + d.hours, 0);
  const total: Row = [
    TOTAL_LABEL, '', hours, result.month.shifts.length, '', t.counts.total, t.counts.completed,
    t.counts.declined, t.counts.cancelled, euro(t.fareCents), euro(t.declinedFeeCents), euro(t.tipCents),
    t.km, '', '',
  ];
  return [[...DAY_HEADERS], ...body, total];
}

const groupHeaders = (label: string): string[] => [
  label, 'Auftraege', 'Abgeschlossen', 'Abgelehnt', 'Storniert', 'Fahrpreise (EUR)', 'davon App (EUR)',
  'davon Bar (EUR)', 'Ablehnungsgebuehren (EUR)', 'Stornogebuehren (EUR)', 'Trinkgeld (EUR)', 'Kilometer',
];

const groupRow = (t: Totals): Row => [
  t.key, t.orders, t.completed, t.declined, t.cancelled, euro(t.fareCents), euro(t.appFareCents),
  euro(t.cashFareCents), euro(t.declinedFeeCents), euro(t.cancelledFeeCents), euro(t.tipCents), t.kmHundredths / 100,
];

function groupSheetRows(label: string, groups: Totals[], total: Totals): Row[] {
  return [groupHeaders(label), ...groups.map(groupRow), groupRow(total)];
}

export function driversSheetRows(result: FullMonthResult): Row[] {
  const groups = totalsByDriver(result.month.rides, result.provenance.settings);
  return groupSheetRows('Fahrer', groups, monthTotals(result));
}

export function vehiclesSheetRows(result: FullMonthResult): Row[] {
  const groups = totalsByVehicle(result.month.rides, result.provenance.settings);
  return groupSheetRows('Fahrzeug', groups, monthTotals(result));
}

// ── Sheet E: declined and cancelled ────────────────────────────────────────

export const DECLINED_HEADERS: readonly string[] = [
  'Datum', 'Status', 'Fahrer', 'Kennzeichen', 'Auftragsuebermittlung', 'Gebuehr gezaehlt (EUR)',
  'Fahrpreis laut Blatt, nicht gezaehlt (EUR)', 'Abholort', 'Zielort',
];

export function declinedSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  const rows = result.month.rides.filter(r => r.status !== 'completed').map((r): Row => [
    dayOfRide(r, s), STATUS_WORD[r.status], r.driver.name, r.vehicle.plate,
    stampOrEmpty(r.orderTransmittedMs, true), euro(declineFeeOf(r, s) ?? 0),
    // A cancelled ride's own fare stays visible but counts into nothing, so it cannot be mistaken for the fee.
    r.status === 'cancelled' ? r.fare : 0, r.pickup.label, r.dropoff.label,
  ]);
  return [[...DECLINED_HEADERS], ...rows];
}

// ── Sheet F: reconciliation, revenue basis, validation ─────────────────────

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

const CANCELLED_FEE_MEASURE = 'Stornogebuehren (Cent)';

const MEASURES: readonly Measure[] = [
  { name: 'Auftraege', of: t => t.orders },
  { name: 'Fahrpreise (Cent)', of: t => t.fareCents },
  { name: 'Trinkgeld (Cent)', of: t => t.tipCents },
  { name: 'Ablehnungsgebuehren (Cent)', of: t => t.declinedFeeCents },
  { name: CANCELLED_FEE_MEASURE, of: t => t.cancelledFeeCents },
  { name: 'Kilometer (Hundertstel)', of: t => t.kmHundredths },
];

/** A day carries no cancellation fee, so that measure is left out of the day check. */
function dayAsTotals(d: FullMonthResult['days'][number]): Totals {
  return {
    key: d.day, orders: d.rides, completed: d.completed, cancelled: d.cancelled, declined: d.declined,
    fareCents: d.fareCents, tipCents: d.tipCents, declinedFeeCents: d.declinedFeeCents, cancelledFeeCents: 0,
    appFareCents: 0, cashFareCents: 0, kmHundredths: Math.round(d.km * 100),
  };
}

function reconcileGroup(
  dimension: string,
  parts: readonly Totals[],
  total: Totals,
  skip: readonly string[] = [],
): ReconciliationRow[] {
  return MEASURES.filter(m => !skip.includes(m.name)).map(m => ({
    label: `${m.name} je ${dimension}`,
    partsSum: parts.reduce((n, p) => n + m.of(p), 0),
    total: m.of(total),
  }));
}

export function reconcile(result: FullMonthResult): ReconciliationRow[] {
  const s = result.provenance.settings;
  const total = monthTotals(result);
  return [
    ...reconcileGroup('Tag', result.days.map(dayAsTotals), total, [CANCELLED_FEE_MEASURE]),
    ...reconcileGroup('Fahrer', totalsByDriver(result.month.rides, s), total),
    ...reconcileGroup('Fahrzeug', totalsByVehicle(result.month.rides, s), total),
  ];
}

const reconciliationLines = (result: FullMonthResult): Row[] =>
  reconcile(result).map(r => {
    const diff = r.partsSum - r.total;
    return [r.label, r.partsSum, r.total, diff, diff === 0 ? 'OK' : 'ABWEICHUNG'];
  });

function shareLines(result: FullMonthResult): Row[] {
  const { basis, share, revenue } = result;
  const s = result.provenance.settings;
  const lines: Row[] = [
    ['Auftraege gesamt', revenue.counts.total],
    ['Abgeschlossen', revenue.counts.completed],
    ['Abgelehnt', revenue.counts.declined],
    ['Storniert', revenue.counts.cancelled],
    ['Fahrpreise (EUR)', euro(basis.parts.fareCents)],
    ['Ablehnungsgebuehren (EUR)', euro(basis.parts.declinedFeeCents)],
    ['Stornogebuehren (EUR)', euro(basis.parts.cancelledFeeCents)],
    ['Trinkgeld (EUR)', euro(basis.parts.tipCents)],
    ['Kilometer', revenue.km],
    ['Zahlung App (EUR)', euro(revenue.appFareCents)],
    ['Zahlung Bar (EUR)', euro(revenue.cashFareCents)],
    ['Trinkgeld in Grundlage', yesNo(s.basisIncludesTips)],
    ['Gebuehren in Grundlage', yesNo(s.basisIncludesDeclinedFees)],
    ['Anspruchsberechtigte Einnahmen (EUR)', euro(basis.basisCents)],
    ['Anspruchsberechtigte Einnahmen (Text)', formatCentsDe(basis.basisCents)],
  ];
  if (!share) return [...lines, ['Monatsanteil', s.monthlyRevenueShareEnabled ? 'nicht berechenbar' : 'abgeschaltet']];
  return [
    ...lines,
    ['Satz (%)', share.rate.ratePercent],
    ['Betrag (EUR)', euro(share.result.amountCents)],
    ['Rest, falls Abzug (EUR)', euro(share.result.remainderCents)],
  ];
}

function limitLines(result: FullMonthResult): Row[] {
  const c = result.constraintSummary;
  const violations: Row[] = result.violations.length > 0
    ? result.violations.map(v => ['Verstoss', v])
    : [['Verstoesse', 'keine']];
  return [
    ['Einschraenkungen geprueft', c.rows],
    ['davon harte Sperren', c.hardBlocks],
    ['davon manuelle Pruefung', c.humanReview],
    ['Verweigerungen der Kapazitaet', result.refusals.length],
    ['Tage ohne Fahrt', result.days.filter(d => d.zeroRideDay).length],
    ['Nicht eingeplante Schichten', result.month.droppedShifts],
    ['Unlesbare Betraege', result.revenue.findings.length],
    ...violations,
  ];
}

export function checksSheetRows(result: FullMonthResult): Row[] {
  return [
    ['Abgleich', 'Summe der Teile', 'Gesamt', 'Differenz', 'Ergebnis'],
    ...reconciliationLines(result),
    [],
    ['Einnahmengrundlage und Monatsanteil', 'Wert'],
    ...shareLines(result),
    [],
    ['Pruefergebnisse und Einschraenkungen', 'Wert'],
    ...limitLines(result),
  ];
}

// ── Sheet G: source, settings, marking ─────────────────────────────────────

function settingLines(prefix: string, values: object): Row[] {
  return Object.entries(values).map(([k, v]): Row => [
    `${prefix}${k}`, typeof v === 'boolean' ? yesNo(v) : (v as Cell),
  ]);
}

export function sourceSheetRows(result: FullMonthResult): Row[] {
  const p = result.provenance;
  return [
    ['Kennzeichnung', SIMULATED_NOTICE],
    ['Hinweis', 'Die Fahrten dieser Datei sind simuliert. Sie sind kein Nachweis tatsaechlich durchgefuehrter Fahrten.'],
    ['Simuliert', yesNo(p.simulated)],
    ['Generatorversion', p.generatorVersion],
    ['Seed', p.seed],
    ['Jahr', p.year],
    ['Monat', p.month],
    ['Eingabequelle', 'period_driven: Tage aus dem Kalender, Einnahmen erzeugt, keine Messung'],
    ['Schichten je Fahrzeug und Tag', p.shiftsPerVehicleDay],
    ...settingLines('Einstellung ', p.settings),
    ...settingLines('Option ', p.options),
    ...settingLines('Eingabe ', p.inputs),
  ];
}

// ── Assembly ───────────────────────────────────────────────────────────────

export function buildMonthWorkbook(result: FullMonthResult): MonthWorkbookFile {
  const sheets: Array<[string, Row[]]> = [
    [SHEET_RIDES, ridesSheetRows(result)],
    [SHEET_DAYS, daysSheetRows(result)],
    [SHEET_DRIVERS, driversSheetRows(result)],
    [SHEET_VEHICLES, vehiclesSheetRows(result)],
    [SHEET_DECLINED, declinedSheetRows(result)],
    [SHEET_CHECKS, checksSheetRows(result)],
    [SHEET_SOURCE, sourceSheetRows(result)],
  ];
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  // Last, so the rides stay the first sheet and the file can be re-imported.
  addSimulatedNotice(wb, 'last');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
  const p = result.provenance;
  const mm = String(p.month).padStart(2, '0');
  return { fileName: simulatedFileName(`Monatsbericht_${p.year}-${mm}_${p.seed}.xlsx`), bytes };
}
