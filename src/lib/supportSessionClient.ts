/**
 * The two calls that open and close a support session (plan 3.4b).
 *
 * Kept apart from `supportSession.ts` the way `platformDirectoryClient.ts` is
 * kept apart from `platformReadModels.ts`: the rules are pure and tested, the
 * round trip is here. Both go through `callPlatformRpc`, so a refusal arrives
 * as a `PlatformRpcError` carrying the database's stable reason code — which is
 * the only authority on whether a company opened.
 *
 * There is no `platform_context_current()` call anywhere in the browser on
 * purpose: that RPC is VOLATILE and writes an audit row per call, and the
 * browser asks for its context on every tab focus. `platform_whoami()` answers
 * the same `company_context` and writes nothing, which is what
 * `SuperAdminContext` polls.
 */
import { callPlatformRpc, PlatformRpcError } from './platformRpc';
import { parsePlatformCompanyContext, type PlatformCompanyContext, type PlatformContextMode } from './platformAccess';
import { normalizeSupportReason } from './supportSession';

/**
 * Opens a context on one company and answers with the row the database wrote.
 *
 * Throws `PlatformRpcError` carrying the database's own reason code when it
 * refuses — `context_open` when another company is still open, `denied` when
 * the role holds neither `business.read` nor `support.session`,
 * `account_in_company` for a staff account that still sits inside a company.
 *
 * The returned context is the answer's own `context` field, not a guess, and it
 * is what the provider installs so the caller can navigate at once.
 *
 * **An answer whose context cannot be read is a failure, not a success.** It
 * would otherwise resolve, the screen would report "now working as …" and
 * navigate into the company, and `PlatformAccountGuard` would bounce the tab
 * straight back to the panel with no message — a success message followed by a
 * silent rejection. A context may well have been opened in the database; the
 * re-ask that follows will find it, and `context_open` then says so.
 */
export async function openCompanyContext(
  companyId: string,
  mode: PlatformContextMode,
  reason?: string | null,
  receivedAt: number = Date.now(),
): Promise<PlatformCompanyContext> {
  const result = await callPlatformRpc('platform_context_open', {
    p_company_id: companyId,
    // A reason on a `view` context is refused as `invalid` by the RPC, so it is
    // never sent: the mode decides, not the form's leftovers.
    p_mode: mode,
    p_reason: mode === 'support' ? normalizeSupportReason(reason) : null,
  });
  const context = parsePlatformCompanyContext(result.context, receivedAt);
  if (context === null) {
    throw new PlatformRpcError('Die Aktion konnte nicht ausgeführt werden.', 'invalid');
  }
  return context;
}

/** Ends the caller's open context, whichever company and mode it is on. */
export async function closeCompanyContext(): Promise<void> {
  await callPlatformRpc('platform_context_close', { p_context_id: null });
}
