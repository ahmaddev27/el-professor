/**
 * A support session around one write the platform panel makes to a company's
 * accounts (plan 3.13a).
 *
 * Since 20260921110000 and the matching change to `manage-users`, a platform
 * account acts on a company's accounts only inside an open **support** session
 * on that company. Two panel flows create an account for a company from the
 * company list, with no session open: the first administrator at the end of the
 * company wizard, and "Benutzer hinzufügen" on a company's page. Each now opens
 * an audited support session itself, around that one call, and closes it again.
 *
 * This module is the decision, kept pure so vitest pins it without a renderer,
 * as 3.4b kept `supportSession.ts`:
 *
 *   no context open                          open a support session, act, close it
 *   a support session on this company        act inside it, leave it open
 *   a view context on this company           refuse: end it first
 *   any context on another company           refuse: end it first
 *
 * An operator's own session is never closed behind their back: only a session
 * this flow opened is closed, in `finally`, whether the write succeeded or not.
 * What is open is asked of the database (`platform_whoami()`), not taken from
 * the provider's last answer, which can be a minute old.
 */
import { liveCompanyContext, type PlatformAccess } from './platformAccess';

/**
 * The reasons these flows record for the support session they open.
 *
 * **Not translated, on purpose.** A reason is audit data, not a label: it is
 * stored in `platform_company_contexts.reason` and copied into every audit row
 * the session writes, and the log is read in German. It must also pass
 * `platform_context_open`'s own rule — non-empty after trimming, at most 500
 * characters (`supportReasonProblem()` in `supportSession.ts`, pinned by the
 * test beside this file).
 */
export const COMPANY_WRITE_SESSION_REASONS = {
  firstAdmin: 'Erster Administrator nach Anlage der Firma',
  addUser: 'Benutzer anlegen aus der Firmenliste',
} as const;

export type CompanyWriteSessionPurpose = keyof typeof COMPANY_WRITE_SESSION_REASONS;

/** Why the flow will not run: another context is open, and it is the operator's. */
export type CompanyWriteSessionRefusal = 'view_open' | 'other_company_open';

export type CompanyWriteSessionPlan =
  | { kind: 'reuse' }
  | { kind: 'open_then_close' }
  | { kind: 'refuse'; refusal: CompanyWriteSessionRefusal };

/**
 * What to do for a write to `companyId`, given the account's platform access as
 * the database reports it and the moment it is judged at. A context that has run
 * out by `now` counts as none, the same rule the company gate applies.
 */
export function planCompanyWriteSession(
  access: PlatformAccess | null | undefined,
  companyId: string,
  now: number,
): CompanyWriteSessionPlan {
  const context = liveCompanyContext(access, now);
  if (context === null) return { kind: 'open_then_close' };
  if (context.companyId.toLowerCase() !== companyId.toLowerCase()) {
    return { kind: 'refuse', refusal: 'other_company_open' };
  }
  return context.mode === 'support'
    ? { kind: 'reuse' }
    : { kind: 'refuse', refusal: 'view_open' };
}

export interface CompanyWriteSessionDeps {
  /** `platform_whoami()`, asked now. Throws when the question itself failed. */
  currentAccess: () => Promise<PlatformAccess>;
  /** Opens a support session on the company with this reason; throws the database's refusal. */
  open: (companyId: string, reason: string) => Promise<void>;
  /** Closes the session this flow opened, so the provider's view follows. */
  close: () => Promise<void>;
  now?: () => number;
}

export type CompanyWriteSessionOutcome<T> =
  | {
      ok: true;
      value: T;
      /** Whether this flow opened (and so closed) the session. */
      opened: boolean;
      /** The write happened, but the session it opened could not be closed. */
      closeFailed: boolean;
    }
  | { ok: false; refusal: CompanyWriteSessionRefusal };

/**
 * Runs `act` inside a support session on `companyId`, per the plan above.
 *
 * - A refusal is a return value and nothing is called.
 * - A failure to open (the database's `PlatformRpcError`: `denied`,
 *   `account_in_company`, …) is thrown before `act` runs.
 * - A failure of `act` is rethrown after the session this flow opened was
 *   closed; a failure of that close is then swallowed, so the write's own error
 *   is the one reported. The session ends by itself within sixty minutes.
 * - A failed close after a successful `act` is reported as `closeFailed`, so the
 *   screen can say the session is still open.
 */
export async function withCompanyWriteSession<T>(
  companyId: string,
  purpose: CompanyWriteSessionPurpose,
  deps: CompanyWriteSessionDeps,
  act: () => Promise<T>,
): Promise<CompanyWriteSessionOutcome<T>> {
  const now = deps.now ?? Date.now;
  const plan = planCompanyWriteSession(await deps.currentAccess(), companyId, now());

  if (plan.kind === 'refuse') {
    return { ok: false, refusal: plan.refusal };
  }
  if (plan.kind === 'reuse') {
    return { ok: true, value: await act(), opened: false, closeFailed: false };
  }

  await deps.open(companyId, COMPANY_WRITE_SESSION_REASONS[purpose]);

  let value: T;
  try {
    value = await act();
  } catch (error) {
    try {
      await deps.close();
    } catch {
      // The write's error is the one to report; the session times out by itself.
    }
    throw error;
  }

  try {
    await deps.close();
  } catch {
    return { ok: true, value, opened: true, closeFailed: true };
  }
  return { ok: true, value, opened: true, closeFailed: false };
}
