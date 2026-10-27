import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_PROVIDERS_OFF,
  fetchAuthProviderSettings,
  loadAuthProviderSettings,
  parseAuthProviderSettings,
  resetAuthProviderSettingsCache,
} from './authProviderSettings';

const API = 'https://api.example.test';

type RecordedCall = { url: string; init: RequestInit | undefined };

function serverAnswers(status: number, body: unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }));
  return calls;
}

beforeEach(() => {
  resetAuthProviderSettingsCache();
  vi.stubEnv('VITE_SUPABASE_URL', `${API}/`);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAuthProviderSettingsCache();
});

describe('parseAuthProviderSettings', () => {
  it('reads GoTrue s own answer', () => {
    expect(parseAuthProviderSettings({ external: { google: true, github: false }, disable_signup: false }))
      .toEqual({ google: true, passkeys: false });
  });

  it.each([
    ['google off', { external: { google: false } }],
    ['no external block', { disable_signup: true }],
    ['a string instead of a boolean', { external: { google: 'true' } }],
    ['an array', []],
    ['nothing', null],
  ])('reads %s as off', (_label, body) => {
    expect(parseAuthProviderSettings(body)).toEqual(AUTH_PROVIDERS_OFF);
  });

  it('reads passkeys from the top-level field, not from the provider block', () => {
    expect(parseAuthProviderSettings({ external: { google: false }, passkeys_enabled: true }))
      .toEqual({ google: false, passkeys: true });
  });

  it.each([
    // The two rows that are live cases, in the order they matter. Since PR #341
    // the stack pins v2.190.0, which knows the field and reports it `false`
    // while PASSKEY_SIGNIN_ENABLED is false — the state this slice ships into.
    // The absent case is an older image, and a rollback across that upgrade.
    ['the field is false, as on v2.190.0 with the switch off', { external: { google: true }, passkeys_enabled: false }],
    ['the field is absent, as before the v2.190.0 upgrade', { external: { google: true }, disable_signup: false }],
    ['the field is the string "true"', { external: { google: true }, passkeys_enabled: 'true' }],
    ['the field is 1', { external: { google: true }, passkeys_enabled: 1 }],
    ['the field is nested under external', { external: { google: true, passkeys_enabled: true } }],
  ])('reads passkeys as off when %s', (_label, body) => {
    expect(parseAuthProviderSettings(body).passkeys).toBe(false);
  });

  it('reads the two switches independently', () => {
    expect(parseAuthProviderSettings({ passkeys_enabled: true }))
      .toEqual({ google: false, passkeys: true });
    expect(parseAuthProviderSettings({ external: { google: true }, passkeys_enabled: true }))
      .toEqual({ google: true, passkeys: true });
  });
});

describe('fetchAuthProviderSettings', () => {
  it('asks GoTrue with the publishable key and no session', async () => {
    const calls = serverAnswers(200, { external: { google: true } });
    await expect(fetchAuthProviderSettings()).resolves.toEqual({ google: true, passkeys: false });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/auth/v1/settings`);
    expect((calls[0].init?.headers as Record<string, string>).apikey).toBe('anon-key');
  });

  it.each([
    ['a refusal', () => serverAnswers(403, { message: 'no' })],
    ['a body that is not JSON', () => serverAnswers(200, 'not json')],
    ['a request that never arrived', () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }))],
  ])('reads %s as off, because a button that cannot work is worse than none', async (_label, arrange) => {
    arrange();
    await expect(fetchAuthProviderSettings()).resolves.toEqual(AUTH_PROVIDERS_OFF);
  });

  it('asks nothing at all when the API is not configured', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    const calls = serverAnswers(200, { external: { google: true } });
    await expect(fetchAuthProviderSettings()).resolves.toEqual(AUTH_PROVIDERS_OFF);
    expect(calls).toHaveLength(0);
  });
});

describe('loadAuthProviderSettings', () => {
  it('asks once however many buttons ask, and shares one request', async () => {
    const calls = serverAnswers(200, { external: { google: true } });

    const [first, second] = await Promise.all([loadAuthProviderSettings(), loadAuthProviderSettings()]);
    const third = await loadAuthProviderSettings();

    const on = { google: true, passkeys: false };
    expect([first, second, third]).toEqual([on, on, on]);
    expect(calls).toHaveLength(1);
  });
});
