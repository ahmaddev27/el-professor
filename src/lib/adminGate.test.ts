import { describe, expect, it } from 'vitest';
import {
  ADMIN_BASE,
  ADMIN_LOGIN_PATH,
  LEGACY_ADMIN_BASE,
  SIGN_IN_PATH,
  TENANT_HOME,
  decideAdminGate,
  googleSignInRefusal,
  legacyAdminLoginRedirect,
  legacyAdminTarget,
  platformAccountRoute,
  platformEntry,
  platformEntryPath,
  platformReturnPath,
  rememberedPanelPath,
  type AdminGateState,
  type PlatformAccountRouteState,
  type PlatformSessionState,
} from './adminGate';

/** A signed-in platform account whose profile has answered. */
const PLATFORM_SESSION: PlatformSessionState = {
  authLoading: false,
  hasSession: true,
  profileLoaded: true,
  isSuperAdmin: true,
};

const GATE: AdminGateState = {
  isSuperAdmin: true,
  platformAccessStatus: 'ready',
  hasPlatformRole: true,
};

describe('legacyAdminTarget', () => {
  it('rewrites the old entry and every page under it onto /admin', () => {
    expect(legacyAdminTarget(LEGACY_ADMIN_BASE)).toBe(ADMIN_BASE);
    expect(legacyAdminTarget('/super-admin/companies')).toBe('/admin/companies');
    expect(legacyAdminTarget('/super-admin/einstellungen')).toBe('/admin/einstellungen');
    // The account page PR #50 registered inside the panel.
    expect(legacyAdminTarget('/super-admin/konto')).toBe('/admin/konto');
    expect(legacyAdminTarget('/super-admin/')).toBe('/admin/');
  });

  it('leaves every other path alone', () => {
    expect(legacyAdminTarget('/')).toBeNull();
    expect(legacyAdminTarget('/overview')).toBeNull();
    expect(legacyAdminTarget(ADMIN_BASE)).toBeNull();
    // A different path that merely starts with the same characters.
    expect(legacyAdminTarget('/super-administration')).toBeNull();
  });
});

describe('platformEntry', () => {
  it('opens the panel for an account the flag routes here', () => {
    expect(platformEntry(PLATFORM_SESSION)).toBe('panel');
    expect(platformEntryPath('panel')).toBe(ADMIN_BASE);
  });

  it('sends a company user that types /admin to its own app', () => {
    const entry = platformEntry({ ...PLATFORM_SESSION, isSuperAdmin: false });
    expect(entry).toBe('tenant');
    expect(platformEntryPath(entry)).toBe(TENANT_HOME);
  });

  it('waits while the session or its profile has not answered', () => {
    // A profile still loading must never be read as an account without one:
    // that answer would route a platform account into the tenant app.
    expect(platformEntry({ ...PLATFORM_SESSION, profileLoaded: false })).toBe('loading');
    expect(platformEntry({ ...PLATFORM_SESSION, profileLoaded: false, isSuperAdmin: false })).toBe('loading');
    expect(platformEntry({ ...PLATFORM_SESSION, authLoading: true })).toBe('loading');
    expect(platformEntryPath('loading')).toBeNull();
  });

  it('asks a visitor without a session to sign in at the one sign-in screen', () => {
    const entry = platformEntry({ ...PLATFORM_SESSION, hasSession: false, isSuperAdmin: false });
    expect(entry).toBe('signIn');
    // The owner's decision of 17.09.2026: one screen, not the panel's own.
    expect(platformEntryPath(entry)).toBe(SIGN_IN_PATH);
    expect(SIGN_IN_PATH).toBe('/login');
    expect(platformEntryPath(entry)).not.toBe(ADMIN_LOGIN_PATH);
  });

  it('never reads a stale flag from a session that no longer exists', () => {
    expect(platformEntry({ ...PLATFORM_SESSION, hasSession: false })).toBe('signIn');
  });
});

describe('platformReturnPath', () => {
  it('keeps a deep link into the panel', () => {
    expect(platformReturnPath(ADMIN_BASE)).toBe(ADMIN_BASE);
    expect(platformReturnPath('/admin/protokoll')).toBe('/admin/protokoll');
    expect(platformReturnPath('/admin/konto')).toBe('/admin/konto');
  });

  it('never goes back to a sign-in page, which would answer with itself forever', () => {
    expect(platformReturnPath(ADMIN_LOGIN_PATH)).toBeNull();
    expect(platformReturnPath(`${ADMIN_LOGIN_PATH}/`)).toBeNull();
    expect(platformReturnPath(SIGN_IN_PATH)).toBeNull();
  });

  it('drops a path that is not inside the panel', () => {
    expect(platformReturnPath('/overview')).toBeNull();
    expect(platformReturnPath('/super-admin/protokoll')).toBeNull();
    expect(platformReturnPath('/administration')).toBeNull();
    expect(platformReturnPath('')).toBeNull();
  });

  it('cannot be talked into leaving the panel, or the site', () => {
    expect(platformReturnPath('//evil.example/admin')).toBeNull();
    expect(platformReturnPath('https://evil.example/admin')).toBeNull();
    expect(platformReturnPath('/admin/../evil')).toBeNull();
    expect(platformReturnPath('/admin\\..\\evil')).toBeNull();
  });

  it('answers null for anything that is not a string', () => {
    expect(platformReturnPath(undefined)).toBeNull();
    expect(platformReturnPath(null)).toBeNull();
    expect(platformReturnPath(42)).toBeNull();
    expect(platformReturnPath({ from: ADMIN_BASE })).toBeNull();
  });
});

describe('platformAccountRoute', () => {
  /** A platform account on a fresh load: no company yet, no answer yet. */
  const FRESH: PlatformAccountRouteState = {
    isSuperAdmin: true,
    platformAccessStatus: 'loading',
    hasCompany: false,
  };

  /*
    The staging defect of 18.09.2026, as a test.

    Opening a company and reloading the page landed on /admin with the
    read-only bar still naming the company — because the guard read "no
    company" out of a question that had not been answered yet. The distinction
    this pins is the whole bug: **unanswered is not the same as answered with
    no context**, and only the first one may wait.
  */
  it('waits while platform_whoami() has not answered, so a reload keeps the company', () => {
    expect(platformAccountRoute(FRESH)).toBe('wait');
    // The same unknown one render earlier, before the provider's effect ran.
    expect(platformAccountRoute({ ...FRESH, platformAccessStatus: 'idle' })).toBe('wait');
  });

  it('sends a platform account to the panel once the answer says no company', () => {
    expect(platformAccountRoute({ ...FRESH, platformAccessStatus: 'ready' })).toBe('panel');
  });

  /*
    Not `wait`: an unanswered question is not permission, and a question that
    failed is not a reason to spin for ever. /admin is where AdminLayout shows
    the failure and offers the retry.
  */
  it('sends it to the panel when the question failed', () => {
    expect(platformAccountRoute({ ...FRESH, platformAccessStatus: 'error' })).toBe('panel');
  });

  it('never waits once a company is in hand, whatever the status says', () => {
    for (const status of ['idle', 'loading', 'ready', 'error'] as const) {
      expect(platformAccountRoute({ ...FRESH, platformAccessStatus: status, hasCompany: true })).toBe('tenant');
    }
  });

  /*
    A company user is not this guard's business at all — and must never be made
    to wait for an answer that is never asked for it: `SuperAdminContext` leaves
    the status at `idle` for every account that is not platform staff, so a
    `wait` here would be a permanent spinner over the whole tenant app.
  */
  it('lets a company user straight through, including while the status is idle', () => {
    expect(platformAccountRoute({ isSuperAdmin: false, platformAccessStatus: 'idle', hasCompany: true })).toBe('tenant');
    expect(platformAccountRoute({ isSuperAdmin: false, platformAccessStatus: 'idle', hasCompany: false })).toBe('tenant');
  });
});

describe('decideAdminGate', () => {
  it('shows the panel to an account with an active platform role', () => {
    expect(decideAdminGate(GATE)).toBe('panel');
  });

  it('refuses an account whose platform_whoami() reports no active role', () => {
    expect(decideAdminGate({ ...GATE, hasPlatformRole: false })).toBe('noRole');
  });

  it('waits for platform_whoami() rather than guessing', () => {
    expect(decideAdminGate({ ...GATE, platformAccessStatus: 'idle' })).toBe('loading');
    expect(decideAdminGate({ ...GATE, platformAccessStatus: 'loading' })).toBe('loading');
    // Even with a role already in hand from an earlier answer.
    expect(decideAdminGate({ ...GATE, platformAccessStatus: 'loading', hasPlatformRole: true })).toBe('loading');
  });

  it('keeps the panel shut when the question could not be answered', () => {
    expect(decideAdminGate({ ...GATE, platformAccessStatus: 'error' })).toBe('accessUnknown');
    expect(decideAdminGate({ ...GATE, platformAccessStatus: 'error', hasPlatformRole: true })).toBe('accessUnknown');
  });

  it('sends a company user to its own app before any of that', () => {
    expect(decideAdminGate({ ...GATE, isSuperAdmin: false })).toBe('notPlatform');
    // A company user cannot talk its way in with a role it should not have.
    expect(decideAdminGate({ isSuperAdmin: false, platformAccessStatus: 'ready', hasPlatformRole: true }))
      .toBe('notPlatform');
  });
});

describe('rememberedPanelPath', () => {
  it('reads the panel path out of a router location state', () => {
    expect(rememberedPanelPath({ from: '/admin/protokoll' })).toBe('/admin/protokoll');
    expect(rememberedPanelPath({ from: ADMIN_BASE })).toBe(ADMIN_BASE);
  });

  it('validates the value again rather than trusting whoever passed it on', () => {
    // Every guard platformReturnPath applies, reached through this door too:
    // the value changes hands twice on its way back (the redirect, then the
    // sign-in screen), and being checked once does not make it safe the second
    // time it is used.
    expect(rememberedPanelPath({ from: 'https://evil.example/admin' })).toBeNull();
    expect(rememberedPanelPath({ from: '//evil.example/admin' })).toBeNull();
    expect(rememberedPanelPath({ from: '/admin/../evil' })).toBeNull();
    expect(rememberedPanelPath({ from: '/admin\\..\\evil' })).toBeNull();
    expect(rememberedPanelPath({ from: '/overview' })).toBeNull();
    expect(rememberedPanelPath({ from: ADMIN_LOGIN_PATH })).toBeNull();
    expect(rememberedPanelPath({ from: SIGN_IN_PATH })).toBeNull();
  });

  it('answers null for a state that carries nothing usable', () => {
    expect(rememberedPanelPath(null)).toBeNull();
    expect(rememberedPanelPath(undefined)).toBeNull();
    expect(rememberedPanelPath({})).toBeNull();
    expect(rememberedPanelPath('/admin/protokoll')).toBeNull();
    expect(rememberedPanelPath(42)).toBeNull();
  });
});

describe('legacyAdminLoginRedirect', () => {
  it('sends the panel’s old front door to the one sign-in screen', () => {
    expect(legacyAdminLoginRedirect(null)).toEqual({ to: SIGN_IN_PATH, from: null });
    expect(legacyAdminLoginRedirect(undefined).to).toBe(SIGN_IN_PATH);
  });

  it('carries the remembered panel path across, so a bookmark still lands right', () => {
    // A signed-out visitor asks for /admin/protokoll: PlatformSignInRedirect
    // remembers it, the old front door hands it on, and the sign-in screen
    // returns the account there once it has a session.
    expect(legacyAdminLoginRedirect({ from: '/admin/protokoll' }))
      .toEqual({ to: SIGN_IN_PATH, from: '/admin/protokoll' });
  });

  it('drops a remembered path it would not have accepted itself', () => {
    expect(legacyAdminLoginRedirect({ from: 'https://evil.example/admin' }).from).toBeNull();
    expect(legacyAdminLoginRedirect({ from: '/overview' }).from).toBeNull();
    // Its own path, which would bounce between the two screens for ever.
    expect(legacyAdminLoginRedirect({ from: ADMIN_LOGIN_PATH }).from).toBeNull();
  });
});

describe('googleSignInRefusal', () => {
  it('refuses a platform account whose session Google minted', () => {
    expect(googleSignInRefusal({ cameFromGoogle: true, isPlatformAccount: true })).toEqual({
      to: SIGN_IN_PATH,
      messageKey: 'auth.google.error.platformStaff',
    });
  });

  it('never refuses a password session, whatever identities the account holds', () => {
    // The rule that must not drift. It asks how *this session* was minted —
    // `sessionCameFromGoogle` — and never whether the account has a Google
    // identity: a platform account whose address also exists at Google would
    // otherwise be signed out of a correct password sign-in.
    expect(googleSignInRefusal({ cameFromGoogle: false, isPlatformAccount: true })).toBeNull();
  });

  it('leaves a company user’s Google sign-in alone', () => {
    expect(googleSignInRefusal({ cameFromGoogle: true, isPlatformAccount: false })).toBeNull();
    expect(googleSignInRefusal({ cameFromGoogle: false, isPlatformAccount: false })).toBeNull();
  });

  it('shows the refusal on the screen the visitor can sign in again from', () => {
    const refusal = googleSignInRefusal({ cameFromGoogle: true, isPlatformAccount: true });
    // Not a screen of its own: the one sign-in screen, which is also where
    // platformEntry() sends a browser with no session — so the sentence and the
    // form the account must now use are the same page.
    expect(refusal?.to).toBe(platformEntryPath('signIn'));
  });
});
