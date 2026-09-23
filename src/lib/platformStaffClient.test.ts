/**
 * What the Team page actually sends when a role is picked (plan 3.5 / the role
 * enable of 23.09.2026).
 *
 * The role is the whole point of this slice, and it travels through two very
 * different doors — an RPC argument for an existing account, a JSON body for an
 * invitation. Both are pinned here, because a role that silently becomes
 * `owner` on the way is the one failure nobody would see: the call succeeds,
 * the screen says so, and the account holds more than was chosen.
 *
 * `./supabase` is mocked rather than imported: it builds a real client from
 * `import.meta.env` at module load, which node has nothing to give it.
 * `callPlatformRpc` is deliberately *not* mocked — the refusal-to-exception
 * shape is part of what these calls promise their callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRpcError } from './platformRpc';
import { PLATFORM_ROLES, type PlatformRole } from './platformAccess';

const rpc = vi.fn();
const getSession = vi.fn();

vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => getSession() },
  },
}));

const {
  addStaffMember,
  disableStaffMember,
  enableStaffMember,
  fetchStaffPage,
  inviteStaffMember,
  resendStaffInvite,
} = await import('./platformStaffClient');

const API = 'https://api.example.test';
const USER = '11111111-1111-4111-8111-111111111111';

/** What supabase.rpc was called with, as { fn, args }. */
const lastRpc = () => ({ fn: rpc.mock.calls.at(-1)![0], args: rpc.mock.calls.at(-1)![1] });

type RecordedFetch = { url: string; init: RequestInit };

function serverAnswers(status: number, body: unknown): RecordedFetch[] {
  const calls: RecordedFetch[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}

beforeEach(() => {
  rpc.mockReset();
  getSession.mockReset();
  rpc.mockResolvedValue({ data: { success: true }, error: null });
  getSession.mockResolvedValue({ data: { session: { access_token: 'token-abc' } } });
  vi.stubEnv('VITE_SUPABASE_URL', API);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('addStaffMember', () => {
  it('sends the role it was given, for every one of the four', async () => {
    for (const role of PLATFORM_ROLES) {
      await addStaffMember(USER, role, null);
      expect(lastRpc()).toEqual({
        fn: 'platform_staff_add',
        args: { p_user_id: USER, p_role: role, p_note: null },
      });
    }
  });

  it('never substitutes owner for the role that was picked', async () => {
    await addStaffMember(USER, 'read_only', null);
    expect(lastRpc().args.p_role).toBe('read_only');
    expect(lastRpc().args.p_role).not.toBe('owner');
  });

  it('trims the id and the note, and sends null for a note of spaces', async () => {
    await addStaffMember(`  ${USER}  `, 'support', '  zweite Ebene  ');
    expect(lastRpc().args).toEqual({ p_user_id: USER, p_role: 'support', p_note: 'zweite Ebene' });

    await addStaffMember(USER, 'support', '   ');
    expect(lastRpc().args.p_note).toBeNull();
  });

  it('throws the German sentence the function wrote, carrying its reason', async () => {
    rpc.mockResolvedValue({
      data: { success: false, reason: 'account_in_company', error: 'Dieses Konto gehört zu einem Unternehmen.' },
      error: null,
    });
    await expect(addStaffMember(USER, 'billing', null)).rejects.toThrow('Dieses Konto gehört zu einem Unternehmen.');
    await expect(addStaffMember(USER, 'billing', null)).rejects.toMatchObject({ reason: 'account_in_company' });
  });

  it('reports a role the database refuses as invalid, not as a success', async () => {
    rpc.mockResolvedValue({ data: { success: false, reason: 'invalid', error: 'Ungültige Eingabe.' }, error: null });
    await expect(addStaffMember(USER, 'admin' as PlatformRole, null)).rejects.toBeInstanceOf(PlatformRpcError);
  });
});

describe('disableStaffMember and enableStaffMember', () => {
  it('name the account and nothing else — neither chooses a role', async () => {
    await disableStaffMember(USER);
    expect(lastRpc()).toEqual({ fn: 'platform_staff_disable', args: { p_user_id: USER } });

    await enableStaffMember(USER);
    expect(lastRpc()).toEqual({ fn: 'platform_staff_enable', args: { p_user_id: USER } });
  });

  it('surfaces the last-owner refusal with its reason, for the hint beside it', async () => {
    rpc.mockResolvedValue({
      data: { success: false, reason: 'last_owner', error: 'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert werden.' },
      error: null,
    });
    await expect(disableStaffMember(USER)).rejects.toMatchObject({ reason: 'last_owner' });
  });
});

describe('inviteStaffMember', () => {
  it('posts the picked role to the invite route with the caller’s token', async () => {
    const calls = serverAnswers(200, { success: true });
    await inviteStaffMember('  Neu@Example.test  ', '  Neue Kollegin  ', 'support', ' zweite Ebene ');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/functions/v1/platform-staff/invite`);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      email: 'Neu@Example.test',
      full_name: 'Neue Kollegin',
      role: 'support',
      note: 'zweite Ebene',
    });
  });

  it('sends each of the four roles unchanged', async () => {
    for (const role of PLATFORM_ROLES) {
      const calls = serverAnswers(200, { success: true });
      await inviteStaffMember('neu@example.test', 'Neu', role, null);
      expect(JSON.parse(String(calls[0].init.body)).role).toBe(role);
    }
  });

  it('throws the function’s own sentence when the role is refused at the door', async () => {
    serverAnswers(400, {
      error: 'Unbekannte Plattform-Rolle. Erlaubt sind: owner, support, billing, read_only.',
      reason: 'invalid_role',
    });
    await expect(inviteStaffMember('neu@example.test', 'Neu', 'admin' as PlatformRole, null))
      .rejects.toThrow('Unbekannte Plattform-Rolle');
  });

  it('refuses to report success for a 200 that does not say so', async () => {
    serverAnswers(200, { staff: { user_id: USER } });
    await expect(inviteStaffMember('neu@example.test', 'Neu', 'owner', null)).rejects.toThrow();
  });

  it('asks for no invitation without a session', async () => {
    const calls = serverAnswers(200, { success: true });
    getSession.mockResolvedValue({ data: { session: null } });
    await expect(inviteStaffMember('neu@example.test', 'Neu', 'owner', null)).rejects.toThrow('Keine aktive Sitzung.');
    expect(calls).toHaveLength(0);
  });
});

describe('resendStaffInvite', () => {
  it('names only the account — a resend never re-decides the role', async () => {
    const calls = serverAnswers(200, { success: true });
    await resendStaffInvite(USER);
    expect(calls[0].url).toBe(`${API}/functions/v1/platform-staff/resend-invite`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ user_id: USER });
  });
});

describe('fetchStaffPage', () => {
  it('reads the roster through the audited read model, active members first', async () => {
    rpc.mockResolvedValue({ data: { ok: true, total: 0, limit: 100, offset: 0, items: [] }, error: null });
    await fetchStaffPage(0);
    expect(lastRpc().fn).toBe('platform_staff_list');
    expect(lastRpc().args).toMatchObject({ p_status: null, p_sort: 'status_asc', p_offset: 0 });
  });
});
