/**
 * The empty drives of a Monatsabschluss (sheet 5, "Fahrzeuge und Leerfahrten"),
 * read back by column name and written as the CSV the auditor feeds into his
 * own routing engine (FleetBook round 8, section 11).
 *
 * Every drive carries the coordinates both its ends were routed between, so no
 * address has to be geocoded twice and two geocoders cannot place one address
 * differently (round 4's largest cause of disagreement). The base legs and the
 * return legs are rows like any other: a shift that returns to the base and
 * has no `to_base` row is a defect, not a quiet omission.
 *
 * Pure: no network, no file system. The script does the routing.
 */
import { classifyTransition, type CheckResult, type GeocodeLookup, type RouteLookup } from './routeAudit.mts';

export interface ClosingLeg {
  readonly legId: string;
  readonly shiftId: string;
  readonly vehicle: string;
  readonly driver: string;
  /** The German word sheet 5 prints, e.g. "Rueckkehr zum Betriebssitz". */
  readonly purpose: string;
  readonly from: { readonly label: string; readonly lat: number; readonly lon: number };
  readonly to: { readonly label: string; readonly lat: number; readonly lon: number };
  readonly departure: string;
  readonly arrival: string;
  /** Null when the generator could not route it ("nicht geroutet"). */
  readonly ourSeconds: number | null;
  readonly ourKm: number | null;
  readonly availableSeconds: number;
  readonly provider: string;
  readonly status: string;
}

export const RETURN_PURPOSE = 'Rueckkehr zum Betriebssitz';
export const BASE_PURPOSE = 'Abfahrt vom Betriebssitz';

const COLUMNS = {
  kind: 'Zeilenart', legId: 'Leerfahrt-ID', shiftId: 'Schicht-ID', vehicle: 'Fahrzeug', driver: 'Fahrer', purpose: 'Zweck',
  from: 'Start', fromLat: 'Start Breite', fromLon: 'Start Laenge', to: 'Ziel', toLat: 'Ziel Breite', toLon: 'Ziel Laenge',
  departure: 'Abfahrt', arrival: 'Ankunft', seconds: 'Fahrzeit (s)', km: 'Leer-km', available: 'Verfuegbar (s)',
  provider: 'Anbieter', status: 'Status',
} as const;

/** A number cell, or NaN; an empty or worded cell ("nicht geroutet") is NaN, never 0. */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || v.trim() === '') return Number.NaN;
  return Number(v.trim());
}

/** The sheet's Leerfahrt rows; throws when a column the CSV needs is missing. */
export function legsFromVehicleSheet(rows: readonly (readonly unknown[])[]): ClosingLeg[] {
  const head = (rows[0] ?? []).map((h) => String(h ?? ''));
  const at = {} as Record<keyof typeof COLUMNS, number>;
  for (const [key, name] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    at[key] = head.indexOf(name);
    if (at[key] < 0) throw new Error(`sheet 5 has no column "${name}"`);
  }
  const text = (r: readonly unknown[], k: keyof typeof COLUMNS) => String(r[at[k]] ?? '');
  return rows.slice(1).filter((r) => r[at.kind] === 'Leerfahrt').map((r) => {
    const seconds = num(r[at.seconds]);
    const km = num(r[at.km]);
    return {
      legId: text(r, 'legId'), shiftId: text(r, 'shiftId'), vehicle: text(r, 'vehicle'), driver: text(r, 'driver'),
      purpose: text(r, 'purpose'),
      from: { label: text(r, 'from'), lat: num(r[at.fromLat]), lon: num(r[at.fromLon]) },
      to: { label: text(r, 'to'), lat: num(r[at.toLat]), lon: num(r[at.toLon]) },
      departure: text(r, 'departure'), arrival: text(r, 'arrival'),
      ourSeconds: Number.isFinite(seconds) ? seconds : null, ourKm: Number.isFinite(km) ? km : null,
      availableSeconds: num(r[at.available]), provider: text(r, 'provider'), status: text(r, 'status'),
    };
  });
}

const validPoint = (p: { lat: number; lon: number }) =>
  Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0);

/** The end as a lookup, so the shared classifier treats a broken coordinate as "not located". */
export function pointLookup(p: { lat: number; lon: number }): GeocodeLookup {
  return validPoint(p) ? { kind: 'located', lat: p.lat, lon: p.lon } : { kind: 'unlocated', reason: 'coordinates_invalid' };
}

/** A re-route of one drive by another engine, judged against the same available time. */
export function recheckLeg(leg: ClosingLeg, route: RouteLookup | undefined): CheckResult {
  return classifyTransition({ availableSeconds: leg.availableSeconds, fromText: leg.from.label, toText: leg.to.label },
    pointLookup(leg.from), pointLookup(leg.to), route);
}

/**
 * Shifts without exactly one drive back to the base: the defect a
 * return-to-base month must not hold. Every shift with a completed ride has
 * drives, and its return is recorded even when it ends at the base (0 km).
 */
export function shiftsWithoutReturn(legs: readonly ClosingLeg[]): string[] {
  const back = new Map<string, number>();
  for (const l of legs) back.set(l.shiftId, (back.get(l.shiftId) ?? 0) + (l.purpose === RETURN_PURPOSE ? 1 : 0));
  return [...back].filter(([, n]) => n !== 1).map(([s]) => s);
}

export const LEG_CSV_HEADERS = [
  'LegId', 'ShiftId', 'Vehicle', 'Driver', 'Purpose', 'Departure', 'Arrival',
  'FromLat', 'FromLon', 'ToLat', 'ToLon', 'AvailableSeconds',
  'OurProvider', 'OurSeconds', 'OurKm', 'OurMarginSeconds', 'OurStatus',
  'RecheckSeconds', 'RecheckKm', 'RecheckMarginSeconds', 'RecheckStatus', 'RecheckReason',
  'From', 'To',
] as const;

/** One CSV row per drive; `alias` replaces names, `route` is the re-route of that drive or undefined. */
export function legCsvRow(leg: ClosingLeg, route: RouteLookup | undefined, alias: (kind: 'vehicle' | 'driver', name: string) => string): (string | number)[] {
  const re = recheckLeg(leg, route);
  const ourMargin = leg.ourSeconds === null ? '' : Math.round(leg.availableSeconds - leg.ourSeconds);
  return [
    leg.legId, leg.shiftId, alias('vehicle', leg.vehicle), alias('driver', leg.driver), leg.purpose, leg.departure, leg.arrival,
    leg.from.lat, leg.from.lon, leg.to.lat, leg.to.lon, leg.availableSeconds,
    leg.provider, leg.ourSeconds ?? '', leg.ourKm ?? '', ourMargin, leg.status,
    re.roadSeconds ?? '', re.roadKm ?? '', re.marginSeconds ?? '', re.status, re.reason,
    leg.from.label, leg.to.label,
  ];
}
