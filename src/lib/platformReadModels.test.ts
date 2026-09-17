import { describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY_MAX_OFFSET,
  DIRECTORY_PAGE_SIZE,
  UNKNOWN_COMPANY_COUNTS,
  collectCompanyCounts,
  directoryHasNextPage,
  directoryOffset,
  directoryPageCount,
  directoryReachablePageCount,
  directoryRpcArgs,
  parseDriverRow,
  parsePlatformReadPage,
  parseUserRow,
  parseVehicleRow,
  platformReadRefusalKey,
  searchArg,
} from './platformReadModels';

describe('directoryOffset', () => {
  it('is the page index times the page size', () => {
    expect(directoryOffset(0)).toBe(0);
    expect(directoryOffset(1)).toBe(100);
    expect(directoryOffset(7, 25)).toBe(175);
  });

  it('never exceeds the offset the database accepts', () => {
    // app_private.platform_read_offset raises 22023 above 10000, so a screen
    // that asked for a deeper page would get an exception, not a page.
    expect(directoryOffset(500)).toBe(DIRECTORY_MAX_OFFSET);
    expect(directoryOffset(101)).toBe(DIRECTORY_MAX_OFFSET);
  });

  it('treats a negative or broken page index as the first page', () => {
    expect(directoryOffset(-3)).toBe(0);
    expect(directoryOffset(Number.NaN)).toBe(0);
  });
});

describe('directoryPageCount', () => {
  it('counts whole and partial pages', () => {
    expect(directoryPageCount(0)).toBe(1);
    expect(directoryPageCount(100)).toBe(1);
    expect(directoryPageCount(101)).toBe(2);
    expect(directoryPageCount(250, 100)).toBe(3);
  });
});

describe('directoryReachablePageCount', () => {
  it('matches the page count while every page can be opened', () => {
    expect(directoryReachablePageCount(0)).toBe(1);
    expect(directoryReachablePageCount(250)).toBe(3);
  });

  it('never advertises a page the offset ceiling refuses', () => {
    // 50 000 rows fill 500 pages, but page 102 starts at offset 10 100, which
    // app_private.platform_read_offset answers with 22023. The label has to stop
    // where the Weiter button already stops, or it promises 399 pages that do
    // not exist for the reader.
    expect(directoryPageCount(50_000)).toBe(500);
    expect(directoryReachablePageCount(50_000)).toBe(101);
    expect(directoryHasNextPage(100, 50_000)).toBe(false);
  });

  it('follows the page size it is given', () => {
    expect(directoryReachablePageCount(1_000_000, 25)).toBe(401);
  });
});

describe('directoryHasNextPage', () => {
  it('follows the row count', () => {
    expect(directoryHasNextPage(0, 250)).toBe(true);
    expect(directoryHasNextPage(2, 250)).toBe(false);
    expect(directoryHasNextPage(0, 100)).toBe(false);
  });

  it('stops at the offset ceiling even when more rows exist', () => {
    // Page 100 starts at offset 10000, the last the database serves. Page 101
    // would be refused, so the screen must not offer it.
    expect(directoryHasNextPage(99, 1_000_000)).toBe(true);
    expect(directoryHasNextPage(100, 1_000_000)).toBe(false);
  });
});

describe('parsePlatformReadPage', () => {
  const item = (raw: Record<string, unknown>) => raw.id as string;

  it('reads a page', () => {
    expect(parsePlatformReadPage(
      { ok: true, total: 3, limit: 100, offset: 0, items: [{ id: 'a' }, { id: 'b' }] },
      item,
    )).toEqual({ ok: true, total: 3, limit: 100, offset: 0, items: ['a', 'b'] });
  });

  it('keeps a refusal as a refusal, with its reason', () => {
    expect(parsePlatformReadPage({ ok: false, reason: 'not_authorized' }, item))
      .toEqual({ ok: false, reason: 'not_authorized' });
  });

  it('reports a malformed answer rather than showing an empty directory', () => {
    // An empty table would read as "this company has no vehicles", which is a
    // different statement from "the answer could not be read".
    for (const data of [null, undefined, 'ok', 42, [], { ok: true }, { ok: true, items: 'none' }]) {
      expect(parsePlatformReadPage(data, item)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('falls back to the item count when the total is missing', () => {
    const page = parsePlatformReadPage({ ok: true, items: [{ id: 'a' }] }, item);
    expect(page).toEqual({ ok: true, total: 1, limit: DIRECTORY_PAGE_SIZE, offset: 0, items: ['a'] });
  });
});

describe('platformReadRefusalKey', () => {
  it('separates a refusal from a failure', () => {
    expect(platformReadRefusalKey('not_authorized')).toBe('admin.read.denied');
    expect(platformReadRefusalKey('malformed')).toBe('admin.read.failed');
    expect(platformReadRefusalKey('something_new')).toBe('admin.read.failed');
  });
});

describe('searchArg', () => {
  it('is null for an empty search, so no filter is sent', () => {
    expect(searchArg('')).toBeNull();
    expect(searchArg('   ')).toBeNull();
  });

  it('sends what was typed, trimmed and capped at the length the database takes', () => {
    expect(searchArg('  B-AB 1234 ')).toBe('B-AB 1234');
    expect(searchArg('x'.repeat(200))).toHaveLength(100);
  });
});

describe('directoryRpcArgs', () => {
  it('turns an empty filter into NULL, not an empty string', () => {
    // platform_read_token refuses '' with 22023, and an empty company id would
    // be a filter that matches nothing.
    expect(directoryRpcArgs({ companyId: '', search: '', status: '', sort: 'name_asc', pageIndex: 0 }))
      .toEqual({
        p_company_id: null,
        p_search: null,
        p_status: null,
        p_sort: 'name_asc',
        p_limit: DIRECTORY_PAGE_SIZE,
        p_offset: 0,
      });
  });

  it('pages with the offset of the page asked for', () => {
    const args = directoryRpcArgs({
      companyId: 'c1', search: 'Müller', status: 'active', sort: 'name_desc', pageIndex: 2,
    });
    expect(args.p_offset).toBe(200);
    expect(args.p_company_id).toBe('c1');
    expect(args.p_search).toBe('Müller');
  });
});

describe('the reduced columns', () => {
  // Migration 20260916140000 lists these key by key, and leaving a column out
  // is a data protection decision. A row type that grew a field would show it.
  it('vehicles carry no created_by and no updated_at', () => {
    expect(Object.keys(parseVehicleRow({}))).toEqual([
      'id', 'company_id', 'company_name', 'kennzeichen', 'status',
      'tuev_gueltig_bis', 'letzte_hu', 'created_at',
    ]);
  });

  it('drivers carry no salary, Personalnummer or planning figure', () => {
    expect(Object.keys(parseDriverRow({}))).toEqual([
      'id', 'company_id', 'company_name', 'name', 'status', 'driver_usage_type', 'created_at',
    ]);
  });

  it('users carry no metadata and no profile id', () => {
    expect(Object.keys(parseUserRow({}))).toEqual([
      'user_id', 'email', 'full_name', 'company_id', 'company_name', 'role', 'role_name',
      'status', 'created_at', 'invited_at', 'activated_at', 'email_confirmed_at', 'last_sign_in_at',
    ]);
  });

  it('reads a row and leaves a missing column null', () => {
    expect(parseDriverRow({ id: 'd1', name: 'Ali', company_name: 'Y&A' })).toEqual({
      id: 'd1',
      company_id: null,
      company_name: 'Y&A',
      name: 'Ali',
      status: null,
      driver_usage_type: null,
      created_at: null,
    });
  });
});

/*
  collectCompanyCounts pages platform_companies_list, and every page it asks for
  is one row in an append-only audit log. So the number of calls is itself an
  assertion here, not a detail.
*/
describe('collectCompanyCounts', () => {
  /** A company row with only what the counts read. */
  const row = (id: string, users: number) => ({
    id, name: id, slug: null, status: null, approval_status: null, plan: null, trial_state: null,
    subscription_status: null, subscription_expires_at: null, open_invoice_count: 0, overdue_invoice_count: 0,
    user_count: users, active_driver_count: users + 1, active_vehicle_count: users + 2,
  });

  /** A fake read model holding `total` companies, served DIRECTORY_PAGE_SIZE at a time. */
  const readModel = (total: number) => vi.fn(async (pageIndex: number) => {
    const offset = Math.min(pageIndex * DIRECTORY_PAGE_SIZE, DIRECTORY_MAX_OFFSET);
    const count = Math.max(0, Math.min(DIRECTORY_PAGE_SIZE, total - offset));
    return {
      ok: true as const,
      total,
      limit: DIRECTORY_PAGE_SIZE,
      offset,
      items: Array.from({ length: count }, (_, i) => row(`c${offset + i}`, (offset + i) % 5)),
    };
  });

  it('reads every page, and asks for no page past the last', async () => {
    const fetchPage = readModel(250);
    const counts = await collectCompanyCounts(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(counts.known).toBe(true);
    expect(Object.keys(counts.users)).toHaveLength(250);
    expect(counts.users.c249).toBe(4);
    expect(counts.drivers.c249).toBe(5);
    expect(counts.vehicles.c249).toBe(6);
  });

  it('knows a platform with no companies at all after one call', async () => {
    const fetchPage = readModel(0);
    const counts = await collectCompanyCounts(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(counts.known).toBe(true);
  });

  it('stops at the offset ceiling instead of asking for offset 10 000 forever', async () => {
    // The loop this replaced paged until offset + items >= total. Past 10 100
    // companies directoryOffset clamps, every page is offset 10 000 again, and
    // that condition never came true — an audit row per iteration, unbounded.
    const fetchPage = readModel(20_000);
    const counts = await collectCompanyCounts(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(DIRECTORY_MAX_OFFSET / DIRECTORY_PAGE_SIZE + 1);
    // Companies past the ceiling were never read, so the counts are not known.
    expect(counts).toBe(UNKNOWN_COMPANY_COUNTS);
  });

  it('is known right up to the last reachable page', async () => {
    const fetchPage = readModel(DIRECTORY_MAX_OFFSET + DIRECTORY_PAGE_SIZE);
    const counts = await collectCompanyCounts(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(DIRECTORY_MAX_OFFSET / DIRECTORY_PAGE_SIZE + 1);
    expect(counts.known).toBe(true);
  });

  it('leaves the counts unknown on a refusal, and asks nothing further', async () => {
    const fetchPage = vi.fn(async () => ({ ok: false as const, reason: 'not_authorized' }));
    expect(await collectCompanyCounts(fetchPage)).toBe(UNKNOWN_COMPANY_COUNTS);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('leaves the counts unknown on a transport error instead of throwing', async () => {
    // fetchCompanies throws on a Supabase error. Uncaught, it aborted the whole
    // dashboard load, and the company table and approvals never rendered.
    const first = readModel(250);
    const fetchPage = vi.fn(async (pageIndex: number) => {
      if (pageIndex === 1) throw new Error('Failed to fetch');
      return first(pageIndex);
    });
    await expect(collectCompanyCounts(fetchPage)).resolves.toBe(UNKNOWN_COMPANY_COUNTS);
  });

  it('does not call a table that shrank mid-read complete', async () => {
    const fetchPage = vi.fn(async (pageIndex: number) => ({
      ok: true as const, total: 250, limit: DIRECTORY_PAGE_SIZE, offset: pageIndex * DIRECTORY_PAGE_SIZE,
      items: pageIndex === 0 ? [row('c0', 1)] : [],
    }));
    expect(await collectCompanyCounts(fetchPage)).toBe(UNKNOWN_COMPANY_COUNTS);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
