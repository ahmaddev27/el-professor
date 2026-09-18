import { describe, expect, it } from 'vitest';
import {
  contextRefusalKey,
  contextRefusalMessage,
  isPanelPath,
  minutesLeft,
  normalizeSupportReason,
  pathAfterContextChange,
  supportReasonProblem,
  supportSessionBar,
  SUPPORT_REASON_MAX_LENGTH,
} from './supportSession';
import { parsePlatformWhoami, type PlatformAccess } from './platformAccess';

/**
 * `PlatformRpcError` as `callPlatformRpc` throws it — rebuilt here rather than
 * imported, because importing it pulls in the Supabase client, which reads
 * `window` at module load and has no business in a test of pure rules. Its
 * shape is the contract: a message and a stable `reason`.
 */
class RpcError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/**
 * The bar, the countdown, the reason and the routing — the whole of 3.4b that
 * can be decided without a browser. The renderer only draws what these answer.
 */

const T0 = Date.parse('2026-09-18T10:00:00Z');

/** A whoami answer with a context of `seconds`, parsed the way the app parses it. */
function access(
  mode: 'view' | 'support' | null,
  seconds = 3600,
  capabilities: string[] = ['business.read', 'support.session'],
): PlatformAccess {
  return parsePlatformWhoami({
    role: 'support',
    capabilities,
    company_context: mode === null ? null : {
      company_id: 'c-b',
      company_name: 'Taxi Nord',
      mode,
      expires_at: new Date(T0 + seconds * 1000).toISOString(),
      seconds_remaining: seconds,
    },
  }, T0);
}

describe('the bar', () => {
  it('says nothing when no company is open', () => {
    expect(supportSessionBar(access(null), T0)).toEqual({ kind: 'none' });
    expect(supportSessionBar(null, T0)).toEqual({ kind: 'none' });
  });

  it('shows the company and the minutes left for a support session', () => {
    expect(supportSessionBar(access('support', 1800), T0)).toEqual({
      kind: 'support',
      companyId: 'c-b',
      companyName: 'Taxi Nord',
      minutesLeft: 30,
    });
  });

  it('offers a support session from a read context — to a role that holds one', () => {
    expect(supportSessionBar(access('view'), T0)).toEqual({
      kind: 'view',
      companyId: 'c-b',
      companyName: 'Taxi Nord',
      canStartSupport: true,
    });
    // read_only holds business.read and not support.session (20260916110000),
    // so it is offered nothing the database would refuse.
    const readOnly = supportSessionBar(access('view', 3600, ['business.read']), T0);
    expect(readOnly).toMatchObject({ kind: 'view', canStartSupport: false });
  });

  /*
    The provider's clock moves on an answer and at the context's end, so the
    bar has to judge the moment itself — and it must agree with the gate, which
    reads the same liveCompanyContext(). One minute past the hour there is no
    session, whatever the last answer said.
  */
  it('goes quiet the moment the context runs out, with no new answer', () => {
    const open = access('support', 3600);
    expect(supportSessionBar(open, T0 + 59 * 60 * 1000)).toMatchObject({ kind: 'support' });
    expect(supportSessionBar(open, T0 + 60 * 60 * 1000 + 1)).toEqual({ kind: 'none' });
  });
});

describe('the countdown', () => {
  it('rounds up, so the last half minute is still a minute', () => {
    expect(minutesLeft(60_000)).toBe(1);
    expect(minutesLeft(30_000)).toBe(1);
    expect(minutesLeft(1)).toBe(1);
    expect(minutesLeft(61_000)).toBe(2);
    expect(minutesLeft(60 * 60 * 1000)).toBe(60);
  });

  it('never goes below zero, whatever it is handed', () => {
    expect(minutesLeft(0)).toBe(0);
    expect(minutesLeft(-5_000)).toBe(0);
    expect(minutesLeft(Number.NaN)).toBe(0);
  });
});

describe('the reason a support session is opened with', () => {
  it('insists on one', () => {
    expect(supportReasonProblem('')).toBe('empty');
    expect(supportReasonProblem('   ')).toBe('empty');
    expect(supportReasonProblem('Fahrtenbuch korrigieren')).toBeNull();
  });

  // The column's own CHECK is length(reason) <= 500 and platform_context_open
  // answers `invalid` past it, so the screen says so before the round trip.
  it('keeps to the column\'s limit', () => {
    expect(supportReasonProblem('x'.repeat(SUPPORT_REASON_MAX_LENGTH))).toBeNull();
    expect(supportReasonProblem('x'.repeat(SUPPORT_REASON_MAX_LENGTH + 1))).toBe('tooLong');
  });

  it('is stored trimmed, and an empty one is no reason at all', () => {
    expect(normalizeSupportReason('  Beleg prüfen  ')).toBe('Beleg prüfen');
    expect(normalizeSupportReason('   ')).toBeNull();
    expect(normalizeSupportReason(null)).toBeNull();
    expect(normalizeSupportReason(undefined)).toBeNull();
  });
});

describe('refusals', () => {
  it('names every reason platform_context_open and _close can answer', () => {
    for (const reason of [
      'denied', 'context_open', 'reason_required', 'no_session',
      'no_context', 'account_in_company', 'not_found', 'invalid',
    ]) {
      expect(contextRefusalKey(reason), reason).not.toBeNull();
    }
  });

  it('keeps the server\'s own sentence for a code this build does not know', () => {
    const error = new RpcError('Etwas Neues ging schief.', 'invented_later');
    expect(contextRefusalMessage(error, () => 'translated')).toBe('Etwas Neues ging schief.');
  });

  it('translates a code it knows, rather than showing German to an English reader', () => {
    const error = new RpcError('Es ist bereits ein Zugriff offen.', 'context_open');
    expect(contextRefusalMessage(error, key => `t:${key}`)).toBe('t:support.error.contextOpen');
  });

  it('shows a transport failure\'s own message', () => {
    expect(contextRefusalMessage(new Error('Failed to fetch'), () => 'x')).toBe('Failed to fetch');
  });
});

describe('where the browser goes', () => {
  it('follows a company opened from the panel into the tenant app', () => {
    expect(pathAfterContextChange(null, 'view', '/admin/companies')).toBe('/overview');
    expect(pathAfterContextChange(null, 'support', '/admin')).toBe('/overview');
  });

  it('returns to the panel when a session ends inside the company', () => {
    expect(pathAfterContextChange('support', null, '/belege')).toBe('/admin');
    expect(pathAfterContextChange('view', null, '/overview')).toBe('/admin');
  });

  // Ending a session from the panel must not take the list away from whoever
  // was reading it — they are already where /admin would send them.
  it('stays put when a session ends in the panel', () => {
    expect(pathAfterContextChange('support', null, '/admin/companies')).toBeNull();
    expect(pathAfterContextChange('view', null, '/admin')).toBeNull();
  });

  it('stays put when only the mode changes', () => {
    expect(pathAfterContextChange('view', 'support', '/belege')).toBeNull();
    expect(pathAfterContextChange('support', 'view', '/admin')).toBeNull();
  });

  it('stays put when nothing was open and nothing is', () => {
    expect(pathAfterContextChange(null, null, '/overview')).toBeNull();
  });

  // A tenant screen opened while a context already existed (a reload inside the
  // company) must not be thrown back to /overview.
  it('does not move a tab that is already inside the company', () => {
    expect(pathAfterContextChange(null, 'view', '/fahrtenbuch')).toBeNull();
  });

  it('knows the panel from the company app', () => {
    expect(isPanelPath('/admin')).toBe(true);
    expect(isPanelPath('/admin/companies')).toBe(true);
    expect(isPanelPath('/overview')).toBe(false);
    // Not a prefix match on the string: a tenant path may not start with it.
    expect(isPanelPath('/administration')).toBe(false);
  });
});
