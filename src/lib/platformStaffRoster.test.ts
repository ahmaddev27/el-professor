import { describe, expect, it, vi } from 'vitest';
import {
  activeOwnerCount,
  collectStaffRoster,
  grantedBy,
  isUserId,
  mayReEnable,
  offersResend,
  staffRefusalHintKey,
  wouldRemoveLastOwner,
} from './platformStaffRoster';
import {
  DIRECTORY_MAX_OFFSET,
  DIRECTORY_PAGE_SIZE,
  type PlatformReadResult,
  type PlatformStaffRow,
} from './platformReadModels';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const SUPPORT = '33333333-3333-4333-8333-333333333333';

/** One row as platform_staff_list answers it. */
const staff = (userId: string, overrides: Partial<PlatformStaffRow> = {}): PlatformStaffRow => ({
  user_id: userId,
  email: `${userId.slice(0, 4)}@example.com`,
  role: 'owner',
  status: 'active',
  disabled_at: null,
  note: null,
  created_at: '2026-09-16T10:00:00Z',
  created_by: null,
  created_by_email: null,
  invitation_pending: false,
  ...overrides,
});

const disabled = (userId: string, overrides: Partial<PlatformStaffRow> = {}): PlatformStaffRow =>
  staff(userId, { status: 'disabled', disabled_at: '2026-09-17T08:00:00Z', ...overrides });

/*
  collectStaffRoster pages platform_staff_list, and every page is one row in an
  append-only audit log, so the number of calls is an assertion here too.
*/
describe('collectStaffRoster', () => {
  /** A fake read model holding `total` members, served a page at a time. */
  const readModel = (total: number) => vi.fn(async (pageIndex: number): Promise<PlatformReadResult<PlatformStaffRow>> => {
    const offset = Math.min(pageIndex * DIRECTORY_PAGE_SIZE, DIRECTORY_MAX_OFFSET);
    const count = Math.max(0, Math.min(DIRECTORY_PAGE_SIZE, total - offset));
    return {
      ok: true,
      total,
      limit: DIRECTORY_PAGE_SIZE,
      offset,
      items: Array.from({ length: count }, (_, i) => staff(`m${String(offset + i).padStart(7, '0')}-0000-4000-8000-000000000000`)),
    };
  });

  it('reads a real team in one call, and calls it complete', async () => {
    const fetchPage = readModel(3);
    const result = await collectStaffRoster(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, complete: true });
    expect(result.ok && result.members).toHaveLength(3);
  });

  it('reads every page of a larger one, and asks for none past the last', async () => {
    const fetchPage = readModel(250);
    const result = await collectStaffRoster(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result.ok && result.members).toHaveLength(250);
    expect(result.ok && result.complete).toBe(true);
  });

  it('answers an empty team after one call', async () => {
    const fetchPage = readModel(0);
    expect(await collectStaffRoster(fetchPage)).toEqual({ ok: true, members: [], complete: true });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stops at the offset ceiling and says the list is not complete', async () => {
    const fetchPage = readModel(20_000);
    const result = await collectStaffRoster(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(DIRECTORY_MAX_OFFSET / DIRECTORY_PAGE_SIZE + 1);
    expect(result.ok && result.complete).toBe(false);
  });

  it('returns a refusal as it came, and asks nothing further', async () => {
    const fetchPage = vi.fn(async () => ({ ok: false as const, reason: 'not_authorized' }));
    expect(await collectStaffRoster(fetchPage)).toEqual({ ok: false, reason: 'not_authorized' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('lets a transport error reach the screen', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('Failed to fetch'); });
    await expect(collectStaffRoster(fetchPage)).rejects.toThrow('Failed to fetch');
  });

  it('does not call a team that shrank mid-read complete', async () => {
    const fetchPage = vi.fn(async (pageIndex: number): Promise<PlatformReadResult<PlatformStaffRow>> => ({
      ok: true, total: 250, limit: DIRECTORY_PAGE_SIZE, offset: pageIndex * DIRECTORY_PAGE_SIZE,
      items: pageIndex === 0 ? [staff(OWNER_A)] : [],
    }));
    const result = await collectStaffRoster(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, complete: false });
  });

  it('does not call a page that holds fewer rows than its total complete', async () => {
    // One page whose total says two: the table changed between the count and the page.
    const fetchPage = vi.fn(async (): Promise<PlatformReadResult<PlatformStaffRow>> => ({
      ok: true, total: 2, limit: DIRECTORY_PAGE_SIZE, offset: 0, items: [staff(OWNER_A)],
    }));
    expect(await collectStaffRoster(fetchPage)).toMatchObject({ ok: true, complete: false });
  });
});

describe('the last active owner', () => {
  it('counts only owners that are active', () => {
    expect(activeOwnerCount([staff(OWNER_A), disabled(OWNER_B), staff(SUPPORT, { role: 'support' })])).toBe(1);
  });

  it('knows when disabling would be refused as last_owner', () => {
    expect(wouldRemoveLastOwner([staff(OWNER_A), disabled(OWNER_B)], OWNER_A)).toBe(true);
    expect(wouldRemoveLastOwner([staff(OWNER_A), staff(OWNER_B)], OWNER_A)).toBe(false);
  });

  it('does not let an active support member stand in for a second owner', () => {
    expect(wouldRemoveLastOwner([staff(OWNER_A), staff(SUPPORT, { role: 'support' })], OWNER_A)).toBe(true);
  });

  it('says no for a disabled member, a non-owner, or an unknown id', () => {
    const roster = [staff(OWNER_A), disabled(OWNER_B), staff(SUPPORT, { role: 'support' })];
    expect(wouldRemoveLastOwner(roster, OWNER_B)).toBe(false);
    expect(wouldRemoveLastOwner(roster, SUPPORT)).toBe(false);
    expect(wouldRemoveLastOwner(roster, 'nobody')).toBe(false);
  });
});

describe('what the page offers each member', () => {
  it('offers re-enabling only to a disabled owner, the one role platform_staff_enable accepts', () => {
    expect(mayReEnable(disabled(OWNER_B))).toBe(true);
    expect(mayReEnable(disabled(SUPPORT, { role: 'support' }))).toBe(false);
    expect(mayReEnable(staff(OWNER_A))).toBe(false);
  });

  it('offers a new invitation only while one is open and the member is active', () => {
    expect(offersResend(staff(OWNER_A, { invitation_pending: true }))).toBe(true);
    expect(offersResend(staff(OWNER_A, { invitation_pending: false }))).toBe(false);
    expect(offersResend(disabled(OWNER_B, { invitation_pending: true }))).toBe(false);
  });
});

describe('grantedBy', () => {
  it('names the account that added the member, by address', () => {
    expect(grantedBy(staff(OWNER_B, { created_by: OWNER_A, created_by_email: 'owner@example.com' })))
      .toEqual({ kind: 'account', email: 'owner@example.com' });
  });

  it('says so when the granting account no longer exists', () => {
    expect(grantedBy(staff(OWNER_B, { created_by: OWNER_A, created_by_email: null })))
      .toEqual({ kind: 'gone', userId: OWNER_A });
  });

  it('says "not recorded" for a row written outside a session, rather than inventing a grantor', () => {
    // The backfill of 20260916110000 and anything run by hand in the database
    // write no created_by, and their audit rows carry no actor either.
    expect(grantedBy(staff(OWNER_A))).toEqual({ kind: 'unrecorded' });
  });
});

describe('isUserId', () => {
  it('accepts a uuid and refuses anything else', () => {
    expect(isUserId(OWNER_A)).toBe(true);
    expect(isUserId(`  ${OWNER_A}  `)).toBe(true);
    expect(isUserId('owner@example.com')).toBe(false);
    expect(isUserId('')).toBe(false);
  });
});

describe('staffRefusalHintKey', () => {
  it('explains the rules a person cannot act on from the message alone', () => {
    expect(staffRefusalHintKey('role_requires_3_3')).toBe('admin.team.hint.roleRequires33');
    expect(staffRefusalHintKey('last_owner')).toBe('admin.team.hint.lastOwner');
    expect(staffRefusalHintKey('account_in_company')).toBe('admin.team.hint.accountInCompany');
  });

  it('adds nothing to a refusal the server already worded fully', () => {
    for (const reason of ['denied', 'already_staff', 'not_found', 'already_disabled', 'invalid']) {
      expect(staffRefusalHintKey(reason)).toBeNull();
    }
  });
});
