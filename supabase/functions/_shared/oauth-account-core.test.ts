import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asDiscountSummary,
  asReconcileDbResult,
  asRegisterDbResult,
  describeOauthError,
  DISCOUNT_REASON_CODES,
  logOauthFailure,
  mapRegisterError,
  MAX_DISCOUNT_CODE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_REFERRAL_CODE_LENGTH,
  normalizeBillingCycle,
  normalizeCarLimit,
  normalizePlan,
  parseOauthAccountRequest,
  RECONCILE_NONE_REASONS,
  REGISTER_SQLSTATE_REASONS,
  runOauthAccountAction,
  type OauthAccountInput,
  type RpcCall,
} from './oauth-account-core.ts';

const USER = '0b5c3f0e-7a1d-4e2b-9c8f-1d2e3f4a5b6c';
const OTHER_USER = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
const INVALID = { status: 400, body: { ok: false, reason: 'invalid_request' } };

// redeem_discount_code's two kinds of answer (20260911120000), German sentence included.
const REDEEMED_DISCOUNT = {
  success: true,
  discount_code_id: OTHER_USER,
  usage_mode: 'once',
  discount_type: 'percentage',
  discount_value: 10,
  original_price: 60,
  discount_amount: 6,
  final_price: 54,
  german_message: 'Rabattcode erfolgreich eingelöst.',
};
const REFUSED_DISCOUNT = { success: false, reason_code: 'EXPIRED', german_message: 'Dieser Rabattcode ist abgelaufen.' };
const REDEEMED_SUMMARY = { success: true, reason_code: null, original_price: 60, discount_amount: 6, final_price: 54 };
const REFUSED_SUMMARY = { success: false, reason_code: 'EXPIRED', original_price: null, discount_amount: null, final_price: null };

function accepted(text: string): OauthAccountInput {
  const parsed = parseOauthAccountRequest(text);
  if (!('input' in parsed)) throw new Error(`refused: ${JSON.stringify(parsed.reply)}`);
  return parsed.input;
}

function refused(text: string) {
  const parsed = parseOauthAccountRequest(text);
  if (!('reply' in parsed)) throw new Error(`accepted: ${JSON.stringify(parsed.input)}`);
  return parsed.reply;
}

const register = (fields: Record<string, unknown>) =>
  JSON.stringify({ action: 'register', full_name: 'Anna Beispiel', company_name: 'Taxi Beispiel GmbH', ...fields });

function fakeRpc(answer: { data?: unknown; error?: unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: RpcCall = async (fn, args) => {
    calls.push({ fn, args });
    return { data: answer.data ?? null, error: answer.error ?? null };
  };
  return { rpc, calls };
}

describe('parseOauthAccountRequest', () => {
  it('accepts reconcile and discard with nothing else', () => {
    expect(accepted('{"action":"reconcile"}')).toEqual({ action: 'reconcile' });
    expect(accepted('{"action":"discard"}')).toEqual({ action: 'discard' });
  });

  it('refuses a body that is not an object with a known action', () => {
    for (const text of ['', 'not json', 'null', '[]', '"reconcile"', '{}', '{"action":1}', '{"action":"Reconcile"}', '{"action":"delete"}']) {
      expect(refused(text)).toEqual(INVALID);
    }
  });

  it('never takes a user id from the body', () => {
    expect(accepted(JSON.stringify({ action: 'discard', user_id: OTHER_USER, p_user_id: OTHER_USER }))).toEqual({ action: 'discard' });
    expect(accepted(register({ user_id: OTHER_USER }))).not.toHaveProperty('user_id');
  });

  describe('register', () => {
    it('trims both names and fills in the defaults company-signup uses', () => {
      expect(accepted(register({ full_name: '  Anna Beispiel ', company_name: '\tTaxi Beispiel GmbH  ' }))).toEqual({
        action: 'register',
        fullName: 'Anna Beispiel',
        companyName: 'Taxi Beispiel GmbH',
        plan: 'basic',
        billingCycle: 'monthly',
        carLimit: 3,
        referralCode: null,
        discountCode: null,
      });
    });

    it('keeps the plan, billing cycle, car limit and codes it is given', () => {
      expect(accepted(register({
        plan: 'premium', billing_cycle: 'yearly', subscription_car_limit: 12, referral_code: ' ref-2026 ', discount_code: ' Sommer26 ',
      }))).toMatchObject({ plan: 'premium', billingCycle: 'yearly', carLimit: 12, referralCode: 'REF-2026', discountCode: 'Sommer26' });
    });

    it('refuses missing, blank, non-text and over-long names', () => {
      const long = 'x'.repeat(MAX_NAME_LENGTH + 1);
      for (const fields of [
        { full_name: undefined }, { company_name: undefined }, { full_name: '   ' }, { company_name: '' },
        { full_name: 42 }, { company_name: ['Taxi'] }, { full_name: long }, { company_name: long },
      ]) {
        expect(refused(register(fields))).toEqual(INVALID);
      }
      expect(accepted(register({ company_name: 'x'.repeat(MAX_NAME_LENGTH) }))).toMatchObject({ companyName: 'x'.repeat(MAX_NAME_LENGTH) });
    });

    it('refuses a name with a control or format character inside it', () => {
      // Built from code points, so this file holds no invisible character itself:
      // line feed, tab, NUL, DEL, NEL, zero-width space, right-to-left override,
      // left-to-right isolate, soft hyphen and byte order mark.
      const codePoints = [0x0a, 0x09, 0x00, 0x7f, 0x85, 0x200b, 0x202e, 0x2066, 0xad, 0xfeff];
      for (const code of codePoints) {
        const name = `Taxi${String.fromCodePoint(code)}Beispiel`;
        expect(refused(register({ full_name: name }))).toEqual(INVALID);
        expect(refused(register({ company_name: name }))).toEqual(INVALID);
      }
    });

    it('keeps names in any script and with ordinary punctuation', () => {
      for (const name of ['Müller & Söhne GmbH', "O'Brien Taxi", 'Ærø Mietwagen', 'Łukasz Żółć', 'تاكسي برلين', 'Taxi-Zentrale (Nord) e.K.']) {
        expect(accepted(register({ full_name: name, company_name: name }))).toMatchObject({ fullName: name, companyName: name });
      }
    });

    it('answers a referral code longer than company-signup allows as referral_invalid', () => {
      expect(refused(register({ referral_code: 'A'.repeat(MAX_REFERRAL_CODE_LENGTH + 1) })))
        .toEqual({ status: 400, body: { ok: false, reason: 'referral_invalid' } });
      expect(accepted(register({ referral_code: 'a'.repeat(MAX_REFERRAL_CODE_LENGTH) })))
        .toMatchObject({ referralCode: 'A'.repeat(MAX_REFERRAL_CODE_LENGTH) });
    });

    it('refuses a discount code longer than a referral code may be', () => {
      expect(MAX_DISCOUNT_CODE_LENGTH).toBe(MAX_REFERRAL_CODE_LENGTH);
      expect(refused(register({ discount_code: 'D'.repeat(MAX_DISCOUNT_CODE_LENGTH + 1) }))).toEqual(INVALID);
      expect(accepted(register({ discount_code: ` ${'d'.repeat(MAX_DISCOUNT_CODE_LENGTH)} ` })))
        .toMatchObject({ discountCode: 'd'.repeat(MAX_DISCOUNT_CODE_LENGTH) });
    });

    it('treats blank and non-text codes as no code, as company-signup does', () => {
      expect(accepted(register({ referral_code: '  ', discount_code: 7 }))).toMatchObject({ referralCode: null, discountCode: null });
      expect(accepted(register({ referral_code: null, discount_code: { code: 'X' } }))).toMatchObject({ referralCode: null, discountCode: null });
    });
  });
});

describe('normalizers', () => {
  it('fall back to basic and monthly', () => {
    expect(normalizePlan('advanced')).toBe('advanced');
    expect(normalizePlan('enterprise')).toBe('basic');
    expect(normalizePlan(undefined)).toBe('basic');
    expect(normalizeBillingCycle('yearly')).toBe('yearly');
    expect(normalizeBillingCycle('weekly')).toBe('monthly');
  });

  it.each([
    [undefined, 3], [null, 3], [0, 3], ['abc', 3], ['5', 5], [5.9, 5], [0.5, 1], [-4, 1], [true, 1], [101, 100], [1e9, 100],
  ])('car limit %p becomes %p', (raw, expected) => {
    expect(normalizeCarLimit(raw)).toBe(expected);
  });
});

describe('asReconcileDbResult', () => {
  it('keeps the action and drops the company id', () => {
    expect(asReconcileDbResult({ action: 'pending_signup_cancelled', company_id: OTHER_USER })).toEqual({ action: 'pending_signup_cancelled' });
    expect(asReconcileDbResult({ action: 'invite_accepted', company_id: OTHER_USER })).toEqual({ action: 'invite_accepted' });
  });

  it.each(RECONCILE_NONE_REASONS)('passes none/%s through', (reason) => {
    expect(asReconcileDbResult({ action: 'none', reason, company_id: OTHER_USER })).toEqual({ action: 'none', reason });
  });

  it('throws for anything outside the contract', () => {
    for (const raw of [null, {}, { action: 'deleted' }, { action: 'none' }, { action: 'none', reason: 'because' }]) {
      expect(() => asReconcileDbResult(raw)).toThrow(/outside the contract/);
    }
  });
});

describe('asDiscountSummary', () => {
  it('passes on success and the prices of a redeemed code, and nothing else', () => {
    expect(asDiscountSummary(REDEEMED_DISCOUNT)).toEqual(REDEEMED_SUMMARY);
  });

  it('passes on the reason code of a code that did not apply, and no sentence', () => {
    expect(asDiscountSummary(REFUSED_DISCOUNT)).toEqual(REFUSED_SUMMARY);
  });

  it.each(DISCOUNT_REASON_CODES)('keeps the reason code %s', (reasonCode) => {
    expect(asDiscountSummary({ success: false, reason_code: reasonCode, german_message: 'Text' })).toEqual({ ...REFUSED_SUMMARY, reason_code: reasonCode });
  });

  it('turns anything outside the contract into nulls, never into text', () => {
    expect(asDiscountSummary({ success: false, reason_code: 'Dieser Rabattcode ist ungültig.' })).toEqual({ ...REFUSED_SUMMARY, reason_code: null });
    expect(asDiscountSummary({ success: 'true', original_price: 60, german_message: 'Text' })).toEqual({ ...REFUSED_SUMMARY, reason_code: null });
    expect(asDiscountSummary({ success: true, original_price: '60', discount_amount: Number.NaN, final_price: null, reason_code: 'EXPIRED' }))
      .toEqual({ success: true, reason_code: null, original_price: null, discount_amount: null, final_price: null });
  });

  it('is null when no discount code was given', () => {
    for (const raw of [null, undefined, 'Rabattcode erfolgreich eingelöst.', 42, [REDEEMED_DISCOUNT]]) {
      expect(asDiscountSummary(raw)).toBeNull();
    }
  });
});

describe('asRegisterDbResult', () => {
  const company = { id: OTHER_USER, name: 'Taxi Beispiel GmbH', slug: 'taxi-beispiel-gmbh', trial_end: '2026-10-15T10:00:00+00:00', approval_status: 'pending' };

  it('returns the company summary and the discount summary', () => {
    expect(asRegisterDbResult({ ok: true, company, discount: REDEEMED_DISCOUNT })).toEqual({ company, discount: REDEEMED_SUMMARY });
    expect(asRegisterDbResult({ ok: true, company, discount: REFUSED_DISCOUNT })).toEqual({ company, discount: REFUSED_SUMMARY });
  });

  it('needs only ok and the company id, because the company is already committed', () => {
    expect(asRegisterDbResult({ ok: true, company: { id: OTHER_USER } })).toEqual({
      company: { id: OTHER_USER, name: null, slug: null, trial_end: null, approval_status: null },
      discount: null,
    });
  });

  it('throws without ok or a company id', () => {
    for (const raw of [null, { ok: false, company }, { ok: true }, { ok: true, company: { id: '' } }, { ok: 'true', company }]) {
      expect(() => asRegisterDbResult(raw)).toThrow(/outside the contract/);
    }
  });
});

describe('mapRegisterError', () => {
  it.each([
    ['22023', 400, 'invalid_request'],
    ['OA001', 401, 'account_not_found'],
    ['OA002', 403, 'account_blocked'],
    ['OA003', 403, 'email_not_confirmed'],
    ['OA004', 403, 'not_google_account'],
    ['OA005', 403, 'platform_staff'],
    ['OA006', 409, 'company_exists'],
    ['OA007', 409, 'no_pending_signup'],
    ['OA008', 400, 'referral_invalid'],
    ['OA009', 400, 'referral_inactive'],
  ])('maps SQLSTATE %s to %i %s', (code, status, reason) => {
    expect(mapRegisterError({ code, message: 'ignored', details: 'ignored' })).toEqual({ status, body: { ok: false, reason } });
  });

  it('covers every SQLSTATE the migration lists and nothing else', () => {
    expect(Object.keys(REGISTER_SQLSTATE_REASONS).sort()).toEqual(
      ['22023', 'OA001', 'OA002', 'OA003', 'OA004', 'OA005', 'OA006', 'OA007', 'OA008', 'OA009'],
    );
  });

  it('maps the code, never the message', () => {
    expect(mapRegisterError({ code: 'P0001', message: 'oauth_signup_create_company: account_blocked' })).toBeNull();
    expect(mapRegisterError({ message: 'OA002' })).toBeNull();
    expect(mapRegisterError({ code: 'toString' })).toBeNull();
    expect(mapRegisterError(new Error('OA002'))).toBeNull();
    expect(mapRegisterError(null)).toBeNull();
  });
});

describe('runOauthAccountAction', () => {
  it('reconciles the caller and nobody else', async () => {
    const { rpc, calls } = fakeRpc({ data: { action: 'invite_accepted', company_id: OTHER_USER } });
    expect(await runOauthAccountAction({ action: 'reconcile' }, USER, rpc))
      .toEqual({ status: 200, body: { ok: true, action: 'invite_accepted' } });
    expect(calls).toEqual([{ fn: 'oauth_session_reconcile', args: { p_user_id: USER } }]);
  });

  it('reports a reconcile that changed nothing, with its reason', async () => {
    const { rpc } = fakeRpc({ data: { action: 'none', reason: 'nothing_pending' } });
    expect(await runOauthAccountAction({ action: 'reconcile' }, USER, rpc))
      .toEqual({ status: 200, body: { ok: true, action: 'none', reason: 'nothing_pending' } });
  });

  it('registers with every field, and the caller as the user', async () => {
    const company = { id: OTHER_USER, name: 'Taxi Beispiel GmbH', slug: 'taxi-beispiel-gmbh', trial_end: '2026-10-15', approval_status: 'pending' };
    const { rpc, calls } = fakeRpc({ data: { ok: true, company, discount: null } });
    const input = accepted(register({ plan: 'advanced', billing_cycle: 'yearly', subscription_car_limit: 7, referral_code: 'ref1', user_id: OTHER_USER }));
    expect(await runOauthAccountAction(input, USER, rpc)).toEqual({ status: 200, body: { ok: true, company, discount: null } });
    expect(calls).toEqual([{
      fn: 'oauth_signup_create_company',
      args: {
        p_user_id: USER,
        p_full_name: 'Anna Beispiel',
        p_company_name: 'Taxi Beispiel GmbH',
        p_plan: 'advanced',
        p_billing_cycle: 'yearly',
        p_car_limit: 7,
        p_referral_code: 'REF1',
        p_discount_code: null,
      },
    }]);
  });

  it('answers a registration with its discount summary and without the database text', async () => {
    const company = { id: OTHER_USER, name: 'Taxi Beispiel GmbH', slug: 'taxi-beispiel-gmbh', trial_end: '2026-10-15', approval_status: 'pending' };
    for (const [discount, summary] of [[REDEEMED_DISCOUNT, REDEEMED_SUMMARY], [REFUSED_DISCOUNT, REFUSED_SUMMARY]] as const) {
      const reply = await runOauthAccountAction(accepted(register({ discount_code: 'Sommer26' })), USER, fakeRpc({ data: { ok: true, company, discount } }).rpc);
      expect(reply).toEqual({ status: 200, body: { ok: true, company, discount: summary } });
      expect(JSON.stringify(reply)).not.toMatch(/german_message|Rabattcode|discount_code_id|usage_mode/);
    }
  });

  it('answers a refusal the database raised with its reason', async () => {
    const { rpc } = fakeRpc({ error: { code: 'OA006', message: 'oauth_signup_create_company: company_exists' } });
    expect(await runOauthAccountAction(accepted(register({})), USER, rpc))
      .toEqual({ status: 409, body: { ok: false, reason: 'company_exists' } });
  });

  it('rethrows any other error and any result outside the contract', async () => {
    const failure = { code: '23505', message: 'duplicate key value violates unique constraint' };
    await expect(runOauthAccountAction(accepted(register({})), USER, fakeRpc({ error: failure }).rpc)).rejects.toBe(failure);
    await expect(runOauthAccountAction(accepted(register({})), USER, fakeRpc({ data: { ok: false } }).rpc)).rejects.toThrow(/outside the contract/);
    await expect(runOauthAccountAction({ action: 'reconcile' }, USER, fakeRpc({ error: failure }).rpc)).rejects.toBe(failure);
    await expect(runOauthAccountAction({ action: 'discard' }, USER, fakeRpc({ error: failure }).rpc)).rejects.toBe(failure);
  });

  it('discards the caller, or says the account cannot be discarded', async () => {
    const yes = fakeRpc({ data: true });
    expect(await runOauthAccountAction({ action: 'discard' }, USER, yes.rpc)).toEqual({ status: 200, body: { ok: true, discarded: true } });
    expect(yes.calls).toEqual([{ fn: 'oauth_signup_discard', args: { p_user_id: USER } }]);
    expect(await runOauthAccountAction({ action: 'discard' }, USER, fakeRpc({ data: false }).rpc))
      .toEqual({ status: 409, body: { ok: false, reason: 'not_discardable' } });
    await expect(runOauthAccountAction({ action: 'discard' }, USER, fakeRpc({ data: 'true' }).rpc)).rejects.toThrow(/outside the contract/);
  });

  it('calls nothing for a caller id that is not a uuid', async () => {
    const { rpc, calls } = fakeRpc({ data: true });
    for (const id of ['', 'anon', `${USER} `, "' OR 1=1 --"]) {
      await expect(runOauthAccountAction({ action: 'discard' }, id, rpc)).rejects.toThrow(/user id/);
    }
    expect(calls).toEqual([]);
  });
});

// Owner decision, 16.09.2026: platform staff sign in with email and password
// only, never with Google. The database decides who is staff, in
// app_private.oauth_account_is_platform_staff, and tests/rls/oauth-signup.sql
// proves it writes nothing for them. These pin that the function passes each
// of those answers on unchanged, with one RPC call and no second opinion.
describe('platform staff', () => {
  it('register: the database raises OA005 and the reply is 403 platform_staff', async () => {
    const { rpc, calls } = fakeRpc({ error: { code: 'OA005', message: 'oauth_signup_create_company: platform_staff' } });
    expect(await runOauthAccountAction(accepted(register({})), USER, rpc))
      .toEqual({ status: 403, body: { ok: false, reason: 'platform_staff' } });
    expect(calls.map((call) => call.fn)).toEqual(['oauth_signup_create_company']);
  });

  it('reconcile: the database answers none/platform_staff and nothing is accepted or cancelled', async () => {
    const { rpc, calls } = fakeRpc({ data: { action: 'none', reason: 'platform_staff' } });
    expect(await runOauthAccountAction({ action: 'reconcile' }, USER, rpc))
      .toEqual({ status: 200, body: { ok: true, action: 'none', reason: 'platform_staff' } });
    expect(calls.map((call) => call.fn)).toEqual(['oauth_session_reconcile']);
  });

  it('discard: the database answers false and the reply is 409 not_discardable', async () => {
    const { rpc, calls } = fakeRpc({ data: false });
    expect(await runOauthAccountAction({ action: 'discard' }, USER, rpc))
      .toEqual({ status: 409, body: { ok: false, reason: 'not_discardable' } });
    expect(calls.map((call) => call.fn)).toEqual(['oauth_signup_discard']);
  });
});

describe('logs', () => {
  afterEach(() => vi.restoreAllMocks());

  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

  it('removes addresses as well as tokens from an error description', () => {
    const detail = describeOauthError(new Error(`user anna.beispiel@taxi-beispiel.de rejected, token ${jwt}`));
    expect(detail).not.toContain('anna.beispiel');
    expect(detail).not.toContain('taxi-beispiel.de');
    expect(detail).not.toContain(jwt);
    expect(detail).toContain('[address]');
  });

  it('removes an address the length limit cut off after the @', () => {
    const detail = describeOauthError(new Error(`${'x'.repeat(480)} lost.owner@example.com`));
    expect(detail).not.toMatch(/lost\.owner/);
  });

  it('writes one JSON line with the context and a scrubbed detail', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logOauthFailure('register', { request_id: 'abcd1234', action: 'register', user_id: USER }, { code: 'XX000', message: 'owner a@b.de' });
    expect(error).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(error.mock.calls[0][0]));
    expect(line).toEqual({
      level: 'error', fn: 'oauth-account', step: 'register', request_id: 'abcd1234', action: 'register', user_id: USER,
      detail: 'XX000: owner [address]',
    });
  });
});
