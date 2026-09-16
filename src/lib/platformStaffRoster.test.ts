import { describe, expect, it } from 'vitest';
import {
  activeOwnerCount,
  isUserId,
  rosterFromAuditRows,
  staffRefusalHintKey,
  wouldRemoveLastOwner,
  type StaffMember,
} from './platformStaffRoster';
import type { AuditRow } from './platformAuditLog';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

let nextId = 1000;

/** One row as app_private.platform_staff_audit() writes it. */
const staffRow = (
  action: string,
  userId: string,
  after: Record<string, unknown> | null,
  occurredAt = '2026-09-16T10:00:00Z',
): AuditRow => ({
  id: nextId--,
  occurred_at: occurredAt,
  actor_user_id: OWNER_A,
  actor_email: 'owner@example.com',
  actor_role: 'owner',
  session_id: null,
  company_id: null,
  company_name: null,
  category: 'staff',
  action,
  outcome: 'ok',
  target_type: 'platform_staff',
  target_id: userId,
  before_value: null,
  after_value: after,
});

const member = (userId: string, disabledAt: string | null): StaffMember => ({
  userId, role: 'owner', disabledAt, note: null, createdAt: null, createdBy: null,
  changedAt: '2026-09-16T10:00:00Z',
});

describe('rosterFromAuditRows', () => {
  it('reads the table out of the trigger rows, newest first', () => {
    const roster = rosterFromAuditRows([
      staffRow('platform_staff.insert', OWNER_B, { user_id: OWNER_B, role: 'owner', disabled_at: null, note: 'Support-Lead', created_at: '2026-09-16T09:00:00Z', created_by: OWNER_A }),
      staffRow('platform_staff.insert', OWNER_A, { user_id: OWNER_A, role: 'owner', disabled_at: null, note: null, created_at: '2026-09-15T08:00:00Z', created_by: null }),
    ]);

    expect(roster).toHaveLength(2);
    expect(roster.map(m => m.userId).sort()).toEqual([OWNER_A, OWNER_B]);
    expect(roster.find(m => m.userId === OWNER_B)?.note).toBe('Support-Lead');
    expect(roster.find(m => m.userId === OWNER_A)?.createdAt).toBe('2026-09-15T08:00:00Z');
  });

  it('lets the newest row for a member win', () => {
    const roster = rosterFromAuditRows([
      staffRow('platform_staff.update', OWNER_B, { user_id: OWNER_B, role: 'owner', disabled_at: '2026-09-16T11:00:00Z', note: null }),
      staffRow('platform_staff.insert', OWNER_B, { user_id: OWNER_B, role: 'owner', disabled_at: null, note: null }),
    ]);

    expect(roster).toHaveLength(1);
    expect(roster[0].disabledAt).toBe('2026-09-16T11:00:00Z');
  });

  it('removes a member whose newest row is a delete', () => {
    // GoTrue deleting the account cascades into the table; the roster must not
    // keep showing a row that no longer exists.
    expect(rosterFromAuditRows([
      staffRow('platform_staff.delete', OWNER_B, null),
      staffRow('platform_staff.update', OWNER_B, { user_id: OWNER_B, role: 'owner', disabled_at: null }),
      staffRow('platform_staff.insert', OWNER_B, { user_id: OWNER_B, role: 'owner', disabled_at: null }),
    ])).toEqual([]);
  });

  it('ignores the RPC rows, which carry only what the call changed', () => {
    // platform_staff.add / .disable / .enable record the intent; the trigger
    // records the row. Folding the partial payload would invent a member.
    expect(rosterFromAuditRows([
      staffRow('platform_staff.add', OWNER_B, { role: 'owner', note: null }),
      staffRow('platform_staff.disable', OWNER_A, { role: 'owner' }),
    ])).toEqual([]);
  });

  it('skips a payload that is not a staff row rather than guessing', () => {
    expect(rosterFromAuditRows([
      staffRow('platform_staff.insert', OWNER_B, { user_id: OWNER_B, role: 'superuser' }),
      staffRow('platform_staff.insert', OWNER_A, null),
    ])).toEqual([]);
  });

  it('puts active members before disabled ones', () => {
    const roster = rosterFromAuditRows([
      staffRow('platform_staff.insert', OWNER_A, { user_id: OWNER_A, role: 'owner', disabled_at: '2026-09-16T11:00:00Z' }),
      staffRow('platform_staff.insert', OWNER_B, { user_id: OWNER_B, role: 'owner', disabled_at: null }),
    ]);
    expect(roster.map(m => m.userId)).toEqual([OWNER_B, OWNER_A]);
  });
});

describe('the last active owner', () => {
  it('counts only active owners', () => {
    expect(activeOwnerCount([member(OWNER_A, null), member(OWNER_B, '2026-09-16T11:00:00Z')])).toBe(1);
  });

  it('knows when disabling would be refused as last_owner', () => {
    const alone = [member(OWNER_A, null), member(OWNER_B, '2026-09-16T11:00:00Z')];
    expect(wouldRemoveLastOwner(alone, OWNER_A)).toBe(true);

    const two = [member(OWNER_A, null), member(OWNER_B, null)];
    expect(wouldRemoveLastOwner(two, OWNER_A)).toBe(false);
  });

  it('says no for a member who is already disabled, or unknown', () => {
    const roster = [member(OWNER_A, null), member(OWNER_B, '2026-09-16T11:00:00Z')];
    expect(wouldRemoveLastOwner(roster, OWNER_B)).toBe(false);
    expect(wouldRemoveLastOwner(roster, 'nobody')).toBe(false);
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
  it('explains the two rules a person cannot act on from the message alone', () => {
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
