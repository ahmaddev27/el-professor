import type { StructuredNote } from '../utils/monatsplanungPhase3';
import type { WerkstattCheckRow } from '../utils/constraintDecisionLog';
import type { VehicleUnavailabilityRow } from '../utils/simulatedRides/vehicleAvailability';
import { supabase } from './supabase';

/**
 * What the simulator reads BEFORE it places a ride (decision 5 of 29.10.2026):
 * the drivers' notes, the planning columns of the drivers table, the workshop
 * checks of the month and, since Round 8, the vehicles' unavailability windows.
 *
 * Every read pages (PostgREST stops at 1000 rows without an error) and every
 * failure throws. A note that could not be read is not "no note": the caller
 * shows the error and generates nothing, because a month built without the
 * constraints it did not hear about looks exactly like one that honoured them.
 */

const PAGE = 1000;

async function fetchAll<Row>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<Row[]> {
  const all: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1);
    if (error || !data) throw new Error(error?.message ?? 'read returned no rows');
    all.push(...(data as Row[]));
    if (data.length < PAGE) return all;
  }
}

/**
 * Non-neutral notes, keyed by `drivers.id`. The same columns and the same
 * one-sided date bound as the monthly plan: a note whose end date lies before
 * `fromDate` cannot touch the month, one with no end date is fetched whatever
 * its dates say. Too wide only costs rows; too narrow drops a constraint.
 */
export async function loadDriverNotes(companyId: string, fromDate: string): Promise<Map<string, StructuredNote[]>> {
  const rows = await fetchAll<StructuredNote & { car_id?: string | null }>((from, to) =>
    supabase
      .from('driver_notes')
      .select('id, driver_id, note_type, note_text, note_planning_behavior, is_full_day, start_date, end_date, note_date, start_time, end_time, car_id')
      .eq('company_id', companyId)
      .neq('note_planning_behavior', 'neutral')
      .or(`end_date.is.null,end_date.gte.${fromDate}`)
      .order('id', { ascending: true })
      .range(from, to));
  const map = new Map<string, StructuredNote[]>();
  for (const note of rows) {
    const list = map.get(note.driver_id) ?? [];
    list.push(note);
    map.set(note.driver_id, list);
  }
  return map;
}

/**
 * The drivers-table columns a driver's month is planned from (Round 8, S4): his
 * weekdays and window, his hours range (min and max salary over the hourly
 * rate, `monthlyPlan/hoursRange.ts`), and the values printed beside it. Read by
 * id only; the names come from the driver chooser's own reader.
 */
export interface DriverPlanningFacts {
  id: string;
  status: string | null;
  employment_type: string | null;
  allowed_weekdays: number[] | null;
  planning_enabled: boolean;
  work_window_start: string | null;
  work_window_end: string | null;
  is_full_day_available: boolean | null;
  planning_min_salary: number | null;
  planning_max_salary: number | null;
  planning_hourly_rate: number | null;
  salary_ratio: number | null;
  planning_target_salary: number | null;
  target_monthly_hours: number | null;
  max_monthly_hours: number | null;
}

const DRIVER_PLANNING_COLUMNS = [
  'id', 'status', 'employment_type', 'allowed_weekdays', 'planning_enabled', 'work_window_start', 'work_window_end',
  'is_full_day_available', 'planning_min_salary', 'planning_max_salary', 'planning_hourly_rate', 'salary_ratio',
  'planning_target_salary', 'target_monthly_hours', 'max_monthly_hours',
].join(', ');

export async function loadDriverPlanningFacts(companyId: string): Promise<Map<string, DriverPlanningFacts>> {
  const rows = await fetchAll<DriverPlanningFacts>((from, to) =>
    supabase
      .from('drivers')
      .select(DRIVER_PLANNING_COLUMNS)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to));
  return new Map(rows.map(r => [r.id, r]));
}

/**
 * The cars' unavailability windows that can touch the month's operating days
 * (`vehicle_unavailability`). The bounds are a day wider on both sides than the
 * calendar month, because an operating day runs to 04:00 of the next one; an
 * open end is fetched whatever its start. Too wide only costs rows.
 */
export async function loadVehicleUnavailability(companyId: string, dayBefore: string, twoDaysAfter: string): Promise<VehicleUnavailabilityRow[]> {
  return fetchAll<VehicleUnavailabilityRow>((from, to) =>
    supabase
      .from('vehicle_unavailability')
      .select('id, car_id, starts_local, ends_local, reason')
      .eq('company_id', companyId)
      .lt('starts_local', twoDaysAfter)
      .or(`ends_local.is.null,ends_local.gt.${dayBefore}`)
      .order('id', { ascending: true })
      .range(from, to));
}

/** The month's workshop checks; a negative one is something to review, never a block. */
export async function loadWerkstattChecks(companyId: string, firstDay: string, lastDay: string): Promise<WerkstattCheckRow[]> {
  return fetchAll<WerkstattCheckRow>((from, to) =>
    supabase
      .from('werkstatt_checks')
      .select('car_id, check_date, status, notes')
      .eq('company_id', companyId)
      .gte('check_date', firstDay)
      .lte('check_date', lastDay)
      .order('id', { ascending: true })
      .range(from, to));
}
