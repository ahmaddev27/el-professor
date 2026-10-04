/**
 * The Fahrtenanalyse screen's reads and its three writes.
 *
 * Reads: the company's Fahrtenbuch imports, one import's trips, the company's
 * drivers, the month's saved Stundennachweise, and the two tables of
 * 20260922110000. Writes: the settings, a driver's reserve, and the
 * confirmation of a month's budget — nothing else, and never a trip.
 *
 * Every call names the company the session is in (`effectiveCompanyId`) and
 * throws on a failed request, so the screen can say the read failed instead of
 * showing an empty month.
 *
 * ## Why the trips are read with `*`
 *
 * Slice A adds `start_at`, `end_at` and `currency` to `fahrtenbuch_trips`, and
 * this screen must work on either side of that migration. Naming a column
 * PostgREST does not have fails the whole request, so the row is read whole and
 * the engine's adapter (`analysisTripFromRow`) uses the new columns when they
 * are there and derives the times from the older ones when they are not.
 */
import { supabase } from './supabase';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import type { TripRowForAnalysis } from '../utils/tripAnalysis/types';
import type { SavedStundennachweisRecord } from './tripAnalysisShifts';
import type { BudgetRow, CompanyDriver, SettingsRow } from './tripAnalysisView';

export interface ImportSummary {
  id: string;
  month: number;
  year: number;
  file_name: string;
  imported_at: string;
  row_count: number;
  status: string;
}

const SETTINGS_COLUMNS = 'id, block_gap_minutes, travel_margin_minutes, updated_at';
const BUDGET_COLUMNS =
  'id, driver_id, year, month, reserved_hours, planning_min_salary, planning_max_salary, planning_hourly_rate, confirmed_at, confirmed_by, recompute_log';

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export async function loadImports(companyId: string): Promise<ImportSummary[]> {
  const { data, error } = await supabase
    .from('fahrtenbuch_imports')
    .select('id, month, year, file_name, imported_at, row_count, status')
    .eq('company_id', companyId)
    .order('imported_at', { ascending: false });
  fail(error);
  return (data ?? []) as ImportSummary[];
}

/** Every trip of one import, in pages of 1000 ordered by id. */
export async function loadTripRows(companyId: string, importId: string): Promise<TripRowForAnalysis[]> {
  return fetchAllPaginated<TripRowForAnalysis>(
    (from, to) =>
      supabase
        .from('fahrtenbuch_trips')
        .select('*')
        .eq('company_id', companyId)
        .eq('import_id', importId)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: TripRowForAnalysis[] | null; error: { message: string } | null }>,
    { label: 'Fahrten' },
  );
}

export async function loadCompanyDrivers(companyId: string): Promise<CompanyDriver[]> {
  const { data, error } = await supabase
    .from('drivers')
    .select('id, name, status, planning_min_salary, planning_max_salary, planning_hourly_rate')
    .eq('company_id', companyId)
    .order('name', { ascending: true });
  fail(error);
  return (data ?? []) as CompanyDriver[];
}

/** The month's saved Stundennachweise: the recorded shifts of release 1. */
export async function loadSavedStundennachweise(companyId: string, year: number, month: number): Promise<SavedStundennachweisRecord[]> {
  const { data, error } = await supabase
    .from('saved_stundennachweise')
    .select('id, driver_id, month, year, rows_json')
    .eq('company_id', companyId)
    .eq('year', year)
    .eq('month', month);
  fail(error);
  return (data ?? []) as SavedStundennachweisRecord[];
}

export async function loadSettings(companyId: string): Promise<SettingsRow | null> {
  const { data, error } = await supabase
    .from('trip_analysis_settings')
    .select(SETTINGS_COLUMNS)
    .eq('company_id', companyId)
    .maybeSingle();
  fail(error);
  return (data ?? null) as SettingsRow | null;
}

export async function loadBudgets(companyId: string, year: number, month: number): Promise<BudgetRow[]> {
  const { data, error } = await supabase
    .from('driver_month_budget')
    .select(BUDGET_COLUMNS)
    .eq('company_id', companyId)
    .eq('year', year)
    .eq('month', month);
  fail(error);
  return (data ?? []) as BudgetRow[];
}

/** Stores the two settings; null stores "not set". Administrators only (RLS). */
export async function saveSettings(
  companyId: string,
  values: { blockGapMinutes: number | null; travelMarginMinutes: number | null },
): Promise<SettingsRow> {
  const { data, error } = await supabase
    .from('trip_analysis_settings')
    .upsert(
      { company_id: companyId, block_gap_minutes: values.blockGapMinutes, travel_margin_minutes: values.travelMarginMinutes },
      { onConflict: 'company_id' },
    )
    .select(SETTINGS_COLUMNS)
    .single();
  fail(error);
  return data as SettingsRow;
}

/**
 * Stores a driver's reserve for the month; null stores "not set". On a
 * confirmed month the database records the change in the budget's log.
 */
export async function saveReserve(
  companyId: string,
  driverId: string,
  year: number,
  month: number,
  reservedHours: number | null,
): Promise<BudgetRow> {
  const { data, error } = await supabase
    .from('driver_month_budget')
    .upsert(
      { company_id: companyId, driver_id: driverId, year, month, reserved_hours: reservedHours },
      { onConflict: 'company_id,year,month,driver_id' },
    )
    .select(BUDGET_COLUMNS)
    .single();
  fail(error);
  return data as BudgetRow;
}

/**
 * Confirms a month's budget, or recomputes a confirmed one. Writing
 * `confirmed_at` is the request; the database takes the driver's figures,
 * stamps the time and the account, and records a recompute in the log
 * (app_private.driver_month_budget_guard). The client's timestamp is discarded.
 */
export async function confirmBudget(
  companyId: string,
  driverId: string,
  year: number,
  month: number,
  existing: BudgetRow | undefined,
): Promise<BudgetRow> {
  const request = new Date().toISOString();
  const query = existing
    ? supabase.from('driver_month_budget').update({ confirmed_at: request }).eq('id', existing.id).eq('company_id', companyId)
    : supabase.from('driver_month_budget').insert({ company_id: companyId, driver_id: driverId, year, month, confirmed_at: request });
  const { data, error } = await query.select(BUDGET_COLUMNS).single();
  fail(error);
  return data as BudgetRow;
}
