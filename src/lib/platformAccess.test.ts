import { describe, expect, it } from 'vitest';
import {
  NO_PLATFORM_ACCESS,
  PLATFORM_CAPABILITIES,
  liveCompanyContext,
  msUntilContextEnds,
  ownCompanyDataReadable,
  parsePlatformWhoami,
  platformAccessCan,
  platformCanEnterCompany,
  platformReadsCompany,
  samePlatformAccess,
  withoutCompanyContext,
} from './platformAccess';
import { PLATFORM_CAPABILITIES as FUNCTION_CAPABILITIES } from '../../supabase/functions/_shared/platform-access';

describe('parsePlatformWhoami', () => {
  it('reads a role and its capabilities', () => {
    expect(parsePlatformWhoami({
      role: 'billing',
      capabilities: ['billing.manage', 'codes.manage', 'companies.read'],
      company_context: null,
      // `companyContext` is part of the answer since 20260917140000 (plan 3.4);
      // null here because this account has opened nothing. toEqual is exact, so
      // it has to be named — the NO_PLATFORM_ACCESS comparisons below need no
      // change, that constant carries the field already.
    })).toEqual({
      role: 'billing',
      capabilities: ['billing.manage', 'codes.manage', 'companies.read'],
      companyContext: null,
    });
  });

  it('is no access for an account without a role', () => {
    expect(parsePlatformWhoami({ role: null, capabilities: [], company_context: null }))
      .toEqual(NO_PLATFORM_ACCESS);
  });

  it('drops capabilities that arrive without a known role', () => {
    expect(parsePlatformWhoami({ role: 'superuser', capabilities: ['staff.manage'] })).toEqual(NO_PLATFORM_ACCESS);
    expect(parsePlatformWhoami({ capabilities: ['staff.manage'] })).toEqual(NO_PLATFORM_ACCESS);
  });

  it('ignores capability names it does not know, and duplicates', () => {
    expect(parsePlatformWhoami({ role: 'owner', capabilities: ['codes.manage', 'everything', 42, 'codes.manage'] }).capabilities)
      .toEqual(['codes.manage']);
  });

  it('treats a malformed answer as no access', () => {
    for (const data of [null, undefined, 'owner', 1, [], { role: 'owner', capabilities: 'codes.manage' }]) {
      const access = parsePlatformWhoami(data);
      expect(access.capabilities).toEqual([]);
    }
  });

  // This expectation moved with 20260917140000 (plan 3.4), deliberately and not
  // by accident: `company_context` used to be dropped because nothing could act
  // on it, and it is now the one thing that decides whether a company may be
  // opened at all. Everything else is still dropped — `verified` below is the
  // control that proves it.
  it('reports the role, its capabilities and the open context, and nothing else', () => {
    expect(Object.keys(parsePlatformWhoami({ role: 'owner', capabilities: [], verified: true, company_context: null })))
      .toEqual(['role', 'capabilities', 'companyContext']);
  });

  it('reads an open context, and refuses one it cannot trust', () => {
    const receivedAt = Date.parse('2026-09-17T11:00:01Z');
    const open = parsePlatformWhoami({
      role: 'support', capabilities: [],
      company_context: {
        company_id: 'c1', company_name: 'Test A', mode: 'support',
        expires_at: '2026-09-17T12:00:00Z', seconds_remaining: 3599,
      },
    }, receivedAt);
    expect(open.companyContext).toEqual({
      companyId: 'c1', companyName: 'Test A', mode: 'support',
      expiresAt: '2026-09-17T12:00:00Z', secondsRemaining: 3599,
      expiresAtMs: receivedAt + 3_599_000,
    });

    // No company, and a mode this build does not know: both read as no context,
    // so the screens offer nothing rather than something the database refuses.
    for (const bad of [{ mode: 'support' }, { company_id: 'c1', mode: 'peek' }, null, 'open', []]) {
      expect(parsePlatformWhoami({ role: 'owner', capabilities: [], company_context: bad }).companyContext)
        .toBeNull();
    }
  });
});

/*
  The company gate. Every screen a platform account reaches inside a company is
  behind these, so each case below is a way that account would otherwise see a
  company's figures as zero: the database answers it with no rows, not an error.
*/
describe('the company gate', () => {
  const T0 = Date.parse('2026-09-17T10:00:00Z');
  const HOUR = 60 * 60 * 1000;

  /** A support account's answer at T0, with a context on `companyId` open for `seconds`. */
  const withContext = (companyId: string, seconds: number, capabilities = ['business.read']) =>
    parsePlatformWhoami({
      role: 'support',
      capabilities,
      company_context: {
        company_id: companyId, company_name: 'Test', mode: 'view',
        expires_at: new Date(T0 + seconds * 1000).toISOString(), seconds_remaining: seconds,
      },
    }, T0);

  describe('platformCanEnterCompany', () => {
    it('refuses with no context open', () => {
      const access = parsePlatformWhoami({ role: 'owner', capabilities: ['business.read'], company_context: null }, T0);
      expect(platformCanEnterCompany(access, 'c1', T0)).toBe(false);
    });

    it('refuses a company other than the one the context is on', () => {
      expect(platformCanEnterCompany(withContext('c1', 3600), 'c2', T0)).toBe(false);
    });

    it('opens the company the context is on, while it lasts', () => {
      const access = withContext('c1', 3600);
      expect(platformCanEnterCompany(access, 'c1', T0)).toBe(true);
      expect(platformCanEnterCompany(access, 'c1', T0 + HOUR - 1)).toBe(true);
    });

    it('refuses once the context has run out, with no new answer in between', () => {
      // The review's case: opened at 10:00 for an hour. At 11:00 and at 11:01
      // the only answer the browser holds still says "open", and the gate must
      // not believe it.
      const access = withContext('c1', 3600);
      expect(platformCanEnterCompany(access, 'c1', T0 + HOUR)).toBe(false);
      expect(platformCanEnterCompany(access, 'c1', T0 + HOUR + 60_000)).toBe(false);
    });

    it('refuses without business.read, context or not', () => {
      expect(platformCanEnterCompany(withContext('c1', 3600, []), 'c1', T0)).toBe(false);
    });

    it('refuses a context it cannot time', () => {
      // No seconds_remaining and no parseable expires_at: acting on it would
      // mean keeping a company open with no idea when the database closes it.
      const access = parsePlatformWhoami({
        role: 'owner', capabilities: ['business.read'],
        company_context: { company_id: 'c1', mode: 'view', expires_at: 'soon' },
      }, T0);
      expect(access.companyContext?.expiresAtMs).toBeNull();
      expect(platformCanEnterCompany(access, 'c1', T0)).toBe(false);
    });
  });

  describe('the clock the gate counts by', () => {
    it("is the database's remainder, not the browser's reading of expires_at", () => {
      // A laptop an hour fast reads expires_at as already past. The remainder
      // was computed on the database's clock, so the company stays open for the
      // ten minutes the database will actually serve it.
      const access = parsePlatformWhoami({
        role: 'owner', capabilities: ['business.read'],
        company_context: {
          company_id: 'c1', mode: 'view',
          expires_at: new Date(T0 - HOUR + 600_000).toISOString(), seconds_remaining: 600,
        },
      }, T0);
      expect(platformCanEnterCompany(access, 'c1', T0 + 599_000)).toBe(true);
      expect(platformCanEnterCompany(access, 'c1', T0 + 600_000)).toBe(false);
    });

    it('falls back to expires_at only when there is no remainder', () => {
      const access = parsePlatformWhoami({
        role: 'owner', capabilities: ['business.read'],
        company_context: { company_id: 'c1', mode: 'view', expires_at: new Date(T0 + 60_000).toISOString() },
      }, T0);
      expect(access.companyContext?.expiresAtMs).toBe(T0 + 60_000);
    });

    it('names the moment to ask again, and nothing once the context is over', () => {
      const access = withContext('c1', 3600);
      expect(msUntilContextEnds(access, T0)).toBe(HOUR);
      expect(msUntilContextEnds(access, T0 + HOUR - 1)).toBe(1);
      expect(msUntilContextEnds(access, T0 + HOUR)).toBeNull();
      expect(msUntilContextEnds(NO_PLATFORM_ACCESS, T0)).toBeNull();
    });

    it('reports the live context only', () => {
      const access = withContext('c1', 60);
      expect(liveCompanyContext(access, T0)?.companyId).toBe('c1');
      expect(liveCompanyContext(access, T0 + 60_000)).toBeNull();
    });
  });

  describe('platformReadsCompany', () => {
    it('is the gate for the company a screen reads, and false with none', () => {
      const access = withContext('c1', 3600);
      expect(platformReadsCompany(access, 'c1', T0)).toBe(true);
      expect(platformReadsCompany(access, 'c2', T0)).toBe(false);
      expect(platformReadsCompany(access, null, T0)).toBe(false);
      expect(platformReadsCompany(access, 'c1', T0 + HOUR)).toBe(false);
    });
  });

  describe('ownCompanyDataReadable — staff whose own company the database refuses', () => {
    it('trusts the router for a company user', () => {
      // App.tsx refuses a blocked company before any tenant screen renders.
      expect(ownCompanyDataReadable({ accountIsPlatformStaff: false, ownCompanyId: 'c1', activeCompanyId: undefined }))
        .toBe(true);
    });

    it('admits staff when get_active_company_id() names their own company', () => {
      expect(ownCompanyDataReadable({ accountIsPlatformStaff: true, ownCompanyId: 'c1', activeCompanyId: 'c1' }))
        .toBe(true);
    });

    it('refuses staff whose own company is pending, suspended or unsubscribed', () => {
      // App.tsx skips those gates for isSuperAdmin; the database does not, and
      // answers NULL. A till read from there would print 0,00 €.
      expect(ownCompanyDataReadable({ accountIsPlatformStaff: true, ownCompanyId: 'c1', activeCompanyId: null }))
        .toBe(false);
    });

    it('refuses staff until the database has answered at all', () => {
      expect(ownCompanyDataReadable({ accountIsPlatformStaff: true, ownCompanyId: 'c1', activeCompanyId: undefined }))
        .toBe(false);
      expect(ownCompanyDataReadable({ accountIsPlatformStaff: true, ownCompanyId: null, activeCompanyId: null }))
        .toBe(false);
    });
  });

  describe('asking again', () => {
    it('treats an answer that differs only in its countdown as the same answer', () => {
      // Every whoami answer carries a new seconds_remaining; replacing the
      // state on each would re-run everything keyed on it at every focus.
      const first = withContext('c1', 3600);
      const later = parsePlatformWhoami({
        role: 'support', capabilities: ['business.read'],
        company_context: {
          company_id: 'c1', company_name: 'Test', mode: 'view',
          expires_at: new Date(T0 + HOUR).toISOString(), seconds_remaining: 1800,
        },
      }, T0 + 1_800_000);
      expect(samePlatformAccess(first, later)).toBe(true);
    });

    it('sees a closed, moved or re-opened context, or a lost capability, as news', () => {
      const open = withContext('c1', 3600);
      const closed = parsePlatformWhoami({ role: 'support', capabilities: ['business.read'], company_context: null }, T0);
      expect(samePlatformAccess(open, closed)).toBe(false);
      expect(samePlatformAccess(open, withContext('c2', 3600))).toBe(false);
      expect(samePlatformAccess(open, withContext('c1', 7200))).toBe(false);
      expect(samePlatformAccess(open, withContext('c1', 3600, []))).toBe(false);
    });

    it('closes the company and keeps the role when a re-ask fails', () => {
      const open = withContext('c1', 3600);
      const after = withoutCompanyContext(open);
      expect(after.companyContext).toBeNull();
      expect(after.role).toBe('support');
      expect(platformAccessCan(after, 'business.read')).toBe(true);
      // Nothing open: the same object, so no state change and no re-render.
      expect(withoutCompanyContext(NO_PLATFORM_ACCESS)).toBe(NO_PLATFORM_ACCESS);
    });
  });
});

describe('platformAccessCan', () => {
  it('answers from the capabilities of a role', () => {
    const access = parsePlatformWhoami({ role: 'support', capabilities: ['business.read', 'company_users.manage'] });
    expect(platformAccessCan(access, 'company_users.manage')).toBe(true);
    expect(platformAccessCan(access, 'companies.lifecycle')).toBe(false);
  });

  it('is false with no access at all', () => {
    expect(platformAccessCan(null, 'companies.read')).toBe(false);
    expect(platformAccessCan(NO_PLATFORM_ACCESS, 'companies.read')).toBe(false);
  });
});

describe('capability names', () => {
  it('match the list the edge functions use', () => {
    expect([...PLATFORM_CAPABILITIES]).toEqual([...FUNCTION_CAPABILITIES]);
  });
});
