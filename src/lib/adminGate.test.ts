import { describe, expect, it } from 'vitest';
import {
  ADMIN_BASE,
  ADMIN_LOGIN_PATH,
  LEGACY_ADMIN_BASE,
  TENANT_HOME,
  decideAdminGate,
  legacyAdminTarget,
  platformEntry,
  platformEntryPath,
  platformReturnPath,
  platformSignInMessageKey,
  type AdminGateState,
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

  it('asks a visitor without a session to sign in at the platform page', () => {
    const entry = platformEntry({ ...PLATFORM_SESSION, hasSession: false, isSuperAdmin: false });
    expect(entry).toBe('signIn');
    expect(platformEntryPath(entry)).toBe(ADMIN_LOGIN_PATH);
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

  it('never goes back to the sign-in page, which would answer with itself forever', () => {
    expect(platformReturnPath(ADMIN_LOGIN_PATH)).toBeNull();
    expect(platformReturnPath(`${ADMIN_LOGIN_PATH}/`)).toBeNull();
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

describe('platformSignInMessageKey', () => {
  it('says the same thing whatever the refusal was', () => {
    const generic = 'admin.login.failed';
    expect(platformSignInMessageKey({ message: 'Invalid login credentials' })).toBe(generic);
    expect(platformSignInMessageKey({ message: 'Email not confirmed' })).toBe(generic);
    expect(platformSignInMessageKey({ message: 'User not found' })).toBe(generic);
    // AuthContext hands a blocked account its message as a translation key.
    expect(platformSignInMessageKey({ message: 'blocked.msg.userSuspended' })).toBe(generic);
    expect(platformSignInMessageKey({})).toBe(generic);
    expect(platformSignInMessageKey(null)).toBe(generic);
    expect(platformSignInMessageKey(undefined)).toBe(generic);
    expect(platformSignInMessageKey({ message: 42 })).toBe(generic);
  });

  it('keeps the two answers that say nothing about an address', () => {
    expect(platformSignInMessageKey({ message: 'Too many requests' })).toBe('admin.login.tooManyAttempts');
    expect(platformSignInMessageKey({ message: 'Request rate limit reached' })).toBe('admin.login.tooManyAttempts');
    expect(platformSignInMessageKey({ message: 'TypeError: Failed to fetch' })).toBe('admin.login.network');
    expect(platformSignInMessageKey({ message: 'NetworkError when attempting to fetch resource' }))
      .toBe('admin.login.network');
  });
});
