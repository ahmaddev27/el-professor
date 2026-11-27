import type { supabase } from '../../lib/supabase';
import { fetchAllPaginated } from '../fetchAllPaginated';
import {
  readUberMonth,
  type UberDriverRef,
  type UberIncomeRow,
  type UberMonthImport,
  type UberPartnerLink,
} from './uberImport';

/**
 * The reads behind `readUberMonth`: the income rows around one calendar
 * month, the company's drivers and its partner links. Read-only, and every
 * read pages, because PostgREST cuts a response at 1000 rows without an error.
 * The client is the caller's (the screen passes `supabase`), so a test needs
 * no browser.
 */

/** The partner both Uber writers link drivers through (`c_partner` in 20261014100000 and 20261015130000). */
export const UBER_PARTNER = 'reidey';

const INCOME_COLUMNS =
  'id, type, amount, date, driver_name, source, source_driver_key, source_period_start, source_period_end, trip_count';

/** An imported period is at most 7 operating days, so its row's `date` lies within 6 days of the month. */
const PERIOD_REACH_DAYS = 6;

function shiftDay(day: string, days: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The `income.date` range that holds every row whose period touches the month. */
export function uberReadWindow(year: number, month: number): { from: string; to: string } {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from: shiftDay(first, -PERIOD_REACH_DAYS), to: shiftDay(last, PERIOD_REACH_DAYS) };
}

export type UberLoaderClient = Pick<typeof supabase, 'from'>;

export async function loadUberMonth(
  companyId: string,
  year: number,
  month: number,
  client: UberLoaderClient,
): Promise<UberMonthImport> {
  const span = uberReadWindow(year, month);
  const [rows, drivers, links] = await Promise.all([
    fetchAllPaginated<UberIncomeRow>((from, to) =>
      client.from('income').select(INCOME_COLUMNS)
        .eq('company_id', companyId).gte('date', span.from).lte('date', span.to)
        .order('id').range(from, to) as unknown as PromiseLike<{ data: UberIncomeRow[] | null; error: { message: string } | null }>),
    fetchAllPaginated<UberDriverRef>((from, to) =>
      client.from('drivers').select('id, name')
        .eq('company_id', companyId).order('id').range(from, to) as unknown as PromiseLike<{ data: UberDriverRef[] | null; error: { message: string } | null }>),
    fetchAllPaginated<UberPartnerLink>((from, to) =>
      client.from('partner_driver_links').select('external_driver_id, driver_id, status')
        .eq('company_id', companyId).eq('partner', UBER_PARTNER)
        .order('external_driver_id').range(from, to) as unknown as PromiseLike<{ data: UberPartnerLink[] | null; error: { message: string } | null }>),
  ]);
  return readUberMonth(year, month, rows, drivers, links);
}
