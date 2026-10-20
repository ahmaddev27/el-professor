import * as XLSX from 'xlsx';
import { FAHRTENBUCH_ORIGINAL_COLUMNS } from '../fahrtenbuchExport';
import type { RawRow } from '../fahrtenbuchImportParser';
import { addSimulatedNotice, simulatedFileName } from './marker';
import { formatStamp, operatingDayOf } from './time';
import type { GeoPoint, SimRide } from './types';

/** How the export writes an empty cell. */
const EMPTY = '\\N';

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
function rideDate(ride: SimRide): string {
  return operatingDayOf(ride.startMs ?? ride.orderTransmittedMs);
}

/** One ride as the 18 columns of the Uber export, keyed by their header. */
export function rideToRow(ride: SimRide): RawRow {
  const values: Record<(typeof COLUMNS)[number], string | number> = {
    'Datum/Uhrzeit Auftragseingang': stamp(ride.orderReceivedMs),
    'Uhrzeit der Auftragsuebermittlung': stamp(ride.orderTransmittedMs, true),
    'Geplante Abholzeit': stamp(ride.plannedPickupMs),
    'Datum der Fahrt': rideDate(ride),
    Fahrtstatus: ride.status === 'completed' ? 'abgeschlossen' : 'storniert',
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
