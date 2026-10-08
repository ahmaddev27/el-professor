/**
 * A `fahrtenbuch_trips` row as the Rückkehrpflicht checks read it.
 *
 * The ride's own times, status, vehicle and driver come from the Fahrtenanalyse
 * adapter (`analysisTripFromRow`), so both screens agree on when a ride
 * happened. The four fields only these checks need live in `raw_data_json`
 * alone and are read **by column name, never by position**: the export lists a
 * ride's end before its start in 96.8 % of rows, and a positional read swapped
 * them once already. The order time is read with the importer's own rules
 * (`classifyTimestampCell`, `wallTimeToInstant` in Europe/Berlin), so a wall
 * time the clocks skip or repeat is not guessed at: it is unreadable.
 */
import {
  SOURCE_TIME_ZONE,
  classifyTimestampCell,
  findOrderTransmissionColumn,
  normalise,
  wallTimeToInstant,
  type CellValue,
} from '../fahrtenbuchImportParser';
import { analysisTripFromRow } from '../tripAnalysis/adapter';
import type { TripRowForAnalysis } from '../tripAnalysis/types';
import { isInGermany } from './geo';
import type { CheckRide, LatLon, OrderTimeProblem, ParsedAddress, PositionProblem } from './types';

const POSITION_HEADERS = new Set([
  'standortdesfahrzeugsbeiauftragsuebermittlung',
  'standortdesfahrzeugsbeiauftragsbermittlung', // "…übermittlung": normalise drops the ü
]);
const KILOMETRE_HEADERS = new Set(['kilometer', 'km', 'strecke']);
const PREBOOKED_HEADERS = new Set(['vorreserviertefahrt']);

type Raw = Readonly<Record<string, unknown>>;

function cellBy(raw: Raw | null, matches: (header: string) => boolean): CellValue {
  if (!raw) return null;
  const key = Object.keys(raw).find(matches);
  if (key === undefined) return null;
  const value = raw[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
    ? value
    : null;
}

function isBlank(value: CellValue): boolean {
  return value === null || value === undefined || (typeof value === 'string' && (value.trim() === '' || value.trim() === '\\N'));
}

function orderTime(raw: Raw | null): { ms: number | null; problem: OrderTimeProblem | null } {
  const column = raw ? findOrderTransmissionColumn(Object.keys(raw)) : '';
  const value = column ? cellBy(raw, header => header === column) : null;
  if (isBlank(value)) return { ms: null, problem: 'missing' };
  const cell = classifyTimestampCell(value);
  if (cell.kind !== 'datetime') return { ms: null, problem: 'unparsed' };
  const instant = wallTimeToInstant(cell.wall, SOURCE_TIME_ZONE);
  return instant.kind === 'ok' ? { ms: instant.ms, problem: null } : { ms: null, problem: 'unparsed' };
}

/** "51.171290 7.083210" — latitude first, the export's own order. */
export function parsePosition(value: CellValue): { position: LatLon | null; problem: PositionProblem | null } {
  if (isBlank(value)) return { position: null, problem: 'missing' };
  // Whitespace, ";" or ", " between the two: a bare comma is a German decimal ("51,7" is one number, not two).
  const match = /^\s*(-?\d{1,3}(?:\.\d+)?)(?:\s+|\s*;\s*|,\s+)(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(value));
  if (!match) return { position: null, problem: 'unparsed' };
  const position = { lat: Number(match[1]), lon: Number(match[2]) };
  if (Math.abs(position.lat) > 90 || Math.abs(position.lon) > 180) return { position: null, problem: 'unparsed' };
  if (!isInGermany(position)) return { position, problem: 'outside_germany' };
  return { position, problem: null };
}

/** "12.5", "12,5", 12.5 → 12.5; anything else → null, never 0. */
export function parseKilometres(value: CellValue): number | null {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value).trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return null;
  const km = Number(text.replace(',', '.'));
  return Number.isFinite(km) ? km : null;
}

function parsePrebooked(value: CellValue): boolean | null {
  if (isBlank(value)) return null;
  const text = String(value).trim().toLowerCase();
  if (text === 'ja' || text === 'yes' || text === 'true') return true;
  if (text === 'nein' || text === 'no' || text === 'false') return false;
  return null;
}

// ── Addresses ────────────────────────────────────────────────────────────────

const COUNTRY = /^(deutschland|germany|de)$/;

function normaliseText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    // "Beethovenstr." ends a compound word, so there is no word boundary before it.
    .replace(/str\.(?=\s|$)/g, 'str')
    .replace(/(stra(ss)?e)\b/g, 'str')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "12", "12a", "12 a", "12-14" at the end of a street segment. */
const HOUSE_NUMBER = /\s(\d+\s?[a-z]?(?:\s?[-/]\s?\d+\s?[a-z]?)?)$/;

/**
 * "Konrad-Adenauer-Straße 12, 42651 Solingen, Deutschland", and the variant
 * with a place name in front ("Hauptbahnhof, Bahnhofstraße 1, 42651 …"). The
 * segment with the postal code names the city; the segment before it, if it
 * ends in a number, is the street.
 */
export function parseAddress(raw: string | null | undefined): ParsedAddress | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const segments = raw
    .split(',')
    .map(segment => normaliseText(segment))
    .filter(segment => segment !== '' && !COUNTRY.test(segment));
  const postalIndex = segments.findIndex(segment => /^\d{5}(\s|$)/.test(segment));
  const postalCode = postalIndex >= 0 ? segments[postalIndex].slice(0, 5) : null;
  const city = postalIndex >= 0 ? segments[postalIndex].slice(5).trim() || null : null;
  // The street is the last segment before the postal code (or of the whole address) that ends in a number,
  // so a place name in front — with or without a postal code — is passed over.
  const candidates = postalIndex >= 0 ? segments.slice(0, postalIndex) : segments;
  const streetSegment = [...candidates].reverse().find(segment => HOUSE_NUMBER.test(segment)) ?? null;
  const number = streetSegment ? HOUSE_NUMBER.exec(streetSegment) : null;
  return {
    raw,
    normalized: segments.join(', '),
    street: number && streetSegment ? streetSegment.slice(0, number.index).trim() || null : null,
    houseNumber: number ? number[1].replace(/\s/g, '') : null,
    postalCode,
    city,
  };
}

export function checkRideFromRow(row: TripRowForAnalysis): CheckRide {
  const trip = analysisTripFromRow(row);
  const raw = (row.raw_data_json ?? null) as Raw | null;
  const order = orderTime(raw);
  const position = parsePosition(cellBy(raw, header => POSITION_HEADERS.has(normalise(header))));
  return {
    id: row.id,
    vehicle: trip.vehicle,
    driverName: trip.driver_name,
    status: trip.status,
    startMs: trip.start_ms,
    endMs: trip.end_ms,
    orderMs: order.ms,
    orderProblem: order.problem,
    position: position.position,
    positionProblem: position.problem,
    km: parseKilometres(cellBy(raw, header => KILOMETRE_HEADERS.has(normalise(header)))),
    prebooked: parsePrebooked(cellBy(raw, header => PREBOOKED_HEADERS.has(normalise(header)))),
    pickup: parseAddress(row.route_start),
    dropoff: parseAddress(row.route_end),
    sourceRow: row.source_row_index,
  };
}
