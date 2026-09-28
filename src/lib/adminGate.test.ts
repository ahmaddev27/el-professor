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
  tenantAccessGate,
  type AdminGateState,
  type PlatformAccountRouteState,
  type PlatformSessionState,
  type TenantAccessState,
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

describe('tenantAccessGate', () => {
  /** An ordinary company user of a healthy company. */
  const COMPANY_USER: TenantAccessState = {
    isSuperAdmin: false,
    hasCompany: true,
    profileStatus: 'active',
    companyStatus: 'active',
    companyApprovalStatus: 'approved',
  };

  /**
   * The gate as App.tsx applied it until 28.09.2026 — the negative control.
   *
   * It is the whole company half of the chain as it stood: one test for
   * `'suspended'`, nothing for any other company state, and no question at all
   * about an account that has no company. Every expectation below that says
   * `oldGate(…)` was `'allow'` is the defect being fixed; every one that says
   * both agree is behaviour that must not move. Restore the old shape and the
   * first group fails.
   */
  const oldGate = (state: TenantAccessState): 'allow' | 'companySuspended' =>
    !state.isSuperAdmin && (state.companyStatus === 'suspended' || state.companyApprovalStatus === 'suspended')
      ? 'companySuspended'
      : 'allow';

  it('lets a company user of an active or trial company into its own app', () => {
    expect(tenantAccessGate(COMPANY_USER)).toBe('allow');
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: 'trial' })).toBe('allow');
    // Unchanged from the old gate, which is the point of the pair.
    expect(oldGate(COMPANY_USER)).toBe('allow');
  });

  /*
    Item 14, as measured on staging on 28.09.2026: one account is a platform
    owner whose `platform_staff` row was disabled, so
    `platform_staff_sync_profile()` cleared `is_super_admin` and left an `active`
    profile with no company and no staff row. Nothing in the chain asked about
    it, so it reached the tenant router, where every query asks for
    `company_id = null`.
  */
  it('blocks the company-less account that is not platform staff', () => {
    const disabledStaff: TenantAccessState = {
      isSuperAdmin: false,
      hasCompany: false,
      profileStatus: 'active',
      companyStatus: null,
      companyApprovalStatus: null,
    };
    expect(tenantAccessGate(disabledStaff)).toBe('noCompany');
    // What it used to get instead.
    expect(oldGate(disabledStaff)).toBe('allow');
  });

  it('blocks an account with no profile row at all, whose status reads as nothing', () => {
    // App.tsx waits on `profileLoaded`, so "no status" here means the query
    // answered with no row — not that it is still running.
    expect(tenantAccessGate({
      isSuperAdmin: false,
      hasCompany: false,
      profileStatus: undefined,
      companyStatus: undefined,
      companyApprovalStatus: undefined,
    })).toBe('noCompany');
  });

  /*
    The window the fix must not catch: `platform-staff` writes a company-less
    `pending_invite` profile before `platform_staff_add` gives it the staff row
    the flag is mirrored from. The gates run above the router, so blocking here
    would put a takeover in front of the invitation being accepted.
  */
  it('lets an invitation in flight through rather than blocking it', () => {
    expect(tenantAccessGate({
      isSuperAdmin: false,
      hasCompany: false,
      profileStatus: 'pending_invite',
      companyStatus: null,
      companyApprovalStatus: null,
    })).toBe('allow');
  });

  /*
    R1. `get_active_company_id()` answers NULL for every company state outside
    active/trial, and `AuthContext.checkProfileAccess` — the sign-in path —
    already refuses all of them. Only the restored-session gate did not, so a
    reload reached the app where a fresh sign-in was refused.
  */
  it('blocks every company state a session may not work in', () => {
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: 'inactive' })).toBe('companyUnusable');
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: 'archived' })).toBe('companyDeleted');
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: 'deleted' })).toBe('companyDeleted');
    // All three used to walk straight into the tenant router.
    for (const companyStatus of ['inactive', 'archived', 'deleted']) {
      expect(oldGate({ ...COMPANY_USER, companyStatus })).toBe('allow');
    }
  });

  it('locks a company state this build has never heard of, rather than opening it', () => {
    // The rule, not a list: a word added to the column by a later migration, and
    // an empty string, both end on a block page.
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: 'frozen' })).toBe('companyUnusable');
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: '' })).toBe('companyUnusable');
    expect(oldGate({ ...COMPANY_USER, companyStatus: 'frozen' })).toBe('allow');
  });

  it('keeps the suspension gate exactly as it was, both arms', () => {
    const suspended = { ...COMPANY_USER, companyStatus: 'suspended' };
    expect(tenantAccessGate(suspended)).toBe('companySuspended');
    expect(oldGate(suspended)).toBe('companySuspended');
    // The rollback arm: a company suspended under the pre-20260919150000
    // convention, where the word sat in approval_status.
    const oldConvention = { ...COMPANY_USER, companyStatus: 'active', companyApprovalStatus: 'suspended' };
    expect(tenantAccessGate(oldConvention)).toBe('companySuspended');
    expect(oldGate(oldConvention)).toBe('companySuspended');
  });

  /*
    AuthContext leaves `companyStatus` null when the `companies` row could not be
    read, and null is an unanswered question rather than a state — the same
    distinction `profileLoaded` exists for. Blocking here would turn one failed
    select into "Zugang gesperrt" with nothing to retry.
  */
  it('treats a company row that could not be read as unanswered, not as refused', () => {
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: null })).toBe('allow');
    expect(tenantAccessGate({ ...COMPANY_USER, companyStatus: undefined })).toBe('allow');
  });

  /*
    Platform staff are not tenants: `platformAccountRoute` decides where they go
    and the database decides what they may do. A platform account carries no
    company of its own, so answering anything but `allow` here would block the
    panel itself — and one whose profile does sit in a company must not be
    blocked by that company's state either, which is how the old gate read too
    (`!isSuperAdmin` on every arm).
  */
  it('leaves platform staff to the panel’s own gate, whatever the company state', () => {
    for (const companyStatus of ['active', 'trial', 'suspended', 'inactive', 'archived', 'deleted', 'frozen', null]) {
      expect(tenantAccessGate({
        isSuperAdmin: true,
        hasCompany: companyStatus !== null,
        profileStatus: 'active',
        companyStatus,
        companyApprovalStatus: 'approved',
      })).toBe('allow');
    }
    expect(tenantAccessGate({
      isSuperAdmin: true,
      hasCompany: false,
      profileStatus: 'active',
      companyStatus: null,
      companyApprovalStatus: null,
    })).toBe('allow');
  });

  /*
    The negative control as a whole: the states the old gate let through, and
    what each answers now. A change that reverts the shape — "test suspended,
    pass everything else" — turns every `not.toBe('allow')` here red.
  */
  it('never answers allow for a shape the old gate let into the tenant router', () => {
    const letThroughBefore: TenantAccessState[] = [
      { isSuperAdmin: false, hasCompany: false, profileStatus: 'active', companyStatus: null, companyApprovalStatus: null },
      { ...COMPANY_USER, companyStatus: 'inactive' },
      { ...COMPANY_USER, companyStatus: 'archived' },
      { ...COMPANY_USER, companyStatus: 'deleted' },
      { ...COMPANY_USER, companyStatus: 'frozen' },
    ];
    for (const state of letThroughBefore) {
      expect(oldGate(state)).toBe('allow');
      expect(tenantAccessGate(state)).not.toBe('allow');
    }
  });
});
