/**
 * The platform team, as the Team page reads it (plan 3.12).
 *
 * ## Where the roster comes from
 *
 * `platform_staff_list` (migration 20260920140000) reads
 * `app_private.platform_staff` itself, joined to each member's sign-in address.
 * Until it existed the page folded the audit log instead, which tied the roster
 * to how long the log is kept: with audit retention (open decision D4) a member
 * added long ago with no later change would have dropped off the list while
 * keeping full access. That fold is gone.
 *
 * The read model asks `staff.manage` — owners only — the same capability the
 * page needs to exist at all, so the roster is whole for exactly the role that
 * may act on it.
 *
 * ## Who granted a membership
 *
 * `created_by` is the table's own column, which `platform_staff_add` sets to the
 * caller. A row written outside any session — the first owners, backfilled by
 * migration 20260916110000, or a statement run by hand in the database — has
 * nobody to name, and the page says "not recorded" rather than guessing.
 *
 * Everything here is pure; the calls are `platformStaffClient.ts`.
 */
import type { TranslationKey } from '../i18n';
import {
  DIRECTORY_PAGE_SIZE,
  directoryHasNextPage,
  type PlatformReadResult,
  type PlatformStaffRow,
} from './platformReadModels';

export type StaffRosterResult =
  | {
      ok: true;
      members: PlatformStaffRow[];
      /**
       * False when the pages that were read do not add up to the total: the
       * table changed during the read, or it holds more rows than the offset
       * ceiling lets anyone page to. The screen then says the list may be
       * incomplete, and stops drawing conclusions from it (the last owner).
       */
      complete: boolean;
    }
  | { ok: false; reason: string };

/**
 * Reads every page of the roster. A realistic team is one page; the loop is
 * there so a larger one is never silently cut off. Every page is one audited
 * read, so this runs when the screen opens or is refreshed, never on a timer.
 *
 * A refusal ends the read and is returned as it is. A transport error is
 * thrown, for the screen to report. `fetchPage` is injected so the paging is
 * testable without a database.
 */
export async function collectStaffRoster(
  fetchPage: (pageIndex: number) => Promise<PlatformReadResult<PlatformStaffRow>>,
): Promise<StaffRosterResult> {
  const members: PlatformStaffRow[] = [];
  for (let pageIndex = 0; ; pageIndex += 1) {
    const page = await fetchPage(pageIndex);
    if (!page.ok) return { ok: false, reason: page.reason };

    members.push(...page.items);

    if (!directoryHasNextPage(pageIndex, page.total)) {
      const complete = (pageIndex + 1) * DIRECTORY_PAGE_SIZE >= page.total
        && members.length === page.total;
      return { ok: true, members, complete };
    }
    // An empty page while the total promises more: the table shrank mid-read.
    if (page.items.length === 0) return { ok: true, members, complete: false };
  }
}

const isActiveOwner = (member: PlatformStaffRow): boolean =>
  member.role === 'owner' && member.status === 'active';

/** How many members are active owners — what "the last active owner" counts. */
export function activeOwnerCount(members: readonly PlatformStaffRow[]): number {
  return members.filter(isActiveOwner).length;
}

/**
 * Whether disabling this member would be refused as `last_owner`.
 *
 * The database decides — `platform_staff_disable` checks it under an advisory
 * lock, and the table's trigger `platform_staff_keep_owner` raises underneath
 * whichever path tries — so this only keeps the screen from offering a button
 * whose one possible outcome is a refusal, and lets it say why instead.
 */
export function wouldRemoveLastOwner(members: readonly PlatformStaffRow[], userId: string): boolean {
  const member = members.find(m => m.user_id === userId);
  if (!member || !isActiveOwner(member)) return false;
  return activeOwnerCount(members) <= 1;
}

/**
 * Whether the database would re-enable this member. `platform_staff_enable`
 * refuses every role but owner (`role_requires_3_3`) until the other roles are
 * enabled by a change of their own; the screen says so instead of offering the
 * click.
 */
export function mayReEnable(member: PlatformStaffRow): boolean {
  return member.status === 'disabled' && member.role === 'owner';
}

/**
 * Whether "resend the invitation" can succeed: `otp_issue` issues an
 * `invite_activate` code only while the profile is still `pending_invite`, and
 * a disabled member has no invitation to accept.
 */
export function offersResend(member: PlatformStaffRow): boolean {
  return member.status === 'active' && member.invitation_pending;
}

export type GrantedBy =
  | { kind: 'account'; email: string }
  /** Recorded, but the account no longer exists; the id is all that is left. */
  | { kind: 'gone'; userId: string }
  /** Written outside a session: a migration, or a statement run in the database. */
  | { kind: 'unrecorded' };

/** Who added this member, as far as the table knows. */
export function grantedBy(member: PlatformStaffRow): GrantedBy {
  if (member.created_by === null) return { kind: 'unrecorded' };
  if (member.created_by_email) return { kind: 'account', email: member.created_by_email };
  return { kind: 'gone', userId: member.created_by };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a typed id can be sent at all; the database validates it again. */
export function isUserId(value: string): boolean {
  return UUID.test(value.trim());
}

/**
 * A sentence to add beside the refusal the database wrote, for the reasons a
 * person cannot act on from the message alone.
 *
 * `platform_staff_add`, `_disable` and `_enable` already answer with German
 * text, and `callPlatformRpc` throws exactly that — the screen shows it. These
 * need the reason behind the rule as well:
 *
 * - `role_requires_3_3`: every role but `owner` is refused and nothing was
 *   created. The name is historical; the other roles are simply not enabled
 *   yet, and enabling them is a decision of its own.
 * - `last_owner`: the platform would be left with nobody who can administer it.
 * - `account_in_company`: platform accounts belong to no company.
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
