/**
 * Phase 5 batch 2's invented rows: Gehälter, Abrechnung and Bargeldbestand.
 *
 * Kept apart from fixtures.ts so the batches building in parallel do not edit
 * the same block. Nothing here is a real company; the drivers are the design
 * preview's, the figures are made up but shaped like a real month.
 *
 * The month is the harness's "today", September 2026. As a business month
 * (weekCalculations, 0-indexed month 8) it holds the four weeks whose Monday is
 * in September: 07.09.–13.09., 14.09.–20.09., 21.09.–27.09. and 28.09.–04.10.
 * The salary period on the Gehälter screen is exactly that range. Bargeldbestand
 * reads the calendar month instead, so the last week's rows split across
 * September and October — and October also holds the Storno of a
 * Gehaltsquittung paid in September, the case the ledger books on the day of
 * the void.
 */
import { PREVIEW_DRIVERS } from '../src/design-preview/sampleData';
import { getBusinessWeeksForMonth } from '../src/utils/weekCalculations';
import type { Row } from './fixtures';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID, type HarnessScenario } from './scenario';

const CREATED_AT = '2026-09-01T08:00:00+00:00';
const SALARY_PERIOD = { start: '2026-09-07', end: '2026-10-04' };
const WEEK_MONDAYS = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];

/** The drivers who hand in cash and file Belege: the Abrechnung and Bargeldbestand rows. */
const CASH_DRIVERS = PREVIEW_DRIVERS.slice(0, 6);

const round2 = (value: number) => Math.round(value * 100) / 100;

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** Salary ratios as a fleet sets them: most at half, a few negotiated. */
const SALARY_RATIO: Record<string, number> = { d03: 0.55, d07: 0.45, d11: 0.4, d14: 0.55 };

export function batch2Drivers(rows: Row[]): Row[] {
  return rows.map(row => ({ ...row, salary_ratio: SALARY_RATIO[row.id as string] ?? 0.5 }));
}

function incomeRows(): Row[] {
  const rows: Row[] = [];
  PREVIEW_DRIVERS.forEach((driver, i) => {
    WEEK_MONDAYS.forEach((monday, w) => {
      const date = addDays(monday, i % 5);
      const base = { company_id: HARNESS_COMPANY_ID, driver_name: driver.name, date, created_by: HARNESS_USER_ID, created_at: CREATED_AT, updated_at: CREATED_AT };
      rows.push({
        ...base,
        id: `inc-u-${driver.id}-${w}`,
        type: 'umsatz',
        amount: round2(780 + ((i * 137 + w * 59) % 520) + ((i * 31 + w * 17) % 100) / 100),
        description: `Uber Wochenumsatz KW ${37 + w}`,
      });
      if (i % 3 === 0) {
        rows.push({ ...base, id: `inc-a-${driver.id}-${w}`, type: 'aktionen', amount: round2(25 + (i + w) * 2.5), description: 'Bonus Stoßzeiten' });
      }
      rows.push({
        ...base,
        id: `inc-t-${driver.id}-${w}`,
        type: 'trinkgeld',
        amount: round2(18 + ((i * 7 + w * 11) % 40) + 0.5),
        description: 'Trinkgeld App',
      });
      if (i < CASH_DRIVERS.length) {
        rows.push({
          ...base,
          id: `inc-b-${driver.id}-${w}`,
          type: 'bargeld',
          amount: round2(210 + ((i * 43 + w * 29) % 180) + 0.4),
          description: `Bargeld Abgabe KW ${37 + w}`,
        });
      }
    });
  });
  return rows;
}

function receiptRows(): Row[] {
  const rows: Row[] = [];
  CASH_DRIVERS.forEach((driver, i) => {
    WEEK_MONDAYS.forEach((monday, w) => {
      const base = { company_id: HARNESS_COMPANY_ID, driver_name: driver.name, created_by: HARNESS_USER_ID, created_at: CREATED_AT };
      rows.push({ ...base, id: `rc-t-${driver.id}-${w}`, date: addDays(monday, (i + 1) % 6), expense: round2(52 + ((i * 17 + w * 13) % 44) + 0.39), description: 'Tanken' });
      if ((i + w) % 2 === 0) {
        rows.push({ ...base, id: `rc-w-${driver.id}-${w}`, date: addDays(monday, (i + 3) % 6), expense: 12.9, description: 'Autowäsche' });
      }
    });
  });
  rows.push({ id: 'rc-p-d04', company_id: HARNESS_COMPANY_ID, driver_name: CASH_DRIVERS[3].name, date: '2026-09-17', expense: 6.5, description: 'Parkgebühren Flughafen', created_by: HARNESS_USER_ID, created_at: CREATED_AT });
  return rows;
}

/**
 * The periods on record. Svenja is part-paid by a Gehaltsquittung, Ahmad's
 * was voided, two are paid in full on an adjusted salary, and Katarzyna holds a
 * calendar-month row beside the business month — the overlap the screen flags.
 */
function salaryRows(): Row[] {
  const row = (id: string, driverId: string, fields: Row): Row => ({
    id,
    company_id: HARNESS_COMPANY_ID,
    driver_id: driverId,
    period_start: SALARY_PERIOD.start,
    period_end: SALARY_PERIOD.end,
    calc_revenue: 0,
    calc_tips: 0,
    amount_due: 0,
    netto_salary: null,
    status: 'unpaid',
    paid_at: null,
    total_paid: 0,
    payment_status: 'unpaid',
    created_by: HARNESS_USER_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...fields,
  });
  return [
    row('sal-d02', 'd02', { total_paid: 450, payment_status: 'partially_paid' }),
    row('sal-d05', 'd05', { total_paid: 0, payment_status: 'unpaid' }),
    row('sal-d03', 'd03', { netto_salary: 1850, total_paid: 1850, payment_status: 'paid', status: 'paid', paid_at: '2026-10-05T09:00:00+00:00' }),
    row('sal-d09', 'd09', { netto_salary: 1720.4, total_paid: 1720.4, payment_status: 'paid', status: 'paid', paid_at: '2026-10-05T09:00:00+00:00' }),
    row('sal-d06-cal', 'd06', { period_start: '2026-09-01', period_end: '2026-09-30', amount_due: 1612.35 }),
    row('sal-d01-aug', 'd01', { period_start: '2026-08-03', period_end: '2026-09-06', amount_due: 1498.2, total_paid: 1498.2, payment_status: 'paid', status: 'paid' }),
  ];
}

const GQ_PAID = { id: 'gq-2026-0007', driverId: 'd02', number: 'GQ-2026-0007', amount: 450, date: '2026-09-11' };
const GQ_VOIDED = { id: 'gq-2026-0008', driverId: 'd05', number: 'GQ-2026-0008', amount: 680, date: '2026-09-25', voidedOn: '2026-10-02' };

function cashMovementRows(): Row[] {
  const movement = (id: string, fields: Row): Row => ({ id, company_id: HARNESS_COMPANY_ID, created_by: HARNESS_USER_ID, created_at: CREATED_AT, ...fields });
  return [
    movement('cm-1', { direction: 'out', amount: GQ_PAID.amount, movement_date: GQ_PAID.date, source_type: 'gehaltsquittung', source_id: GQ_PAID.id, description: `Gehaltsquittung ${GQ_PAID.number}` }),
    movement('cm-2', { direction: 'out', amount: GQ_VOIDED.amount, movement_date: GQ_VOIDED.date, source_type: 'gehaltsquittung', source_id: GQ_VOIDED.id, description: `Gehaltsquittung ${GQ_VOIDED.number}` }),
    movement('cm-3', { direction: 'in', amount: GQ_VOIDED.amount, movement_date: GQ_VOIDED.voidedOn, source_type: 'gehaltsquittung_storno', source_id: GQ_VOIDED.id, description: `Storno Gehaltsquittung ${GQ_VOIDED.number}` }),
  ];
}

function salaryCashReceiptRows(): Row[] {
  return [GQ_PAID, GQ_VOIDED].map(receipt => ({
    id: receipt.id,
    company_id: HARNESS_COMPANY_ID,
    driver_id: receipt.driverId,
    receipt_number: receipt.number,
    amount: receipt.amount,
  }));
}

const BATCH2_SCREENS = new Set(['gehaelter', 'abrechnung', 'bargeld']);

export function isBatch2Screen(scenario: HarnessScenario): boolean {
  return BATCH2_SCREENS.has(scenario.screen);
}

/** The tables batch 2's screens read, empty in the `empty` scenario. */
export function batch2Tables(scenario: HarnessScenario): Array<[string, Row[]]> {
  const empty = scenario.data === 'empty';
  return [
    ['income', empty ? [] : incomeRows()],
    ['receipts', empty ? [] : receiptRows()],
    ['salaries', empty ? [] : salaryRows()],
    ['cash_movements', empty ? [] : cashMovementRows()],
    ['salary_cash_receipts', empty ? [] : salaryCashReceiptRows()],
  ];
}

/**
 * The table whose statements a failure scenario breaks, or null for the batch
 * 1 screens. `drivers-error` breaks the driver list the Gehälter page loads
 * first; every other failure breaks the screen's own first read.
 */
export function batch2PrimaryTable(scenario: HarnessScenario): string | null {
  if (!isBatch2Screen(scenario)) return null;
  if (scenario.data === 'drivers-error') return 'drivers';
  if (scenario.screen === 'gehaelter') return 'salaries';
  if (scenario.screen === 'bargeld') return 'income';
  // Abrechnung reads through its RPCs; see batch2Rpc.
  return 'get_weekly_abrechnung';
}

// ── The Abrechnung RPCs, computed from the rows above ────────────────────────

const sumOf = (rows: Row[], column: string) => round2(rows.reduce((sum, row) => sum + Number(row[column]), 0));

function weeklyAbrechnung(tables: Map<string, Row[]>, year: number, month: number): Row[] {
  const income = (tables.get('income') ?? []).filter(row => row.type === 'bargeld');
  const receipts = tables.get('receipts') ?? [];
  const drivers = Array.from(new Set([...income, ...receipts].map(row => row.driver_name as string))).sort();
  const result: Row[] = [];
  for (const week of getBusinessWeeksForMonth(month - 1, year)) {
    const from = week.firstDay.toLocaleDateString('sv-SE');
    const to = week.lastDay.toLocaleDateString('sv-SE');
    const inWeek = (row: Row) => (row.date as string) >= from && (row.date as string) <= to;
    for (const driver of drivers) {
      const cash = income.filter(row => row.driver_name === driver && inWeek(row));
      const belege = receipts.filter(row => row.driver_name === driver && inWeek(row));
      if (cash.length === 0 && belege.length === 0) continue;
      const bargeld = sumOf(cash, 'amount');
      const ausgegeben = sumOf(belege, 'expense');
      result.push({
        year,
        month,
        week_number: week.weekNumber,
        driver_name: driver,
        anzahl_belege: belege.length,
        ausgegebene_bargeld: ausgegeben,
        bargeld,
        bar_zuruck: round2(bargeld - ausgegeben),
      });
    }
  }
  return result;
}

function monthlyAbrechnung(tables: Map<string, Row[]>, year: number, month: number): Row[] {
  const byDriver = new Map<string, Row>();
  for (const row of weeklyAbrechnung(tables, year, month)) {
    const driver = row.driver_name as string;
    const total = byDriver.get(driver) ?? { year, month, driver_name: driver, anzahl_belege: 0, ausgegebene_bargeld: 0, bargeld: 0, bar_zuruck: 0, week_count: 0 };
    byDriver.set(driver, {
      ...total,
      anzahl_belege: (total.anzahl_belege as number) + (row.anzahl_belege as number),
      ausgegebene_bargeld: round2((total.ausgegebene_bargeld as number) + (row.ausgegebene_bargeld as number)),
      bargeld: round2((total.bargeld as number) + (row.bargeld as number)),
      bar_zuruck: round2((total.bar_zuruck as number) + (row.bar_zuruck as number)),
      week_count: (total.week_count as number) + 1,
    });
  }
  return [...byDriver.values()];
}

type RpcAnswer = { data: unknown; error: { message: string; code: string } | null };

/** Batch 2's RPCs, or null for a name this batch does not answer. */
export function batch2Rpc(
  scenario: HarnessScenario,
  tables: Map<string, Row[]>,
  name: string,
  args: Record<string, unknown> | undefined,
): RpcAnswer | null {
  if (name !== 'get_weekly_abrechnung' && name !== 'get_monthly_abrechnung') return null;
  const year = Number(args?.p_year);
  const month = Number(args?.p_month);
  const fails =
    scenario.screen === 'abrechnung' &&
    (scenario.data === 'error' || scenario.data === 'missing' || (scenario.data === 'next-month-fails' && year === 2026 && month === 10));
  if (fails) return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };
  const data = name === 'get_weekly_abrechnung' ? weeklyAbrechnung(tables, year, month) : monthlyAbrechnung(tables, year, month);
  return { data, error: null };
}
