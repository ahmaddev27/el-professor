/**
 * The platform team, reconstructed from the audit log.
 *
 * ## Why from the log
 *
 * `app_private.platform_staff` lives in a schema PostgREST does not serve, and
 * no read model lists it: `platform_companies_list` and the three directories
 * are the merged read models of plan 3.6b, and `platform_users_list`
 * deliberately **excludes** every account that has a staff row — the team is
 * not part of the company user directory. A `platform_staff_list` RPC is not
 * built yet.
 *
 * What does exist is a complete record. `app_private.platform_staff_audit()` is
 * an AFTER INSERT/UPDATE/DELETE trigger on the table that writes
 * `platform_staff.insert` / `.update` / `.delete` with `to_jsonb(NEW)` and
 * `to_jsonb(OLD)`, whichever path made the change — a migration, a platform
 * RPC, or GoTrue deleting the account. The backfill of 20260916110000 inserts
 * its rows after that trigger is created, so the first owners are in the log
 * too. Folding those rows newest-first therefore yields the table's current
 * content exactly.
 *
 * Two consequences the screen states rather than hides:
 *
 * - it needs `audit.read`, which today is the owner — the same role that holds
 *   `staff.manage`, so the page is whole for the role that may use it;
 * - the log records the staff row, never the account, so a member is identified
 *   by user id. No merged read model returns a staff account's address.
 *
 * The RPC rows (`platform_staff.add` / `.disable` / `.enable`) are ignored for
 * the roster: they carry only what the call changed, while the trigger's rows
 * carry the whole row. They are still shown as history on the Protokoll screen.
 */
import type { AuditRow } from './platformAuditLog';
import type { TranslationKey } from '../i18n';
import { PLATFORM_ROLES, type PlatformRole } from './platformAccess';

/** The three trigger actions that carry a whole `platform_staff` row. */
export const STAFF_TABLE_ACTIONS = [
  'platform_staff.insert',
  'platform_staff.update',
  'platform_staff.delete',
] as const;

/** Every action written about the staff table, for the history list. */
export const STAFF_ACTION_PREFIX = 'platform_staff.';

export interface StaffMember {
  userId: string;
  role: PlatformRole;
  /** null while active. */
  disabledAt: string | null;
  note: string | null;
  createdAt: string | null;
  createdBy: string | null;
  /** When the log last recorded a change to this row. */
  changedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRole = (value: unknown): value is PlatformRole =>
  typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);

const nullableStr = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Folds audit rows into today's team.
 *
 * `rows` arrive newest first, as `platform_audit_list` returns them, so the
 * first row seen for a user id is that row's latest state and every older one
 * is history. A `.delete` removes the member; an `.insert` or `.update` whose
 * payload is not a staff row is skipped rather than guessed at.
 *
 * Sorted for the screen: active members first, then by user id, so the order
 * does not jump around as rows are added.
 */
export function rosterFromAuditRows(rows: readonly AuditRow[]): StaffMember[] {
  const settled = new Set<string>();
  const members: StaffMember[] = [];

  for (const row of rows) {
    const userId = row.target_id;
    if (!userId || settled.has(userId)) continue;
    if (!(STAFF_TABLE_ACTIONS as readonly string[]).includes(row.action)) continue;

    // Whatever the newest row says about this user id is final, deletion
    // included — an older row cannot bring a removed member back.
    settled.add(userId);
    if (row.action === 'platform_staff.delete') continue;

    const after = row.after_value;
    if (!isRecord(after) || !isRole(after.role)) continue;

    members.push({
      userId,
      role: after.role,
      disabledAt: nullableStr(after.disabled_at),
      note: nullableStr(after.note),
      createdAt: nullableStr(after.created_at),
      createdBy: nullableStr(after.created_by),
      changedAt: row.occurred_at,
    });
  }

  return members.sort((a, b) => {
    const activeDiff = Number(a.disabledAt !== null) - Number(b.disabledAt !== null);
    return activeDiff !== 0 ? activeDiff : a.userId.localeCompare(b.userId);
  });
}

/** How many members are still active — what "the last active owner" counts. */
export function activeOwnerCount(members: readonly StaffMember[]): number {
  return members.filter(m => m.role === 'owner' && m.disabledAt === null).length;
}

/**
 * Whether disabling this member would be refused as `last_owner`.
 *
 * The database decides — `platform_staff_disable` checks it under an advisory
 * lock and the table's trigger raises underneath — so this only keeps the
 * screen from offering a button whose single outcome is a refusal.
 */
export function wouldRemoveLastOwner(members: readonly StaffMember[], userId: string): boolean {
  const member = members.find(m => m.userId === userId);
  if (!member || member.role !== 'owner' || member.disabledAt !== null) return false;
  return activeOwnerCount(members) <= 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a typed id can be sent at all; the database validates it again. */
export function isUserId(value: string): boolean {
  return UUID.test(value.trim());
}

/**
 * A sentence to add beside the refusal the database wrote, for the two reasons
 * a person cannot act on from the message alone.
 *
 * `platform_staff_add`, `_disable` and `_enable` already answer with German
 * text, and `callPlatformRpc` throws exactly that — the screen shows it. These
 * two need the reason behind the rule as well:
 *
 * - `role_requires_3_3`: every policy still built on is_user_super_admin()
 *   gives an active staff row an owner's writes, so no path may create or
 *   re-enable a row with another role before plan step 3.3 rewrites them. The
 *   role was **not** created.
 * - `last_owner`: the platform would be left with nobody who can administer it,
 *   so the database refuses before anything changes.
 *
 * Every other reason is shown as the server worded it, with nothing added.
 */
export function staffRefusalHintKey(reason: string): TranslationKey | null {
  switch (reason) {
    case 'role_requires_3_3': return 'admin.team.hint.roleRequires33';
    case 'last_owner':        return 'admin.team.hint.lastOwner';
    case 'account_in_company': return 'admin.team.hint.accountInCompany';
    default: return null;
  }
}
