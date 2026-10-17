/**
 * Phase 5 batch 1b's invented rows: Belege, Fahrer and Umsätze.
 *
 * Kept apart from fixtures.ts so the batches building in parallel do not edit
 * the same block. Nothing here is a real company; the drivers are the design
 * preview's, with the payroll columns the Fahrer form reads.
 *
 * The harness clock is the design preview's PREVIEW_TODAY, Monday 14.09.2026.
 * Belege and Umsätze open on the current business month, which runs from
 * Monday 07.09. to Sunday 04.10.2026 (a week belongs to the month of its
 * Monday), so the rows that should show at first are dated in that range and
 * a few older ones sit in August for the filters to find.
 */
import { PREVIEW_DRIVERS } from '../src/design-preview/sampleData';
import type { Row } from './fixtures';
import {
  HARNESS_COMPANY_ID,
  HARNESS_DISPATCHER_ID,
  HARNESS_FORMER_USER_ID,
  HARNESS_USER_ID,
  type HarnessScenario,
} from './scenario';

const CREATED_AT = '2026-01-12T08:30:00+00:00';

const BATCH1B_PRIMARY_TABLES = { belege: 'receipts', fahrer: 'drivers', umsaetze: 'income' } as const;

export function isBatch1bScreen(scenario: HarnessScenario): scenario is HarnessScenario & { screen: keyof typeof BATCH1B_PRIMARY_TABLES } {
  return scenario.screen in BATCH1B_PRIMARY_TABLES;
}

/** The table a batch 1b screen is about: the one its empty and loading scenarios act on. */
export function batch1bPrimaryTable(scenario: HarnessScenario): string | null {
  return isBatch1bScreen(scenario) ? BATCH1B_PRIMARY_TABLES[scenario.screen] : null;
}

/**
 * Batch 1b's `error` is the network being down, every table at once: Belege
 * and Fahrer read through useDatabase, which tests the connection on
 * `receipts` and falls back to (empty) local storage when that fails, so a
 * failure of one table alone would not be a failure those screens can see.
 */
export function batch1bFailsEveryTable(scenario: HarnessScenario): boolean {
  return isBatch1bScreen(scenario) && scenario.data === 'error';
}

/** Its tables, on its own screens only; `empty` empties the screen's own table. */
export function batch1bTables(scenario: HarnessScenario): Array<[string, Row[]]> {
  if (!isBatch1bScreen(scenario)) return [];
  const primary = BATCH1B_PRIMARY_TABLES[scenario.screen];
  const rows = (table: string, make: () => Row[]) => (scenario.data === 'empty' && table === primary ? [] : make());
  return [
    ['drivers', rows('drivers', driverRecords)],
    ['receipts', rows('receipts', receiptRows)],
    ['income', rows('income', incomeRows)],
    ['user_profiles', profileRows()],
  ];
}

/** The company's members, as BelegePage reads them to name who filed a Beleg. */
export function profileRows(): Row[] {
  return [
    { user_id: HARNESS_USER_ID, full_name: 'Katrin Lindner', email: 'katrin.lindner@example.com', company_id: HARNESS_COMPANY_ID },
    { user_id: HARNESS_DISPATCHER_ID, full_name: 'Tobias Ernst', email: 'tobias.ernst@example.com', company_id: HARNESS_COMPANY_ID },
  ];
}

/**
 * The drivers with the columns Fahrer and its form read. Three have left
 * (inactive), one drives as the owner (company_owner), and two were created
 * before `created_by` was recorded.
 */
const INACTIVE_DRIVERS = new Set(['d16', 'd18', 'd19']);
const RATIOS = [0.5, 0.45, 0.4, 0.5, 0.6, 0.45, 0.5, 0.4, 0.5, 0.45, 0.5, 0.35, 0.5, 0.45, 0.5, 0.4, 0.5, 0.45, 0.5];

export function driverRecords(): Row[] {
  return PREVIEW_DRIVERS.map((driver, index) => ({
    id: driver.id,
    company_id: HARNESS_COMPANY_ID,
    name: driver.name,
    salary_ratio: RATIOS[index],
    personalnummer: index === 7 ? null : String(1001 + index),
    gender: index % 3 === 0 ? 'male' : index % 3 === 1 ? 'female' : null,
    status: INACTIVE_DRIVERS.has(driver.id) ? 'inactive' : 'active',
    created_by: index === 2 || index === 9 ? null : HARNESS_USER_ID,
    created_at: CREATED_AT,
    employment_type: driver.id === 'd05' ? 'company_owner' : 'employee',
    driver_usage_type: driver.id === 'd14' ? 'coverage_only' : 'regular',
    target_monthly_hours: 160,
    max_monthly_hours: 190,
    planning_target_salary: null,
    planning_min_salary: 2200,
    planning_max_salary: 2800,
    planning_hourly_rate: 14.6,
    planning_priority: 100,
    planning_enabled: true,
    can_cover_other_drivers: true,
    allowed_weekdays: [1, 2, 3, 4, 5],
    work_window_start: '06:00',
    work_window_end: '18:00',
    allow_outside_shift_exceptions: false,
    is_full_day_available: false,
  }));
}

/** Active drivers in driverRecords(); the Fahrer limit scenario sets the plan to exactly this many. */
export const ACTIVE_DRIVER_COUNT = PREVIEW_DRIVERS.length - INACTIVE_DRIVERS.size;

const name = (id: string) => PREVIEW_DRIVERS.find(driver => driver.id === id)?.name ?? id;

/**
 * Belege: mostly fuel, a car wash, an oil change, accessories and two free
 * texts, paid in cash or by transfer, filed by two members and one former one.
 * The numbers follow the system's own BEL-{timestamp}-{random} pattern.
 */
export function receiptRows(): Row[] {
  const receipts: Array<[string, string, string, number, string | null, string | null, 'bar' | 'uberweisung', string]> = [
    // date, description, driver, expense, postal code, city, payment, filed by
    ['2026-09-14', 'Tanken', 'd01', 68.2, '10115', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-09-13', 'Tanken', 'd04', 71.05, '12057', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-09-13', 'Autowäsche', 'd02', 14.9, '10785', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-09-12', 'Tanken', 'd05', 41.47, '13405', 'Berlin', 'bar', HARNESS_USER_ID],
    ['2026-09-12', 'Parkgebühren Flughafen BER', 'd09', 18, '12529', 'Schönefeld', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-09-11', 'Öl wechseln', 'd07', 189.9, '10365', 'Berlin', 'uberweisung', HARNESS_USER_ID],
    ['2026-09-11', 'Tanken', 'd10', 63.88, '10115', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-09-10', 'Autozubehör', 'd12', 34.99, null, null, 'uberweisung', HARNESS_USER_ID],
    ['2026-09-10', 'Tanken', 'd03', 59.4, '10967', 'Berlin', 'bar', HARNESS_FORMER_USER_ID],
    ['2026-09-09', 'Tanken', 'd13', 77.13, '12057', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-09-08', 'Reparatur Taxameter-Kabel', 'd15', 126.5, '10365', 'Berlin', 'uberweisung', HARNESS_USER_ID],
    ['2026-09-07', 'Tanken', 'd11', 52.3, '10785', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    // August's business month, for the month filter
    ['2026-09-04', 'Tanken', 'd01', 66.75, '10115', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-08-28', 'Autowäsche', 'd06', 14.9, '10785', 'Berlin', 'bar', HARNESS_DISPATCHER_ID],
    ['2026-08-21', 'Tanken', 'd08', 58.02, '13405', 'Berlin', 'bar', HARNESS_USER_ID],
  ];
  return receipts.map(([date, description, driverId, expense, postalCode, city, payment, filedBy], index) => ({
    id: `rc-${index + 1}`,
    company_id: HARNESS_COMPANY_ID,
    receipt_number: `BEL-${Date.UTC(2026, 8, 1) + index * 86_413_777}-${String((index * 7919) % 10000).padStart(4, '0')}`,
    date,
    description,
    driver_name: name(driverId),
    expense,
    postal_code: postalCode,
    city,
    payment_method: payment,
    created_by: filedBy,
    user_id: filedBy,
    created_at: `${date}T18:00:00+00:00`,
  }));
}

/**
 * Umsätze: one week's settlement for six drivers, each split into the four
 * types the batch form writes (Netto-Fahrpreis as `umsatz`, Aktionen,
 * Trinkgeld, Bargeld), plus the last week of August.
 */
export function incomeRows(): Row[] {
  const weeks: Array<{ date: string; week: number; drivers: Array<[string, number, number, number, number, number]> }> = [
    {
      date: '2026-09-13',
      week: 1,
      drivers: [
        // driver, umsatz, aktionen, trinkgeld, bargeld, trips
        ['d01', 1184.6, 42.5, 63.2, 512.4, 58],
        ['d02', 1027.35, 0, 48.9, 401.15, 51],
        ['d04', 1311.8, 65, 71.4, 598.3, 64],
        ['d05', 942.1, 20, 39.75, 377.6, 45],
        ['d07', 1098.45, 32.5, 55.1, 466.2, 53],
        ['d10', 876.9, 0, 41.3, 352.85, 42],
      ],
    },
    {
      // Sunday of the week of Monday 31.08., so August's fifth business week.
      date: '2026-09-06',
      week: 5,
      drivers: [
        ['d01', 1122.3, 30, 58.6, 489.9, 55],
        ['d04', 1250.15, 45, 66.8, 571.4, 61],
      ],
    },
  ];
  const TYPES = ['umsatz', 'aktionen', 'trinkgeld', 'bargeld'] as const;
  let id = 0;
  return [...weeks.flatMap(({ date, week, drivers }) =>
    drivers.flatMap(([driverId, ...values]) => {
      const trips = values[4];
      return TYPES.flatMap((type, typeIndex) => {
        const amount = values[typeIndex];
        if (amount <= 0) return [];
        id += 1;
        return [{
          id: `in-${id}`,
          company_id: HARNESS_COMPANY_ID,
          description: `Woche ${week} - Uber/Bolt`,
          amount,
          type,
          driver_name: name(driverId),
          date,
          week,
          trip_count: trips,
          created_by: 0,
          created_at: `${date}T20:00:00+00:00`,
          updated_at: `${date}T20:00:00+00:00`,
        }];
      });
    }),
  ), ...incomeDailyRows()];
}

/**
 * Uber imports that carry a day each (Mon 07.09. to Sat 12.09. for three
 * drivers), a weekly import with no day of its own, and the week of 24.08.,
 * so the day, week and month levels of the Umsätze list have something to
 * tell apart.
 */
function incomeDailyRows(): Row[] {
  const days: Array<[string, Array<[string, number, number, number, number]>]> = [
    ['2026-09-07', [['d01', 212.4, 0, 9.5, 88.2], ['d04', 244.8, 10, 12, 101.6]]],
    ['2026-09-08', [['d01', 198.7, 0, 7, 79.4], ['d02', 176.25, 0, 5.5, 64.8], ['d04', 261.1, 15, 14.5, 112.3]]],
    ['2026-09-09', [['d02', 189.9, 0, 8, 70.1], ['d05', 154.6, 0, 3, 52.7]]],
    ['2026-09-10', [['d01', 223.35, 20, 11, 94.9], ['d04', 238.0, 0, 10.5, 99.5]]],
    ['2026-09-11', [['d02', 201.8, 0, 9, 83.3], ['d05', 168.4, 0, 6.5, 58.9], ['d07', 190.15, 12.5, 7.75, 72.4]]],
    ['2026-09-12', [['d01', 305.6, 25, 16, 130.2], ['d04', 322.75, 30, 18.25, 140.8]]],
    ['2026-08-25', [['d01', 219.5, 0, 8, 90.1], ['d04', 230.9, 0, 9.5, 95.7]]],
    ['2026-08-27', [['d02', 187.3, 0, 6, 71.6], ['d05', 160.2, 10, 4.25, 55.3]]],
  ];
  const TYPES = ['umsatz', 'aktionen', 'trinkgeld', 'bargeld'] as const;
  const dayRows = days.flatMap(([date, drivers]) => drivers.flatMap(([driverId, ...values]) =>
    TYPES.flatMap((type, i) => (values[i]! > 0 ? [{
      id: `in-day-${date}-${driverId}-${type}`,
      company_id: HARNESS_COMPANY_ID,
      description: 'Uber-Import',
      amount: values[i],
      type,
      driver_name: name(driverId),
      date,
      source: 'uber',
      source_period_start: date,
      source_period_end: date,
      created_by: 0,
      created_at: `${date}T20:00:00+00:00`,
      updated_at: `${date}T20:00:00+00:00`,
    }] : [])),
  ));
  const weekly = {
    id: 'in-week-d07-umsatz',
    company_id: HARNESS_COMPANY_ID,
    description: 'Uber-Import Woche',
    amount: 884.35,
    type: 'umsatz',
    driver_name: name('d07'),
    date: '2026-08-31',
    source: 'uber',
    source_period_start: '2026-08-31',
    source_period_end: '2026-09-06',
    created_by: 0,
    created_at: '2026-09-07T08:00:00+00:00',
    updated_at: '2026-09-07T08:00:00+00:00',
  };
  return [...dayRows, weekly];
}
