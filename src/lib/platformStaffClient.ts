/**
 * The platform team, read and changed (plan 3.5 / 3.6c).
 *
 * Writes are the three merged RPCs, each one transaction that checks
 * `staff.manage`, applies the rule and writes its own audit row:
 * `platform_staff_add`, `platform_staff_disable`, `platform_staff_enable`.
 * They go through `callPlatformRpc`, which throws the German sentence the
 * function wrote, carrying its reason.
 *
 * **Only `owner` may be created or re-enabled until plan step 3.3.** Every
 * policy still built on is_user_super_admin() gives an active staff row an
 * owner's writes on the tenant tables, so a `support` or `read_only` row would
 * hold more than its name says. The database refuses the others with reason
 * `role_requires_3_3`; this module never offers another role in the first
 * place, so the two agree.
 *
 * Reading is the audit log — see `platformStaffRoster.ts` for why there is no
 * list to read instead.
 *
 * An invitation is the `platform-staff` edge function, which creates the
 * account, writes a company-less `pending_invite` profile, adds the staff row
 * through `platform_staff_add` with the caller's own token, and only then mails
 * a one-time code. A failed step deletes the account it just created, so a
 * retry is not blocked by "address already registered".
 */
import { supabase } from './supabase';
import { callPlatformRpc, type PlatformRpcResult } from './platformRpc';
import { fetchAuditPage } from './platformAuditClient';
import { AUDIT_PAGE_SIZE, appendAuditRows, type AuditCursor, type AuditRow } from './platformAuditLog';
import {
  STAFF_ACTION_PREFIX,
  rosterFromAuditRows,
  type StaffMember,
} from './platformStaffRoster';

/** The only role a staff row may carry until plan step 3.3; see the header. */
export const STAFF_ROLE_UNTIL_3_3 = 'owner';

/**
 * How far back the roster reads. Each page is one audit row per change to the
 * staff table — a handful per member — so twenty pages covers any real team
 * many times over. Beyond that the screen says the roster may be incomplete
 * rather than showing a partial one as if it were whole.
 */
const MAX_ROSTER_PAGES = 20;

export type StaffRosterResult =
  | { ok: true; members: StaffMember[]; truncated: boolean }
  | { ok: false; reason: string };

/**
 * Today's team, folded out of the log. Needs `audit.read` — the same role that
 * holds `staff.manage` today — and a refusal is returned, not thrown, so the
 * screen can name it.
 */
export async function loadStaffRoster(): Promise<StaffRosterResult> {
  let rows: AuditRow[] = [];
  let cursor: AuditCursor | null = null;

  for (let page = 0; page < MAX_ROSTER_PAGES; page += 1) {
    const result = await fetchAuditPage({
      actionPrefix: STAFF_ACTION_PREFIX,
      cursor,
      limit: AUDIT_PAGE_SIZE,
    });
    if (!result.ok) return result;

    rows = appendAuditRows(rows, result.items);
    cursor = result.nextCursor;
    if (!cursor) return { ok: true, members: rosterFromAuditRows(rows), truncated: false };
  }

  return { ok: true, members: rosterFromAuditRows(rows), truncated: true };
}

/** An existing account joins the team. It must have no company of its own. */
export function addStaffMember(userId: string, note: string | null): Promise<PlatformRpcResult> {
  return callPlatformRpc('platform_staff_add', {
    p_user_id: userId.trim(),
    p_role: STAFF_ROLE_UNTIL_3_3,
    p_note: note?.trim() ? note.trim() : null,
  });
}

export function disableStaffMember(userId: string): Promise<PlatformRpcResult> {
  return callPlatformRpc('platform_staff_disable', { p_user_id: userId });
}

export function enableStaffMember(userId: string): Promise<PlatformRpcResult> {
  return callPlatformRpc('platform_staff_enable', { p_user_id: userId });
}

// ─── Invitations ─────────────────────────────────────────────────────────────

async function callPlatformStaffFunction(segment: string, body: unknown): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Keine aktive Sitzung.');

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/platform-staff${segment}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const payload = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : {};

  if (!response.ok || payload.success !== true) {
    // The function writes its own German sentence; Kong's own 502 while the
    // container restarts carries none, so that case gets a sentence of ours.
    const message = typeof payload.error === 'string'
      ? payload.error
      : 'Die Aktion konnte nicht ausgeführt werden. Bitte versuchen Sie es erneut.';
    throw new Error(message);
  }
  return payload;
}

/** Creates the account, adds the staff row and mails the activation code. */
export function inviteStaffMember(email: string, fullName: string, note: string | null): Promise<Record<string, unknown>> {
  return callPlatformStaffFunction('/invite', {
    email: email.trim(),
    full_name: fullName.trim(),
    role: STAFF_ROLE_UNTIL_3_3,
    note: note?.trim() ? note.trim() : null,
  });
}

/** A fresh code for a member who has not activated yet. */
export function resendStaffInvite(userId: string): Promise<Record<string, unknown>> {
  return callPlatformStaffFunction('/resend-invite', { user_id: userId });
}
