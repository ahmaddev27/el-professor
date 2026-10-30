import type { WorkbookPayload } from '../../lib/workbookContract';
import type { FullMonthResult } from './fullMonth';
import {
  REASON_TEXT,
  SHEET_SOURCE,
  assemblePayload,
  reportFileName,
  sourceSheetRows,
  yesNo,
  type Row,
} from './monthWorkbook';
import { verifyMonth, type MonthVerification } from './monthVerification';
import { operatingDayIn } from './period';
import { declineFeeOf, inExportScope } from './revenue';
import type { RepositioningLeg, RepositioningPurpose } from './repositioningLegs';
import { formatStamp } from './time';
import type { SimRide } from './types';

/**
 * The operational report of a simulated month: what the Fahrtenbuch report
 * deliberately leaves out, kept rather than dropped (external audit round 6).
 *
 * - **Leerfahrten.** Every empty drive as a record of its own
 *   (`repositioningLegs.ts`): never a passenger ride, never in the passenger
 *   sheet, and stated here with its road time, its margin, its routing source
 *   and its verification status.
 * - **Declined orders, internal.** The owner's final rule: a declined order is
 *   no row of the Fahrtenbuch and its fee is in none of its totals. It is kept
 *   here, with its fee, and the money is labelled as internal revenue that is
 *   in no figure of the other file.
 * - **Scheduling.** Every accepted shift with what the ride loop refused
 *   before it stopped, and every shift that was not placed, with its reason.
 *
 * It is a second file on purpose. A sheet inside the Fahrtenbuch report could
 * be read as part of it; a file of its own, named as what it is and carrying
 * the SIMULIERT label on every row like the first, cannot.
 */

export const SHEET_LEGS = 'L Leerfahrten';
export const SHEET_DECLINED_INTERNAL = 'M Abgelehnt intern';
export const SHEET_INTERNAL_REVENUE = 'N Interne Einnahmen';
export const SHEET_SCHEDULING = 'O Schichtplanung';

export const OPERATIONAL_SHEET_ORDER: readonly string[] = [
  SHEET_LEGS, SHEET_DECLINED_INTERNAL, SHEET_INTERNAL_REVENUE, SHEET_SCHEDULING, SHEET_SOURCE,
];

export interface OperationalReport {
  fileName: string;
  payload: WorkbookPayload;
}

const euro = (cents: number): number => cents / 100;
const stamp = (ms: number | null, millis = false): string => (ms === null ? '' : formatStamp(ms, millis));

const PURPOSE_WORD: Record<RepositioningPurpose, string> = {
  from_base: 'Betriebssitz zur ersten Abholung',
  to_waiting_position: 'Zielort zum Warteplatz',
  to_pickup: 'zur naechsten Abholung',
};

export const LEG_HEADERS: readonly string[] = [
  'Leerfahrt-ID', 'Art', 'Bezeichnung', 'Zweck', 'Lauf-ID', 'Seed', 'Datenart', 'Mandant', 'Fahrzeug-ID', 'Kennzeichen',
  'Fahrer-ID', 'Fahrer', 'Fahrerzuordnung', 'Schicht', 'Fahrt-ID vorher', 'Fahrt-ID nachher', 'Von', 'Von Breite',
  'Von Laenge', 'Nach', 'Nach Breite', 'Nach Laenge', 'Abfahrt', 'Ankunft', 'Verfuegbar (s)', 'Fahrzeit Strasse (s)',
  'Strecke (km)', 'Abholzeit (s)', 'Sicherheitsreserve (s)', 'Benoetigt (s)', 'Spielraum (s)', 'Im Wunschfenster 2-5 min',
  'Routingquelle', 'Pruefstatus',
];

const legRow = (l: RepositioningLeg): Row => [
  l.legId, l.kind, l.label, PURPOSE_WORD[l.purpose], l.runId, l.seed, l.dataKind, l.tenantId ?? '', l.vehicleId ?? '', l.plate,
  l.driverId ?? '', l.driverName, l.driverAssignment === 'simulated' ? 'simuliert' : l.driverAssignment, l.shiftId,
  l.previousTripId ?? '', l.nextTripId, l.from.label, l.from.lat, l.from.lon, l.to.label, l.to.lat, l.to.lon,
  stamp(l.departMs, true), stamp(l.arriveMs, true), l.availableSeconds, l.roadSeconds, l.roadKm, l.handlingSeconds,
  l.safetyMarginSeconds, l.requiredSeconds, l.slackSeconds, l.preferredWindow === null ? '' : yesNo(l.preferredWindow),
  l.routingSource, l.verificationStatus,
];

export function legsSheetRows(result: FullMonthResult): Row[] {
  return [[...LEG_HEADERS], ...result.repositioning.map(legRow)];
}

export const DECLINED_INTERNAL_HEADERS: readonly string[] = [
  'Fahrt-ID', 'Datum', 'Status', 'Fahrer', 'Fahrer-ID', 'Kennzeichen', 'Schicht', 'Auftragsuebermittlung',
  'Ablehnungsgebuehr intern (EUR)', 'Gebuehrenregel', 'Abholort', 'Zielort', 'Hinweis',
];

const NOT_IN_BOOK = 'intern - nicht im Fahrtenbuch, nicht in dessen Summen und nicht in der Grundlage des Monatsanteils';

function declinedRides(result: FullMonthResult): SimRide[] {
  return result.month.rides.filter(r => !inExportScope(r));
}

export function declinedInternalSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  const rows = declinedRides(result).map((r): Row => [
    r.tripId ?? '', operatingDayIn(r.orderTransmittedMs, s.timeZone, s.operatingDayStartHour), 'abgelehnt', r.driver.name,
    r.driver.id ?? '', r.vehicle.plate, r.shiftId, stamp(r.orderTransmittedMs, true), euro(declineFeeOf(r, s) ?? 0),
    r.declineRule ?? '', r.pickup.label, r.dropoff.label, NOT_IN_BOOK,
  ]);
  return [[...DECLINED_INTERNAL_HEADERS], ...rows];
}

export const INTERNAL_REVENUE_HEADERS: readonly string[] = ['Posten', 'Gruppe', 'Anzahl', 'Betrag (EUR)', 'Hinweis'];

/** The declined fees, per driver and per vehicle and in total, each labelled as internal. */
export function internalRevenueSheetRows(result: FullMonthResult): Row[] {
  const s = result.provenance.settings;
  const declined = declinedRides(result);
  const sum = (list: readonly SimRide[]) => list.reduce((n, r) => n + (declineFeeOf(r, s) ?? 0), 0);
  const group = (keyOf: (r: SimRide) => string, labelOf: (r: SimRide) => string, what: string): Row[] => {
    const groups = new Map<string, { label: string; rides: SimRide[] }>();
    for (const r of declined) {
      const entry = groups.get(keyOf(r)) ?? { label: labelOf(r), rides: [] };
      entry.rides.push(r);
      groups.set(keyOf(r), entry);
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'de'))
      .map(g => [`Ablehnungsgebuehren je ${what}`, g.label, g.rides.length, euro(sum(g.rides)), NOT_IN_BOOK]);
  };
  const total = result.internal.declined;
  return [
    [...INTERNAL_REVENUE_HEADERS],
    ['Abgelehnte Auftraege gesamt', 'Monat', total.counts.declined, euro(total.declinedFeeCents), NOT_IN_BOOK],
    ['Abgelehnte Auftraege einzeln summiert', 'Monat', declined.length, euro(sum(declined)), 'Kontrollsumme ueber Blatt M'],
    ['Gebuehrenregel', 'Monat', '', '', 'idle_in_shift: Auftrag erreichte das leere Fahrzeug waehrend der Schicht'],
    ['Ablehnungsgebuehr je Auftrag', 'Einstellung', '', euro(s.declinedFeeCents), s.declinedRidesEnabled ? 'aktiv' : 'abgeschaltet'],
    ...group(r => r.driver.id ?? `name:${r.driver.name}`, r => r.driver.name, 'Fahrer'),
    ...group(r => r.vehicle.plate, r => r.vehicle.plate, 'Fahrzeug'),
  ];
}

export const SCHEDULING_HEADERS: readonly string[] = [
  'Art', 'Schicht', 'Tag', 'Kennzeichen', 'Fahrer-ID', 'Beginn', 'Geplantes Ende', 'Ende', 'Dauer (min)',
  'Schleife endete mit', 'Verworfene Versuche: keine Anfahrt', 'Verworfene Versuche: keine Zeit',
  'Verworfene Versuche: kein Zielort', 'Grund', 'Anzahl',
];

const END_WORD: Record<string, string> = {
  no_approach: 'keine passende Anfahrt',
  no_budget: 'Zeitfenster ausgeschoepft',
  no_dropoff: 'kein passender Zielort',
};

/** Accepted shifts with their loop's own refusals, then every refusal of a shift that was not placed. */
export function schedulingSheetRows(result: FullMonthResult): Row[] {
  const accepted = result.scheduling.map((s): Row => [
    'Schicht eingeplant', s.shiftId, s.day, s.plate, s.driverId ?? '', stamp(s.startMs), stamp(s.plannedEndMs), stamp(s.endMs),
    Math.round((s.endMs - s.startMs) / 60_000), END_WORD[s.endedBy] ?? s.endedBy, s.refusedSteps.no_approach ?? 0,
    s.refusedSteps.no_budget ?? 0, s.refusedSteps.no_dropoff ?? 0, '', 1,
  ]);
  const counts = new Map<string, { day: string; plate: string; driverId: string; reason: string; n: number }>();
  for (const r of result.refusals) {
    const key = `${r.day}|${r.plate ?? ''}|${r.driverId ?? ''}|${r.reason}`;
    const entry = counts.get(key) ?? { day: r.day, plate: r.plate ?? '', driverId: r.driverId ?? '', reason: r.reason, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  const refused = [...counts.values()].map((c): Row => [
    'Versuch verworfen', '', c.day, c.plate, c.driverId, '', '', '', '', '', '', '', '', REASON_TEXT[c.reason] ?? c.reason, c.n,
  ]);
  return [[...SCHEDULING_HEADERS], ...accepted, ...refused];
}

export function buildOperationalReport(result: FullMonthResult, verification: MonthVerification = verifyMonth(result)): OperationalReport {
  const payload = assemblePayload([
    [SHEET_LEGS, legsSheetRows(result)],
    [SHEET_DECLINED_INTERNAL, declinedInternalSheetRows(result)],
    [SHEET_INTERNAL_REVENUE, internalRevenueSheetRows(result)],
    [SHEET_SCHEDULING, schedulingSheetRows(result)],
    [SHEET_SOURCE, sourceSheetRows(result, verification)],
  ]);
  return { fileName: reportFileName('Betriebsbericht', result, verification), payload };
}
