import { describe, expect, it } from 'vitest';
import {
  NO_PLATFORM_ACCESS,
  PLATFORM_CAPABILITIES,
  parsePlatformWhoami,
  platformAccessCan,
} from './platformAccess';
import { PLATFORM_CAPABILITIES as FUNCTION_CAPABILITIES } from '../../supabase/functions/_shared/platform-access';

describe('parsePlatformWhoami', () => {
  it('reads a role and its capabilities', () => {
    expect(parsePlatformWhoami({
      role: 'billing',
      capabilities: ['billing.manage', 'codes.manage', 'companies.read'],
      company_context: null,
    })).toEqual({ role: 'billing', capabilities: ['billing.manage', 'codes.manage', 'companies.read'] });
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
    const open = parsePlatformWhoami({
      role: 'support', capabilities: [],
      company_context: {
        company_id: 'c1', company_name: 'Test A', mode: 'support',
        expires_at: '2026-09-17T12:00:00Z', seconds_remaining: 3599,
      },
    });
    expect(open.companyContext).toEqual({
      companyId: 'c1', companyName: 'Test A', mode: 'support',
      expiresAt: '2026-09-17T12:00:00Z', secondsRemaining: 3599,
    });

    // No company, and a mode this build does not know: both read as no context,
    // so the screens offer nothing rather than something the database refuses.
    for (const bad of [{ mode: 'support' }, { company_id: 'c1', mode: 'peek' }, null, 'open', []]) {
      expect(parsePlatformWhoami({ role: 'owner', capabilities: [], company_context: bad }).companyContext)
        .toBeNull();
    }
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
