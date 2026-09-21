import { describe, expect, it, vi } from 'vitest';
import {
  COMPANY_WRITE_SESSION_REASONS,
  planCompanyWriteSession,
  withCompanyWriteSession,
  type CompanyWriteSessionDeps,
} from './companyWriteSession';
import { contextRefusalMessage, supportReasonProblem, SUPPORT_REASON_MAX_LENGTH } from './supportSession';
import { NO_PLATFORM_ACCESS, type PlatformAccess, type PlatformContextMode } from './platformAccess';

/*
  Plan 3.13a: the company list's two account flows open an audited support
  session around their one manage-users call. These pin the decision for every
  state an operator can be in, and what is opened, closed and left alone.
*/

const NOW = 1_800_000_000_000;
const companyA = 'c0000000-0000-4000-8000-00000000000a';
const companyB = 'c0000000-0000-4000-8000-00000000000b';

function access(context: { companyId: string; mode: PlatformContextMode; msLeft?: number } | null): PlatformAccess {
  return {
    role: 'owner',
    capabilities: ['business.read', 'support.session', 'company_users.manage'],
    companyContext: context === null ? null : {
      companyId: context.companyId,
      companyName: 'Firma',
      mode: context.mode,
      expiresAt: null,
      secondsRemaining: null,
      expiresAtMs: NOW + (context.msLeft ?? 30 * 60_000),
    },
  };
}

function deps(current: PlatformAccess, overrides: Partial<CompanyWriteSessionDeps> = {}) {
  const open = vi.fn(async (_companyId: string, _reason: string) => {});
  const close = vi.fn(async () => {});
  const value: CompanyWriteSessionDeps = {
    currentAccess: vi.fn(async () => current),
    open,
    close,
    now: () => NOW,
    ...overrides,
  };
  return { value, open: value.open as typeof open, close: value.close as typeof close };
}

describe('planCompanyWriteSession — every state an operator can be in', () => {
  it('no context open: open a support session, act, close it', () => {
    expect(planCompanyWriteSession(access(null), companyA, NOW)).toEqual({ kind: 'open_then_close' });
    expect(planCompanyWriteSession(NO_PLATFORM_ACCESS, companyA, NOW)).toEqual({ kind: 'open_then_close' });
  });

  it('a context that has already run out counts as none', () => {
    expect(planCompanyWriteSession(access({ companyId: companyA, mode: 'view', msLeft: -1 }), companyA, NOW))
      .toEqual({ kind: 'open_then_close' });
    expect(planCompanyWriteSession(access({ companyId: companyB, mode: 'support', msLeft: 0 }), companyA, NOW))
      .toEqual({ kind: 'open_then_close' });
  });

  it('a support session on this very company: reuse it', () => {
    expect(planCompanyWriteSession(access({ companyId: companyA, mode: 'support' }), companyA, NOW))
      .toEqual({ kind: 'reuse' });
  });

  it('compares the company as a uuid, whatever its case', () => {
    expect(planCompanyWriteSession(access({ companyId: companyA.toUpperCase(), mode: 'support' }), companyA, NOW))
      .toEqual({ kind: 'reuse' });
  });

  it('a view context on this company: refuse — it is the operator\'s, and a write needs support', () => {
    expect(planCompanyWriteSession(access({ companyId: companyA, mode: 'view' }), companyA, NOW))
      .toEqual({ kind: 'refuse', refusal: 'view_open' });
  });

  it('any context on another company: refuse, in either mode', () => {
    for (const mode of ['view', 'support'] as const) {
      expect(planCompanyWriteSession(access({ companyId: companyB, mode }), companyA, NOW))
        .toEqual({ kind: 'refuse', refusal: 'other_company_open' });
    }
  });
});

describe('withCompanyWriteSession', () => {
  it('opens a support session with the fixed reason, acts inside it, and closes it', async () => {
    const order: string[] = [];
    const d = deps(access(null), {
      open: vi.fn(async () => { order.push('open'); }),
      close: vi.fn(async () => { order.push('close'); }),
    });
    const outcome = await withCompanyWriteSession(companyA, 'firstAdmin', d.value, async () => {
      order.push('act');
      return 'created';
    });
    expect(outcome).toEqual({ ok: true, value: 'created', opened: true, closeFailed: false });
    expect(order).toEqual(['open', 'act', 'close']);
    expect(d.value.open).toHaveBeenCalledWith(companyA, COMPANY_WRITE_SESSION_REASONS.firstAdmin);
  });

  it('records the reason of the flow that asked', async () => {
    const d = deps(access(null));
    await withCompanyWriteSession(companyA, 'addUser', d.value, async () => 1);
    expect(d.open).toHaveBeenCalledWith(companyA, COMPANY_WRITE_SESSION_REASONS.addUser);
  });

  it('reuses the operator\'s support session and leaves it open', async () => {
    const d = deps(access({ companyId: companyA, mode: 'support' }));
    const act = vi.fn(async () => 'created');
    const outcome = await withCompanyWriteSession(companyA, 'addUser', d.value, act);
    expect(outcome).toEqual({ ok: true, value: 'created', opened: false, closeFailed: false });
    expect(act).toHaveBeenCalledTimes(1);
    expect(d.open).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
  });

  it('refuses a view context on the company without acting, opening or closing anything', async () => {
    const d = deps(access({ companyId: companyA, mode: 'view' }));
    const act = vi.fn(async () => 'created');
    await expect(withCompanyWriteSession(companyA, 'addUser', d.value, act))
      .resolves.toEqual({ ok: false, refusal: 'view_open' });
    expect(act).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
  });

  it('refuses a context on another company without touching it', async () => {
    const d = deps(access({ companyId: companyB, mode: 'support' }));
    const act = vi.fn(async () => 'created');
    await expect(withCompanyWriteSession(companyA, 'firstAdmin', d.value, act))
      .resolves.toEqual({ ok: false, refusal: 'other_company_open' });
    expect(act).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
  });

  it('decides from the answer it asks for now, not from anything older', async () => {
    const d = deps(access(null));
    await withCompanyWriteSession(companyA, 'addUser', d.value, async () => 1);
    expect(d.value.currentAccess).toHaveBeenCalledTimes(1);
  });

  it('closes the session it opened when the write fails, and reports the write\'s error', async () => {
    const d = deps(access(null));
    const boom = new Error('Diese E-Mail-Adresse ist bereits registriert.');
    await expect(withCompanyWriteSession(companyA, 'addUser', d.value, async () => { throw boom; }))
      .rejects.toBe(boom);
    expect(d.close).toHaveBeenCalledTimes(1);
  });

  it('…and still reports the write\'s error when the close fails too', async () => {
    const d = deps(access(null), { close: vi.fn(async () => { throw new Error('close failed'); }) });
    const boom = new Error('write failed');
    await expect(withCompanyWriteSession(companyA, 'addUser', d.value, async () => { throw boom; }))
      .rejects.toBe(boom);
  });

  it('says so when the write succeeded but the session it opened could not be closed', async () => {
    const d = deps(access(null), { close: vi.fn(async () => { throw new Error('close failed'); }) });
    await expect(withCompanyWriteSession(companyA, 'firstAdmin', d.value, async () => 'created'))
      .resolves.toEqual({ ok: true, value: 'created', opened: true, closeFailed: true });
  });

  it('never acts or closes when the database refuses to open the session', async () => {
    const refused = Object.assign(new Error('Dieses Konto gehört zu einem Unternehmen …'), { reason: 'account_in_company' });
    const d = deps(access(null), { open: vi.fn(async () => { throw refused; }) });
    const act = vi.fn(async () => 'created');
    await expect(withCompanyWriteSession(companyA, 'firstAdmin', d.value, act)).rejects.toBe(refused);
    expect(act).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
  });

  it('never acts when the question of what is open failed', async () => {
    const d = deps(access(null), { currentAccess: vi.fn(async () => { throw new Error('offline'); }) });
    const act = vi.fn(async () => 'created');
    await expect(withCompanyWriteSession(companyA, 'firstAdmin', d.value, act)).rejects.toThrow('offline');
    expect(act).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });
});

describe('the refusal of an open, as a sentence', () => {
  const t = (key: string) => `«${key}»`;
  it('turns platform_context_open\'s reason codes into sentences, never shows the code', () => {
    for (const reason of ['account_in_company', 'denied', 'context_open', 'no_session', 'not_found', 'reason_required', 'invalid']) {
      const message = contextRefusalMessage(Object.assign(new Error('Server-Satz'), { reason }), t);
      expect(message).toMatch(/^«support\.error\.[a-zA-Z]+»$/);
      expect(message).not.toBe(reason);
    }
  });

  it('shows the server\'s own sentence for a code this build does not know — still a sentence', () => {
    expect(contextRefusalMessage(Object.assign(new Error('Server-Satz'), { reason: 'something_new' }), t))
      .toBe('Server-Satz');
  });
});

describe('COMPANY_WRITE_SESSION_REASONS', () => {
  it('each passes platform_context_open\'s own reason rule, and is stored as written', () => {
    for (const reason of Object.values(COMPANY_WRITE_SESSION_REASONS)) {
      expect(supportReasonProblem(reason)).toBeNull();
      expect(reason).toBe(reason.trim());
      expect(reason.length).toBeLessThanOrEqual(SUPPORT_REASON_MAX_LENGTH);
    }
  });

  it('names the two flows, and says what each is for', () => {
    expect(COMPANY_WRITE_SESSION_REASONS).toEqual({
      firstAdmin: 'Erster Administrator nach Anlage der Firma',
      addUser: 'Benutzer anlegen aus der Firmenliste',
    });
  });
});
