import { describe, expect, it } from 'vitest';
import { hasGoogleIdentity, needsCompanyRegistration, sessionCameFromGoogle } from './googleAccount';

const googleNative = { app_metadata: { provider: 'google', providers: ['google'] } };
const passwordOnly = { app_metadata: { provider: 'email', providers: ['email'] } };
const linked = { app_metadata: { provider: 'email', providers: ['email', 'google'] } };
const linkedByIdentity = { app_metadata: { provider: 'email' }, identities: [{ provider: 'google' }] };

describe('hasGoogleIdentity', () => {
  it.each([
    ['an account Google created', googleNative, true],
    ['an account linked to Google later', linked, true],
    ['an account whose session lists the identity', linkedByIdentity, true],
    ['a password account', passwordOnly, false],
    ['no user', null, false],
  ])('%s', (_label, user, expected) => {
    expect(hasGoogleIdentity(user)).toBe(expected);
  });
});

describe('sessionCameFromGoogle', () => {
  it('is true for an account Google created, marker or not: it holds no password', () => {
    expect(sessionCameFromGoogle(googleNative, false)).toBe(true);
    expect(sessionCameFromGoogle(googleNative, true)).toBe(true);
  });

  it('needs the marker for a linked account, since GoTrue leaves provider at email', () => {
    expect(sessionCameFromGoogle(linked, true)).toBe(true);
    expect(sessionCameFromGoogle(linked, false)).toBe(false);
  });

  it('is false for a password account even with a stale marker in the tab', () => {
    expect(sessionCameFromGoogle(passwordOnly, true)).toBe(false);
  });
});

describe('needsCompanyRegistration', () => {
  const profile = (over: Record<string, unknown> = {}) => ({ company_id: null, is_super_admin: false, ...over });

  it('is true for a Google account with no company', () => {
    expect(needsCompanyRegistration(googleNative, profile())).toBe(true);
  });

  it('is false once the account belongs to a company', () => {
    expect(needsCompanyRegistration(googleNative, profile({ company_id: 'c-1' }))).toBe(false);
  });

  it('never claims a platform account, which is company-less by design', () => {
    expect(needsCompanyRegistration(googleNative, profile({ is_super_admin: true }))).toBe(false);
  });

  it('leaves a password account where it is, whatever state it is in', () => {
    expect(needsCompanyRegistration(passwordOnly, profile())).toBe(false);
  });

  it('waits for the profile rather than guessing', () => {
    expect(needsCompanyRegistration(googleNative, null)).toBe(false);
  });
});
