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
      .toEqual({ google: true });
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
});

describe('fetchAuthProviderSettings', () => {
  it('asks GoTrue with the publishable key and no session', async () => {
    const calls = serverAnswers(200, { external: { google: true } });
    await expect(fetchAuthProviderSettings()).resolves.toEqual({ google: true });

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

    expect([first, second, third]).toEqual([{ google: true }, { google: true }, { google: true }]);
    expect(calls).toHaveLength(1);
  });
});
