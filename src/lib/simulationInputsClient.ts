import type { StructuredNote } from '../utils/monatsplanungPhase3';
import type { WerkstattCheckRow } from '../utils/constraintDecisionLog';
import { supabase } from './supabase';

/**
 * What the simulator reads BEFORE it places a ride (decision 5 of 29.10.2026):
 * the drivers' notes, the planning columns of the drivers table, and the
 * workshop checks of the month.
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

export interface DriverPlanningFacts {
  id: string;
  allowed_weekdays: number[] | null;
  planning_enabled: boolean;
}

/** The two planning columns the driver chooser's reader does not carry, consulted by id only. */
export async function loadDriverPlanningFacts(companyId: string): Promise<Map<string, DriverPlanningFacts>> {
  const rows = await fetchAll<DriverPlanningFacts>((from, to) =>
    supabase
      .from('drivers')
      .select('id, allowed_weekdays, planning_enabled')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to));
  return new Map(rows.map(r => [r.id, r]));
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
