/**
 * Opening, showing and ending a platform support session (plan 3.C, slice 3.4b).
 *
 * 20260917140000 built the database half: a platform account reaches one
 * company's operational data only while it holds a row in
 * `app_private.platform_company_contexts` — `view` for sixty minutes with no
 * reason and no writes, `support` for sixty minutes with a mandatory reason and
 * the rights of a company administrator. `get_active_company_id()` answers with
 * that company and no other, so a screen opened without a context reads nothing
 * at all.
 *
 * This module is the browser's side of that, kept pure so it can be tested
 * without a renderer:
 *
 * - `supportSessionBar()` — what the bar says, from the same answer the gate
 *   judges by, at a moment the caller supplies. A context ends by the clock,
 *   not by an event, so every function here takes `now`.
 * - `minutesLeft()` — the "noch {n} Min" figure, rounded **up**, so a session
 *   with thirty seconds left says one minute rather than none.
 * - `normalizeSupportReason()` / `supportReasonProblem()` — the reason the
 *   database requires, judged before the round trip and again after it.
 * - `contextRefusalKey()` — the refusal's stable code turned into a sentence in
 *   the reader's language. The database answers German for every caller (it has
 *   no language), which would put a German sentence in an English screen.
 *
 * The two calls that are not pure — opening and closing — live beside it in
 * `supportSessionClient.ts`, so this file pulls in no Supabase client and the
 * tests need no browser. What may be opened, by whom, on which company and for
 * how long is the database's decision anyway, re-taken on every statement.
 */
import type { TranslationKey } from '../i18n';
import {
  liveCompanyContext,
  platformAccessCan,
  type PlatformAccess,
  type PlatformContextMode,
} from './platformAccess';
import { ADMIN_BASE, TENANT_HOME } from './adminGate';

/** `app_private.platform_company_contexts.reason`'s own CHECK. */
export const SUPPORT_REASON_MAX_LENGTH = 500;

const MS_PER_MINUTE = 60_000;

// ─── The bar ─────────────────────────────────────────────────────────────────

/**
 * What the workspace bar shows. One shape per state rather than a bag of
 * nullable fields, so a screen cannot render a countdown for a read context or
 * a company name for no context at all.
 */
export type SupportSessionBar =
  | { kind: 'none' }
  | {
      kind: 'view';
      companyId: string;
      companyName: string | null;
      /** Whether this role may raise the read context to a support session. */
      canStartSupport: boolean;
    }
  | {
      kind: 'support';
      companyId: string;
      companyName: string | null;
      /** Whole minutes left, rounded up; never below one while the bar shows. */
      minutesLeft: number;
    };

/**
 * Minutes to print for a remainder in milliseconds.
 *
 * Rounded up: the session is still open with thirty seconds to go, and "noch 0
 * Min" next to a working screen reads as a bug. Never negative — a remainder
 * that has passed belongs to `kind: 'none'`, not to a bar showing minus one.
 */
export function minutesLeft(msRemaining: number): number {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 0;
  return Math.ceil(msRemaining / MS_PER_MINUTE);
}

/**
 * The bar for this answer at this moment.
 *
 * It reads the same `liveCompanyContext()` the company gate does, so the bar and
 * the screens behind it can never disagree about whether a company is open: one
 * expiry, judged once, on the browser's clock against the remainder the database
 * sent.
 */
export function supportSessionBar(
  access: PlatformAccess | null | undefined,
  now: number,
): SupportSessionBar {
  const context = liveCompanyContext(access, now);
  if (context === null || context.expiresAtMs === null) return { kind: 'none' };

  if (context.mode === 'support') {
    return {
      kind: 'support',
      companyId: context.companyId,
      companyName: context.companyName,
      minutesLeft: minutesLeft(context.expiresAtMs - now),
    };
  }

  return {
    kind: 'view',
    companyId: context.companyId,
    companyName: context.companyName,
    // Only `owner` and `support` hold support.session (20260916110000), so a
    // read_only account is offered nothing it would be refused.
    canStartSupport: platformAccessCan(access, 'support.session'),
  };
}

// ─── The reason ──────────────────────────────────────────────────────────────

/** What is wrong with a typed reason, or null when it will be accepted. */
export type SupportReasonProblem = 'empty' | 'tooLong';

export function supportReasonProblem(raw: string): SupportReasonProblem | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > SUPPORT_REASON_MAX_LENGTH) return 'tooLong';
  return null;
}

/**
 * The reason as the database will store it, or null when there is none.
 *
 * `platform_context_open` trims and rejects an empty string itself; trimming
 * here as well means a reason of spaces is refused before the round trip rather
 * than coming back as `reason_required`.
 */
export function normalizeSupportReason(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * The sentence for a refusal code.
 *
 * `platform_rpc_response` already answers a German sentence, and the screens
 * could show it — but it is German for an English reader too, because the
 * database has no language. So the stable `reason` is mapped here and the
 * server's own sentence stays the fallback for a code this build does not know.
 */
export function contextRefusalKey(reason: string): TranslationKey | null {
  switch (reason) {
    case 'denied':             return 'support.error.denied';
    case 'context_open':       return 'support.error.contextOpen';
    case 'reason_required':    return 'support.error.reasonRequired';
    case 'no_session':         return 'support.error.noSession';
    case 'no_context':         return 'support.error.noContext';
    case 'account_in_company': return 'support.error.accountInCompany';
    case 'not_found':          return 'support.error.notFound';
    case 'invalid':            return 'support.error.invalid';
    default:                   return null;
  }
}

/**
 * The message for a failed call: a translated sentence, or the server's own.
 *
 * The refusal is recognised by its `reason` rather than by `instanceof
 * PlatformRpcError`, so this file stays free of the Supabase client — the class
 * is defined next to it, and a reason is what it carries.
 */
export function contextRefusalMessage(
  error: unknown,
  t: (key: TranslationKey) => string,
): string {
  const reason = error !== null && typeof error === 'object' && 'reason' in error
    ? (error as { reason: unknown }).reason
    : null;
  if (typeof reason === 'string') {
    const key = contextRefusalKey(reason);
    if (key) return t(key);
  }
  return error instanceof Error ? error.message : t('support.error.invalid');
}

// ─── Where the browser goes ──────────────────────────────────────────────────

/**
 * Where a session change sends the browser, or null to stay put.
 *
 * Opening a company means working in it, so a click in the panel goes on to the
 * tenant app. Ending one leaves the account with no company at all, and
 * `PlatformAccountGuard` would bounce it off every tenant route anyway, so it
 * returns to the panel deliberately rather than by rejection.
 *
 * Two cases deliberately do not move, and both are about not taking a screen
 * away from someone who did not ask: a context ended from **inside** the panel
 * (the person is looking at a list, not at the company), and a change of mode,
 * which alters what may be written and not what is open.
 */
export function pathAfterContextChange(
  before: PlatformContextMode | null,
  after: PlatformContextMode | null,
  currentPath: string,
): string | null {
  const inPanel = currentPath === ADMIN_BASE || currentPath.startsWith(`${ADMIN_BASE}/`);
  if (after === null) return before !== null && !inPanel ? ADMIN_BASE : null;
  if (before === null) return inPanel ? TENANT_HOME : null;
  return null;
}
