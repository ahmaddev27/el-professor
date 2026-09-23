import { describe, expect, it, vi } from 'vitest';
import { PlatformCheckError } from './platform-access.ts';
import {
  decideCreateCompany,
  GOTRUE_PAGE_SIZE,
  MANAGE_USERS_SCOPE_MESSAGES,
  resolveAuthAccounts,
  resolveManageUsersScope,
  sameCompany,
  type ManageUsersScopeFacts,
} from './manage-users-routes.ts';

/*
  Plan 3.13a: manage-users acts with the service role, so the database's
  confinement of a platform account (3.4a) never reaches it. These are the pure
  decisions the function takes instead, before it reads or changes anything.
*/

const companyA = 'c0000000-0000-4000-8000-00000000000a';
const companyB = 'c0000000-0000-4000-8000-00000000000b';

function facts(overrides: Partial<ManageUsersScopeFacts> = {}) {
  const supportSessionCompanyId = vi.fn(async (): Promise<string | null> => companyA);
  return {
    supportSessionCompanyId,
    value: {
      isPlatformCaller: false,
      callerRole: 'admin',
      membershipCompanyId: companyA,
      supportSessionCompanyId,
      ...overrides,
    } as ManageUsersScopeFacts,
  };
}

describe('resolveManageUsersScope', () => {
  it('gives a company admin its own company, without asking about a support session', async () => {
    const f = facts();
    await expect(resolveManageUsersScope(f.value)).resolves.toEqual({ ok: true, companyId: companyA, via: 'membership' });
    expect(f.supportSessionCompanyId).not.toHaveBeenCalled();
  });

  it('refuses anyone who is neither an administrator nor a platform caller, before asking anything', async () => {
    for (const callerRole of ['viewer', 'editor', 'supervisor', null]) {
      const f = facts({ callerRole });
      await expect(resolveManageUsersScope(f.value)).resolves.toEqual({ ok: false, refusal: 'not_admin' });
      expect(f.supportSessionCompanyId).not.toHaveBeenCalled();
    }
  });

  it('refuses a company admin with no company, rather than reading that as "no restriction"', async () => {
    const f = facts({ membershipCompanyId: null });
    await expect(resolveManageUsersScope(f.value)).resolves.toEqual({ ok: false, refusal: 'admin_without_company' });
    expect(f.supportSessionCompanyId).not.toHaveBeenCalled();
  });

  it('gives a company-less platform caller the company of its open support session', async () => {
    const f = facts({ isPlatformCaller: true, callerRole: 'viewer', membershipCompanyId: null,
                      supportSessionCompanyId: vi.fn(async () => companyB) });
    await expect(resolveManageUsersScope(f.value)).resolves.toEqual({ ok: true, companyId: companyB, via: 'support_session' });
  });

  // The hole 3.13a closes: before it, a platform caller with no session reached
  // every company's accounts.
  it('refuses a company-less platform caller with no support session — no context, a view context, an expired one', async () => {
    const f = facts({ isPlatformCaller: true, callerRole: 'viewer', membershipCompanyId: null,
                      supportSessionCompanyId: vi.fn(async () => null) });
    await expect(resolveManageUsersScope(f.value)).resolves.toEqual({ ok: false, refusal: 'support_session_required' });
  });

  it('judges a platform account that still sits in a company by that company, as get_user_company_id() does', async () => {
    const f = facts({ isPlatformCaller: true, callerRole: 'viewer', membershipCompanyId: companyB });
    await expect(resolveManageUsersScope(f.value)).resolves.toEqual({ ok: true, companyId: companyB, via: 'membership' });
    expect(f.supportSessionCompanyId).not.toHaveBeenCalled();
  });

  it('lets a failed session check throw instead of granting or refusing a scope', async () => {
    const f = facts({ isPlatformCaller: true, membershipCompanyId: null,
                      supportSessionCompanyId: vi.fn(async () => { throw new PlatformCheckError('platform_support_company_id failed'); }) });
    await expect(resolveManageUsersScope(f.value)).rejects.toBeInstanceOf(PlatformCheckError);
  });

  it('says every refusal in German, and says what to do about the missing session', () => {
    expect(Object.keys(MANAGE_USERS_SCOPE_MESSAGES).sort()).toEqual(['admin_without_company', 'not_admin', 'support_session_required']);
    for (const message of Object.values(MANAGE_USERS_SCOPE_MESSAGES)) {
      expect(message).toMatch(/^Keine Berechtigung: /);
    }
    expect(MANAGE_USERS_SCOPE_MESSAGES.support_session_required).toContain('Support-Sitzung');
  });
});

describe('decideCreateCompany', () => {
  it('creates in the scope when the request names no company', () => {
    for (const requested of [undefined, null, '']) {
      expect(decideCreateCompany(companyA, requested)).toEqual({ ok: true, companyId: companyA });
    }
  });

  it('accepts a company_id that repeats the scope, in either case', () => {
    expect(decideCreateCompany(companyA, companyA)).toEqual({ ok: true, companyId: companyA });
    expect(decideCreateCompany(companyA, companyA.toUpperCase())).toEqual({ ok: true, companyId: companyA });
  });

  // Before 3.13a a platform caller's company_id was taken as it came, for any
  // company, and went into the role lookup's filter string unchecked.
  it('refuses a company_id that names another company', () => {
    expect(decideCreateCompany(companyA, companyB)).toEqual({ ok: false, refusal: 'other_company' });
  });

  it('refuses a company_id that is not a uuid as a broken request, so nothing reaches a filter', () => {
    for (const requested of ['x', `${companyB},company_id.not.is.null`, 42, {}, [companyA], true]) {
      expect(decideCreateCompany(companyA, requested)).toEqual({ ok: false, refusal: 'invalid_company' });
    }
  });
});

describe('sameCompany', () => {
  it('is true only for two present ids that name the same uuid', () => {
    expect(sameCompany(companyA, companyA)).toBe(true);
    expect(sameCompany(companyA, companyA.toUpperCase())).toBe(true);
    expect(sameCompany(companyA, companyB)).toBe(false);
    expect(sameCompany(null, null)).toBe(false);
    expect(sameCompany(undefined, undefined)).toBe(false);
    expect(sameCompany('', '')).toBe(false);
    expect(sameCompany(companyA, null)).toBe(false);
  });
});

/*
  Slice 3.13b. The `list` route called `auth.admin.listUsers()` with no
  arguments — GoTrue's first page of 50 accounts of the *whole project* — and
  applied the company filter to that page, so above 50 accounts on the
  installation a company's own users could be missing from its Benutzer screen,
  with a 200, a short array and the truncated count in the audit row.

  The fix drives from the company's own profiles and resolves them against
  GoTrue's paged list. What is tested here is the resolver: it must page, stop
  early, not read one page per account, and report an id it could not resolve
  instead of dropping it.
*/
describe('resolveAuthAccounts', () => {
  /** A GoTrue admin list holding `total` accounts, served perPage at a time. */
  const gotrue = (total: number) =>
    vi.fn(async (page: number, perPage: number) => {
      const offset = (page - 1) * perPage;
      return Array.from({ length: Math.max(0, Math.min(perPage, total - offset)) },
        (_, i) => ({ id: `u${offset + i}`, email: `u${offset + i}@test.invalid` }));
    });

  it('finds an account that the old first-page-of-50 read would have missed', async () => {
    // u120 is on GoTrue's third page of 50. Before this it was invisible.
    const listPage = gotrue(500);
    const out = await resolveAuthAccounts(['u120'], listPage, { perPage: 50 });
    expect(out.found).toEqual([{ id: 'u120', email: 'u120@test.invalid' }]);
    expect(out.complete).toBe(true);
    expect(out.pagesRead).toBe(3);
  });

  it('reads one page when the company fits in one, which is the ordinary case', async () => {
    const listPage = gotrue(40);
    const out = await resolveAuthAccounts(['u0', 'u7', 'u39'], listPage, { perPage: 200 });
    expect(out.found.map(u => u.id)).toEqual(['u0', 'u7', 'u39']);
    expect(listPage).toHaveBeenCalledTimes(1);
    expect(listPage).toHaveBeenCalledWith(1, 200);
  });

  it('stops as soon as every id is resolved, rather than reading the whole project', async () => {
    const listPage = gotrue(10_000);
    const out = await resolveAuthAccounts(['u0', 'u1'], listPage, { perPage: 200 });
    expect(out.complete).toBe(true);
    expect(out.pagesRead).toBe(1);
  });

  it('never asks one page per account: the count follows the pages, not the ids', async () => {
    const listPage = gotrue(400);
    const ids = Array.from({ length: 300 }, (_, i) => `u${i}`);
    const out = await resolveAuthAccounts(ids, listPage, { perPage: 200 });
    expect(out.found).toHaveLength(300);
    expect(out.pagesRead).toBe(2);
  });

  it('asks nothing at all for a company with no profiles', async () => {
    const listPage = gotrue(10_000);
    const out = await resolveAuthAccounts([], listPage);
    expect(listPage).not.toHaveBeenCalled();
    expect(out).toEqual({ found: [], missing: [], complete: true, pagesRead: 0 });
  });

  it('reports a profile with no auth account instead of dropping it', async () => {
    // The old code drove from the auth list, so such a profile simply vanished.
    const listPage = gotrue(10);
    const out = await resolveAuthAccounts(['u1', 'ghost', 'u2'], listPage, { perPage: 200 });
    expect(out.found.map(u => u.id)).toEqual(['u1', 'u2']);
    expect(out.missing).toEqual(['ghost']);
    expect(out.complete).toBe(false);
  });

  it("answers in the order the ids were given, not in GoTrue's", async () => {
    const listPage = gotrue(50);
    const out = await resolveAuthAccounts(['u9', 'u0', 'u4'], listPage, { perPage: 200 });
    expect(out.found.map(u => u.id)).toEqual(['u9', 'u0', 'u4']);
  });

  it('emits a repeated id once', async () => {
    const listPage = gotrue(10);
    const out = await resolveAuthAccounts(['u1', 'u1', 'u2'], listPage, { perPage: 200 });
    expect(out.found.map(u => u.id)).toEqual(['u1', 'u2']);
  });

  it('stops at the page ceiling and says the answer is incomplete', async () => {
    // A server that keeps answering a full page is an infinite loop inside an
    // edge function; the ceiling is what makes it a bounded, reported failure.
    const listPage = vi.fn(async (_page: number, perPage: number) =>
      Array.from({ length: perPage }, (_, i) => ({ id: `filler${i}` })));
    const out = await resolveAuthAccounts(['nowhere'], listPage, { perPage: 10, maxPages: 5 });
    expect(listPage).toHaveBeenCalledTimes(5);
    expect(out.complete).toBe(false);
    expect(out.missing).toEqual(['nowhere']);
  });

  it('ends on a short page: past the end GoTrue answers an empty one', async () => {
    const listPage = gotrue(25);
    const out = await resolveAuthAccounts(['missing'], listPage, { perPage: 10, maxPages: 200 });
    // pages of 10, 10, 5 — the third is short, so there is no fourth request.
    expect(listPage).toHaveBeenCalledTimes(3);
    expect(out.complete).toBe(false);
  });

  it('lets a transport failure through rather than answering a short list', async () => {
    const listPage = vi.fn(async () => { throw new Error('Failed to fetch'); });
    await expect(resolveAuthAccounts(['u1'], listPage)).rejects.toThrow('Failed to fetch');
  });

  it("defaults to a page far larger than GoTrue's own 50", async () => {
    const listPage = gotrue(0);
    await resolveAuthAccounts(['u1'], listPage);
    expect(listPage).toHaveBeenCalledWith(1, GOTRUE_PAGE_SIZE);
    expect(GOTRUE_PAGE_SIZE).toBeGreaterThan(50);
  });
});
