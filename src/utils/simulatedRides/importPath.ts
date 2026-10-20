import * as XLSX from 'xlsx';
import type { TripInsertRow } from '../../hooks/useFahrtenbuch';
import {
  applySourceRowKeys, buildTripRows, driverMatchInfo, findOrderTransmissionColumn, normalise, sha256HexOfBytes,
  type BuildStats, type CarMatchInfo, type ColMap, type DriverCandidate, type DriverMatchInfo, type RawRow,
} from '../fahrtenbuchImportParser';
import { buildSimulatedWorkbookFile, type SimulatedFile } from './sheet';

/**
 * The generated month, taken through the same steps a real file takes.
 *
 * Rows are written to an .xlsx, read back with the importer's own reader
 * (`raw: true`, first sheet), mapped by the 18 export headers and built into
 * trip rows by `buildTripRows`, so the parser, `start_at`, `source_row_key` and
 * the per-company file hash all run exactly as they do for an uploaded file.
 * Nothing here writes a trip row by hand. The import row that carries the rows
 * is created by the caller with `isSimulated: true`.
 */
export const UBER_COLUMN_MAP: ColMap = {
  trip_date: 'Datum der Fahrt',
  start_time: 'Uhrzeit des Fahrtbeginns',
  end_time: 'Uhrzeit des Fahrtendes',
  driver_name: 'Fahrername',
  car_identifier: 'Kennzeichen',
  price_amount: 'Fahrpreis',
  tip_amount: 'Trinkgeld',
  payment_method: 'Zahlungsart',
  route_start: 'Abholort',
  route_end: 'Zielort',
  description: 'Fahrzeugtyp',
};
const STATUS_COLUMN = 'Fahrtstatus';

export interface CarCandidate { id: string; plate: string }

export interface PreparedSimulatedImport {
  file: SimulatedFile;
  fileSha256: string;
  sheetName: string;
  headers: string[];
  trips: TripInsertRow[];
  stats: BuildStats;
  inFileDuplicates: number;
}

function matchCars(rows: readonly RawRow[], cars: readonly CarCandidate[]): Map<string, CarMatchInfo> {
  const plates = [...new Set(rows.map(r => String(r[UBER_COLUMN_MAP.car_identifier] ?? '').trim()).filter(Boolean))];
  return new Map(plates.map(plate => {
    const norm = normalise(plate);
    const found = cars.find(c => normalise(c.plate) === norm);
    return [plate, { matchedCarId: found?.id ?? null }];
  }));
}

function matchDrivers(rows: readonly RawRow[], drivers: readonly DriverCandidate[]): Map<string, DriverMatchInfo> {
  const names = [...new Set(rows.map(r => String(r[UBER_COLUMN_MAP.driver_name] ?? '').trim()).filter(Boolean))];
  return new Map(names.map(name => [name, driverMatchInfo(name, drivers)]));
}

export async function prepareSimulatedImport(args: {
  year: number;
  month: number;
  seed: number;
  rows: readonly RawRow[];
  drivers: readonly DriverCandidate[];
  cars: readonly CarCandidate[];
}): Promise<PreparedSimulatedImport> {
  const file = buildSimulatedWorkbookFile(args.rows, args.year, args.month, args.seed);
  // Read back like an upload: the first sheet, values as the file holds them.
  const wb = XLSX.read(file.bytes, { type: 'array', raw: true, cellDates: false });
  const sheetName = wb.SheetNames[0];
  const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: true }) as RawRow[];
  const headers = Object.keys(json[0] ?? {});

  const { built, stats } = buildTripRows({
    rows: json,
    colMap: UBER_COLUMN_MAP,
    statusCol: STATUS_COLUMN,
    orderTransmissionCol: findOrderTransmissionColumn(headers),
    driverMatches: matchDrivers(json, args.drivers),
    carMatches: matchCars(json, args.cars),
  });
  const keyed = await applySourceRowKeys(built);
  return {
    file,
    fileSha256: await sha256HexOfBytes(file.bytes),
    sheetName,
    headers,
    trips: keyed.rows,
    stats,
    inFileDuplicates: keyed.inFileDuplicates,
  };
}
