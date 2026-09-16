/**
 * The audited read models of the platform panel (plan 3.6b, section 3.D).
 *
 * `platform_companies_list`, `platform_vehicles_list`, `platform_drivers_list`
 * and `platform_users_list` are SECURITY DEFINER functions that check a
 * capability, write exactly one audit row per call, and answer
 *
 *   { ok: true,  total, limit, offset, items: [...] }
 *   { ok: false, reason: 'not_authorized' }
 *
 * A refusal is a **return value**, not an exception, so the `denied` row the
 * function wrote survives. Only a broken argument contract raises (22023), and
 * a raise arrives here as a Supabase error.
 *
 * They are VOLATILE, so supabase-js `rpc` calls them with POST: a GET would run
 * in a read-only transaction where the audit row could not be written, and the
 * read would fail rather than happen unrecorded.
 *
 * ## The columns are deliberately reduced
 *
 * No salary, no bank data, no personal identifier beyond the name, and the user
 * directory lists no account that has a platform staff row. Which columns the
 * directories carry is a data protection decision recorded in migration
 * 20260916140000 and pinned key by key by tests/rls/platform-readmodels.sql —
 * never a convenience. The row types below name exactly what the database
 * returns; do not widen one without widening the migration first.
 *
 * This module holds no I/O on purpose: the page arithmetic, the row shapes and
 * the refusal mapping are testable without a database, and the calls
 * themselves live in `platformDirectoryClient.ts`.
 */
import type { TranslationKey } from '../i18n';

// ─── Paging ──────────────────────────────────────────────────────────────────

/**
 * The page size the panel asks for. `app_private.platform_read_limit` refuses
 * anything above 100, so this is the maximum a directory screen may request.
 */
export const DIRECTORY_PAGE_SIZE = 100;

/**
 * The offset ceiling of `app_private.platform_read_offset`. A deeper page is
 * refused with 22023, so the screens stop at it rather than raise; a search or
 * a company filter is how one reaches rows beyond it.
 */
export const DIRECTORY_MAX_OFFSET = 10_000;

/** The offset of a zero-based page, never past the ceiling the database allows. */
export function directoryOffset(pageIndex: number, pageSize: number = DIRECTORY_PAGE_SIZE): number {
  if (!Number.isFinite(pageIndex) || pageIndex <= 0) return 0;
  const offset = Math.floor(pageIndex) * pageSize;
  return Math.min(offset, DIRECTORY_MAX_OFFSET);
}

/** How many pages `total` rows fill; at least one, so an empty list still has a page 1. */
export function directoryPageCount(total: number, pageSize: number = DIRECTORY_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Whether a next page exists *and* the database would serve it. Rows past the
 * offset ceiling exist but cannot be paged to — `platform_read_offset` refuses
 * the call outright — so a screen must not offer a button that raises. A search
 * or a company filter is how those rows are reached.
 */
export function directoryHasNextPage(
  pageIndex: number,
  total: number,
  pageSize: number = DIRECTORY_PAGE_SIZE,
): boolean {
  const next = Math.max(0, Math.floor(pageIndex)) + 1;
  if (next >= directoryPageCount(total, pageSize)) return false;
  return next * pageSize <= DIRECTORY_MAX_OFFSET;
}

// ─── The answer shape every read model shares ────────────────────────────────

export interface PlatformReadRefusal {
  ok: false;
  reason: string;
}

export interface PlatformReadPage<T> {
  ok: true;
  total: number;
  limit: number;
  offset: number;
  items: T[];
}

export type PlatformReadResult<T> = PlatformReadPage<T> | PlatformReadRefusal;

/**
 * The message a refusal reads as. `not_authorized` is the role lacking the
 * capability — the sidebar hiding an entry is a courtesy, this is the answer —
 * and anything else is an answer this build does not recognise, which is
 * reported as a failure rather than silently shown as an empty table.
 */
export function platformReadRefusalKey(reason: string): TranslationKey {
  return reason === 'not_authorized' ? 'admin.read.denied' : 'admin.read.failed';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableStr = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const int = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;

/**
 * Reads one page out of a read model's answer. Anything that is not the shape
 * the database documents is a refusal with reason `malformed`, so a screen
 * reports a problem instead of rendering an empty directory that looks like
 * "no rows".
 */
export function parsePlatformReadPage<T>(
  data: unknown,
  parseItem: (raw: Record<string, unknown>) => T,
  pageSize: number = DIRECTORY_PAGE_SIZE,
): PlatformReadResult<T> {
  if (!isRecord(data)) return { ok: false, reason: 'malformed' };
  if (data.ok !== true) {
    return { ok: false, reason: typeof data.reason === 'string' ? data.reason : 'malformed' };
  }
  if (!Array.isArray(data.items)) return { ok: false, reason: 'malformed' };

  const items = data.items.filter(isRecord).map(parseItem);
  return {
    ok: true,
    total: int(data.total, items.length),
    limit: int(data.limit, pageSize),
    offset: int(data.offset, 0),
    items,
  };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

/** Migration 20260916140000: no created_by, no updated_at. */
export interface PlatformVehicleRow {
  id: string;
  company_id: string | null;
  company_name: string | null;
  kennzeichen: string;
  status: string | null;
  tuev_gueltig_bis: string | null;
  letzte_hu: string | null;
  created_at: string | null;
}

/** No user_id, no Personalnummer, no salary, no planning figure. */
export interface PlatformDriverRow {
  id: string;
  company_id: string | null;
  company_name: string | null;
  name: string;
  status: string | null;
  driver_usage_type: string | null;
  created_at: string | null;
}

/** No metadata, no profile id; accounts with a platform staff row are not listed. */
export interface PlatformUserRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  company_id: string | null;
  company_name: string | null;
  role: string | null;
  role_name: string | null;
  status: string | null;
  created_at: string | null;
  invited_at: string | null;
  activated_at: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
}

/** Only what a company picker and a directory row need; no money figure. */
export interface PlatformCompanyRow {
  id: string;
  name: string;
  slug: string | null;
  status: string | null;
  approval_status: string | null;
  plan: string | null;
  trial_state: string | null;
  subscription_status: string | null;
  subscription_expires_at: string | null;
  open_invoice_count: number;
  overdue_invoice_count: number;
  user_count: number;
  active_driver_count: number;
  active_vehicle_count: number;
}

export function parseVehicleRow(raw: Record<string, unknown>): PlatformVehicleRow {
  return {
    id: str(raw.id),
    company_id: nullableStr(raw.company_id),
    company_name: nullableStr(raw.company_name),
    kennzeichen: str(raw.kennzeichen),
    status: nullableStr(raw.status),
    tuev_gueltig_bis: nullableStr(raw.tuev_gueltig_bis),
    letzte_hu: nullableStr(raw.letzte_hu),
    created_at: nullableStr(raw.created_at),
  };
}

export function parseDriverRow(raw: Record<string, unknown>): PlatformDriverRow {
  return {
    id: str(raw.id),
    company_id: nullableStr(raw.company_id),
    company_name: nullableStr(raw.company_name),
    name: str(raw.name),
    status: nullableStr(raw.status),
    driver_usage_type: nullableStr(raw.driver_usage_type),
    created_at: nullableStr(raw.created_at),
  };
}

export function parseUserRow(raw: Record<string, unknown>): PlatformUserRow {
  return {
    user_id: str(raw.user_id),
    email: nullableStr(raw.email),
    full_name: nullableStr(raw.full_name),
    company_id: nullableStr(raw.company_id),
    company_name: nullableStr(raw.company_name),
    role: nullableStr(raw.role),
    role_name: nullableStr(raw.role_name),
    status: nullableStr(raw.status),
    created_at: nullableStr(raw.created_at),
    invited_at: nullableStr(raw.invited_at),
    activated_at: nullableStr(raw.activated_at),
    email_confirmed_at: nullableStr(raw.email_confirmed_at),
    last_sign_in_at: nullableStr(raw.last_sign_in_at),
  };
}

export function parseCompanyRow(raw: Record<string, unknown>): PlatformCompanyRow {
  return {
    id: str(raw.id),
    name: str(raw.name),
    slug: nullableStr(raw.slug),
    status: nullableStr(raw.status),
    approval_status: nullableStr(raw.approval_status),
    plan: nullableStr(raw.plan),
    trial_state: nullableStr(raw.trial_state),
    subscription_status: nullableStr(raw.subscription_status),
    subscription_expires_at: nullableStr(raw.subscription_expires_at),
    open_invoice_count: int(raw.open_invoice_count, 0),
    overdue_invoice_count: int(raw.overdue_invoice_count, 0),
    user_count: int(raw.user_count, 0),
    active_driver_count: int(raw.active_driver_count, 0),
    active_vehicle_count: int(raw.active_vehicle_count, 0),
  };
}

// ─── The sorts each directory accepts ────────────────────────────────────────
//
// The database refuses any other value with 22023 before it reads anything, so
// these lists must stay in step with migration 20260916140000.

export const VEHICLE_SORTS = [
  'kennzeichen_asc', 'kennzeichen_desc', 'created_at_desc', 'created_at_asc',
  'tuev_gueltig_bis_asc', 'company_name_asc',
] as const;
export type VehicleSort = typeof VEHICLE_SORTS[number];

export const DRIVER_SORTS = [
  'name_asc', 'name_desc', 'created_at_desc', 'created_at_asc', 'company_name_asc',
] as const;
export type DriverSort = typeof DRIVER_SORTS[number];

export const USER_SORTS = [
  'created_at_desc', 'created_at_asc', 'email_asc', 'email_desc',
  'full_name_asc', 'last_sign_in_at_desc', 'company_name_asc',
] as const;
export type UserSort = typeof USER_SORTS[number];

// ─── What a directory screen asks for ────────────────────────────────────────

export interface DirectoryQuery {
  companyId: string | null;
  search: string;
  status: string | null;
  sort: string;
  pageIndex: number;
}

/**
 * A search box sends what was typed. The database trims it, caps it at 100
 * characters and escapes LIKE's own characters, so a search for "100%" finds
 * that text rather than matching everything. An empty search is no filter at
 * all — an empty string would be sent as a filter nothing matches.
 */
export function searchArg(search: string): string | null {
  const trimmed = search.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 100);
}

/**
 * One directory call's arguments. Written out here so the mapping from a
 * screen's filter state to the function's parameters is testable: the offset
 * must respect the ceiling, and an empty filter must become NULL rather than
 * an empty string, which `platform_read_token` refuses with 22023.
 */
export function directoryRpcArgs(query: DirectoryQuery): Record<string, unknown> {
  return {
    p_company_id: query.companyId || null,
    p_search: searchArg(query.search),
    p_status: query.status || null,
    p_sort: query.sort,
    p_limit: DIRECTORY_PAGE_SIZE,
    p_offset: directoryOffset(query.pageIndex),
  };
}
