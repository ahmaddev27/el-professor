/**
 * Invented rows for phase 5 batch 3: Dokumente, Monatsplanung, Stundennachweis.
 *
 * Kept out of the shared fixtures.ts so the batches built in parallel do not
 * edit the same lines; fakes/supabase.ts appends these tables to its store,
 * and only when the harness shows one of this batch's screens, so batch 1's
 * shots keep the rows they were taken with.
 *
 * The company is the design preview's (src/design-preview/sampleData.ts): its
 * drivers, its vehicles, its "today" of 14.09.2026. What is new here is the
 * payroll side: a month of Fahrtenbuch rides per import, an applied planning
 * run for August 2026 with its rides assigned, and saved Stundennachweise for
 * July and August. The figures are plausible, not statutory — nothing here is
 * computed by the product's engines, and nothing here is a real company.
 */
import { PREVIEW_DRIVERS, PREVIEW_VEHICLES } from '../../src/design-preview/sampleData';
import type { Row } from '../fixtures';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID, scenario } from '../scenario';

// ── Which screen ─────────────────────────────────────────────────────────────

/**
 * scenario.ts knows batch 1's screens only, and falls back to Fahrzeuge for any
 * other name; that fallback decides nothing here but which table batch 1's
 * error scenarios act on, and this batch uses none of them. So the screen is
 * read from the query string directly.
 */
export type Batch3Screen = 'dokumente' | 'monatsplanung' | 'stundennachweis';

const params = new URLSearchParams(window.location.search);
const requested = params.get('screen');
export const batch3Screen: Batch3Screen | null =
  requested === 'dokumente' || requested === 'monatsplanung' || requested === 'stundennachweis' ? requested : null;

/** `entry=archiv` opens the Stundennachweis sheet the way Dokumente's "Öffnen" does. */
export const batch3Entry = params.get('entry');

const empty = scenario.data === 'empty';

// ── A small deterministic random source ─────────────────────────────────────

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const pad = (value: number) => String(value).padStart(2, '0');
const isoDate = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const daysIn = (year: number, month: number) => new Date(year, month, 0).getDate();
const weekday = (year: number, month: number, day: number) => new Date(year, month - 1, day).getDay();

// ── Drivers ─────────────────────────────────────────────────────────────────

interface PlanningProfile {
  id: string;
  personalnummer: string;
  window: [string, string] | null;
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  maxDaily: number;
  targetMonthly: number | null;
  salary: [number, number];
  usage: 'regular' | 'coverage_only';
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const SIX_DAYS = [1, 2, 3, 4, 5, 6];

const PROFILES: PlanningProfile[] = [
  { id: 'd01', personalnummer: '1001', window: ['06:00', '16:00'], days: WEEKDAYS, maxDaily: 9, targetMonthly: 160, salary: [2250, 2350], usage: 'regular' },
  { id: 'd02', personalnummer: '1002', window: ['12:00', '23:00'], days: SIX_DAYS, maxDaily: 9, targetMonthly: 150, salary: [2150, 2250], usage: 'regular' },
  { id: 'd03', personalnummer: '1003', window: ['05:30', '15:30'], days: WEEKDAYS, maxDaily: 8.5, targetMonthly: 140, salary: [1950, 2050], usage: 'regular' },
  { id: 'd04', personalnummer: '1004', window: ['06:00', '14:00'], days: SIX_DAYS, maxDaily: 8, targetMonthly: 130, salary: [1800, 1900], usage: 'regular' },
  { id: 'd05', personalnummer: '1005', window: ['13:00', '23:30'], days: WEEKDAYS, maxDaily: 9, targetMonthly: 150, salary: [2100, 2200], usage: 'regular' },
  { id: 'd06', personalnummer: '1006', window: ['07:00', '15:00'], days: [1, 3, 5], maxDaily: 8, targetMonthly: 70, salary: [980, 1050], usage: 'coverage_only' },
  // A profile with no working window: the pool marks it, and the Stundennachweis refuses to plan it.
  { id: 'd07', personalnummer: '1007', window: null, days: WEEKDAYS, maxDaily: 8, targetMonthly: 120, salary: [1650, 1750], usage: 'regular' },
  { id: 'd08', personalnummer: '1008', window: ['15:00', '23:59'], days: [4, 5, 6], maxDaily: 8.5, targetMonthly: null, salary: [900, 1000], usage: 'coverage_only' },
];

const HOURLY_RATE = 13.9;
const nameOf = (id: string) => PREVIEW_DRIVERS.find(driver => driver.id === id)?.name ?? id;

/** The owner drives when nobody else can; the planning treats her as Inhaberin. */
const OWNER_ID = 'd20';
const OWNER_NAME = 'Katrin Lindner';

function driverRows(): Row[] {
  const employees = PROFILES.map(profile => ({
    id: profile.id,
    company_id: HARNESS_COMPANY_ID,
    name: nameOf(profile.id),
    status: 'active',
    personalnummer: profile.personalnummer,
    gender: profile.id === 'd02' || profile.id === 'd06' ? 'female' : 'male',
    work_window_start: profile.window?.[0] ?? null,
    work_window_end: profile.window?.[1] ?? null,
    planned_shift_start_time: profile.window?.[0] ?? null,
    planned_shift_end_time: profile.window?.[1] ?? null,
    allowed_weekdays: profile.days,
    is_full_day_available: false,
    max_daily_hours: profile.maxDaily,
    target_monthly_hours: profile.targetMonthly,
    max_monthly_hours: profile.targetMonthly == null ? null : profile.targetMonthly + 20,
    planning_hourly_rate: HOURLY_RATE,
    planning_target_salary: (profile.salary[0] + profile.salary[1]) / 2,
    planning_min_salary: profile.salary[0],
    planning_max_salary: profile.salary[1],
    planning_enabled: true,
    driver_usage_type: profile.usage,
    employment_type: 'employee',
    notes: profile.id === 'd04' ? 'Fährt nur Fahrzeuge mit Automatik.' : null,
  }));
  const owner = {
    id: OWNER_ID,
    company_id: HARNESS_COMPANY_ID,
    name: OWNER_NAME,
    status: 'active',
    personalnummer: '1000',
    gender: 'female',
    work_window_start: null,
    work_window_end: null,
    allowed_weekdays: [1, 2, 3, 4, 5, 6, 7],
    is_full_day_available: true,
    max_daily_hours: 10,
    target_monthly_hours: null,
    planning_hourly_rate: null,
    planning_enabled: true,
    driver_usage_type: 'coverage_only',
    employment_type: 'company_owner',
    notes: null,
  };
  return [...employees, owner];
}

// ── Fahrtenbuch imports and rides ────────────────────────────────────────────

/** Which vehicle each driver pair drives: the first takes the early block, the second the late one. */
const SHIFT_PAIRS: Array<{ vehicle: string; early: string; late: string }> = [
  { vehicle: 'v01', early: 'd01', late: 'd02' },
  { vehicle: 'v02', early: 'd03', late: 'd05' },
  { vehicle: 'v03', early: 'd04', late: 'd08' },
];

const plateOf = (vehicleId: string) => PREVIEW_VEHICLES.find(vehicle => vehicle.id === vehicleId)?.plate ?? vehicleId;

const STREETS = [
  'Alexanderplatz', 'Hauptbahnhof', 'Kurfürstendamm 21', 'Flughafen BER T1', 'Potsdamer Platz', 'Charité Mitte',
  'Messe Süd', 'Ostbahnhof', 'Hackescher Markt', 'Tempelhofer Damm 2', 'Schloßstraße 14', 'Frankfurter Allee 88',
];

interface ImportSpec {
  id: string;
  year: number;
  month: number;
  lastDay: number;
  importedAt: string;
  runId: string | null;
}

const IMPORTS: ImportSpec[] = [
  { id: 'imp-2026-09', year: 2026, month: 9, lastDay: 13, importedAt: '2026-09-14T07:40:00+02:00', runId: null },
  { id: 'imp-2026-08', year: 2026, month: 8, lastDay: 31, importedAt: '2026-09-02T16:05:00+02:00', runId: 'run-2026-08' },
];

/** Earlier imports that only name a file for the older planning runs; their rides are not in the store. */
const OLDER_IMPORTS = [
  { id: 'imp-2026-07', year: 2026, month: 7, importedAt: '2026-08-03T15:20:00+02:00', rows: 1184 },
  { id: 'imp-2026-06', year: 2026, month: 6, importedAt: '2026-07-02T14:55:00+02:00', rows: 1127 },
];

const MONTH_FILE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const fileName = (month: number, year: number) => `Fahrtenbuch_${MONTH_FILE[month - 1]}_${year}.xlsx`;

interface BuiltTrips {
  trips: Row[];
  blocks: number;
  assigned: number;
}

/** A day's rides for one vehicle: an early block and a late block, rides 12 to 38 minutes apart. */
function buildTrips(spec: ImportSpec): BuiltTrips {
  const next = random(spec.year * 100 + spec.month);
  const trips: Row[] = [];
  let blocks = 0;
  let assigned = 0;
  let rowIndex = 2;

  for (let day = 1; day <= spec.lastDay; day += 1) {
    if (weekday(spec.year, spec.month, day) === 0) continue; // the fleet rests on Sundays
    const date = isoDate(spec.year, spec.month, day);
    for (const pair of SHIFT_PAIRS) {
      const blockPlan: Array<{ driver: string; from: number; to: number }> = [
        { driver: pair.early, from: 6 * 60 + 10 + Math.floor(next() * 20), to: 11 * 60 + 30 + Math.floor(next() * 40) },
        { driver: pair.late, from: 15 * 60 + Math.floor(next() * 30), to: 20 * 60 + 30 + Math.floor(next() * 50) },
      ];
      for (const [blockIndex, block] of blockPlan.entries()) {
        blocks += 1;
        let clock = block.from;
        while (clock < block.to) {
          const duration = 12 + Math.floor(next() * 26);
          const start = clock;
          const end = Math.min(clock + duration, block.to);
          const canceled = next() < 0.03;
          const price = Math.round((9 + duration * 0.95 + next() * 6) * 100) / 100;
          const cash = next() < 0.55 ? price : 0;
          const tip = cash > 0 && next() < 0.3 ? Math.round(next() * 4 * 100) / 100 : 0;
          const driverId = block.driver;
          const onRun = spec.runId !== null && !canceled;
          if (onRun) assigned += 1;
          const from = STREETS[Math.floor(next() * STREETS.length)];
          const to = STREETS[Math.floor(next() * STREETS.length)];
          trips.push({
            id: `${spec.id}-t${String(trips.length + 1).padStart(4, '0')}`,
            company_id: HARNESS_COMPANY_ID,
            import_id: spec.id,
            trip_date: date,
            start_time: `${hhmm(start)}:00`,
            end_time: `${hhmm(end)}:00`,
            duration_minutes: end - start,
            original_driver_id: driverId,
            original_driver_name: nameOf(driverId),
            assigned_driver_id: onRun ? driverId : null,
            assigned_driver_name: onRun ? nameOf(driverId) : '',
            car_id: pair.vehicle,
            car_identifier: plateOf(pair.vehicle),
            route_start: from,
            route_end: to,
            description: null,
            price_amount: canceled ? 0 : price,
            cash_amount: canceled ? 0 : cash,
            online_amount: canceled ? 0 : Math.round((price - cash) * 100) / 100,
            tip_amount: canceled ? 0 : tip,
            action_amount: 0,
            raw_data_json: {
              Fahrername: nameOf(driverId),
              Kennzeichen: plateOf(pair.vehicle),
              Datum: `${pad(day)}.${pad(spec.month)}.${spec.year}`,
              Start: hhmm(start),
              Ende: hhmm(end),
              Status: canceled ? 'Storniert' : 'Abgeschlossen',
              Startadresse: from,
              Zieladresse: to,
              Fahrpreis: canceled ? '0,00' : price.toFixed(2).replace('.', ','),
            },
            plausibility_status: canceled ? 'canceled' : 'ok',
            is_canceled: canceled,
            source_status: canceled ? 'Storniert' : 'Abgeschlossen',
            assignment_reason: null,
            assignment_note: null,
            assignment_planning_run_id: onRun ? spec.runId : null,
            assignment_block_id: onRun ? `${spec.runId}-${pair.vehicle}-${date}-${blockIndex + 1}` : null,
            assignment_source: onRun ? 'planning' : null,
            confirmed_by: null,
            confirmed_at: null,
            source_row_index: rowIndex++,
            created_at: spec.importedAt,
            updated_at: spec.importedAt,
          });
          clock = end + 3 + Math.floor(next() * 22);
        }
      }
    }
  }
  return { trips, blocks, assigned };
}

const BUILT = new Map(IMPORTS.map(spec => [spec.id, buildTrips(spec)]));

function importRows(): Row[] {
  const recent = IMPORTS.map(spec => ({
    id: spec.id,
    company_id: HARNESS_COMPANY_ID,
    month: spec.month,
    year: spec.year,
    file_name: fileName(spec.month, spec.year),
    imported_by: HARNESS_USER_ID,
    imported_at: spec.importedAt,
    status: 'confirmed',
    row_count: BUILT.get(spec.id)?.trips.length ?? 0,
    notes: null,
    source_columns_json: ['Datum', 'Start', 'Ende', 'Kennzeichen', 'Fahrername', 'Status', 'Startadresse', 'Zieladresse', 'Fahrpreis'],
    source_sheet_name: 'Fahrten',
    storage_path: `${HARNESS_COMPANY_ID}/${spec.id}.xlsx`,
  }));
  const older = OLDER_IMPORTS.map(item => ({
    id: item.id,
    company_id: HARNESS_COMPANY_ID,
    month: item.month,
    year: item.year,
    file_name: fileName(item.month, item.year),
    imported_by: HARNESS_USER_ID,
    imported_at: item.importedAt,
    status: 'confirmed',
    row_count: item.rows,
    notes: null,
    source_columns_json: null,
    source_sheet_name: 'Fahrten',
    storage_path: `${HARNESS_COMPANY_ID}/${item.id}.xlsx`,
  }));
  return [...recent, ...older];
}

// ── Planning runs ────────────────────────────────────────────────────────────

function planningRunRows(): Row[] {
  const august = BUILT.get('imp-2026-08')!;
  const run = (id: string, month: number, importId: string, appliedAt: string, updated: number, blocks: number, workTimeExceptions: number) => ({
    id,
    company_id: HARNESS_COMPANY_ID,
    month,
    year: 2026,
    import_id: importId,
    status: 'applied',
    applied_at: appliedAt,
    applied_by: HARNESS_USER_ID,
    apply_summary_json: { updated_trips: updated, dienstzeit_exceptions_count: workTimeExceptions, tageslimit_exceptions_count: 0 },
    settings_json: { block_separator_gap_minutes: 60, min_block_duration_minutes: 30, max_block_duration_minutes: 270, vehicle_switch_buffer_minutes: 60 },
    summary_json: { assigned_blocks_count: blocks },
  });
  return [
    run('run-2026-08', 8, 'imp-2026-08', '2026-09-03T09:12:00+02:00', august.assigned, august.blocks, 1),
    run('run-2026-07', 7, 'imp-2026-07', '2026-08-04T10:30:00+02:00', 1152, 154, 0),
    run('run-2026-06', 6, 'imp-2026-06', '2026-07-03T08:45:00+02:00', 1098, 150, 0),
  ];
}

function finalizationRows(): Row[] {
  return [
    {
      id: 'fin-2026-07',
      company_id: HARNESS_COMPANY_ID,
      planning_run_id: 'run-2026-07',
      finalized_at: '2026-08-05T11:02:00+02:00',
      trip_count: 1152,
      driver_count: 7,
      is_stale: true,
      stale_reason: 'Nach der Finalisierung wurden 3 Fahrten übertragen.',
    },
    {
      id: 'fin-2026-06',
      company_id: HARNESS_COMPANY_ID,
      planning_run_id: 'run-2026-06',
      finalized_at: '2026-07-04T09:40:00+02:00',
      trip_count: 1098,
      driver_count: 7,
      is_stale: false,
      stale_reason: null,
    },
  ];
}

// ── Saved Stundennachweise ──────────────────────────────────────────────────

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

interface Shift { from: number; to: number }

/** Minutes of a shift that fall between 20:00 and 06:00. */
function nightMinutes({ from, to }: Shift): number {
  const end = to >= from ? to : to + 1440;
  return Math.max(0, Math.min(end, 1440) - Math.max(from, 1200)) + Math.max(0, Math.min(end, 1800) - Math.max(from, 1440));
}

/** A saved month in the shape rows_json stores: one row per day, times as HH:MM, buckets as HH:MM. */
function savedMonth(driverId: string, year: number, month: number, seed: number) {
  const profile = PROFILES.find(candidate => candidate.id === driverId)!;
  const next = random(seed);
  const rows: Row[] = [];
  const totals = { grundlohn: 0, nachtarbeit: 0, nacht04: 0, samstag: 0, sonntag: 0, feiertag: 0, weihnachten: 0 };
  let workingDays = 0;
  const [windowStart] = (profile.window ?? ['07:00', '17:00']).map(value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)));

  for (let day = 1; day <= daysIn(year, month); day += 1) {
    const dow = weekday(year, month, day);
    const iso = dow === 0 ? 7 : dow;
    const works = profile.days.includes(iso) && next() > 0.12;
    const shifts: Shift[] = [];
    if (works) {
      const first = windowStart + Math.floor(next() * 4) * 15;
      const firstEnd = first + 180 + Math.floor(next() * 6) * 15;
      shifts.push({ from: first, to: firstEnd });
      const second = firstEnd + 30 + Math.floor(next() * 3) * 15;
      shifts.push({ from: second, to: second + 120 + Math.floor(next() * 8) * 15 });
    }
    const total = shifts.reduce((sum, shift) => sum + (shift.to - shift.from), 0);
    const night = shifts.reduce((sum, shift) => sum + nightMinutes(shift), 0);
    const saturday = dow === 6 ? total : 0;
    if (total > 0) workingDays += 1;
    totals.grundlohn += total;
    totals.nachtarbeit += night;
    totals.samstag += saturday;
    const time = (shift: Shift | undefined, edge: 'from' | 'to') => (shift ? hhmm(shift[edge] % 1440) : '');
    rows.push({
      dayIndex: day,
      date_key: isoDate(year, month, day),
      weekday: WEEKDAY_SHORT[dow],
      isSat: dow === 6,
      isSun: dow === 0,
      isHol: false,
      von1: time(shifts[0], 'from'), bis1: time(shifts[0], 'to'),
      von2: time(shifts[1], 'from'), bis2: time(shifts[1], 'to'),
      von3: '', bis3: '',
      grundlohn: total > 0 ? hhmm(total) : '',
      nachtarbeit: night > 0 ? hhmm(night) : '',
      nachtarbeit04: '',
      samstag: saturday > 0 ? hhmm(saturday) : '',
      sonntag: '',
      feiertag: '',
      weihnachten: '',
      noteHighlight: false,
    });
  }
  return { rows, totals, workingDays, profile };
}

interface SavedSpec {
  driverId: string;
  year: number;
  month: number;
  savedAt: string;
  updatedAt: string;
  source: 'monatsplanung' | 'fahrtenbuch' | null;
  /** A record saved before salaries were stored has no calculated_salary: its month shows no gross total. */
  withSalary: boolean;
}

const SAVED: SavedSpec[] = [
  { driverId: 'd05', year: 2026, month: 8, savedAt: '2026-09-04T10:15:00+02:00', updatedAt: '2026-09-08T14:32:00+02:00', source: 'monatsplanung', withSalary: true },
  { driverId: 'd02', year: 2026, month: 8, savedAt: '2026-09-04T10:15:00+02:00', updatedAt: '2026-09-04T10:15:00+02:00', source: 'monatsplanung', withSalary: true },
  { driverId: 'd03', year: 2026, month: 8, savedAt: '2026-09-04T10:16:00+02:00', updatedAt: '2026-09-04T10:16:00+02:00', source: 'monatsplanung', withSalary: true },
  { driverId: 'd01', year: 2026, month: 8, savedAt: '2026-09-04T10:16:00+02:00', updatedAt: '2026-09-05T09:03:00+02:00', source: 'monatsplanung', withSalary: true },
  { driverId: 'd06', year: 2026, month: 8, savedAt: '2026-09-06T17:41:00+02:00', updatedAt: '2026-09-06T17:41:00+02:00', source: null, withSalary: true },
  { driverId: 'd01', year: 2026, month: 7, savedAt: '2026-08-05T11:20:00+02:00', updatedAt: '2026-08-05T11:20:00+02:00', source: 'fahrtenbuch', withSalary: true },
  { driverId: 'd03', year: 2026, month: 7, savedAt: '2026-08-05T11:21:00+02:00', updatedAt: '2026-08-05T11:21:00+02:00', source: 'fahrtenbuch', withSalary: false },
  { driverId: 'd04', year: 2026, month: 7, savedAt: '2026-08-05T11:21:00+02:00', updatedAt: '2026-08-07T08:10:00+02:00', source: null, withSalary: true },
];

function savedRows(): Row[] {
  return SAVED.map((spec, index) => {
    const { rows, totals, workingDays, profile } = savedMonth(spec.driverId, spec.year, spec.month, 7000 + index * 31);
    const hours = totals.grundlohn / 60;
    const salary = Math.round((hours * HOURLY_RATE + (totals.nachtarbeit / 60) * HOURLY_RATE * 0.25) * 100) / 100;
    return {
      id: `sn-${spec.year}-${pad(spec.month)}-${spec.driverId}`,
      company_id: HARNESS_COMPANY_ID,
      driver_id: spec.driverId,
      driver_name: nameOf(spec.driverId),
      personalnummer: profile.personalnummer,
      month: spec.month,
      year: spec.year,
      grundlohn_min: totals.grundlohn,
      nachtarbeit_min: totals.nachtarbeit,
      nacht04_min: totals.nacht04,
      samstag_min: totals.samstag,
      sonntag_min: totals.sonntag,
      feiertag_min: totals.feiertag,
      weihnachten_min: totals.weihnachten,
      working_days: workingDays,
      rows_json: rows,
      saved_at: spec.savedAt,
      updated_at: spec.updatedAt,
      generation_source: spec.source,
      generation_mode: 'salary',
      grundlohn_ratio: 0.85,
      hourly_rate: spec.withSalary ? HOURLY_RATE : null,
      target_salary: spec.withSalary ? (profile.salary[0] + profile.salary[1]) / 2 : null,
      min_salary: spec.withSalary ? profile.salary[0] : null,
      max_salary: spec.withSalary ? profile.salary[1] : null,
      calculated_salary: spec.withSalary ? salary : null,
      totals_target_json: null,
      work_window_json: null,
      warnings_json: null,
      pdf_storage_path: null,
      snapshot_hash: null,
      source_import_id: spec.source === 'monatsplanung' ? `imp-${spec.year}-${pad(spec.month)}` : null,
      generated_at: spec.savedAt,
    };
  });
}

/** The record Dokumente's "Öffnen" hands to the Stundennachweis page, for `entry=archiv`. */
export function archivedRecord(): Row {
  return savedRows()[0];
}

// ── Notes, receipts, settings ────────────────────────────────────────────────

function driverNoteRows(): Row[] {
  const note = (id: string, driverId: string, date: string, text: string, behavior: string | null) => ({
    id,
    company_id: HARNESS_COMPANY_ID,
    driver_id: driverId,
    note_type: 'general',
    note_date: `${date}T00:00:00+02:00`,
    note_text: text,
    start_date: date,
    end_date: date,
    is_full_day: true,
    start_time: null,
    end_time: null,
    note_planning_behavior: behavior,
  });
  return [
    note('note-1', 'd05', '2026-08-12', 'Arzttermin, ganztägig abwesend.', 'exclude_from_plan'),
    note('note-2', 'd05', '2026-08-21', 'Übernimmt die Spätschicht von Svenja Krüger.', null),
    note('note-3', 'd02', '2026-09-18', 'Urlaub bis 25.09.', 'exclude_from_plan'),
  ];
}

/** Two cash salary receipts, so Dokumente's Gehaltsquittung list is not empty. */
function receiptRows(): Row[] {
  const receipt = (id: string, number: string, driverId: string, amount: number, date: string) => ({
    id,
    company_id: HARNESS_COMPANY_ID,
    receipt_number: number,
    salary_id: `sal-${driverId}-2026-07`,
    driver_id: driverId,
    period_start: '2026-06-29',
    period_end: '2026-08-02',
    business_month: 7,
    business_year: 2026,
    payment_date: date,
    place: 'Berlin',
    amount,
    is_partial: false,
    due_amount: amount,
    paid_bank_before: 0,
    paid_cash_manual_before: 0,
    paid_cash_weekly_before: 0,
    paid_cash_receipts_before: 0,
    remaining_before: amount,
    remaining_after: 0,
    status: 'confirmed',
    signed_copy_path: null,
    confirmed_at: `${date}T16:20:00+02:00`,
    voided_at: null,
    void_reason: null,
    driver: { name: nameOf(driverId), gender: driverId === 'd07' ? 'male' : 'female' },
  });
  return [
    receipt('gq-2', 'GQ-2026-0002', 'd07', 1712.4, '2026-08-07'),
    receipt('gq-1', 'GQ-2026-0001', 'd06', 1015.25, '2026-08-06'),
  ];
}

// ── What the store receives ─────────────────────────────────────────────────

/**
 * The tables this batch adds to the harness store, or none on another batch's
 * screen. `data=empty` empties what Dokumente lists (the archive and the
 * receipts) and what Monatsplanung plans (imports, rides and runs); the drivers
 * stay, as they would in a company that has not imported anything yet.
 */
export function batch3Tables(): Array<[string, Row[]]> {
  if (!batch3Screen) return [];
  const trips = [...BUILT.values()].flatMap(built => built.trips);
  return [
    ['drivers', driverRows()],
    ['saved_stundennachweise', empty ? [] : savedRows()],
    ['salary_cash_receipts', empty ? [] : receiptRows()],
    ['fahrtenbuch_imports', empty ? [] : importRows()],
    ['fahrtenbuch_trips', empty ? [] : trips],
    ['company_planning_runs', empty ? [] : planningRunRows()],
    ['planning_finalizations', empty ? [] : finalizationRows()],
    ['monthly_planning_manual_exceptions', []],
    ['planning_run_adjustments', []],
    ['driver_notes', driverNoteRows()],
    ['company_settings', [{ id: 'cs-1', company_id: HARNESS_COMPANY_ID, company_name: 'Stadttaxi Lindner GmbH', state: 'BE' }]],
  ];
}

// ── What the screen writes ───────────────────────────────────────────────────

/**
 * Every write and RPC the screen sends while this batch's screens are shown,
 * so flows-batch3.mjs can prove that opening dialogs, switching tabs and
 * moving between steps writes nothing — no apply, no finalize, no delete.
 */
declare global {
  interface Window {
    __harnessBatch3: { writes: string[]; rpcs: string[] };
  }
}
window.__harnessBatch3 = { writes: [], rpcs: [] };

export function recordBatch3Write(table: string, op: string): void {
  if (batch3Screen) window.__harnessBatch3.writes.push(`${op} ${table}`);
}

export function recordBatch3Rpc(name: string): void {
  if (batch3Screen) window.__harnessBatch3.rpcs.push(name);
}
