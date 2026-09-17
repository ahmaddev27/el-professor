import { describe, expect, it } from 'vitest';
import {
  googleSessionIsSettled,
  hasGoogleIdentity,
  needsCompanyRegistration,
  sessionCameFromGoogle,
} from './googleAccount';

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

describe('googleSessionIsSettled', () => {
  it('is true for a company account in good standing: reconcile has nothing to do', () => {
    expect(googleSessionIsSettled({ company_id: 'c-1', status: 'active' })).toBe(true);
  });

  it('is false for an invited employee, whose invitation is what reconcile accepts', () => {
    expect(googleSessionIsSettled({ company_id: 'c-1', status: 'pending_invite' })).toBe(false);
  });

  it.each([
    ['an account with no company yet', { company_id: null, status: 'active' }],
    ['a company account that is not active', { company_id: 'c-1', status: 'suspended' }],
    ['a profile that has not loaded', null],
  ])('is false for %s', (_label, profile) => {
    expect(googleSessionIsSettled(profile)).toBe(false);
  });
});

describe('needsCompanyRegistration', () => {
  const profile = (over: Record<string, unknown> = {}) => ({ company_id: null, is_super_admin: false, ...over });

  it('is true for a Google account with no company', () => {
    expect(needsCompanyRegistration(googleNative, profile())).toBe(true);
  });

  /*
    The state the owner hit minutes after Google sign-in went live on staging.

    Nothing writes a profile between GoTrue creating the account and
    oauth_signup_create_company writing the company — no trigger on auth.users
    creates one, and both signup RPCs write the owner's profile themselves — so
    "no row at all" is the ordinary first state of a Google signup, not a load
    that has not answered. Answering `false` here let the account into the
    tenant router with no company, where every query asked for company_id null
    and Postgres answered `invalid input syntax for type uuid: "null"`.

    App.tsx waits on `profileLoaded` before any gate, so a null profile reaching
    this function is a decided answer, never a query still in flight.
  */
  it('is true for a Google account with no profile row at all', () => {
    expect(needsCompanyRegistration(googleNative, null)).toBe(true);
  });

  it('is true with no profile row however the Google identity is recorded', () => {
    expect(needsCompanyRegistration(linked, null)).toBe(true);
    expect(needsCompanyRegistration(linkedByIdentity, null)).toBe(true);
  });

  it('never claims a password account with no profile row: it is no Google signup', () => {
    expect(needsCompanyRegistration(passwordOnly, null)).toBe(false);
  });

  it('is false once the account belongs to a company', () => {
    expect(needsCompanyRegistration(googleNative, profile({ company_id: 'c-1' }))).toBe(false);
  });

  it('never claims a platform account, which is company-less by design', () => {
    expect(needsCompanyRegistration(googleNative, profile({ is_super_admin: true }))).toBe(false);
    expect(needsCompanyRegistration(googleNative, profile({ is_super_admin: true, company_id: 'c-1' }))).toBe(false);
  });

  it('leaves a password account where it is, whatever state it is in', () => {
    expect(needsCompanyRegistration(passwordOnly, profile())).toBe(false);
    expect(needsCompanyRegistration(passwordOnly, profile({ company_id: 'c-1' }))).toBe(false);
  });

  it('is false with no user at all, whatever the profile says', () => {
    expect(needsCompanyRegistration(null, null)).toBe(false);
    expect(needsCompanyRegistration(null, profile())).toBe(false);
  });
});
