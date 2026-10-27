import * as XLSX from 'xlsx';
import { FAHRTENBUCH_ORIGINAL_COLUMNS } from '../fahrtenbuchExport';
import type { RawRow } from '../fahrtenbuchImportParser';
import { addSimulatedNotice, simulatedFileName } from './marker';
import { formatStamp, operatingDayOf } from './time';
import type { GeoPoint, SimRide } from './types';

/** How the export writes an empty cell. */
const EMPTY = '\\N';

/**
 * The word each status is written as in `Fahrtstatus`.
 *
 * `abgeschlossen` and `storniert` are the two the importer knows:
 * `COMPLETED_STATUS_WORDS` and `CANCELLED_STATUS_WORDS` in
 * `fahrtenbuchImportParser.ts`.
 *
 * **`abgelehnt` is deliberately in neither list, and that is the whole answer
 * to section 3's import question.** `mapTripStatus` returns `'unknown'` for a
 * word it does not know, which means the row is *stored and flagged for
 * review*, counted as neither completed nor cancelled, with `is_canceled`
 * false — so a declined ride that is re-imported enters **no** existing figure
 * on any screen or document. That is the honest state of the product: a third
 * ride status in the ledger is a migration, a CHECK change and a decision
 * about what a word in a customer's file means — the header of
 * `CANCELLED_STATUS_WORDS` says in so many words that widening a list is such
 * a decision — and it is not taken under an audit's name. Writing `storniert`
 * here instead would be worse than leaving it unknown: it would silently
 * merge declines into cancellations, which is exactly what section 3 forbids.
 */
const STATUS_WORDS: Readonly<Record<SimRide['status'], string>> = {
  completed: 'abgeschlossen',
  cancelled: 'storniert',
  declined: 'abgelehnt',
};

export const DECLINED_STATUS_WORD = STATUS_WORDS.declined;

const COLUMNS = FAHRTENBUCH_ORIGINAL_COLUMNS;
export const SIMULATED_SHEET_COLUMNS: readonly string[] = COLUMNS;

/** "51.21507 7.0108": latitude and longitude, a space between, no trailing zeros. */
export function formatPosition(p: GeoPoint): string {
  const n = (v: number) => String(Number(v.toFixed(7)));
  return `${n(p.lat)} ${n(p.lon)}`;
}

function stamp(ms: number | null, withMillis = false): string {
  return ms === null ? EMPTY : formatStamp(ms, withMillis);
}

/**
 * "Datum der Fahrt" is the ride's operating day, so a ride that starts between
 * midnight and 04:00 is dated the day before, the way the real export dates it.
 * `start_at` stays the ride's real start; this is the property the analysis
 * code reads it for.
 */
export function rideDate(ride: SimRide): string {
  return operatingDayOf(ride.startMs ?? ride.orderTransmittedMs);
}

/** One ride as the 18 columns of the Uber export, keyed by their header. */
export function rideToRow(ride: SimRide): RawRow {
  const values: Record<(typeof COLUMNS)[number], string | number> = {
    'Datum/Uhrzeit Auftragseingang': stamp(ride.orderReceivedMs),
    'Uhrzeit der Auftragsuebermittlung': stamp(ride.orderTransmittedMs, true),
    'Geplante Abholzeit': stamp(ride.plannedPickupMs),
    'Datum der Fahrt': rideDate(ride),
    Fahrtstatus: STATUS_WORDS[ride.status],
    'Standort des Fahrzeugs bei Auftragsuebermittlung': formatPosition(ride.vehiclePosition),
    'Uhrzeit des Fahrtbeginns': stamp(ride.startMs),
    'Uhrzeit des Fahrtendes': stamp(ride.endMs),
    Kennzeichen: ride.vehicle.plate,
    Fahrzeugtyp: ride.vehicle.type,
    Fahrername: ride.driver.name,
    Fahrpreis: ride.fare,
    Trinkgeld: ride.tip,
    Kilometer: ride.km,
    Zahlungsart: ride.payment,
    Abholort: ride.pickup.label,
    Zielort: ride.dropoff.label,
    'Vorreservierte Fahrt': ride.prebooked ? 'Ja' : 'Nein',
  };
  return Object.fromEntries(COLUMNS.map(column => [column, values[column]]));
}

export function ridesToRows(rides: readonly SimRide[]): RawRow[] {
  return rides.map(rideToRow);
}

export interface SimulatedFile {
  fileName: string;
  bytes: Uint8Array;
}

/**
 * The generated month as an .xlsx file: the ride sheet first, exactly the
 * export's 18 columns, and a second sheet that says the rides are simulated.
 * The importer reads the first sheet, so the rides take the normal import path.
 */
export function buildSimulatedWorkbookFile(rows: readonly RawRow[], year: number, month: number, seed: number): SimulatedFile {
  const ws = XLSX.utils.aoa_to_sheet([[...COLUMNS], ...rows.map(row => COLUMNS.map(c => row[c] ?? EMPTY))]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  addSimulatedNotice(wb, 'last');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
  const fileName = simulatedFileName(`Fahrtenbuch_${year}-${String(month).padStart(2, '0')}_${seed}.xlsx`);
  return { fileName, bytes };
}
