import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_INTENT_MAX_AGE_MS,
  GOOGLE_INTENT_STORAGE_KEY,
  consumeGoogleSignInIntent,
  googleOAuthCredentials,
  markGoogleSignInIntent,
  parseGoogleSignInIntent,
  readGoogleSignInIntent,
  startGoogleSignIn,
  type GoogleOAuthCredentials,
} from './googleSignIn';

const NOW = 1_800_000_000_000;

/** A sessionStorage that lives in a Map, and can be made to throw. */
function fakeStorage(options: { throws?: boolean } = {}) {
  const items = new Map<string, string>();
  const guard = () => {
    if (options.throws) throw new Error('storage is blocked');
  };
  return {
    items,
    getItem: vi.fn((key: string) => { guard(); return items.get(key) ?? null; }),
    setItem: vi.fn((key: string, value: string) => { guard(); items.set(key, value); }),
    removeItem: vi.fn((key: string) => { guard(); items.delete(key); }),
  };
}

let storage = fakeStorage();

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('sessionStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseGoogleSignInIntent', () => {
  const marker = (body: unknown) => JSON.stringify(body);

  it('reads a marker this browser wrote', () => {
    const raw = marker({ from: 'signup', startedAt: NOW - 1000, selection: { plan: 'premium', carLimit: 7, billingCycle: 'yearly' } });
    expect(parseGoogleSignInIntent(raw, NOW)).toEqual({
      from: 'signup',
      startedAt: NOW - 1000,
      selection: { plan: 'premium', carLimit: 7, billingCycle: 'yearly' },
    });
  });

  it.each([
    ['nothing stored', null],
    ['text that is not JSON', '{oops'],
    ['an array', '[]'],
    ['an origin nobody offers', marker({ from: 'facebook', startedAt: NOW })],
    ['no timestamp', marker({ from: 'login' })],
  ])('refuses %s', (_label, raw) => {
    expect(parseGoogleSignInIntent(raw, NOW)).toBeNull();
  });

  it('refuses a marker older than ten minutes', () => {
    const raw = marker({ from: 'login', startedAt: NOW - GOOGLE_INTENT_MAX_AGE_MS - 1 });
    expect(parseGoogleSignInIntent(raw, NOW)).toBeNull();
    expect(parseGoogleSignInIntent(marker({ from: 'login', startedAt: NOW - GOOGLE_INTENT_MAX_AGE_MS }), NOW)).not.toBeNull();
  });

  it('refuses a marker from the future, which is a clock change and not a sign-in', () => {
    expect(parseGoogleSignInIntent(marker({ from: 'login', startedAt: NOW + 5_000 }), NOW)).toBeNull();
  });

  it.each([
    ['a tier that does not exist', { plan: 'enterprise', carLimit: 3, billingCycle: 'monthly' }],
    ['no vehicles', { plan: 'basic', carLimit: 0, billingCycle: 'monthly' }],
    ['a cycle nobody bills', { plan: 'basic', carLimit: 3, billingCycle: 'weekly' }],
    ['a selection that is not an object', 'premium'],
  ])('keeps the intent but drops %s', (_label, selection) => {
    const intent = parseGoogleSignInIntent(marker({ from: 'signup', startedAt: NOW, selection }), NOW);
    expect(intent).toEqual({ from: 'signup', startedAt: NOW, selection: null });
  });
});

describe('the marker in storage', () => {
  it('is written, read without being consumed, and then consumed once', () => {
    markGoogleSignInIntent('invite', null, NOW);
    expect(storage.items.get(GOOGLE_INTENT_STORAGE_KEY)).toContain('"from":"invite"');

    expect(readGoogleSignInIntent(NOW)?.from).toBe('invite');
    expect(readGoogleSignInIntent(NOW)?.from).toBe('invite');

    expect(consumeGoogleSignInIntent(NOW)?.from).toBe('invite');
    expect(consumeGoogleSignInIntent(NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('clears a marker that has expired rather than leaving it to be read again', () => {
    markGoogleSignInIntent('login', null, NOW);
    expect(readGoogleSignInIntent(NOW + GOOGLE_INTENT_MAX_AGE_MS + 1)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('survives a store that throws: a blocked one means no marker, not a broken screen', () => {
    vi.stubGlobal('sessionStorage', fakeStorage({ throws: true }));
    expect(() => markGoogleSignInIntent('login', null, NOW)).not.toThrow();
    expect(readGoogleSignInIntent(NOW)).toBeNull();
    expect(consumeGoogleSignInIntent(NOW)).toBeNull();
  });

  it('survives a browser without sessionStorage at all', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => markGoogleSignInIntent('signup', null, NOW)).not.toThrow();
    expect(readGoogleSignInIntent(NOW)).toBeNull();
  });
});

describe('googleOAuthCredentials', () => {
  it('asks Google which account, and asks for nothing else', () => {
    const credentials = googleOAuthCredentials('https://app.example.eu/auth/callback');
    expect(credentials).toEqual({
      provider: 'google',
      options: {
        redirectTo: 'https://app.example.eu/auth/callback',
        queryParams: { prompt: 'select_account' },
      },
    });
    // access_type=offline would ask Google for a refresh token. We call no
    // Google API, so it would be a secret kept for nothing.
    expect(Object.keys(credentials.options.queryParams)).toEqual(['prompt']);
  });
});

describe('startGoogleSignIn', () => {
  const clientThat = (error: unknown) => {
    const calls: GoogleOAuthCredentials[] = [];
    return {
      calls,
      client: {
        auth: {
          signInWithOAuth: vi.fn(async (credentials: GoogleOAuthCredentials) => {
            calls.push(credentials);
            return { error };
          }),
        },
      },
    };
  };

  it('marks the intent and sends the browser to Google', async () => {
    const { client, calls } = clientThat(null);
    const result = await startGoogleSignIn('signup', {
      client,
      appOrigin: 'https://app.example.eu/',
      selection: { plan: 'advanced', carLimit: 5, billingCycle: 'monthly' },
      now: NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(calls[0].options.redirectTo).toBe('https://app.example.eu/auth/callback');
    expect(calls[0].options.queryParams).toEqual({ prompt: 'select_account' });
    expect(readGoogleSignInIntent(NOW)).toEqual({
      from: 'signup',
      startedAt: NOW,
      selection: { plan: 'advanced', carLimit: 5, billingCycle: 'monthly' },
    });
  });

  it('takes the marker back when the redirect never happened', async () => {
    const { client } = clientThat({ message: 'provider is not enabled' });
    const result = await startGoogleSignIn('login', { client, appOrigin: 'https://app.example.eu', now: NOW });

    expect(result).toEqual({ ok: false, message: 'auth.google.error.startFailed' });
    expect(readGoogleSignInIntent(NOW)).toBeNull();
  });

  it('reports a client that throws as the same failure', async () => {
    const client = { auth: { signInWithOAuth: vi.fn(async () => { throw new Error('offline'); }) } };
    const result = await startGoogleSignIn('login', { client, appOrigin: 'https://app.example.eu', now: NOW });

    expect(result).toEqual({ ok: false, message: 'auth.google.error.startFailed' });
    expect(readGoogleSignInIntent(NOW)).toBeNull();
  });
});
