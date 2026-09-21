import { describe, expect, it, vi } from 'vitest';
import { PlatformCheckError } from './platform-access.ts';
import {
  decideCreateCompany,
  MANAGE_USERS_SCOPE_MESSAGES,
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
