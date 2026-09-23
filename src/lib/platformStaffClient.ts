/**
 * The platform team, read and changed (plan 3.5 / 3.12).
 *
 * Reading is `platform_staff_list`, the audited read model of migration
 * 20260920140000: one POST per page, one `platform_read.staff_list` row in the
 * audit log per call, `staff.manage` required. See `platformStaffRoster.ts`.
 *
 * Writes are the three RPCs, each one transaction that checks `staff.manage`,
 * applies the rule and writes its own audit row: `platform_staff_add`,
 * `platform_staff_disable`, `platform_staff_enable`. They go through
 * `callPlatformRpc`, which throws the German sentence the function wrote,
 * carrying its reason.
 *
 * **All four roles may be granted since migration 20260923110000** (owner's
 * decision, 23.09.2026). `platform_staff_add` refused every role but `owner`
 * with reason `role_requires_3_3` until then; the technical reasons had already
 * gone — 3.3 moved the tenant policies onto capabilities, and 20260920100000
 * stopped a read-only support session writing company files — and what remained
 * was the decision itself, because enabling the other roles decides which
 * accounts read every customer's data.
 *
 * The role is passed on every call rather than assumed: the RPC's own default
 * is `owner`, and defaulting silently in two places is how a picker ends up
 * granting something nobody chose.
 *
 * An invitation is the `platform-staff` edge function, which creates the
 * account, writes a company-less `pending_invite` profile, adds the staff row
 * through `platform_staff_add` with the caller's own token, and only then mails
 * a one-time code. A failed step deletes the account it just created, so a
 * retry is not blocked by "address already registered".
 */
import { supabase } from './supabase';
import { callPlatformRpc, type PlatformRpcResult } from './platformRpc';
import type { PlatformRole } from './platformAccess';
import {
  DIRECTORY_PAGE_SIZE,
  directoryOffset,
  parsePlatformReadPage,
  parseStaffRow,
  type PlatformReadResult,
  type PlatformStaffRow,
  type StaffSort,
} from './platformReadModels';
import { collectStaffRoster, type StaffRosterResult } from './platformStaffRoster';

/** Active members first, then by address: the order the page shows. */
const ROSTER_SORT: StaffSort = 'status_asc';

/** One page of the team. Throws on a transport error; a refusal is a value. */
export async function fetchStaffPage(pageIndex: number): Promise<PlatformReadResult<PlatformStaffRow>> {
  const { data, error } = await supabase.rpc('platform_staff_list', {
    p_status: null,
    p_sort: ROSTER_SORT,
    p_limit: DIRECTORY_PAGE_SIZE,
    p_offset: directoryOffset(pageIndex),
  });
  if (error) throw new Error(error.message);
  return parsePlatformReadPage(data, parseStaffRow);
}

/** Today's team, every page of it. */
export function loadStaffRoster(): Promise<StaffRosterResult> {
  return collectStaffRoster(fetchStaffPage);
}

/** An existing account joins the team. It must have no company of its own. */
export function addStaffMember(
  userId: string,
  role: PlatformRole,
  note: string | null,
): Promise<PlatformRpcResult> {
  return callPlatformRpc('platform_staff_add', {
    p_user_id: userId.trim(),
    p_role: role,
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
export function inviteStaffMember(
  email: string,
  fullName: string,
  role: PlatformRole,
  note: string | null,
): Promise<Record<string, unknown>> {
  return callPlatformStaffFunction('/invite', {
    email: email.trim(),
    full_name: fullName.trim(),
    role,
    note: note?.trim() ? note.trim() : null,
  });
}

/** A fresh code for a member who has not activated yet. */
export function resendStaffInvite(userId: string): Promise<Record<string, unknown>> {
  return callPlatformStaffFunction('/resend-invite', { user_id: userId });
}
