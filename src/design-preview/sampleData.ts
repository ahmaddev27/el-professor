/**
 * Invented data for the design preview, shaped like the real tables (cars,
 * car_driver_assignments, salary_payments, the monthly overview figures) so
 * the prototype shows realistic lengths and awkward cases: a vehicle without
 * drivers, one without a TÜV date, an overdue TÜV, partly paid salaries.
 *
 * Money is held in integer cents. Totals are summed in cents and divided only
 * for display.
 */

/** A fixed "today", so the TÜV countdowns and the screenshots never drift. */
export const PREVIEW_TODAY = '2026-09-14';
export const PREVIEW_COMPANY = 'Stadttaxi Lindner GmbH';
export const PREVIEW_USER = { name: 'Katrin Lindner', initials: 'KL' };
export const PREVIEW_PLAN = 'Premium';
export const PREVIEW_CAR_LIMIT = 15;

/** The month the dashboard reports on: August 2026 (month index is 0-based). */
export const PREVIEW_PERIOD = { year: 2026, monthIndex: 7 };
export const PREVIEW_CASH_DATE = '2026-08-31';
export const PREVIEW_CASH_CENTS = 641870;

export interface PreviewDriver {
  id: string;
  name: string;
}

export interface PreviewVehicle {
  id: string;
  plate: string;
  driverIds: string[];
  tuevValidUntil: string | null;
  lastHu: string | null;
  /** Revenue in the reporting month; null for a vehicle that did not drive. */
  revenueCents: number | null;
}

export interface PreviewSalary {
  id: string;
  driverId: string;
  year: number;
  monthIndex: number;
  dueCents: number;
  paidCents: number;
}

export interface PreviewMonth {
  year: number;
  monthIndex: number;
  revenueCents: number;
  costsCents: number;
  salariesCents: number;
}

export const PREVIEW_DRIVERS: PreviewDriver[] = [
  { id: 'd01', name: 'Mehmet Yıldız' },
  { id: 'd02', name: 'Svenja Krüger' },
  { id: 'd03', name: 'Jonas Albrecht' },
  { id: 'd04', name: 'Dragan Petrović' },
  { id: 'd05', name: 'Ahmad Haddad' },
  { id: 'd06', name: 'Katarzyna Nowak' },
  { id: 'd07', name: 'Thomas Wendt' },
  { id: 'd08', name: 'Lukas Brandt' },
  { id: 'd09', name: 'Ewa Kowalczyk' },
  { id: 'd10', name: 'Hüseyin Demir' },
  { id: 'd11', name: 'Anja Schubert' },
  { id: 'd12', name: 'Karim Mansour' },
  { id: 'd13', name: 'Olena Shevchenko' },
  { id: 'd14', name: 'Florian Seidel' },
  { id: 'd15', name: 'Bernd Hartmann' },
  { id: 'd16', name: 'Marco Rossi' },
  { id: 'd17', name: 'Nadine Vogt' },
  { id: 'd18', name: 'Sebastian Kühn' },
  { id: 'd19', name: 'Ivana Marković' },
];

// Taxis go to the Hauptuntersuchung every year, so each TÜV date is the end of
// the month twelve months after the last HU.
export const PREVIEW_VEHICLES: PreviewVehicle[] = [
  { id: 'v01', plate: 'B-SL 2041', driverIds: ['d01', 'd02'], tuevValidUntil: '2027-03-31', lastHu: '2026-03-18', revenueCents: 962520 },
  { id: 'v02', plate: 'B-SL 2187', driverIds: ['d03'], tuevValidUntil: '2026-09-30', lastHu: '2025-09-22', revenueCents: 878030 },
  { id: 'v03', plate: 'B-SL 3310', driverIds: ['d04', 'd05'], tuevValidUntil: '2027-06-30', lastHu: '2026-06-11', revenueCents: 1024080 },
  { id: 'v04', plate: 'B-SL 3472', driverIds: ['d06'], tuevValidUntil: '2026-08-31', lastHu: '2025-08-28', revenueCents: 596940 },
  { id: 'v05', plate: 'B-SL 4172', driverIds: ['d07', 'd08'], tuevValidUntil: '2027-01-31', lastHu: '2026-01-20', revenueCents: 931180 },
  { id: 'v06', plate: 'B-SL 4406', driverIds: ['d09'], tuevValidUntil: '2026-10-31', lastHu: '2025-10-06', revenueCents: 774250 },
  { id: 'v07', plate: 'B-SL 5028', driverIds: ['d10', 'd11'], tuevValidUntil: '2027-08-31', lastHu: '2026-08-19', revenueCents: 1080560 },
  { id: 'v08', plate: 'B-SL 5591', driverIds: ['d12'], tuevValidUntil: '2027-02-28', lastHu: '2026-02-16', revenueCents: 799670 },
  { id: 'v09', plate: 'B-SL 6130', driverIds: ['d13', 'd14'], tuevValidUntil: '2027-05-31', lastHu: '2026-05-27', revenueCents: 944220 },
  { id: 'v10', plate: 'B-SL 6284', driverIds: ['d15'], tuevValidUntil: '2027-04-30', lastHu: '2026-04-09', revenueCents: 708990 },
  { id: 'v11', plate: 'B-SL 7015', driverIds: [], tuevValidUntil: '2027-07-31', lastHu: '2026-07-14', revenueCents: null },
  { id: 'v12', plate: 'B-SL 7342', driverIds: ['d16'], tuevValidUntil: null, lastHu: null, revenueCents: 442080 },
  { id: 'v13', plate: 'B-SL 8056', driverIds: ['d17', 'd18'], tuevValidUntil: '2026-12-31', lastHu: '2025-12-01', revenueCents: 624110 },
  { id: 'v14', plate: 'B-SL 9120', driverIds: ['d19'], tuevValidUntil: '2027-02-28', lastHu: '2026-02-03', revenueCents: 676650 },
];

export const PREVIEW_OPEN_SALARIES: PreviewSalary[] = [
  { id: 's01', driverId: 'd02', year: 2026, monthIndex: 7, dueCents: 341280, paidCents: 0 },
  { id: 's02', driverId: 'd04', year: 2026, monthIndex: 7, dueCents: 390544, paidCents: 200000 },
  { id: 's03', driverId: 'd09', year: 2026, monthIndex: 7, dueCents: 298710, paidCents: 0 },
  { id: 's04', driverId: 'd12', year: 2026, monthIndex: 6, dueCents: 312065, paidCents: 250000 },
];

/** March to August 2026; the last entry is the reporting month. */
export const PREVIEW_MONTHS: PreviewMonth[] = [
  { year: 2026, monthIndex: 2, revenueCents: 9120415, costsCents: 2091140, salariesCents: 3648166 },
  { year: 2026, monthIndex: 3, revenueCents: 9487760, costsCents: 2348075, salariesCents: 3795104 },
  { year: 2026, monthIndex: 4, revenueCents: 9931025, costsCents: 2190230, salariesCents: 3972410 },
  { year: 2026, monthIndex: 5, revenueCents: 9564280, costsCents: 2411865, salariesCents: 3825712 },
  { year: 2026, monthIndex: 6, revenueCents: 9778135, costsCents: 2210490, salariesCents: 3911254 },
  { year: 2026, monthIndex: 7, revenueCents: 10443280, costsCents: 2128645, salariesCents: 4177312 },
];

export const driverName = (id: string): string => PREVIEW_DRIVERS.find(driver => driver.id === id)?.name ?? id;

export const sumCents = (values: Array<number | null>): number =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

export const profitCents = (month: PreviewMonth): number => month.revenueCents - month.costsCents - month.salariesCents;

export const centsToEuros = (cents: number): number => cents / 100;

export type TuevState = 'valid' | 'expiringSoon' | 'expired' | 'unknown';

export interface TuevInfo {
  state: TuevState;
  /** Days until expiry; negative once expired, null without a date. */
  daysLeft: number | null;
}

const MS_PER_DAY = 86_400_000;
const utcDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/**
 * The rule of getTuevStatus in src/types/car.ts (warning within 60 days),
 * evaluated against a given day instead of the clock, and on UTC calendar days
 * so no timezone moves a date.
 */
export function tuevOn(validUntil: string | null, today: string = PREVIEW_TODAY): TuevInfo {
  if (!validUntil) return { state: 'unknown', daysLeft: null };
  const daysLeft = Math.round((utcDay(validUntil) - utcDay(today)) / MS_PER_DAY);
  if (daysLeft < 0) return { state: 'expired', daysLeft };
  if (daysLeft <= 60) return { state: 'expiringSoon', daysLeft };
  return { state: 'valid', daysLeft };
}

/** "August 2026" or "August", in the UI language; numbers stay German elsewhere. */
export function monthLabel(year: number, monthIndex: number, language: string, withYear = true): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'de-DE', {
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(Date.UTC(year, monthIndex, 1));
}

export function shortMonthLabel(year: number, monthIndex: number, language: string): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'de-DE', { month: 'short', timeZone: 'UTC' }).format(
    Date.UTC(year, monthIndex, 1),
  );
}
