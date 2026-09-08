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
  status?: 'active' | 'inactive';
  personalnummer?: string;
  gender?: 'male' | 'female' | null;
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
  source_type?: 'manual' | 'weekly_cash_difference';
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