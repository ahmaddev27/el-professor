/**
 * Invented rows for the Fahrtenanalyse screen (Fahrtenbuch plan, slice D).
 *
 * Kept in a folder of its own, like batch 3's, so the branches built in
 * parallel do not edit the same lines: `fakes/supabase.ts` appends these
 * tables to its store and asks this module for its failures, and only while
 * the harness shows this screen, so every other batch's shots keep the rows
 * they were taken with.
 *
 * The company is the design preview's (`src/design-preview/sampleData.ts`).
 * What is new here is one August 2026 of imported rides written the way slice
 * A stores them — `start_at` / `end_at` as absolute Europe/Berlin instants,
 * an explicit `trip_status`, a `currency` — plus the two tables of
 * 20260922110000 and the saved Stundennachweise the shifts come from.
 *
 * The rides are built to show every state the screen has to draw, and each
 * one is commented with the finding it produces. Nothing here is computed by
 * the product's engines and nothing here is a real company.
 */
import { PREVIEW_DRIVERS, PREVIEW_VEHICLES } from '../../src/design-preview/sampleData';
import type { Row } from '../fixtures';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID } from '../scenario';

// ── Which screen, and which state of it ──────────────────────────────────────

/**
 * `scenario.ts` knows batch 1's screens only and falls back to Fahrzeuge for
 * any other name, so this screen and its own data states are read from the
 * query string directly (as batch 3 does).
 *
 *   screen=fahrtenanalyse
 *   data   default     | one August import, everything below
 *          empty       | no import for the month on screen
 *          error       | every read of this screen's tables fails
 *          no-settings | the company has not decided the two settings
 *          no-budget   | no driver_month_budget row for the month
 *          two-files   | two imports for the month, so the file picker shows
 */
export type AnalysisData = 'default' | 'empty' | 'error' | 'no-settings' | 'no-budget' | 'two-files';

const params = new URLSearchParams(window.location.search);
export const isAnalysisScreen = params.get('screen') === 'fahrtenanalyse';

const requestedData = params.get('data') ?? 'default';
export const analysisData: AnalysisData = (
  ['default', 'empty', 'error', 'no-settings', 'no-budget', 'two-files'] as const
).includes(requestedData as AnalysisData)
  ? (requestedData as AnalysisData)
  : 'default';

/** The tables this screen reads and writes; a scenario fails every one of them. */
const ANALYSIS_TABLES = new Set([
  'fahrtenbuch_imports',
  'fahrtenbuch_trips',
  'drivers',
  'saved_stundennachweise',
  'trip_analysis_settings',
  'driver_month_budget',
]);

/** The failure `data=error` asks for, on every table this screen reads. */
export function analysisFailure(table: string): { message: string; code: string } | null {
  if (!isAnalysisScreen || analysisData !== 'error' || !ANALYSIS_TABLES.has(table)) return null;
  return { message: 'TypeError: Failed to fetch', code: '' };
}

// ── The month ────────────────────────────────────────────────────────────────

const YEAR = 2026;
const MONTH = 8;
/** August is summer time in Berlin, so every instant below carries +02:00. */
const OFFSET = '+02:00';

const pad = (value: number) => String(value).padStart(2, '0');

/** A Berlin wall-clock time of August 2026 as the `timestamptz` text PostgREST returns. */
const at = (day: number, hour: number, minute: number, second = 0) =>
  `${YEAR}-${pad(MONTH)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${OFFSET}`;

// ── Drivers ──────────────────────────────────────────────────────────────────

interface Pay {
  id: string;
  min: number | null;
  max: number | null;
  rate: number | null;
}

/**
 * Four of the preview's drivers. The first carries the plan's worked example
 * (1000 € ÷ 13,90 € = 71,94 h); the fourth has no pay figures at all, so its
 * budget is "nicht berechenbar" and the screen has to say so rather than
 * print a zero.
 */
const PAY: Pay[] = [
  { id: 'd01', min: 1000, max: 1500, rate: 13.9 },
  { id: 'd02', min: 1800, max: 2200, rate: 14.5 },
  { id: 'd03', min: 1200, max: 1400, rate: 13.9 },
  { id: 'd04', min: null, max: null, rate: null },
];

const nameOf = (id: string) => PREVIEW_DRIVERS.find(driver => driver.id === id)?.name ?? id;
const PLATE = PREVIEW_VEHICLES.slice(0, 3).map(vehicle => vehicle.plate);

function driverRows(): Row[] {
  return PAY.map((pay, index) => ({
    id: pay.id,
    company_id: HARNESS_COMPANY_ID,
    name: nameOf(pay.id),
    status: 'active',
    planning_min_salary: pay.min,
    planning_max_salary: pay.max,
    planning_hourly_rate: pay.rate,
    created_at: `${YEAR}-01-0${index + 1}T08:00:00${OFFSET}`,
  }));
}

// ── The imported rides ───────────────────────────────────────────────────────

interface RideSpec {
  day: number;
  driver: string | null;
  /** The name as the file spells it; a different spelling of one id is a finding. */
  driverName?: string;
  vehicle: string | null;
  from: [number, number];
  to: [number, number] | null;
  /** Across midnight: the end lands on the next day. */
  overnight?: boolean;
  price: string | null;
  status?: 'completed' | 'cancelled' | 'unknown';
  /** What this ride is here to show. */
  note: string;
}

/**
 * A working month for three drivers, plus the rows that produce each state
 * the screen draws. Every ride is a plausible city fare; the sums are not.
 */
function rideSpecs(): RideSpec[] {
  const specs: RideSpec[] = [];

  // Six ordinary working days per driver: three or four rides in a block, a
  // long pause, then a second block. These are the "bestanden" side.
  const pattern: Array<{ driver: string; vehicle: string; start: number }> = [
    { driver: 'd01', vehicle: PLATE[0], start: 7 },
    { driver: 'd02', vehicle: PLATE[1], start: 13 },
    { driver: 'd03', vehicle: PLATE[2], start: 9 },
  ];
  for (const day of [3, 4, 5, 6, 7, 10]) {
    for (const { driver, vehicle, start } of pattern) {
      for (const [index, offset] of [0, 55, 110, 240, 300].entries()) {
        const begin = start * 60 + offset;
        const length = 30 + ((day + index) % 4) * 8;
        specs.push({
          day,
          driver,
          vehicle,
          from: [Math.floor(begin / 60), begin % 60],
          to: [Math.floor((begin + length) / 60), (begin + length) % 60],
          price: (14 + ((day * 7 + index * 3) % 26) + 0.5).toFixed(2),
          note: 'ordinary ride',
        });
      }
    }
  }

  // One driver in two rides at once: a conflict, the strongest finding.
  specs.push({
    day: 11, driver: 'd01', vehicle: PLATE[0], from: [8, 0], to: [8, 50],
    price: '23.40', note: 'driver_overlap A',
  });
  specs.push({
    day: 11, driver: 'd01', vehicle: PLATE[1], from: [8, 30], to: [9, 10],
    price: '18.90', note: 'driver_overlap B — and a vehicle change inside the overlap',
  });

  // Two drivers in one vehicle at once: vehicle_overlap.
  specs.push({
    day: 12, driver: 'd02', vehicle: PLATE[2], from: [14, 0], to: [14, 40],
    price: '21.00', note: 'vehicle_overlap A',
  });
  specs.push({
    day: 12, driver: 'd03', vehicle: PLATE[2], from: [14, 20], to: [15, 0],
    price: '19.50', note: 'vehicle_overlap B',
  });

  // Four minutes between two rides across the city: too short for the margin,
  // and with no routing service the engine answers "nicht prüfbar".
  specs.push({
    day: 13, driver: 'd02', vehicle: PLATE[1], from: [15, 0], to: [15, 36],
    price: '26.80', note: 'travel_gap, first leg',
  });
  specs.push({
    day: 13, driver: 'd02', vehicle: PLATE[1], from: [15, 40], to: [16, 5],
    price: '17.20', note: 'travel_gap, second leg',
  });

  // A ride over midnight: it must not be split, and it appears on both days
  // of the timeline.
  specs.push({
    day: 14, driver: 'd03', vehicle: PLATE[2], from: [23, 30], to: [0, 25], overnight: true,
    price: '38.60', note: 'across midnight',
  });

  // The rows that go to review, each kept and none invented away.
  specs.push({
    day: 17, driver: 'd01', vehicle: PLATE[0], from: [9, 0], to: null,
    price: '15.00', note: 'missing_end',
  });
  specs.push({
    day: 17, driver: 'd02', vehicle: null, from: [16, 0], to: [16, 30],
    price: '12.50', note: 'missing_vehicle',
  });
  specs.push({
    day: 18, driver: 'd03', vehicle: PLATE[2], from: [11, 0], to: [11, 45],
    price: '20.00', status: 'unknown', note: 'status_unknown',
  });
  specs.push({
    day: 18, driver: 'd01', vehicle: PLATE[0], from: [12, 0], to: [12, 30],
    price: '5.00', status: 'cancelled', note: 'cancelled, with a cancellation fee',
  });
  specs.push({
    day: 19, driver: 'd01', driverName: 'M. Yildiz', vehicle: PLATE[0], from: [7, 30], to: [8, 5],
    price: '16.40', note: 'driver_name_mismatch — one id, two spellings',
  });

  // A driver the import could not match: no id at all, and one id the company
  // does not know. Both are listed beside the table, never counted into it.
  specs.push({
    day: 20, driver: null, driverName: 'Gastfahrer Nachtschicht', vehicle: PLATE[1], from: [22, 0], to: [22, 40],
    price: '24.00', note: 'missing_driver',
  });
  specs.push({
    day: 20, driver: 'd09', driverName: 'Ewa Kowalczyk', vehicle: PLATE[1], from: [23, 0], to: [23, 35],
    price: '22.10', note: 'a driver id that is not one of the company drivers',
  });

  // A fourth driver with no pay figures, so the budget is not computable.
  for (const day of [21, 24]) {
    for (const offset of [0, 70]) {
      const begin = 10 * 60 + offset;
      specs.push({
        day, driver: 'd04', vehicle: PLATE[0],
        from: [Math.floor(begin / 60), begin % 60],
        to: [Math.floor((begin + 45) / 60), (begin + 45) % 60],
        price: '19.90', note: 'budget_not_computable',
      });
    }
  }

  return specs;
}

const IMPORT_ID = 'ta-import-2026-08';
const SECOND_IMPORT_ID = 'ta-import-2026-08-korrektur';

function tripRows(importId: string): Row[] {
  return rideSpecs().map((spec, index) => {
    const endDay = spec.overnight ? spec.day + 1 : spec.day;
    const status = spec.status ?? 'completed';
    return {
      id: `${importId}-t${pad(index + 1)}`,
      company_id: HARNESS_COMPANY_ID,
      import_id: importId,
      trip_date: `${YEAR}-${pad(MONTH)}-${pad(spec.day)}`,
      start_time: `${pad(spec.from[0])}:${pad(spec.from[1])}:00`,
      end_time: spec.to ? `${pad(spec.to[0])}:${pad(spec.to[1])}:00` : null,
      start_at: at(spec.day, spec.from[0], spec.from[1]),
      end_at: spec.to ? at(endDay, spec.to[0], spec.to[1]) : null,
      time_zone: 'Europe/Berlin',
      time_source: spec.to ? 'file' : 'missing',
      trip_status: status,
      is_canceled: status === 'cancelled',
      source_status: status === 'cancelled' ? 'Storniert' : status === 'unknown' ? 'Unklar' : 'Abgeschlossen',
      needs_review: status !== 'completed' || !spec.to || !spec.vehicle || !spec.driver,
      review_reasons: null,
      original_driver_id: spec.driver,
      original_driver_name: spec.driverName ?? (spec.driver ? nameOf(spec.driver) : null),
      car_identifier: spec.vehicle,
      route_start: 'Berlin',
      route_end: 'Berlin',
      price_amount: spec.price,
      currency: 'EUR',
      currency_source: 'assumed',
      source_row_index: index + 2,
      source_row_key: `${importId}:${index + 1}`,
      raw_data_json: null,
    };
  });
}

function importRows(): Row[] {
  const rows: Row[] = [
    {
      id: IMPORT_ID,
      company_id: HARNESS_COMPANY_ID,
      month: MONTH,
      year: YEAR,
      file_name: '2026-08_Fahrtenbuch_Uber.xlsx',
      imported_at: `${YEAR}-09-01T09:14:00${OFFSET}`,
      row_count: rideSpecs().length,
      status: 'completed',
    },
  ];
  if (analysisData === 'two-files') {
    rows.push({
      id: SECOND_IMPORT_ID,
      company_id: HARNESS_COMPANY_ID,
      month: MONTH,
      year: YEAR,
      file_name: '2026-08_Fahrtenbuch_Uber_Korrektur.xlsx',
      imported_at: `${YEAR}-09-03T11:02:00${OFFSET}`,
      row_count: rideSpecs().length,
      status: 'completed',
    });
  }
  return rows;
}

// ── The recorded working time ────────────────────────────────────────────────

/**
 * Saved Stundennachweise for two of the three regular drivers, in the shape
 * `MonatsplanungStundennachweisPreview` writes: one row per day with up to
 * three von/bis pairs and a `date_key`. The third driver has none, so the
 * screen shows "Kein gespeicherter Stundennachweis" instead of a zero, and
 * one recorded day carries no ride at all.
 */
function savedRows(): Row[] {
  const days = [3, 4, 5, 6, 7, 10];
  const make = (driver: string, von: string, bis: string, extraDay: number | null) => ({
    id: `ta-sn-${driver}`,
    company_id: HARNESS_COMPANY_ID,
    driver_id: driver,
    driver_name: nameOf(driver),
    month: MONTH,
    year: YEAR,
    rows_json: [
      ...days.map(day => ({
        date_key: `${YEAR}-${pad(MONTH)}-${pad(day)}`,
        von1: von,
        bis1: bis,
        von2: '',
        bis2: '',
        von3: '',
        bis3: '',
      })),
      // A recorded day with no ride: "Dienst ohne Fahrt".
      ...(extraDay === null
        ? []
        : [{ date_key: `${YEAR}-${pad(MONTH)}-${pad(extraDay)}`, von1: '08:00', bis1: '12:00', von2: '', bis2: '', von3: '', bis3: '' }]),
    ],
  });
  return [make('d01', '07:00', '13:00', 25), make('d02', '13:00', '19:00', null)];
}

// ── The two tables of 20260922110000 ─────────────────────────────────────────

function settingsRows(): Row[] {
  if (analysisData === 'no-settings') return [];
  return [
    {
      id: 'ta-settings',
      company_id: HARNESS_COMPANY_ID,
      block_gap_minutes: 45,
      travel_margin_minutes: 10,
      updated_by: HARNESS_USER_ID,
      created_at: `${YEAR}-09-01T09:00:00${OFFSET}`,
      updated_at: `${YEAR}-09-01T09:00:00${OFFSET}`,
    },
  ];
}

/**
 * One confirmed month whose driver's pay has since changed ("Eingaben
 * geändert"), and one confirmed month that still matches. The third and
 * fourth drivers have no row at all, which is "nicht bestätigt" — the
 * current figures are used and the screen says so.
 */
function budgetRows(): Row[] {
  if (analysisData === 'no-budget') return [];
  return [
    {
      id: 'ta-budget-d01',
      company_id: HARNESS_COMPANY_ID,
      driver_id: 'd01',
      year: YEAR,
      month: MONTH,
      reserved_hours: 8,
      // The driver now earns 1000–1500 at 13,90; the month was confirmed at 13,50.
      planning_min_salary: 1000,
      planning_max_salary: 1500,
      planning_hourly_rate: 13.5,
      confirmed_by: HARNESS_USER_ID,
      confirmed_at: `${YEAR}-09-01T10:12:00${OFFSET}`,
      recompute_log: [],
      updated_at: `${YEAR}-09-01T10:12:00${OFFSET}`,
    },
    {
      id: 'ta-budget-d02',
      company_id: HARNESS_COMPANY_ID,
      driver_id: 'd02',
      year: YEAR,
      month: MONTH,
      reserved_hours: 0,
      planning_min_salary: 1800,
      planning_max_salary: 2200,
      planning_hourly_rate: 14.5,
      confirmed_by: HARNESS_USER_ID,
      confirmed_at: `${YEAR}-09-01T10:14:00${OFFSET}`,
      recompute_log: [
        { kind: 'reserve', at: `${YEAR}-09-02T08:30:00${OFFSET}`, by: HARNESS_USER_ID, previous: { reserved_hours: 4 }, reserved_hours: 0 },
      ],
      updated_at: `${YEAR}-09-02T08:30:00${OFFSET}`,
    },
  ];
}

// ── What the store gets ──────────────────────────────────────────────────────

/**
 * This screen's tables, and only while it is on screen; every other batch's
 * shots keep the rows they were taken with. `empty` leaves the month without
 * an import, which is the state the screen has to distinguish from a failed
 * read.
 */
export function analysisTables(): Array<[string, Row[]]> {
  if (!isAnalysisScreen) return [];
  const empty = analysisData === 'empty';
  const trips = [...tripRows(IMPORT_ID), ...(analysisData === 'two-files' ? tripRows(SECOND_IMPORT_ID) : [])];
  return [
    ['drivers', driverRows()],
    ['fahrtenbuch_imports', empty ? [] : importRows()],
    ['fahrtenbuch_trips', empty ? [] : trips],
    ['saved_stundennachweise', empty ? [] : savedRows()],
    ['trip_analysis_settings', empty ? [] : settingsRows()],
    ['driver_month_budget', empty ? [] : budgetRows()],
  ];
}
