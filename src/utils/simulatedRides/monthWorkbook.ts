import { CONTRACT_LIMITS, CONTRACT_VERSION, type PayloadCell, type WorkbookPayload } from '../../lib/workbookContract';
import type { ConstraintDecision } from '../constraintDecisionLog';
import { formatCentsDe } from '../money';
import type { FullMonthResult } from './fullMonth';
import { SIMULATED_NOTICE, SIMULATED_SHEET_NAME, simulatedFileName } from './marker';
import {
  TOTAL_LABEL,
  monthTotals,
  reconcile,
  totalsByDriver,
  totalsByVehicle,
  type Totals,
} from './monthTotals';
import { VERDICT_TEXT, verifyMonth, type MonthVerification, type CheckOutcome } from './monthVerification';
import { operatingDayIn } from './period';
import { cancellationFeeOf, inExportScope } from './revenue';
import type { RouteCheck } from './routeCheck';
import type { ShiftDecision } from './simulationConstraints';
import type { SimulationTenantSettings } from './tenantSettings';
import { formatStamp } from './time';
import type { SimRide } from './types';

export { TOTAL_LABEL, monthTotals, reconcile, totalsByDriver, totalsByVehicle };
export type { DriverTotals, ReconciliationRow, Totals, VehicleTotals } from './monthTotals';

/**
 * The monthly report of a simulated month — the Fahrtenbuch report — as a
 * workbook the export service writes with openpyxl (owner decision 6 of 29.10.2026: every operational Excel
 * file comes from the service; there is no JavaScript writer and no fallback).
 *
 * Every sheet is built by a pure function returning rows, header first, and the
 * assembly at the bottom only labels and checks them, so a test reads the data
 * without parsing a binary.
 *
 * ## The label travels with every row
 *
 * The first column of every row of every sheet is `Kennzeichnung`, and its
 * data cells say `SIMULIERT`. Until round 4 the label lived in a second sheet,
 * the file name and a document property, all of which are lost the moment a
 * sheet is copied out of the file (FB-R4-UNVERIFIED-AUTH-001). The notice sheet
 * is the one exception: it is a single cell whose text begins with the label.
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
 * because adding the sheet's two-decimal floats would drift. Numbers are bare:
 * the plain export carries no number format.
 *
 * ## What the report holds, and what it never holds (round 6)
 *
 * Passenger rides and cancelled rides, nothing else. A **declined** order is
 * not a ride of this book (the owner's final rule): no row, no count and no
 * fee of one reaches any sheet here, and the basis of the monthly share is the
 * report's own. The **empty drives** are not rides either. Both live in the
 * separate operational report (`operationalReport.ts`). A cancelled ride stays,
 * with its cancellation fee under the company's setting and its financial
 * status on its row.
 */

export type Cell = string | number | null;
export type Row = Cell[];

export interface MonthReport {
  fileName: string;
  payload: WorkbookPayload;
}

export const SHEET_RIDES = 'A Fahrten';
export const SHEET_DAYS = 'B Monatsuebersicht';
export const SHEET_DRIVERS = 'C Summe je Fahrer';
export const SHEET_VEHICLES = 'D Summe je Fahrzeug';
export const SHEET_CANCELLED = 'E Stornierungen';
export const SHEET_CHECKS = 'F Pruefung und Grenzen';
export const SHEET_ROUTES = 'G Routenpruefung';
/** H is two tables, so two sheets: each keeps its own header row in row 1. */
export const SHEET_EVENTS = 'H Ereignisse';
export const SHEET_DECISIONS = 'H2 Schichtentscheidungen';
export const SHEET_SOURCE = 'I Quelle und Einstellungen';

export const SHEET_ORDER: readonly string[] = [
  SHEET_RIDES, SHEET_DAYS, SHEET_DRIVERS, SHEET_VEHICLES, SHEET_CANCELLED, SHEET_CHECKS,
  SHEET_ROUTES, SHEET_EVENTS, SHEET_DECISIONS, SHEET_SOURCE, SIMULATED_SHEET_NAME,
];

/** Column 1 of every row: header text, then the value every data row carries. */
export const LABEL_HEADER = 'Kennzeichnung';
export const LABEL_VALUE = 'SIMULIERT';

/** Prepends the label column; row 0 is the header. Blank spacer rows are not allowed. */
export function labelled(rows: readonly Row[]): Row[] {
  return rows.map((r, i) => [i === 0 ? LABEL_HEADER : LABEL_VALUE, ...r]);
}

const euro = (cents: number): number => cents / 100;
export const yesNo = (v: boolean): string => (v ? 'Ja' : 'Nein');

const dayOfRide = (ride: SimRide, s: SimulationTenantSettings): string =>
  operatingDayIn(ride.startMs ?? ride.orderTransmittedMs, s.timeZone, s.operatingDayStartHour);

const stampOrEmpty = (ms: number | null, millis = false): string => (ms === null ? '' : formatStamp(ms, millis));

// ── Sheet A: the report's rides ────────────────────────────────────────────

/**
 * `Nr` is the row's number in this sheet; `Fahrt-ID` is the ride's identity in
 * the month, which the route sheet and the operational report name. They differ
 * because the declined orders, which hold ids of their own, are not rows here.
 */
export const RIDE_HEADERS: readonly string[] = [
  'Nr', 'Fahrt-ID', 'Datum der Fahrt', 'Status', 'Fahrer', 'Fahrer-ID', 'Kennzeichen', 'Schicht',
  'Auftragsuebermittlung', 'Fahrtbeginn', 'Fahrtende', 'Fahrpreis (EUR)', 'Trinkgeld (EUR)',
  'Stornogebuehr (EUR)', 'Finanzstatus', 'Kilometer', 'Zahlungsart', 'Abholort', 'Zielort',
];

export const STATUS_WORD: Record<SimRide['status'], string> = {
  completed: 'abgeschlossen', cancelled: 'storniert', declined: 'abgelehnt',
};

/** The financial status of a ride of the report, in words, so the fee's reason is on its own row. */
export function financialStatus(ride: SimRide, s: SimulationTenantSettings): string {
  if (ride.status === 'completed') return 'Fahrpreis abgerechnet';
  if (ride.status === 'cancelled') {
    return cancellationFeeOf(ride, s) === null
      ? 'storniert, keine Stornogebuehr (Einstellung der Firma)'
      : 'storniert, Stornogebuehr berechnet (Einstellung der Firma)';
  }
  return 'abgelehnt - nicht im Fahrtenbuch';
}

/** The report's rides in sheet order: completed and cancelled, by transmission. */
export function reportRides(result: FullMonthResult): SimRide[] {
  return result.month.rides.filter(inExportScope);
}

/** Fare, tip and km count only for a completed ride; the others read 0 here by rule. */
function rideRow(ride: SimRide, nr: number, s: SimulationTenantSettings): Row {
  const done = ride.status === 'completed';
  const fee = cancellationFeeOf(ride, s);
  return [
    nr, ride.tripId ?? '', dayOfRide(ride, s), STATUS_WORD[ride.status], ride.driver.name, ride.driver.id ?? '',
    ride.vehicle.plate, ride.shiftId, stampOrEmpty(ride.orderTransmittedMs, true), stampOrEmpty(ride.startMs),
    stampOrEmpty(ride.endMs), done ? ride.fare : 0, done ? ride.tip : 0, euro(fee ?? 0), financialStatus(ride, s),
    done ? ride.km : 0, ride.payment, ride.pickup.label, ride.dropoff.label,
  ];
}

export function ridesSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  return [[...RIDE_HEADERS], ...reportRides(result).map((r, i) => rideRow(r, i + 1, s))];
}

// ── Sheets B, C, D: the breakdowns ─────────────────────────────────────────

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

export const REASON_TEXT: Record<string, string> = {
  no_vehicle_in_fleet: 'kein Fahrzeug im Bestand',
  no_driver_in_pool: 'kein Fahrer im Pool',
  operating_day_has_no_start_instant: 'Betriebstag hat keinen Startzeitpunkt (Zeitumstellung)',
  no_driver_available: 'kein Fahrer verfuegbar',
  no_vehicle_free: 'kein Fahrzeug frei',
  driver_blocked_by_note: 'Fahrer durch Notiz gesperrt',
  driver_weekday_not_allowed: 'Wochentag fuer Fahrer nicht erlaubt',
  driver_resting: 'Fahrer in Ruhezeit',
  shift_produced_no_ride: 'Schicht ohne Fahrt',
  shift_too_short: 'Schicht unter der Mindestdauer verworfen',
  vehicle_tuev_expired: 'TUEV des Fahrzeugs abgelaufen',
};

export const DAY_HEADERS: readonly string[] = [
  'Datum', 'Wochentag', 'Stunden', 'Schichten', 'Fahrer im Einsatz', 'Fahrten', 'Abgeschlossen',
  'Storniert', 'Fahrpreise (EUR)', 'Stornogebuehren (EUR)', 'Trinkgeld (EUR)', 'Kilometer',
  'Tag ohne Fahrt', 'Grund',
];

function emptyDayReason(result: FullMonthResult, day: string): string {
  const reasons = new Set(result.refusals.filter(r => r.day === day).map(r => REASON_TEXT[r.reason] ?? r.reason));
  return reasons.size > 0 ? [...reasons].join('; ') : 'keine Fahrt erzeugt, kein Grund erfasst';
}

/** Every calendar day of the month, including the days with no ride, each with its reason. */
export function daysSheetRows(result: FullMonthResult): Row[] {
  const body = result.days.map((d): Row => [
    d.day, WEEKDAYS[d.isoWeekday - 1] ?? '', d.hours, d.shifts, d.driversWorked, d.rides, d.completed,
    d.cancelled, euro(d.fareCents), euro(d.cancelledFeeCents), euro(d.tipCents), d.km,
    yesNo(d.zeroRideDay), d.zeroRideDay ? emptyDayReason(result, d.day) : '',
  ]);
  const t = monthTotals(result);
  const hours = result.days.reduce((n, d) => n + d.hours, 0);
  const total: Row = [
    TOTAL_LABEL, '', hours, result.month.shifts.length, '', t.rides, t.completed,
    t.cancelled, euro(t.fareCents), euro(t.cancelledFeeCents), euro(t.tipCents), t.kmHundredths / 100, '', '',
  ];
  return [[...DAY_HEADERS], ...body, total];
}

const groupHeaders = (label: string, idLabel: string | null): string[] => [
  label, ...(idLabel ? [idLabel] : []), 'Fahrten', 'Abgeschlossen', 'Storniert', 'Fahrpreise (EUR)', 'davon App (EUR)',
  'davon Bar (EUR)', 'Stornogebuehren (EUR)', 'Trinkgeld (EUR)', 'Kilometer',
];

const groupRow = (t: Totals, withId: boolean): Row => [
  t.label, ...(withId ? [t.key === TOTAL_LABEL ? '' : t.key] : []), t.rides, t.completed, t.cancelled, euro(t.fareCents),
  euro(t.appFareCents), euro(t.cashFareCents), euro(t.cancelledFeeCents), euro(t.tipCents), t.kmHundredths / 100,
];

function groupSheetRows(label: string, idLabel: string | null, groups: Totals[], total: Totals): Row[] {
  return [groupHeaders(label, idLabel), ...groups.map(g => groupRow(g, idLabel !== null)), groupRow(total, idLabel !== null)];
}

export function driversSheetRows(result: FullMonthResult): Row[] {
  const groups = totalsByDriver(result.month.rides, result.provenance.settings);
  return groupSheetRows('Fahrer', 'Fahrer-ID', groups, monthTotals(result));
}

export function vehiclesSheetRows(result: FullMonthResult): Row[] {
  const groups = totalsByVehicle(result.month.rides, result.provenance.settings);
  return groupSheetRows('Fahrzeug', null, groups, monthTotals(result));
}

// ── Sheet E: cancellations ─────────────────────────────────────────────────

export const CANCELLED_HEADERS: readonly string[] = [
  'Fahrt-ID', 'Datum', 'Fahrer', 'Kennzeichen', 'Schicht', 'Auftragsuebermittlung', 'Stornogebuehr (EUR)',
  'Finanzstatus', 'Abholort', 'Zielort',
];

/** Every cancelled ride, each with its fee under the company's setting and its financial status. */
export function cancelledSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  const rows = reportRides(result).filter(r => r.status === 'cancelled').map((r): Row => [
    r.tripId ?? '', dayOfRide(r, s), r.driver.name, r.vehicle.plate, r.shiftId, stampOrEmpty(r.orderTransmittedMs, true),
    euro(cancellationFeeOf(r, s) ?? 0), financialStatus(r, s), r.pickup.label, r.dropoff.label,
  ]);
  return [[...CANCELLED_HEADERS], ...rows];
}

// ── Sheet F: verification, reconciliation, revenue basis ───────────────────

const SECTION_RECON = 'Abgleich';
const SECTION_BASIS = 'Einnahmengrundlage und Monatsanteil';
const SECTION_VERIFY = 'Pruefung fuer den Export';
const SECTION_LIMITS = 'Pruefergebnisse und Einschraenkungen';

/** One uniform table: Abschnitt, Posten, Wert, then Gesamt/Differenz/Ergebnis. */
const reconciliationLines = (result: FullMonthResult): Row[] =>
  reconcile(result).map((r): Row => {
    const diff = r.partsSum - r.total;
    return [SECTION_RECON, r.label, r.partsSum, r.total, diff, diff === 0 ? 'OK' : 'ABWEICHUNG'];
  });

const NOT_A_TAX =
  'Der Monatsanteil ist weder eine Steuer noch eine Provision. Er ist eine simulierte Rechengroesse '
  + 'auf der genannten Grundlage und keine tatsaechlich erhobene Abgabe.';

/** What the basis adds up, in words, so the amount can be re-derived from the sheet alone. */
function basisContents(s: SimulationTenantSettings): string {
  const parts = ['Fahrpreise abgeschlossener Fahrten'];
  if (s.basisIncludesTips) parts.push('Trinkgeld');
  if (s.basisIncludesCancellationFees) parts.push('Stornogebuehren');
  return parts.join(' + ');
}

function shareLines(result: FullMonthResult): Row[] {
  const { basis, share, revenue } = result;
  const s = result.provenance.settings;
  const line = (label: string, value: Cell): Row => [SECTION_BASIS, label, value];
  const lines: Row[] = [
    line('Fahrten im Bericht', revenue.counts.completed + revenue.counts.cancelled),
    line('Abgeschlossen', revenue.counts.completed),
    line('Storniert', revenue.counts.cancelled),
    line('Fahrpreise (EUR)', euro(basis.parts.fareCents)),
    line('Stornogebuehren (EUR)', euro(basis.parts.cancelledFeeCents)),
    line('Trinkgeld (EUR)', euro(basis.parts.tipCents)),
    line('Kilometer', revenue.km),
    line('Zahlung App (EUR)', euro(revenue.appFareCents)),
    line('Zahlung Bar (EUR)', euro(revenue.cashFareCents)),
    line('Monatssumme Fahrpreise App + Bar (EUR)', euro(revenue.appFareCents + revenue.cashFareCents)),
    line('Stornogebuehr der Firma (EUR)', s.cancellationFeeEnabled ? euro(s.cancellationFeeCents) : 'keine'),
    line('Trinkgeld in Grundlage', yesNo(s.basisIncludesTips)),
    line('Stornogebuehren in Grundlage', yesNo(s.basisIncludesCancellationFees)),
    line('Grundlage enthaelt', basisContents(s)),
    line('Abgelehnte Auftraege', 'nicht im Bericht und nicht in der Grundlage (intern im Betriebsbericht)'),
    line('Anspruchsberechtigte Einnahmen (EUR)', euro(basis.basisCents)),
    line('Anspruchsberechtigte Einnahmen (Text)', formatCentsDe(basis.basisCents)),
  ];
  const note = line('Hinweis Monatsanteil', NOT_A_TAX);
  if (!share) {
    return [...lines, line('Monatsanteil', s.monthlyRevenueShareEnabled ? 'nicht berechenbar' : 'abgeschaltet'), note];
  }
  return [
    ...lines,
    line('Satz (%)', share.rate.ratePercent),
    line('Betrag (EUR)', euro(share.result.amountCents)),
    line('Rest, falls Abzug (EUR)', euro(share.result.remainderCents)),
    note,
  ];
}

const OUTCOME_TEXT: Record<CheckOutcome, string> = { passed: 'bestanden', failed: 'NICHT BESTANDEN', not_verified: 'nicht geprueft' };

function verificationLines(v: MonthVerification): Row[] {
  const line = (label: string, value: Cell, outcome: Cell = ''): Row => [SECTION_VERIFY, label, value, '', '', outcome];
  return [
    line('Erzeugung', v.generated ? 'erzeugt, keine Regel verletzt' : 'erzeugt mit Regelverstoessen'),
    line('Exportstatus', v.verdict, VERDICT_TEXT[v.verdict]),
    line('Fahrzeiten', v.routing === 'measured' ? 'berechnete Routen' : 'nur Schaetzung (ESTIMATE_ONLY)'),
    ...v.checks.map(c => line(c.label, c.detail, OUTCOME_TEXT[c.outcome])),
  ];
}

function limitLines(result: FullMonthResult): Row[] {
  const c = result.constraintSummary;
  const line = (label: string, value: Cell): Row => [SECTION_LIMITS, label, value];
  const violations: Row[] = result.violations.length > 0
    ? result.violations.map(v => line('Verstoss', v))
    : [line('Verstoesse', 'keine')];
  return [
    line('Einschraenkungen geprueft', c.rows),
    line('davon harte Sperren', c.hardBlocks),
    line('davon manuelle Pruefung', c.humanReview),
    line('Verweigerungen der Kapazitaet', result.refusals.length),
    line('Tage ohne Fahrt', result.days.filter(d => d.zeroRideDay).length),
    line('Nicht eingeplante Schichten', result.month.droppedShifts),
    line('Unlesbare Betraege', result.revenue.findings.length),
    line('Leerfahrten (im Betriebsbericht)', result.repositioningSummary.legs),
    ...violations,
  ];
}

export const CHECKS_HEADERS: readonly string[] = ['Abschnitt', 'Posten', 'Wert / Summe der Teile', 'Gesamt', 'Differenz', 'Ergebnis'];

export function checksSheetRows(result: FullMonthResult, verification: MonthVerification = verifyMonth(result)): Row[] {
  return [
    [...CHECKS_HEADERS], ...verificationLines(verification), ...reconciliationLines(result), ...shareLines(result),
    ...limitLines(result),
  ];
}

// ── Sheet G: the route check ───────────────────────────────────────────────

export const ROUTE_HEADERS: readonly string[] = [
  'Gruppierung', 'Gruppe', 'Fahrt-ID frueher', 'Fahrt-ID spaeter', 'Gleiche Schicht', 'Ende frueher',
  'Beginn spaeter', 'Luecke (s)', 'Fahrzeit Strasse (s)', 'Strecke (km)', 'Sicherheitsreserve (s)',
  'Benoetigt (s)', 'Spielraum (s)', 'Status', 'Grund', 'Quelle',
];

const routeRow = (c: RouteCheck): Row => [
  c.grouping === 'vehicle' ? 'Fahrzeug' : 'Fahrer', c.groupLabel, c.prevTripId, c.nextTripId, yesNo(c.sameShift),
  formatStamp(c.prevEndMs, false), formatStamp(c.nextStartMs, false), c.availableSeconds, c.roadSeconds, c.roadKm,
  c.safetyMarginSeconds, c.requiredSeconds, c.slackSeconds, c.status, c.reason, c.source,
];

/** Every check, no summary rows above it: the header is row 1. */
export function routesSheetRows(result: FullMonthResult): Row[] {
  return [[...ROUTE_HEADERS], ...result.routeChecks.map(routeRow)];
}

// ── Sheets H and H2: events and shift decisions ────────────────────────────

export const EVENT_HEADERS: readonly string[] = [
  'Betrifft', 'Bezeichnung', 'Ereignis', 'Quelle', 'Sicherheit', 'Wirkung', 'Zeitraum', 'Pruefung noetig', 'Grund',
];

const CERTAINTY_WORD: Record<string, string> = {
  confirmed: 'bestaetigt',
  assumed_from_notice_date: 'aus Meldedatum angenommen',
  reported: 'gemeldet',
};
const certaintyWord = (c: string | null): string => (c === null ? '' : (CERTAINTY_WORD[c] ?? c));

function windowText(c: ConstraintDecision): string {
  if (!c.windowStart) return '';
  const from = [c.windowStart, c.windowStartTime].filter(Boolean).join(' ');
  const to = [c.windowEnd ?? c.windowStart, c.windowEndTime].filter(Boolean).join(' ');
  return `${from} bis ${to}`;
}

export function eventsSheetRows(result: FullMonthResult): Row[] {
  const rows = result.constraints.map((c): Row => [
    c.subject === 'driver' ? 'Fahrer' : 'Fahrzeug', c.subjectLabel, c.eventLabel, c.source,
    certaintyWord(c.certainty), c.effect, windowText(c), yesNo(c.needsHumanReview), c.reason,
  ]);
  return [[...EVENT_HEADERS], ...rows];
}

export const DECISION_HEADERS: readonly string[] = [
  'Tag', 'Kennzeichen', 'Fahrer', 'Ergebnis', 'Code', 'Grund', 'Ereignis', 'Sicherheit', 'Anzahl',
  'Schichtbeginn', 'Schichtende',
];

const OUTCOME_WORD: Record<ShiftDecision['outcome'], string> = {
  accepted: 'eingeplant',
  accepted_with_review: 'eingeplant, zu pruefen',
  excluded: 'nicht eingeplant',
};

/** A driver's label from the rides (by id), then from the constraint log; the id itself when neither knows him. */
function driverLabels(result: FullMonthResult): Map<string, string> {
  const labels = new Map<string, string>();
  for (const c of result.constraints) if (c.subject === 'driver' && c.subjectId) labels.set(c.subjectId, c.subjectLabel);
  for (const r of result.month.rides) if (r.driver.id) labels.set(r.driver.id, r.driver.name);
  return labels;
}

export function decisionsSheetRows(result: FullMonthResult): Row[] {
  const labels = driverLabels(result);
  const rows = result.decisions.map((d): Row => [
    d.day, d.plate, d.driverId === null ? '' : (labels.get(d.driverId) ?? d.driverId), OUTCOME_WORD[d.outcome],
    d.code, d.reason, d.eventRef ?? '', certaintyWord(d.certainty), d.count,
    stampOrEmpty(d.startMs), stampOrEmpty(d.endMs),
  ]);
  return [[...DECISION_HEADERS], ...rows];
}

// ── Sheet I: source, settings, marking ─────────────────────────────────────

const SOURCE_HEADERS: readonly string[] = ['Angabe', 'Wert'];

function scalar(v: unknown): Cell {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return yesNo(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function settingLines(prefix: string, values: object): Row[] {
  return Object.entries(values).map(([k, v]): Row => [`${prefix}${k}`, scalar(v)]);
}

function routingLines(result: FullMonthResult): Row[] {
  const p = result.provenance;
  const r = p.routing;
  const rs = result.routeSummary;
  const rp = result.repositioningSummary;
  const base: Row[] = [
    ['Fahrzeitquelle', p.travel.source],
    ['Fahrzeit gemessen', yesNo(p.travel.measured)],
    ['Routenpruefungen gesamt', rs.checks],
    ...Object.entries(rs.byStatus).map(([status, n]): Row => [`Routenpruefungen: ${status}`, n]),
    ['Routenpruefungen: Konflikte (eindeutige Paare)', rs.uniqueConflicts],
    ['Routenpruefungen: nicht pruefbar (eindeutige Paare)', rs.uniqueUnverifiable],
    ['Routenpruefungen: gleiche Adresse', rs.sameAddress],
    ['Leerfahrten gesamt', rp.legs],
    ...Object.entries(rp.byStatus).map(([status, n]): Row => [`Leerfahrten: ${status}`, n]),
    ['Leerfahrten im Wunschfenster 2-5 Minuten', rp.preferredWindow],
    ['Leerfahrten mit Route', rp.withRoute],
    ['Leerfahrten Strecke (km)', rp.roadKm],
  ];
  if (!r) return [...base, ['Routing', 'keine Routing-Angaben uebergeben (Schaetzung ohne Messung)']];
  return [
    ...base,
    ['Routing: Punkte', r.points],
    ['Routing: berechnete Paare', r.routedPairs],
    ['Routing: fehlgeschlagene Paare', r.failedPairs],
    ...Object.entries(r.failuresByReason).map(([reason, n]): Row => [`Routing: Fehler ${reason}`, n]),
    ['Routing: berechnet am', r.computedAt ?? ''],
    ['Adressen geprueft', r.addressesChecked ?? ''],
    ['Adressen behalten', r.addressesKept ?? ''],
    ...Object.entries(r.addressesDroppedByReason ?? {}).map(([reason, n]): Row => [`Adressen verworfen: ${reason}`, n]),
    ['Geocoder-Quelle', r.geocoderSource ?? ''],
  ];
}

export function sourceSheetRows(result: FullMonthResult, verification: MonthVerification = verifyMonth(result)): Row[] {
  const p = result.provenance;
  return [
    [...SOURCE_HEADERS],
    ['Kennzeichnung', SIMULATED_NOTICE],
    ['Hinweis', 'Die Fahrten dieser Datei sind simuliert. Sie sind kein Nachweis tatsaechlich durchgefuehrter Fahrten.'],
    ['Simuliert', yesNo(p.simulated)],
    ['Exportstatus', `${verification.verdict} - ${VERDICT_TEXT[verification.verdict]}`],
    ['Lauf-ID', p.runId],
    ['Firma (Mandant)', p.tenantId ?? ''],
    ['Generatorversion', p.generatorVersion],
    ['Seed', p.seed],
    ['Jahr', p.year],
    ['Monat', p.month],
    ['Eingabequelle', 'period_driven: Tage aus dem Kalender, Einnahmen erzeugt, keine Messung'],
    ['Schichten je Fahrzeug und Tag', p.shiftsPerVehicleDay],
    ...settingLines('Einstellung ', p.settings),
    ...settingLines('Option ', p.options),
    ...settingLines('Eingabe ', p.inputs),
    ...routingLines(result),
  ];
}

// ── Assembly ───────────────────────────────────────────────────────────────

/** Excel cannot store C0 control characters and the service refuses the file; a stray one in a label must not cost the export. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function toPayloadCell(cell: Cell): PayloadCell {
  if (typeof cell === 'string') return cell.replace(CONTROL_CHARS, ' ').slice(0, CONTRACT_LIMITS.maxStringLength);
  if (typeof cell === 'number' && !Number.isFinite(cell)) return String(cell);
  return cell;
}

/** What a payload costs against the contract, so a too-large month fails here and says why. */
export interface PayloadCost { sheets: number; cells: number; maxRows: number; maxColumns: number; bytes: number }

export function payloadCost(payload: WorkbookPayload): PayloadCost {
  let cells = 0;
  let maxRows = 0;
  let maxColumns = 0;
  for (const sheet of payload.sheets) {
    maxRows = Math.max(maxRows, sheet.rows.length);
    for (const row of sheet.rows) { cells += row.length; maxColumns = Math.max(maxColumns, row.length); }
  }
  return { sheets: payload.sheets.length, cells, maxRows, maxColumns, bytes: new TextEncoder().encode(JSON.stringify(payload)).length };
}

/** A German sentence for the first limit the payload would break, or null. */
export function contractProblem(cost: PayloadCost): string | null {
  const L = CONTRACT_LIMITS;
  if (cost.sheets > L.maxSheets) return `Der Bericht hat ${cost.sheets} Blaetter, erlaubt sind ${L.maxSheets}.`;
  if (cost.maxRows > L.maxRowsPerSheet) return `Ein Blatt hat ${cost.maxRows} Zeilen, erlaubt sind ${L.maxRowsPerSheet}.`;
  if (cost.maxColumns > L.maxColumns) return `Ein Blatt hat ${cost.maxColumns} Spalten, erlaubt sind ${L.maxColumns}.`;
  if (cost.cells > L.maxCells) return `Der Bericht hat ${cost.cells} Zellen, erlaubt sind ${L.maxCells}. Bitte einen kleineren Monat waehlen.`;
  if (cost.bytes > L.maxBodyBytes) return `Der Bericht ist ${cost.bytes} Bytes gross, erlaubt sind ${L.maxBodyBytes}.`;
  return null;
}

/**
 * Labelled sheets, the notice sheet last, checked against the contract. Shared
 * by both reports of a month, so both carry the label the same way.
 */
export function assemblePayload(tables: ReadonlyArray<readonly [string, Row[]]>): WorkbookPayload {
  const sheets = tables.map(([name, rows]) => ({
    name,
    header: true as const,
    rows: labelled(rows).map(r => r.map(toPayloadCell)),
  }));
  // Last, so the data stays first; it is a single cell whose text opens with the label.
  sheets.push({ name: SIMULATED_SHEET_NAME, header: true as const, rows: [[SIMULATED_NOTICE]] });
  const payload: WorkbookPayload = { version: CONTRACT_VERSION, sheets };
  const problem = contractProblem(payloadCost(payload));
  if (problem) throw new Error(problem);
  return payload;
}

/** The verdict in the file's own name, so a file that was not validated cannot pass for one that was. */
export function reportFileName(kind: string, result: FullMonthResult, verification: MonthVerification): string {
  const p = result.provenance;
  const mm = String(p.month).padStart(2, '0');
  const routing = verification.routing === 'estimate' ? '_ESTIMATE_ONLY' : '';
  return simulatedFileName(`${kind}_${p.year}-${mm}_${p.seed}_${verification.verdict}${routing}.xlsx`);
}

/**
 * The monthly report as the payload the export service writes. Throws a
 * German message when the month is larger than the contract carries; the
 * service would refuse it anyway, and this says why before a round trip.
 *
 * It also refuses a ride sheet that holds a declined order. The sheet is built
 * from `reportRides`, so this cannot happen today; it is the second wall the
 * owner's rule gets, because a rule kept by one filter is lost by the next
 * person who builds the rows another way.
 */
export function buildMonthReport(result: FullMonthResult, verification: MonthVerification = verifyMonth(result)): MonthReport {
  const rides = ridesSheetRows(result);
  const statusAt = RIDE_HEADERS.indexOf('Status');
  if (rides.slice(1).some(r => r[statusAt] === STATUS_WORD.declined)) {
    throw new Error('Der Fahrtenbuch-Bericht enthielte abgelehnte Auftraege; er wird nicht erstellt.');
  }
  const payload = assemblePayload([
    [SHEET_RIDES, rides],
    [SHEET_DAYS, daysSheetRows(result)],
    [SHEET_DRIVERS, driversSheetRows(result)],
    [SHEET_VEHICLES, vehiclesSheetRows(result)],
    [SHEET_CANCELLED, cancelledSheetRows(result)],
    [SHEET_CHECKS, checksSheetRows(result, verification)],
    [SHEET_ROUTES, routesSheetRows(result)],
    [SHEET_EVENTS, eventsSheetRows(result)],
    [SHEET_DECISIONS, decisionsSheetRows(result)],
    [SHEET_SOURCE, sourceSheetRows(result, verification)],
  ]);
  return { fileName: reportFileName('Monatsbericht', result, verification), payload };
}
