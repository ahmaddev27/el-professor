import type { DriverLanguage } from '../lib/driverLanguage';
export interface Receipt {
  id: string;
  receiptNumber: string;
  date: string;
  description: string;
  driverName: string;
  expense: number;
  postalCode?: string;
  city?: string;
  createdBy?: string;
  paymentMethod?: 'bar' | 'uberweisung';
  /**
   * What the Beleg itself says, filled when it came from the driver app
   * (20261011100000, 20261012100000). All optional: a Beleg entered by hand
   * has none of them, and an absent figure is not a zero.
   */
  merchantName?: string;
  /** `HH:MM:SS`, the time printed on the Beleg. */
  receiptTime?: string;
  litres?: number;
  pricePerLitre?: number;
  odometerKm?: number;
  rangeKm?: number;
  /**
   * The letterhead split (20261027150000): the brand half ("JET Tankstelle"),
   * the franchise operator after it, and the street with its house number.
   * `merchantName` keeps the whole name; old Belege carry none of these.
   */
  stationName?: string;
  operatorName?: string;
  street?: string;
  /**
   * The number PRINTED on the receipt (beside `Bon` on a JET one). NOT the
   * Belegnummer: `receiptNumber` stays the server-drawn `BEL-…` id, and
   * neither is ever copied into the other.
   */
  printedReceiptNumber?: string;
  /** `HH:MM:SS`, the fiscal TSE clock — not the sale time, which is `receiptTime`. */
  tseTime?: string;
  /**
   * The driver's name when the Beleg came from the driver app, which has no
   * user behind it: `createdBy` is then absent and this is who uploaded it.
   */
  submittedByName?: string;
}

export interface ReceiptFormData {
  receiptNumber: string;
  date: string;
  description: string;
  driverName: string;
  expense: number;
  postalCode?: string;
  city?: string;
  paymentMethod?: 'bar' | 'uberweisung';
  /**
   * What the Beleg itself says, as the driver app captures it. An absent figure
   * is `undefined` and reaches the column as NULL, never 0. The fuel figures
   * exist only for the refuel category (see utils/receiptFormRules.ts).
   */
  merchantName?: string;
  /** `HH:MM`, the time printed on the Beleg - not when it was entered. */
  receiptTime?: string;
  litres?: number;
  pricePerLitre?: number;
  odometerKm?: number;
  rangeKm?: number;
  /** The letterhead split and the printed number, as the receipt carries them. */
  stationName?: string;
  operatorName?: string;
  street?: string;
  printedReceiptNumber?: string;
  /** `HH:MM` or `HH:MM:SS`, the TSE clock - never written into receiptTime. */
  tseTime?: string;
}

export interface Income {
  id: string;
  description: string;
  amount: number;
  type: 'bargeld' | 'umsatz' | 'trinkgeld' | 'aktionen';
  driver_name: string;
  date: string;
  week?: number;
  trip_count?: number | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface IncomeFormData {
  description: string;
  amount: string;
  type: 'bargeld' | 'umsatz' | 'trinkgeld' | 'aktionen';
  driver_name: string;
  date: string;
  week?: number;
}

export interface Driver {
  id: string;
  name: string;
  salary_ratio?: number;
  salaryRatio?: number;
  createdBy?: string;
  /** `drivers.created_at`, carried by `mapDriverRow` for the Fahrer export. */
  createdAt?: string;
  status?: 'active' | 'inactive';
  personalnummer?: string;
  gender?: 'male' | 'female' | null;
  /** Where this driver's Abrechnung is sent. Absent is ordinary, not an error. */
  email?: string | null;
  /** E.164 (`+4917012345678`), so a wa.me link can be built without reprocessing. */
  phone?: string | null;
  /** The language this driver's e-mails are written in. Default English. */
  preferred_language?: DriverLanguage;
  // Planning fields
  driver_usage_type?: 'regular' | 'coverage_only';
  target_monthly_hours?: number | null;
  max_monthly_hours?: number | null;
  planning_target_salary?: number | null;
  planning_min_salary?: number | null;
  planning_max_salary?: number | null;
  planning_hourly_rate?: number | null;
  planning_priority?: number;
  planning_enabled?: boolean;
  can_cover_other_drivers?: boolean;
  allowed_weekdays?: number[] | null;
  work_window_start?: string | null;
  work_window_end?: string | null;
  allow_outside_shift_exceptions?: boolean;
  is_full_day_available?: boolean;
  employment_type?: 'employee' | 'company_owner';
}

/**
 * A driver's contact details as the form produces them: the address trimmed, the
 * number already in E.164.
 *
 * One object through the write path rather than two more positional arguments at
 * each of four hops. `onEditDriver` already takes seven parameters of which three
 * are optional, and an eighth and ninth string there is how a caller ends up
 * passing a phone number where a Personalnummer belongs with nothing to catch it.
 */
export interface DriverContact {
  email: string | null;
  phone: string | null;
  /**
   * Where the mail goes belongs with what language it is written in, so the
   * language travels in this object rather than as a tenth positional argument.
   * Always a language we write: the form cannot produce another.
   */
  preferred_language: DriverLanguage;
}

export interface Salary {
  id: string;
  driver_id: string;
  period_start: string;
  period_end: string;
  calc_revenue: number;
  calc_tips: number;
  amount_due: number;
  netto_salary?: number;
  status: 'paid' | 'unpaid';
  paid_at?: string;
  notes?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  total_paid?: number;
  remaining_balance?: number;
  payment_status?: 'unpaid' | 'partially_paid' | 'paid';
}

export interface SalaryPayment {
  id: string;
  salary_id: string;
  payment_type: 'cash' | 'bank';
  amount: number;
  payment_date: string;
  description: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  payment_category?: string;
  /** `gehaltsquittung` rows are written by confirm_salary_cash_payment and change only through their receipt. */
  source_type?: 'manual' | 'weekly_cash_difference' | 'gehaltsquittung';
  source_reference?: string;
  week_start?: string;
  week_end?: string;
}

export interface SalaryCalculation {
  driver_id: string;
  driver_name: string;
  salary_ratio: number;
  revenue: number;
  tips: number;
  revenue_share: number;
  amount_due: number;
  /** Clawbacks beyond what the period earned, in salary euros; display only. */
  unrecovered?: number;
  netto_salary?: number;
  status: 'paid' | 'unpaid';
  paid_at?: string;
  salary_id?: string;
  total_paid?: number;
  remaining_balance?: number;
  payment_status?: 'unpaid' | 'partially_paid' | 'paid';
  period_start?: string;
  period_end?: string;
}

export const INCOME_TYPES = {
  bargeld: 'Bargeld',
  umsatz: 'Umsatz',
  trinkgeld: 'Trinkgeld',
  aktionen: 'Aktionen'
} as const;

export interface CashTransaction {
  id: string;
  transaction_type: 'deposit' | 'payment';
  amount: number;
  description: string;
  reference_id?: string;
  reference_type?: string;
  date: string;
  created_by: string;
  created_at: string;
}

export interface CashTransactionFormData {
  transaction_type: 'deposit' | 'payment';
  amount: string;
  description: string;
  date: string;
}

export const PAYMENT_METHODS = {
  bar: 'Bar (Bargeld)',
  uberweisung: 'Überweisung'
} as const;