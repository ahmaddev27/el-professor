import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discardOauthAccount,
  nextAfterReconcile,
  reconcileOauthAccount,
  registerFailure,
  registerOauthCompany,
  type ReconcileResult,
} from './oauthAccountClient';

const API = 'https://api.example.test';
const TOKEN = 'the-session-access-token';

type RecordedCall = { url: string; init: RequestInit };

function serverAnswers(status: number, body: unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }));
  return calls;
}

const sentBody = (call: RecordedCall) => JSON.parse(String(call.init.body));
const sentHeaders = (call: RecordedCall) => call.init.headers as Record<string, string>;

const REGISTER_INPUT = {
  fullName: 'Max Mustermann',
  companyName: 'Muster GmbH',
  plan: 'advanced' as const,
  billingCycle: 'yearly' as const,
  carLimit: 5,
  referralCode: 'PARTNER2024',
  discountCode: 'WELCOME10',
};

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', `${API}/`);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the request', () => {
  it('names the action, carries the session and never names a user', async () => {
    const calls = serverAnswers(200, { ok: true, action: 'none', reason: 'nothing_pending' });
    await reconcileOauthAccount(TOKEN);

    expect(calls[0].url).toBe(`${API}/functions/v1/oauth-account`);
    expect(sentHeaders(calls[0]).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sentHeaders(calls[0]).apikey).toBe('anon-key');
    expect(sentBody(calls[0])).toEqual({ action: 'reconcile' });
  });

  it('sends the registration in the function s own snake_case', async () => {
    const calls = serverAnswers(200, { ok: true, company: { id: 'c-1' }, discount: null });
    await registerOauthCompany(REGISTER_INPUT, TOKEN);

    expect(sentBody(calls[0])).toEqual({
      action: 'register',
      full_name: 'Max Mustermann',
      company_name: 'Muster GmbH',
      plan: 'advanced',
      billing_cycle: 'yearly',
      subscription_car_limit: 5,
      referral_code: 'PARTNER2024',
      discount_code: 'WELCOME10',
    });
  });
});

describe('reconcileOauthAccount', () => {
  it.each([
    ['pending_signup_cancelled', { ok: true, action: 'pending_signup_cancelled' }],
    ['invite_accepted', { ok: true, action: 'invite_accepted' }],
  ])('reads %s', async (action, body) => {
    serverAnswers(200, body);
    await expect(reconcileOauthAccount(TOKEN)).resolves.toEqual({ ok: true, action });
  });

  it('reads a reason for doing nothing', async () => {
    serverAnswers(200, { ok: true, action: 'none', reason: 'platform_staff' });
    await expect(reconcileOauthAccount(TOKEN)).resolves.toEqual({ ok: true, action: 'none', reason: 'platform_staff' });
  });

  it('reads a reason outside the list as the harmless one', async () => {
    serverAnswers(200, { ok: true, action: 'none', reason: 'something_new' });
    await expect(reconcileOauthAccount(TOKEN)).resolves.toEqual({ ok: true, action: 'none', reason: 'nothing_pending' });
  });

  it.each([
    ['a session the function refused', 401, { ok: false, reason: 'unauthorized' }, 'unauthorized'],
    ['an internal failure', 500, { ok: false, reason: 'internal' }, 'internal'],
    ['a body from nothing we wrote', 502, '<html>bad gateway</html>', 'network'],
  ])('reports %s', async (_label, status, body, reason) => {
    serverAnswers(status, body);
    await expect(reconcileOauthAccount(TOKEN)).resolves.toEqual({ ok: false, reason });
  });

  it('reports a request that never arrived as network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(reconcileOauthAccount(TOKEN)).resolves.toEqual({ ok: false, reason: 'network' });
  });
});

describe('nextAfterReconcile', () => {
  const routing = (result: ReconcileResult) => nextAfterReconcile(result);

  it('sends a cancelled signup to the registration screen, with a fresh profile', () => {
    expect(routing({ ok: true, action: 'pending_signup_cancelled' })).toEqual({
      route: 'complete_registration', reloadProfile: true, message: null,
    });
  });

  it('lets an accepted invitation into the app, with a fresh profile', () => {
    expect(routing({ ok: true, action: 'invite_accepted' })).toEqual({
      route: 'app', reloadProfile: true, message: null,
    });
  });

  it('ends the session of a platform account and says why', () => {
    expect(routing({ ok: true, action: 'none', reason: 'platform_staff' })).toEqual({
      route: 'sign_out', reloadProfile: false, message: 'auth.google.error.platformStaff',
    });
  });

  it.each([
    ['account_blocked', 'auth.google.error.accountBlocked'],
    ['account_not_found', 'auth.google.error.generic'],
  ] as const)('ends the session for %s', (reason, message) => {
    expect(routing({ ok: true, action: 'none', reason })).toEqual({ route: 'sign_out', reloadProfile: false, message });
  });

  it.each([
    'pending_signup_kept',
    'nothing_pending',
    'not_google_account',
  ] as const)('lets %s through to the gates that already know it', reason => {
    expect(routing({ ok: true, action: 'none', reason })).toEqual({ route: 'app', reloadProfile: false, message: null });
  });

  it.each(['network', 'internal'] as const)('keeps a valid session when reconcile could not answer (%s)', reason => {
    // Nothing was changed, the sign-in stands, and the next one tries again.
    expect(routing({ ok: false, reason })).toEqual({ route: 'app', reloadProfile: false, message: null });
  });

  it('ends the session when the function refused the token', () => {
    expect(routing({ ok: false, reason: 'unauthorized' })).toEqual({
      route: 'sign_out', reloadProfile: false, message: 'auth.google.error.generic',
    });
  });
});

describe('registerOauthCompany', () => {
  it('reads the company and the discount it applied', async () => {
    serverAnswers(200, {
      ok: true,
      company: { id: 'c-1', name: 'Muster GmbH', slug: 'muster-gmbh', trial_end: '2026-10-01', approval_status: 'pending' },
      discount: { success: true, reason_code: null, original_price: 60, discount_amount: 6, final_price: 54 },
    });

    await expect(registerOauthCompany(REGISTER_INPUT, TOKEN)).resolves.toEqual({
      ok: true,
      company: { id: 'c-1', name: 'Muster GmbH', slug: 'muster-gmbh', trial_end: '2026-10-01', approval_status: 'pending' },
      discount: { success: true, reason_code: null, original_price: 60, discount_amount: 6, final_price: 54 },
    });
  });

  it('reads a code that did not apply without failing the registration', async () => {
    serverAnswers(200, { ok: true, company: { id: 'c-1' }, discount: { success: false, reason_code: 'EXPIRED' } });
    const result = await registerOauthCompany(REGISTER_INPUT, TOKEN);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.discount).toEqual({ success: false, reason_code: 'EXPIRED', original_price: null, discount_amount: null, final_price: null });
  });

  it.each([
    [409, 'company_exists'],
    [403, 'platform_staff'],
    [400, 'referral_invalid'],
  ] as const)('reads the refusal %s as %s', async (status, reason) => {
    serverAnswers(status, { ok: false, reason });
    await expect(registerOauthCompany(REGISTER_INPUT, TOKEN)).resolves.toEqual({ ok: false, reason });
  });

  it('reads a refusal outside the list as internal', async () => {
    serverAnswers(400, { ok: false, reason: 'something_new' });
    await expect(registerOauthCompany(REGISTER_INPUT, TOKEN)).resolves.toEqual({ ok: false, reason: 'internal' });
  });
});

describe('registerFailure', () => {
  it('puts a bad referral code under its own field', () => {
    expect(registerFailure('referral_invalid')).toEqual({
      field: 'referral', message: 'signup.error.referralInvalid', fatal: false,
    });
  });

  it.each([
    ['platform_staff', 'auth.google.error.platformStaff'],
    ['account_blocked', 'auth.google.error.accountBlocked'],
    ['account_not_found', 'gsignup.error.sessionGone'],
    ['unauthorized', 'gsignup.error.sessionGone'],
  ] as const)('treats %s as a session that cannot register anything', (reason, message) => {
    expect(registerFailure(reason)).toEqual({ field: 'form', message, fatal: true });
  });

  it.each([
    ['company_exists', 'gsignup.error.companyExists'],
    ['no_pending_signup', 'gsignup.error.noPendingSignup'],
    ['email_not_confirmed', 'gsignup.error.emailNotConfirmed'],
    ['not_google_account', 'gsignup.error.notGoogle'],
    ['invalid_request', 'gsignup.error.invalid'],
    ['network', 'otp.error.network'],
    ['internal', 'gsignup.error.failed'],
  ] as const)('shows %s above the form and keeps the session', (reason, message) => {
    expect(registerFailure(reason)).toEqual({ field: 'form', message, fatal: false });
  });
});

describe('discardOauthAccount', () => {
  it('reads a deleted account', async () => {
    serverAnswers(200, { ok: true, discarded: true });
    await expect(discardOauthAccount(TOKEN)).resolves.toEqual({ ok: true });
  });

  it('reads an account the database would not delete', async () => {
    serverAnswers(409, { ok: false, reason: 'not_discardable' });
    await expect(discardOauthAccount(TOKEN)).resolves.toEqual({ ok: false, reason: 'not_discardable' });
  });

  it('reads a refused session as unauthorized', async () => {
    serverAnswers(401, { ok: false, reason: 'unauthorized' });
    await expect(discardOauthAccount(TOKEN)).resolves.toEqual({ ok: false, reason: 'unauthorized' });
  });
});
