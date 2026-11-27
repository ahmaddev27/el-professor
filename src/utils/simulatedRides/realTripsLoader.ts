import type { supabase } from '../../lib/supabase';
import { fetchAllPaginated } from '../fetchAllPaginated';
import { REAL_TRIP_COLUMNS, type RealTripDriverRef, type RealTripRow } from './realTrips';

/**
 * The reads behind `readRealTrips`: the company's real trips around one
 * calendar month and its drivers. Read-only, paged (PostgREST stops at 1000
 * rows without an error), and through the caller's client, so a test needs no
 * browser. Nothing here writes a trip; the table is append-only by design and
 * this module has no reason to ask otherwise.
 */

/**
 * `trip_date` is the file's "Datum der Fahrt", which the Uber export dates a
 * day early for a ride starting just after midnight, and an operating day ends
 * at its cut-off hour on the next calendar day. Two days either side hold every
 * trip whose operating day lies in the month; `readRealTrips` drops the rest.
 */
const TRIP_DATE_REACH_DAYS = 2;

function shiftDay(day: string, days: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function realTripReadWindow(year: number, month: number): { from: string; to: string } {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from: shiftDay(first, -TRIP_DATE_REACH_DAYS), to: shiftDay(last, TRIP_DATE_REACH_DAYS) };
}

export type RealTripsLoaderClient = Pick<typeof supabase, 'from'>;

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function loadRealTripRows(
  companyId: string,
  year: number,
  month: number,
  client: RealTripsLoaderClient,
): Promise<{ rows: RealTripRow[]; drivers: RealTripDriverRef[] }> {
  const span = realTripReadWindow(year, month);
  const [rows, drivers] = await Promise.all([
    fetchAllPaginated<RealTripRow>((from, to) =>
      client.from('fahrtenbuch_trips').select(REAL_TRIP_COLUMNS)
        .eq('company_id', companyId).eq('is_simulated', false)
        .gte('trip_date', span.from).lte('trip_date', span.to)
        .order('id').range(from, to) as unknown as Page<RealTripRow>),
    fetchAllPaginated<RealTripDriverRef>((from, to) =>
      client.from('drivers').select('id, name')
        .eq('company_id', companyId).order('id').range(from, to) as unknown as Page<RealTripDriverRef>),
  ]);
  return { rows, drivers };
}
