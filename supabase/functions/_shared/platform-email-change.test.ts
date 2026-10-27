/**
 * The pure half of the platform account's direct email change.
 *
 * The freshness test is the one that matters: with the emailed code gone, the
 * age of the password sign-in in the token's `amr` is the only proof that the
 * person at the keyboard knows the password. These cases pin that it is read
 * from the same claim, against the same constant, as `otp-request`'s.
 */
import { describe, expect, it } from 'vitest';
import {
  accountBlocked,
  asCheckResult,
  auditUnavailable,
  CHECK_RESULTS,
  checkResultReply,
  emailChanged,
  isAccountStanding,
  matchPlatformEmailChangeRoute,
  noAccount,
  notPlatformAccount,
  parseEmailChangeBody,
  reauthProofState,
  rateLimited,
  sameEmail,
  type CheckResult,
} from './platform-email-change.ts';
import { PASSWORD_PROOF_MAX_AGE_SECONDS } from './otp-core.ts';
import { PLATFORM_STAFF_ROUTES, resolvePlatformStaffRoute } from './platform-staff-routes.ts';

const NOW = 1_800_000_000;

/** A token amr as GoTrue v2.170.0 writes it for a password grant. */
const passwordAmr = (signedInAt: number) => ({ amr: [{ method: 'password', timestamp: signedInAt }] });

describe('matchPlatformEmailChangeRoute', () => {
  it('matches a POST on the route’s own last segment', () => {
    expect(matchPlatformEmailChangeRoute('POST', '/platform-staff/email-change')).toBe('match');
  });

  it('answers method_not_allowed rather than falling through to the route table', () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      expect(matchPlatformEmailChangeRoute(method, '/platform-staff/email-change')).toBe('method_not_allowed');
    }
  });

  it('matches only the last segment, so a longer path is not this route', () => {
    expect(matchPlatformEmailChangeRoute('POST', '/platform-staff/email-change/other')).toBe('no_match');
    expect(matchPlatformEmailChangeRoute('POST', '/platform-staff/email-change-other')).toBe('no_match');
    expect(matchPlatformEmailChangeRoute('POST', '/platform-staff/invite')).toBe('no_match');
    expect(matchPlatformEmailChangeRoute('POST', '/platform-staff')).toBe('no_match');
    expect(matchPlatformEmailChangeRoute('POST', '/')).toBe('no_match');
  });

  it('tolerates the trailing and doubled slashes a proxy can leave behind', () => {
    expect(matchPlatformEmailChangeRoute('POST', '/platform-staff/email-change/')).toBe('match');
    expect(matchPlatformEmailChangeRoute('POST', '//platform-staff//email-change')).toBe('match');
  });
});

describe('the route is deliberately outside PLATFORM_STAFF_ROUTES', () => {
  // That table is compared against app_private.platform_edge_audit_actions() by
  // platform-access-actions.test.ts. This route needs no capability and its
  // audit row is written by the database under an action platform_audit_record
  // must refuse, so a row here would fail that test — correctly.
  it('is not listed there and is not resolved by it', () => {
    expect(PLATFORM_STAFF_ROUTES.some(r => r.segment.includes('email-change'))).toBe(false);
    expect(resolvePlatformStaffRoute('POST', '/platform-staff/email-change')).toBeNull();
  });
});

describe('parseEmailChangeBody', () => {
  it('normalises the address the way otp-request does', () => {
    expect(parseEmailChangeBody('{"new_email":"  NEU@Example.COM "}')).toEqual({ newEmail: 'neu@example.com' });
  });

  it('ignores unknown fields, and never reads a password from the body', () => {
    const parsed = parseEmailChangeBody('{"new_email":"a@b.de","password":"hunter2","user_id":"someone else"}');
    expect(parsed).toEqual({ newEmail: 'a@b.de' });
    expect(Object.keys(parsed!)).toEqual(['newEmail']);
  });

  it('is null for anything that is not a usable address', () => {
    for (const text of [
      '', 'not json', '[]', 'null', '{}',
      '{"new_email":null}', '{"new_email":123}', '{"new_email":"a@b"}',
      '{"new_email":"a b@c.de"}', '{"new_email":""}',
      `{"new_email":"${'a'.repeat(250)}@b.de"}`,
    ]) {
      expect(parseEmailChangeBody(text), text).toBeNull();
    }
  });
});

describe('reauthProofState', () => {
  it('is fresh for a password sign-in inside the window', () => {
    expect(reauthProofState(passwordAmr(NOW), NOW)).toBe('fresh');
    expect(reauthProofState(passwordAmr(NOW - PASSWORD_PROOF_MAX_AGE_SECONDS), NOW)).toBe('fresh');
  });

  it('is stale one second past the window', () => {
    expect(reauthProofState(passwordAmr(NOW - PASSWORD_PROOF_MAX_AGE_SECONDS - 1), NOW)).toBe('stale');
  });

  it('reads the same window otp-request enforces', () => {
    // If this ever drifts, the two email-change paths disagree about how old a
    // password proof may be, and the weaker one decides.
    expect(PASSWORD_PROOF_MAX_AGE_SECONDS).toBe(600);
  });

  it('is absent for a session no re-authentication established', () => {
    // A code-minted session (issueSession uses GoTrue's magiclink /verify) and
    // a Google one carry no proof method at all.
    expect(reauthProofState({ amr: [{ method: 'otp', timestamp: NOW }] }, NOW)).toBe('absent');
    expect(reauthProofState({ amr: [{ method: 'oauth', timestamp: NOW }] }, NOW)).toBe('absent');
    expect(reauthProofState({ amr: [] }, NOW)).toBe('absent');
    expect(reauthProofState({}, NOW)).toBe('absent');
    expect(reauthProofState({ amr: 'password' }, NOW)).toBe('absent');
    expect(reauthProofState({ amr: [{ method: 'password' }] }, NOW)).toBe('absent');
    expect(reauthProofState({ amr: [{ method: 'password', timestamp: 'now' }] }, NOW)).toBe('absent');
  });

  it('accepts a fresh passkey sign-in, and ages it on the same window', () => {
    // The owner's decision of 27.10.2026: a passkey is a password for this
    // purpose. Both directions, because admitting it is only half the rule —
    // an expired passkey proof must still be refused.
    expect(reauthProofState({ amr: [{ method: 'passkey', timestamp: NOW }] }, NOW)).toBe('fresh');
    expect(
      reauthProofState({ amr: [{ method: 'passkey', timestamp: NOW - PASSWORD_PROOF_MAX_AGE_SECONDS }] }, NOW),
    ).toBe('fresh');
    expect(
      reauthProofState({ amr: [{ method: 'passkey', timestamp: NOW - PASSWORD_PROOF_MAX_AGE_SECONDS - 1 }] }, NOW),
    ).toBe('stale');
    // A passkey beside a stale password is fresh on the passkey, and the other
    // way round: the rule reads the newest proof, not the first entry.
    expect(
      reauthProofState({
        amr: [
          { method: 'password', timestamp: NOW - 10_000 },
          { method: 'passkey', timestamp: NOW - 5 },
        ],
      }, NOW),
    ).toBe('fresh');
  });

  it('takes the newest password entry when a session names several', () => {
    const claims = {
      amr: [
        { method: 'password', timestamp: NOW - 10_000 },
        { method: 'password', timestamp: NOW - 5 },
      ],
    };
    expect(reauthProofState(claims, NOW)).toBe('fresh');
  });

  it('never reads a clock skew as an aged proof', () => {
    expect(reauthProofState(passwordAmr(NOW + 120), NOW)).toBe('fresh');
  });
});

describe('asCheckResult', () => {
  it('accepts every value the migration can return', () => {
    for (const value of CHECK_RESULTS) {
      expect(asCheckResult(value)).toBe(value);
    }
  });

  it('throws for anything outside the contract, so it is a 500 and not a refusal', () => {
    for (const value of [null, undefined, '', 'OK', 'denied', 0, {}, ['ok']]) {
      expect(() => asCheckResult(value)).toThrow(/outside the contract/);
    }
  });
});

describe('isAccountStanding', () => {
  // These three are answered before the freshness test, so "this account may not
  // use this route at all" never depends on how the caller signed in. The rest
  // are about the request and must come after it.
  it('is the three verdicts about the account, and only those', () => {
    expect(CHECK_RESULTS.filter(isAccountStanding))
      .toEqual(['not_platform_account', 'no_account', 'account_blocked']);
  });

  it('does not treat the hourly cap or the address as standing', () => {
    for (const result of ['ok', 'rate_limited', 'same_email', 'email_taken'] as CheckResult[]) {
      expect(isAccountStanding(result), result).toBe(false);
    }
  });
});

describe('checkResultReply', () => {
  it('gives every refusal its own stable reason and status', () => {
    const replies: Record<Exclude<CheckResult, 'ok'>, { status: number; reason: string }> = {
      not_platform_account: { status: 403, reason: 'not_platform_account' },
      no_account: { status: 404, reason: 'no_account' },
      // A banned or deleted account: GoTrue keeps an issued token valid to its
      // exp, so the ban has to be re-read here or containment would not hold.
      account_blocked: { status: 403, reason: 'account_blocked' },
      rate_limited: { status: 429, reason: 'rate_limited' },
      same_email: { status: 400, reason: 'same_email' },
      email_taken: { status: 409, reason: 'email_taken' },
    };
    for (const [result, expected] of Object.entries(replies)) {
      const reply = checkResultReply(result as CheckResult)!;
      expect(reply.status, result).toBe(expected.status);
      expect(reply.body, result).toEqual({ ok: false, reason: expected.reason });
    }
  });

  it('is null for ok, so the route goes on', () => {
    expect(checkResultReply('ok')).toBeNull();
  });

  it('answers email_taken in the shape the code path already answers', () => {
    // otp-core's emailTaken(); the browser must not have to tell them apart.
    expect(checkResultReply('email_taken')).toEqual({ status: 409, body: { ok: false, reason: 'email_taken' } });
  });

  it('names a distinct reason for every refusal', () => {
    const reasons = CHECK_RESULTS.filter(r => r !== 'ok').map(r => checkResultReply(r)!.body.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('the successful answer', () => {
  it('reports the address that is now live', () => {
    expect(emailChanged('neu@example.com')).toEqual({ status: 200, body: { ok: true, email: 'neu@example.com' } });
  });

  it('never carries a session or a token', () => {
    expect(Object.keys(emailChanged('a@b.de').body).sort()).toEqual(['email', 'ok']);
  });
});

describe('the refusal helpers', () => {
  it('say nothing beyond ok and reason', () => {
    for (const reply of [notPlatformAccount(), sameEmail(), noAccount(), accountBlocked(), rateLimited(), auditUnavailable()]) {
      expect(Object.keys(reply.body).sort()).toEqual(['ok', 'reason']);
      expect(reply.body.ok).toBe(false);
    }
  });

  // The route answers this instead of changing the address when the `attempt`
  // audit row cannot be written. An address the log cannot record is an address
  // that does not move; a 200 here would be the one unrecorded change.
  it('reports a missing audit row as a server failure, not as a success', () => {
    expect(auditUnavailable()).toEqual({ status: 500, body: { ok: false, reason: 'audit_unavailable' } });
  });
});
