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
  parseCompanyRow,
  parseDriverRow,
  parsePlatformReadPage,
  parseStaffRow,
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

  it('staff carry the sign-in address and the grantor, and no name, sign-in time or company', () => {
    // Migration 20260920140000 lists these, and tests/rls/platform-readmodels.sql
    // section 11 pins them key by key on the database side.
    expect(Object.keys(parseStaffRow({}))).toEqual([
      'user_id', 'email', 'role', 'status', 'disabled_at', 'note',
      'created_at', 'created_by', 'created_by_email', 'invitation_pending',
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

describe('parseStaffRow', () => {
  it('reads a member as the database answers it', () => {
    expect(parseStaffRow({
      user_id: 'u1', email: 'owner@example.com', role: 'owner', status: 'active', disabled_at: null,
      note: 'Gründer', created_at: '2026-09-16T10:00:00Z', created_by: 'u0',
      created_by_email: 'first@example.com', invitation_pending: false,
    })).toEqual({
      user_id: 'u1', email: 'owner@example.com', role: 'owner', status: 'active', disabled_at: null,
      note: 'Gründer', created_at: '2026-09-16T10:00:00Z', created_by: 'u0',
      created_by_email: 'first@example.com', invitation_pending: false,
    });
  });

  it('never hides a member it cannot fully read: an unclear status reads as active unless disabled_at says otherwise', () => {
    // On the screen that answers who holds platform rights, overstating access
    // is the safe direction; dropping the row or calling it disabled is not.
    expect(parseStaffRow({ user_id: 'u1' }).status).toBe('active');
    expect(parseStaffRow({ user_id: 'u1', status: 'paused' }).status).toBe('active');
    expect(parseStaffRow({ user_id: 'u1', status: 'paused', disabled_at: '2026-09-17T08:00:00Z' }).status).toBe('disabled');
    expect(parseStaffRow({ user_id: 'u1', status: 'disabled', disabled_at: '2026-09-17T08:00:00Z' }).status).toBe('disabled');
  });

  it('keeps a role this build does not know, rather than dropping the member', () => {
    expect(parseStaffRow({ user_id: 'u1', role: 'auditor' }).role).toBe('auditor');
  });

  it('treats only a true invitation_pending as open', () => {
    expect(parseStaffRow({ user_id: 'u1', invitation_pending: 'true' }).invitation_pending).toBe(false);
    expect(parseStaffRow({ user_id: 'u1', invitation_pending: true }).invitation_pending).toBe(true);
  });
});

describe('parseCompanyRow', () => {
  /*
    20260923100000 (plan 3.13b) added drivers_per_car_limit, so the dashboard
    stops reading company_settings across every company. It is the one column
    of that table this model carries, and it is nullable: a company with no
    settings row has no limit, which is not the same as a limit of nothing.
  */
  it('reads the driver allowance as a number, and anything else as unknown', () => {
    expect(parseCompanyRow({ id: 'c1', drivers_per_car_limit: 6 }).drivers_per_car_limit).toBe(6);
    expect(parseCompanyRow({ id: 'c1', drivers_per_car_limit: 0 }).drivers_per_car_limit).toBe(0);
    for (const value of [null, undefined, '6', Number.NaN, {}]) {
      expect(parseCompanyRow({ id: 'c1', drivers_per_car_limit: value }).drivers_per_car_limit).toBeNull();
    }
  });

  it('still reads the counts as numbers, with zero for a missing one', () => {
    const row = parseCompanyRow({ id: 'c1', name: 'C', user_count: 3 });
    expect(row).toMatchObject({ id: 'c1', name: 'C', user_count: 3, active_driver_count: 0, active_vehicle_count: 0 });
  });
});

/*
  collectCompanyCounts pages platform_companies_list, and every page it asks for
  is one row in an append-only audit log. So the number of calls is itself an
  assertion here, not a detail.
*/
describe('collectCompanyCounts', () => {
  /** A company row with only what the counts read. */
  const row = (id: string, users: number, driversPerCar: number | null = users + 3) => ({
    id, name: id, slug: null, status: null, approval_status: null, plan: null, trial_state: null,
    subscription_status: null, subscription_expires_at: null, open_invoice_count: 0, overdue_invoice_count: 0,
    user_count: users, active_driver_count: users + 1, active_vehicle_count: users + 2,
    drivers_per_car_limit: driversPerCar,
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
    expect(counts.driversPerCar.c249).toBe(7);
  });

  /*
    Plan 3.13b: since 20260923100000 a platform account reads company_settings
    only inside an open context, so this is the dashboard's only source for the
    driver allowance. A company without a settings row must stay *absent* from
    the map — the screen then applies its own default. Writing a 0 would show
    an allowance of zero drivers for a company that simply has no row.
  */
  it('carries the driver allowance, and leaves a company without one out of the map', async () => {
    const fetchPage = vi.fn(async () => ({
      ok: true as const, total: 2, limit: DIRECTORY_PAGE_SIZE, offset: 0,
      items: [row('with', 1, 6), row('without', 1, null)],
    }));
    const counts = await collectCompanyCounts(fetchPage);
    expect(counts.driversPerCar).toEqual({ with: 6 });
    expect(Object.prototype.hasOwnProperty.call(counts.driversPerCar, 'without')).toBe(false);
    // The counts themselves are unaffected: a missing settings row is not a
    // missing company.
    expect(counts.known).toBe(true);
    expect(counts.users.without).toBe(1);
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
