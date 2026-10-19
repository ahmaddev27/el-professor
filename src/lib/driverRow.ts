/**
 * One `drivers` row as the Fahrer screen and its edit form read it.
 *
 * `employment_type` must be carried. The edit form (`DriverModal`) opens a
 * driver with `driver.employment_type ?? 'employee'`, and saving writes that
 * value back through `planningToDb`, so a row mapped without it turned every
 * Inhaber into an employee on the next save of any field — and planning then
 * applied the hour limits an Inhaber is exempt from. The create and update
 * paths in `useDatabase` already carried it; only the list read did not.
 *
 * THE RULE THIS FILE HAS TO KEEP: this mapper is the only producer of the
 * objects the Fahrer screen renders and exports, and its key list is explicit,
 * so a column the screen reads under a name the mapper does not emit is blank
 * with nothing thrown and nothing logged. `created_at` was exactly that: the
 * Fahrer export declared a `createdAt` column, `.select('*')` had the value in
 * hand, and the mapper dropped it — 40 drivers, 40 empty cells under
 * "Erstellt am". `driverRow.test.ts` now reads the export's declared keys out
 * of `DriversManagement.tsx` and fails when one of them is not emitted here.
 *
 * The audit columns keep the `Driver` type's camelCase — `createdBy`,
 * `createdAt` — not the column's `created_at`, so the pair reads the same way
 * in the export and in `canEditDriver`.
 */
import type { Driver } from '../types/receipt';
import { toDriverLanguage } from './driverLanguage';

export interface DriverRow {
  id: string;
  name: string;
  salary_ratio: number;
  created_by?: string | null;
  created_at?: string | null;
  status?: string | null;
  personalnummer?: string | null;
  gender?: string | null;
  email?: string | null;
  phone?: string | null;
  preferred_language?: string | null;
  employment_type?: string | null;
  driver_usage_type?: string | null;
  planning_target_salary?: number | null;
  planning_min_salary?: number | null;
  planning_max_salary?: number | null;
  planning_hourly_rate?: number | null;
  planning_priority?: number | null;
  planning_enabled?: boolean | null;
  can_cover_other_drivers?: boolean | null;
  allowed_weekdays?: number[] | null;
  work_window_start?: string | null;
  work_window_end?: string | null;
  allow_outside_shift_exceptions?: boolean | null;
  is_full_day_available?: boolean | null;
}

export function mapDriverRow(d: DriverRow): Driver {
  return {
    id: d.id,
    name: d.name,
    salary_ratio: d.salary_ratio,
    salaryRatio: d.salary_ratio,
    createdBy: d.created_by || undefined,
    createdAt: d.created_at || undefined,
    status: (d.status || 'active') as 'active' | 'inactive',
    personalnummer: d.personalnummer || undefined,
    gender: (d.gender ?? null) as 'male' | 'female' | null,
    // `?? null` and not `|| undefined`: an empty string in the column means the
    // same as no address, and the send path reads null to mean "skip and say so".
    email: d.email || null,
    phone: d.phone || null,
    // English for a row that does not carry the column (read before the migration).
    preferred_language: toDriverLanguage(d.preferred_language),
    employment_type: (d.employment_type ?? 'employee') as 'employee' | 'company_owner',
    // Planning fields
    driver_usage_type:      (d.driver_usage_type ?? 'regular') as 'regular' | 'coverage_only',
    planning_target_salary: d.planning_target_salary ?? null,
    planning_min_salary:    d.planning_min_salary ?? null,
    planning_max_salary:    d.planning_max_salary ?? null,
    planning_hourly_rate:   d.planning_hourly_rate ?? null,
    planning_priority:      d.planning_priority ?? 100,
    planning_enabled:       d.planning_enabled ?? true,
    can_cover_other_drivers: d.can_cover_other_drivers ?? true,
    allowed_weekdays:       d.allowed_weekdays ?? null,
    work_window_start:      d.work_window_start ?? null,
    work_window_end:        d.work_window_end ?? null,
    allow_outside_shift_exceptions: d.allow_outside_shift_exceptions ?? false,
    is_full_day_available:  d.is_full_day_available ?? false,
  };
}
