/**
 * Design remake, batch R1: invented data for the Übersicht and the locked page.
 *
 * The Übersicht reads seven tables of its own plus Belege and Fahrer through
 * `useDatabase`, and every panel is a function of the clock: the month it opens
 * on is the clock's month, the comparison month the one before, the trend the
 * six months ending there. The capture installs one fixed clock, so every date
 * here is derived from `new Date()` at load and the shots never go stale.
 *
 * Nothing here is a real person or company. This file answers for its own
 * screens only and returns an empty list for every other batch's.
 */
import type { Row } from '../fixtures';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID } from '../scenario';

export type R1Screen = 'r1-uebersicht' | 'r1-uebersicht-leer' | 'r1-gesperrt' | 'r1-gesperrt-premium';

const params = new URLSearchParams(window.location.search);
const requested = params.get('screen');
const SCREENS: readonly string[] = ['r1-uebersicht', 'r1-uebersicht-leer', 'r1-gesperrt', 'r1-gesperrt-premium'];
export const r1Screen: R1Screen | null = SCREENS.includes(requested ?? '') ? (requested as R1Screen) : null;

// ── Dates, from the clock ───────────────────────────────────────────────────
const NOW = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (days: number) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days);
/** The first of the month `back` months before the clock's month. */
const monthStart = (back: number) => new Date(NOW.getFullYear(), NOW.getMonth() - back, 1);
const monthEnd = (back: number) => new Date(NOW.getFullYear(), NOW.getMonth() - back + 1, 0);
const day = (back: number, dayOfMonth: number) => iso(new Date(NOW.getFullYear(), NOW.getMonth() - back, dayOfMonth));

/** Deterministic jitter in [-0.06, +0.06]; no Math.random, so every run draws the same picture. */
const jitter = (seed: number) => (((seed * 2654435761) >>> 0) % 13 - 6) / 100;
const euro = (value: number) => Math.round(value * 100) / 100;

// ── The invented company ────────────────────────────────────────────────────
const DRIVERS = [
  { id: 'r1-d1', name: 'Lena Hartmann', ratio: 0.5, weekly: 1480 },
  { id: 'r1-d2', name: 'Tobias Kessler', ratio: 0.48, weekly: 1330 },
  { id: 'r1-d3', name: 'Selin Aydın', ratio: 0.5, weekly: 1190 },
  { id: 'r1-d4', name: 'Marek Zielinski', ratio: 0.45, weekly: 1020 },
  { id: 'r1-d5', name: 'Birgit Sandmann', ratio: 0.48, weekly: 880 },
  { id: 'r1-d6', name: 'Florian Wegener', ratio: 0.5, weekly: 760 },
  { id: 'r1-d7', name: 'Nadia Rahimi', ratio: 0.45, weekly: 540 },
];

/** Index 0 is the clock's month; the trend rises, with a dip in the middle. */
const MONTH_FACTOR = [1.07, 1.0, 1.04, 0.97, 0.93, 0.88];
/** The clock's month is part-way through: its four weekly rows all sit in the past. */
const WEEK_DAYS_PAST = [2, 9, 16, 23];
const WEEK_DAYS_CURRENT = [Math.min(2, NOW.getDate()), Math.min(5, NOW.getDate()), Math.min(9, NOW.getDate()), Math.min(12, NOW.getDate())];

const monthDays = (back: number) => (back === 0 ? WEEK_DAYS_CURRENT : WEEK_DAYS_PAST);

function incomeRows(): Row[] {
  const rows: Row[] = [];
  let n = 0;
  for (let back = 5; back >= 0; back -= 1) {
    DRIVERS.forEach((driver, di) => {
      monthDays(back).forEach((d, wi) => {
        const base = driver.weekly * MONTH_FACTOR[back] * (1 + jitter(back * 97 + di * 13 + wi * 7 + 3));
        const entries: Array<[string, number, string]> = [
          ['umsatz', base, 'Uber Umsatz'],
          ['bargeld', base * 0.21, 'Bargeld abgegeben'],
        ];
        if (wi === 1) entries.push(['aktionen', base * 0.06, 'Aktionen']);
        if (wi === 3) entries.push(['trinkgeld', base * 0.045, 'Trinkgeld']);
        entries.forEach(([type, amount, description]) => {
          n += 1;
          rows.push({
            id: `r1-inc-${String(n).padStart(4, '0')}`,
            company_id: HARNESS_COMPANY_ID,
            description: `${description} Woche ${wi + 1}`,
            amount: euro(amount),
            type,
            driver_name: driver.name,
            date: day(back, d),
            week: wi + 1,
            trip_count: null,
            created_by: HARNESS_USER_ID,
            created_at: `${day(back, d)}T18:00:00+02:00`,
            updated_at: `${day(back, d)}T18:00:00+02:00`,
          });
        });
      });
    });
  }
  return rows;
}

function salaryRows(income: Row[]): Row[] {
  const rows: Row[] = [];
  for (let back = 5; back >= 0; back -= 1) {
    const from = iso(monthStart(back));
    const to = iso(monthEnd(back));
    DRIVERS.forEach((driver, di) => {
      const own = income.filter(r => r.driver_name === driver.name && String(r.date) >= from && String(r.date) <= to);
      const sum = (types: string[]) => own.filter(r => types.includes(String(r.type))).reduce((s, r) => s + Number(r.amount), 0);
      const due = euro(sum(['umsatz', 'aktionen']) * driver.ratio + sum(['trinkgeld']));
      // Last month: one salary still unpaid and one half paid, which the alerts panel lists.
      const paid = back === 1 && di === 2 ? 0 : back === 1 && di === 4 ? euro(due / 2) : due;
      rows.push({
        id: `r1-sal-${back}-${di + 1}`,
        company_id: HARNESS_COMPANY_ID,
        driver_id: driver.id,
        driver_name: driver.name,
        period_start: from,
        period_end: to,
        amount_due: due,
        total_paid: paid,
        status: 'calculated',
        payment_status: paid >= due ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid',
        remaining_balance: euro(due - paid),
        created_at: `${to}T08:00:00+02:00`,
      });
    });
  }
  return rows;
}

function receiptRows(): Row[] {
  const rows: Row[] = [];
  let n = 0;
  for (let back = 5; back >= 0; back -= 1) {
    DRIVERS.forEach((driver, di) => {
      const count = back === 0 ? 1 : 2;
      for (let k = 0; k < count; k += 1) {
        n += 1;
        const dayOfMonth = back === 0 ? Math.min(2 + di + k, NOW.getDate()) : 3 + di * 3 + k * 2;
        const fuel = di === 0 && k === 1 && back !== 0;
        rows.push({
          id: `r1-bel-${String(n).padStart(3, '0')}`,
          company_id: HARNESS_COMPANY_ID,
          receipt_number: `BEL-1780000${String(n).padStart(3, '0')}-${(n * 7919) % 9000 + 1000}`,
          date: day(back, dayOfMonth),
          description: fuel ? 'Reifenwechsel' : k === 0 ? 'Tanken' : 'Autowäsche',
          driver_name: driver.name,
          expense: euro(fuel ? 238 : k === 0 ? 74 + ((n * 11) % 38) : 19.5),
          payment_method: 'bar',
          merchant_name: k === 0 ? 'Nordstern Tankstelle' : 'Glanzwerk Wäsche',
          receipt_time: '15:20:00',
          city: 'Musterstadt',
          postal_code: '12345',
          created_by: HARNESS_USER_ID,
        });
      }
    });
  }
  return rows;
}

function fixedCostRows(): Row[] {
  const costs: Array<[string, number]> = [
    ['Kfz-Versicherung Flotte', 2184.37],
    ['Miete Stellplätze Hof', 1250],
    ['Buchhaltung und Steuerberatung', 650],
    ['Funkzentrale', 420],
    ['Telefon und Internet', 64.99],
  ];
  return costs.map(([description, amount], i) => ({
    id: `r1-fc-${i + 1}`,
    company_id: HARNESS_COMPANY_ID,
    description,
    amount,
    // A standing cost with no month: applies to every month, as `fixedCostMonths` reads it.
    period_month: null,
    created_at: '2026-01-12T08:30:00+00:00',
  }));
}

function carRows(): Row[] {
  // One TÜV expired, one expiring inside the 60-day window, the rest valid.
  const cars: Array<[string, number]> = [
    ['M-ZK 2101', -25], ['M-ZK 2102', 31], ['M-ZK 2103', 190], ['M-ZK 2104', 240],
    ['M-ZK 2105', 310], ['M-ZK 2106', 420], ['M-ZK 2107', 505],
  ];
  return cars.map(([kennzeichen, offset], i) => ({
    id: `r1-car-${i + 1}`,
    company_id: HARNESS_COMPANY_ID,
    kennzeichen,
    tuev_gueltig_bis: iso(addDays(offset)),
    status: 'active',
  }));
}

function werkstattRows(): Row[] {
  const checks: Array<[number, string, number, string]> = [
    [1, 'negative', -3, 'Bremsen quietschen, Termin vereinbart.'],
    [2, 'positive', -5, 'Ölwechsel ohne Befund.'],
    [3, 'positive', -8, 'Reifendruck und Beleuchtung in Ordnung.'],
    [4, 'repaired', -9, 'Stoßdämpfer hinten erneuert.'],
    [5, 'positive', -35, 'Inspektion ohne Befund.'],
  ];
  return checks.map(([carIndex, status, offset, notes], i) => ({
    id: `r1-wk-${i + 1}`,
    company_id: HARNESS_COMPANY_ID,
    car_id: `r1-car-${carIndex}`,
    status,
    check_date: iso(addDays(offset)),
    notes,
    car: { kennzeichen: String(carRows()[carIndex - 1].kennzeichen) },
  }));
}

function profileRows(): Row[] {
  return [
    { id: 'r1-up-1', company_id: HARNESS_COMPANY_ID, email: 'katrin.lindner@example.com', full_name: 'Katrin Lindner', role: 'admin', status: 'active', invited_at: null },
    { id: 'r1-up-2', company_id: HARNESS_COMPANY_ID, email: 'jan.vogt@example.com', full_name: 'Jan Vogt', role: 'editor', status: 'active', invited_at: '2026-06-02T09:00:00+02:00' },
    { id: 'r1-up-3', company_id: HARNESS_COMPANY_ID, email: 'meike.arnold@example.com', full_name: 'Meike Arnold', role: 'viewer', status: 'pending_invite', invited_at: iso(addDays(-4)) },
  ];
}

function cashMovementRows(): Row[] {
  const d = (offset: number) => iso(new Date(Math.max(NOW.getTime() + offset * 86400000, monthStart(0).getTime())));
  return [
    { id: 'r1-cm-1', company_id: HARNESS_COMPANY_ID, direction: 'out', amount: 380, movement_date: d(-8), source_type: 'gehaltsquittung', source_id: 'r1-sal-1-3', description: 'Gehaltsquittung GQ-2026-0007' },
    { id: 'r1-cm-2', company_id: HARNESS_COMPANY_ID, direction: 'out', amount: 220, movement_date: d(-5), source_type: 'gehaltsquittung', source_id: 'r1-sal-1-5', description: 'Gehaltsquittung GQ-2026-0008' },
    { id: 'r1-cm-3', company_id: HARNESS_COMPANY_ID, direction: 'in', amount: 120, movement_date: d(-3), source_type: 'gehaltsquittung_storno', source_id: 'r1-sal-1-5', description: 'Storno GQ-2026-0008' },
  ];
}

function driverRows(): Row[] {
  return DRIVERS.map(driver => ({
    id: driver.id,
    company_id: HARNESS_COMPANY_ID,
    name: driver.name,
    status: 'active',
    salary_ratio: driver.ratio,
  }));
}

const EMPTY_TABLES = ['cars', 'car_driver_assignments', 'drivers', 'fixed_costs', 'income', 'salaries', 'receipts', 'werkstatt_checks', 'user_profiles', 'cash_movements'];

/**
 * Rows for this batch's screens only, and nothing for any other batch's.
 * Later entries win in the fake's seed, so the full list replaces the default
 * fleet and drivers; the empty variant names every table to empty them too.
 */
export function r1Tables(): Array<[string, Row[]]> {
  if (r1Screen === 'r1-uebersicht-leer') return EMPTY_TABLES.map(name => [name, []]);
  if (r1Screen !== 'r1-uebersicht') return [];
  const income = incomeRows();
  return [
    ['cars', carRows()],
    ['car_driver_assignments', []],
    ['drivers', driverRows()],
    ['fixed_costs', fixedCostRows()],
    ['income', income],
    ['salaries', salaryRows(income)],
    ['receipts', receiptRows()],
    ['werkstatt_checks', werkstattRows()],
    ['user_profiles', profileRows()],
    ['cash_movements', cashMovementRows()],
  ];
}
