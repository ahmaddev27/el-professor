import React, { Suspense, lazy } from 'react';
import { AlertCircle } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { CompanySettingsProvider } from './contexts/CompanySettingsContext';
import { SuperAdminProvider, useSuperAdmin } from './contexts/SuperAdminContext';
import { PlanProvider, usePlan, FeatureKey } from './contexts/PlanContext';
import AppLayout from './components/AppLayout';
import LockedFeaturePage from './components/LockedFeaturePage';
import LoginForm from './components/LoginForm';
import LandingPage from './pages/LandingPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import SetPasswordPage from './pages/SetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import InviteAcceptPage from './pages/InviteAcceptPage';
import SignupPage from './pages/SignupPage';
import CompleteRegistrationPage from './pages/CompleteRegistrationPage';
import OverviewPage from './pages/OverviewPage';
import AccountPage from './pages/AccountPage';
import BelegePage from './pages/BelegePage';
import FahrerPage from './pages/FahrerPage';
import CarsPage from './pages/CarsPage';
import UmsaetzePage from './pages/UmsaetzePage';
import FixkostenPage from './pages/FixkostenPage';
import SalariesPage from './pages/SalariesPage';
import BargeldbestandPage from './pages/BargeldbestandPage';
import WerkstattPage from './pages/WerkstattPage';
import { AbrechnungPage } from './pages/AbrechnungPage';
import { NotesPage } from './pages/NotesPage';
import UsersPage from './pages/UsersPage';
import RolesPage from './pages/RolesPage';
import DocumentsPage from './pages/DocumentsPage';
import StundennachweisPage from './pages/StundennachweisPage';
import SettingsPage from './pages/SettingsPage';
import CompaniesPage from './pages/CompaniesPage';
import SuperAdminDashboard from './pages/SuperAdminDashboard';
import NotificationsPage from './pages/NotificationsPage';
import CompanyPlannerPage from './pages/CompanyPlannerPage';
import SubscriptionBillingPage from './pages/SubscriptionBillingPage';
import CompanyBillingPage from './pages/CompanyBillingPage';
import AbnahmeDiagnosticPage from './pages/AbnahmeDiagnosticPage';
import PlatformDirectoriesPage from './pages/PlatformDirectoriesPage';
import PlatformAuditPage from './pages/PlatformAuditPage';
import PlatformSettingsPage from './pages/PlatformSettingsPage';
import PlatformTeamPage from './pages/PlatformTeamPage';
import PendingApprovalPage from './pages/PendingApprovalPage';
import RejectedPage from './pages/RejectedPage';
import CompanySuspendedPage from './pages/CompanySuspendedPage';
import ActivationPage from './pages/ActivationPage';
import AccountBlockedPage from './pages/AccountBlockedPage';
import AdminLayout from './components/AdminLayout';
import { useTranslation } from './contexts/LanguageContext';
import type { TranslationKey } from './i18n';
import PlatformLoginPage from './pages/PlatformLoginPage';
import { isDesignPreviewPath } from './design-preview/gate';
import { needsCompanyRegistration } from './lib/googleAccount';
import {
  ADMIN_BASE,
  ADMIN_LOGIN_PATH,
  LEGACY_ADMIN_BASE,
  legacyAdminTarget,
  platformEntry,
  platformEntryPath,
  platformReturnPath,
} from './lib/adminGate';

// ─── Design preview (Phase 2 prototype) ──────────────────────────────────────
// The new design on invented data, for the owner to approve before any screen
// moves over. __DESIGN_PREVIEW__ is false in production builds (vite.config.ts),
// which folds this to null and leaves the preview's code out of the bundle.
// Nothing links to it; it is reached by typing /design-preview.
const DesignPreviewApp = __DESIGN_PREVIEW__ ? lazy(() => import('./design-preview/DesignPreviewApp')) : null;

// ─── Plan-gated route wrapper ─────────────────────────────────────────────────

// The name LockedFeaturePage puts in "X is not included in your plan", as
// translation keys — the map is module-level and cannot call t() itself.
// Werkstatt, Abrechnung, Stundennachweis and Trinkgeld Quittung resolve to
// themselves in English: they are the domain vocabulary listed in i18n/index.ts,
// and the locked screen has to name the feature the way the nav does.
const FEATURE_LABEL_KEYS: Partial<Record<FeatureKey, TranslationKey>> = {
  werkstatt:            'nav.werkstatt',
  abrechnung:           'nav.abrechnung',
  notizen:              'nav.notes',
  rollen_nutzer:        'locked.feature.rollenNutzer',
  benachrichtigungen:   'nav.notifications',
  gehaelter:            'nav.salaries',
  dokumente:            'nav.documents',
  trinkgeld_quittung:   'locked.feature.trinkgeld',
  stundennachweis:      'locked.feature.stundennachweis',
};

const PlanGate: React.FC<{ feature: FeatureKey; children: React.ReactNode }> = ({ feature, children }) => {
  // The plan a feature needs comes from the database's feature map (plan 3.9),
  // through PlanContext, so the locked screen names the same plan the gate used.
  const { can, minPlanFor } = usePlan();
  const { t } = useTranslation();
  if (can(feature)) return <>{children}</>;
  const labelKey = FEATURE_LABEL_KEYS[feature];
  return (
    <LockedFeaturePage
      featureName={labelKey ? t(labelKey) : feature}
      requiredPlan={minPlanFor(feature)}
    />
  );
};

// ─── Must-change-password guard (must live inside BrowserRouter) ────────────
// If an authenticated user has must_change_password=true, block all routes
// except the password-change page and logout. Redirect to /set-new-password.

const PASSWORD_CHANGE_ALLOWED_PATHS = ['/set-new-password'];

const MustChangePasswordGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { mustChangePassword } = useAuth();
  const location = useLocation();

  if (mustChangePassword && !PASSWORD_CHANGE_ALLOWED_PATHS.includes(location.pathname)) {
    return <Navigate to="/set-new-password" replace />;
  }

  return <>{children}</>;
};

// ─── Subscription guard (must live inside BrowserRouter) ─────────────────────
// Redirects to /abo-aktivieren when an approved company's subscription is inactive.
// Allows through: activation page, billing page, and auth routes.

const SUBSCRIPTION_ALLOWED_PATHS = ['/abo-aktivieren', '/aktivierung', '/billing'];

const SubscriptionGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isSuperAdmin, companyApprovalStatus, isSubscriptionActive, profile } = useAuth();
  const location = useLocation();

  if (
    !isSuperAdmin &&
    companyApprovalStatus === 'approved' &&
    !!profile?.company_id &&
    !isSubscriptionActive &&
    !SUBSCRIPTION_ALLOWED_PATHS.includes(location.pathname)
  ) {
    return <Navigate to="/abo-aktivieren" replace />;
  }

  return <>{children}</>;
};

/**
 * A super admin is a platform account, not a tenant.
 *
 * Detached from a company, its `effectiveCompanyId` is null until it enters
 * one — and every tenant screen then queries `company_id = null`. PostgREST
 * serialises that as the string "null", so Postgres answers
 *
 *   invalid input syntax for type uuid: "null"
 *
 * as a banner over zeroed figures on a page that has already rendered.
 *
 * Sending the account to the platform panel is not a workaround for that
 * error, it is the model: a super admin reaches a company's screens by
 * entering it from /admin, which sets effectiveCompanyId, and the same
 * screens then work against that company.
 *
 * Outermost of the three guards, so it settles the question before
 * SubscriptionGuard can route a company-less account to /abo-aktivieren.
 */
/**
 * Where a company-less platform account goes instead of a tenant path.
 *
 * `/mein-konto` used to be let through this guard, which kept the account on a
 * route registered inside AppLayout: the company sidebar, with fourteen tenant
 * screens the account can never open, wrapped around a page that said it had no
 * company. The account page itself is not the problem — AccountPage reads only
 * the caller's own record (no company settings, no plan, no company id) — so it
 * is registered a second time at `/admin/konto`, under AdminLayout, where
 * it renders identically inside the shell the account actually belongs to.
 *
 * The old path stays a working bookmark by redirecting here rather than falling
 * through to the dashboard, which would silently drop whoever followed it.
 */
const PLATFORM_ACCOUNT_REDIRECTS: Record<string, string> = {
  '/mein-konto': '/admin/konto',
};

const PlatformAccountGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isSuperAdmin } = useAuth();
  const { effectiveCompanyId } = useSuperAdmin();
  const location = useLocation();

  // Only a platform account that has not entered a company: a super admin who
  // has entered one keeps using /mein-konto in that company's shell, and a
  // company user never reaches this branch at all.
  if (isSuperAdmin && !effectiveCompanyId) {
    return <Navigate to={PLATFORM_ACCOUNT_REDIRECTS[location.pathname] ?? ADMIN_BASE} replace />;
  }

  return <>{children}</>;
};

/** The full-page spinner shown while the session, or its profile, is still being read. */
const AuthLoadingScreen: React.FC = () => (
  <div className="min-h-screen bg-[#060a0f] flex items-center justify-center">
    <div className="text-center">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-400 mx-auto mb-4" />
      <p className="text-white/40 text-sm">Wird geladen...</p>
    </div>
  </div>
);

/**
 * `/admin/login` — the platform team's own front door (plan slice 3.6a).
 *
 * Registered in both routers, because it has to answer for a browser with no
 * session and for one that has just acquired a session on this very page:
 * signing in swaps App's public router for the authenticated one, which starts
 * at whatever the address bar still says. Deciding here, rather than with a
 * navigate() inside the form, is what keeps that redirect out of the router
 * being unmounted — the same reason useOtpSessionHandoff rewrites the address
 * before it installs a session.
 *
 * Who goes where is `platformEntry()`, kept pure and covered by tests.
 */
const AdminLoginRoute: React.FC = () => {
  const { user, profileLoaded, loading, isSuperAdmin } = useAuth();
  const location = useLocation();
  const entry = platformEntry({
    authLoading: loading,
    hasSession: !!user,
    profileLoaded,
    isSuperAdmin,
  });

  if (entry === 'loading') return <AuthLoadingScreen />;
  if (entry === 'signIn') return <PlatformLoginPage />;

  // Back to the page the visitor asked for before signing in, when there was
  // one and it is a panel path — `platformReturnPath` is where that is decided.
  // Only for an account the panel is actually for: a company user has no
  // business at /admin/protokoll, so it goes to its own app whatever the
  // browser remembers.
  const state = location.state as { from?: unknown } | null;
  const returnTo = entry === 'panel' ? platformReturnPath(state?.from) : null;

  // A company user that signs in here belongs in its own app, not in a shell
  // with nothing it may open. Refusing it a session instead would be a
  // permission notion of the browser's own invention: what any account may
  // actually do is decided in the database, on every call.
  return <Navigate to={returnTo ?? platformEntryPath(entry) ?? ADMIN_BASE} replace />;
};

/**
 * `/super-admin/*` — the panel's previous entry, until plan slice 3.13.
 *
 * The panel is registered once, under `/admin`, and every old path is rewritten
 * onto it here. So a bookmark, and the in-app links that still say
 * `/super-admin` (the company sidebar, the user menu, the overview card and the
 * platform dashboard's own links), reach exactly the screen they always did,
 * and there is no second copy of the routes that could drift from the first.
 */
const LegacyAdminRedirect: React.FC = () => {
  const location = useLocation();
  const target = legacyAdminTarget(location.pathname) ?? ADMIN_BASE;
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
};

/**
 * A platform path asked for without a session: the sign-in page, remembering
 * where the visitor was going.
 *
 * It answers for the old entry as well as the new one, and that is the case the
 * front door exists for — signed out is exactly when a `/super-admin` bookmark
 * gets followed, and without this it lands on the marketing landing page
 * through the public catch-all.
 *
 * The remembered path travels in the router's own location state rather than in
 * the query string, so it never appears in the address bar. It is not trusted
 * on the way back: `platformReturnPath` validates it.
 */
const PlatformSignInRedirect: React.FC = () => {
  const location = useLocation();
  const intended = legacyAdminTarget(location.pathname) ?? location.pathname;
  const from = platformReturnPath(intended);
  return <Navigate to={ADMIN_LOGIN_PATH} state={from ? { from } : undefined} replace />;
};

/**
 * The profile never answered, after the bounded retries in AuthContext.
 *
 * The gate above stays closed — a profile that did not load must never be read
 * as an account without one — so this is what keeps that from being an
 * indefinite spinner: nothing else reloads the profile until a token refresh or
 * a page reload, which can be an hour away.
 */
const ProfileUnavailableScreen: React.FC<{ onRetry: () => void; onSignOut: () => void }> = ({ onRetry, onSignOut }) => {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7">
        <div className="w-12 h-12 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="text-amber-400" size={22} aria-hidden="true" />
        </div>
        <h2 className="text-white font-semibold mb-2">{t('profile.unavailable.title')}</h2>
        <p className="text-white/60 text-sm leading-relaxed mb-6">{t('profile.unavailable.body')}</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onRetry}
            className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm"
          >
            {t('profile.unavailable.retry')}
          </button>
          <button
            onClick={onSignOut}
            className="w-full text-white/50 hover:text-white/80 text-sm py-2 transition-colors"
          >
            {t('common.logout')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const { user, profile, profileLoaded, profileLoadFailed, refreshProfile, signOut, loading: authLoading, isAdmin, isSuperAdmin, companyApprovalStatus, userBlockReason } = useAuth();

  // Ahead of every gate: the preview reads no account or tenant data, and it
  // has to render for a reviewer whatever their session state is.
  if (DesignPreviewApp && isDesignPreviewPath(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <DesignPreviewApp />
      </Suspense>
    );
  }

  if (authLoading) {
    return <AuthLoadingScreen />;
  }

  if (!user) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginForm />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/auth/set-password" element={<SetPasswordPage />} />
          <Route path="/set-new-password" element={<SetPasswordPage />} />
          <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
          <Route path="/einladung" element={<InviteAcceptPage />} />
          <Route path="/signup" element={<SignupPage />} />
          {/* The platform team signs in here, not through the company login.
              Anything else under /admin without a session lands on it: the
              panel is never rendered for a browser that has no account at all.
              The old entry answers here too — signed out is exactly when a
              /super-admin bookmark is followed, and the public catch-all below
              would otherwise drop it on the landing page. */}
          <Route path={ADMIN_LOGIN_PATH} element={<AdminLoginRoute />} />
          <Route path={`${ADMIN_BASE}/*`} element={<PlatformSignInRedirect />} />
          <Route path={`${LEGACY_ADMIN_BASE}/*`} element={<PlatformSignInRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }

  // Every gate below reads the profile, and a null one means two different
  // things: the query has not answered yet (or failed), or this account has no
  // row. Waiting here is what keeps the first from being read as the second —
  // one failed profile load after a Google redirect otherwise fell past the
  // registration gate and the approval gates into the tenant router, with no
  // company at all. The gates themselves are unchanged, and in the ordinary
  // case the profile is already loaded when `authLoading` clears.
  if (!profileLoaded) {
    // Retrying clears the failure in AuthContext, so this falls back to the
    // spinner while the next attempts run.
    return profileLoadFailed
      ? <ProfileUnavailableScreen onRetry={() => { void refreshProfile(); }} onSignOut={() => { void signOut(); }} />
      : <AuthLoadingScreen />;
  }

  // Account revocation gate. Runs before the company gates because it is the
  // narrower block: a deactivated user must be stopped even while their company
  // is perfectly healthy. signIn() already refuses these accounts; this catches
  // restored sessions and sessions installed from a one-time code, where
  // signIn() never runs.
  if (userBlockReason) {
    return <AccountBlockedPage reason={userBlockReason} />;
  }

  // A Google account that has registered no company yet (plan 1.6). Ahead of
  // the approval gates because none of them can answer for it: there is no
  // company to be pending, rejected or suspended. Without this the
  // authenticated router would send it to /overview, where every tenant query
  // asks for company_id null and PostgREST sends Postgres the string "null".
  if (needsCompanyRegistration(user, profile)) {
    return <CompleteRegistrationPage />;
  }

  // Approval status gates — only for non-super-admins with a company
  if (!isSuperAdmin && companyApprovalStatus === 'pending') {
    return <PendingApprovalPage />;
  }
  if (!isSuperAdmin && companyApprovalStatus === 'rejected') {
    return <RejectedPage />;
  }
  if (!isSuperAdmin && companyApprovalStatus === 'suspended') {
    return <CompanySuspendedPage />;
  }

  return (
    <CompanySettingsProvider>
      <SuperAdminProvider>
        <PlanProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route path="/auth/set-password" element={<SetPasswordPage />} />
              <Route path="/set-new-password" element={<SetPasswordPage />} />
              <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/einladung" element={<InviteAcceptPage />} />
              {/* Already signed in: the sign-in page sends the account on to
                  the panel, or to its own app when the panel is not for it. */}
              <Route path={ADMIN_LOGIN_PATH} element={<AdminLoginRoute />} />
              <Route path="/" element={
                <PlatformAccountGuard>
                <MustChangePasswordGuard>
                <SubscriptionGuard>
                  <AppLayout isSupportAdmin={isAdmin} />
                </SubscriptionGuard>
                </MustChangePasswordGuard>
                </PlatformAccountGuard>
              }>
                <Route index element={<Navigate to={isSuperAdmin ? ADMIN_BASE : "/overview"} replace />} />
                {/* Activation routes — inside AppLayout so sidebar is visible */}
                <Route path="abo-aktivieren" element={<ActivationPage />} />
                <Route path="aktivierung"    element={<ActivationPage />} />
                {/* Basic features — always accessible */}
                <Route path="mein-konto"     element={<AccountPage />} />
                <Route path="overview"       element={<OverviewPage />} />
                <Route path="belege"         element={<BelegePage />} />
                <Route path="fahrer"         element={<FahrerPage />} />
                <Route path="cars"           element={<CarsPage />} />
                <Route path="umsaetze"       element={<UmsaetzePage />} />
                <Route path="fixkosten"      element={<FixkostenPage />} />
                <Route path="bargeldbestand" element={<BargeldbestandPage />} />
                {/* Advanced features */}
                <Route path="werkstatt"  element={<PlanGate feature="werkstatt"><WerkstattPage /></PlanGate>} />
                <Route path="abrechnung" element={<PlanGate feature="abrechnung"><AbrechnungPage /></PlanGate>} />
                <Route path="notes"              element={<PlanGate feature="notizen"><NotesPage /></PlanGate>} />
                <Route path="benachrichtigungen" element={<PlanGate feature="benachrichtigungen"><NotificationsPage /></PlanGate>} />
                {/* Premium features */}
                <Route path="salaries"       element={<PlanGate feature="gehaelter"><SalariesPage /></PlanGate>} />
                <Route path="dokumente"              element={<PlanGate feature="dokumente"><DocumentsPage /></PlanGate>} />
                <Route path="dokumente/:id"          element={<PlanGate feature="dokumente"><DocumentsPage /></PlanGate>} />
                <Route path="dokumente/:id/bearbeiten" element={<PlanGate feature="dokumente"><DocumentsPage /></PlanGate>} />
                <Route path="stundennachweis" element={<PlanGate feature="dokumente"><StundennachweisPage /></PlanGate>} />
                <Route path="company-planner" element={<PlanGate feature="dokumente"><CompanyPlannerPage /></PlanGate>} />
                {/* Admin-only */}
                {isAdmin && <Route path="users"    element={<PlanGate feature="rollen_nutzer"><UsersPage /></PlanGate>} />}
                {isAdmin && <Route path="roles"    element={<PlanGate feature="rollen_nutzer"><RolesPage /></PlanGate>} />}
                {isAdmin && <Route path="billing"  element={<CompanyBillingPage />} />}
                {isAdmin && <Route path="settings" element={<SettingsPage />} />}
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Route>

              {/* Platform administration — its own shell, with no company
                  navigation, at its own entry since plan slice 3.6a. Registered
                  only for super admins, and AdminLayout re-checks against
                  platform_whoami(), so a direct URL cannot land a tenant user
                  here: for it, /admin falls through to the tenant catch-all
                  above and ends on /overview. */}
              {isSuperAdmin && (
                <Route path={ADMIN_BASE} element={<AdminLayout />}>
                  <Route index                   element={<SuperAdminDashboard />} />
                  <Route path="companies"        element={<CompaniesPage />} />
                  <Route path="billing"          element={<SubscriptionBillingPage />} />
                  <Route path="abnahme-diagnose" element={<AbnahmeDiagnosticPage />} />
                  {/* Each of these checks its own capability again, and every
                      RPC behind them checks it a third time in the database. */}
                  <Route path="verzeichnisse"    element={<PlatformDirectoriesPage />} />
                  <Route path="protokoll"        element={<PlatformAuditPage />} />
                  <Route path="einstellungen"    element={<PlatformSettingsPage />} />
                  <Route path="team"             element={<PlatformTeamPage />} />
                  {/* The same AccountPage the company shell registers. It reads
                      only the caller's own record, so it needs nothing this
                      shell does not provide, and a platform account changes its
                      own name, address and password without being handed a
                      company sidebar it cannot use. Before the catch-all. */}
                  <Route path="konto"            element={<AccountPage />} />
                  <Route path="*" element={<Navigate to={ADMIN_BASE} replace />} />
                </Route>
              )}

              {/* The panel's previous entry. One panel and not two: every
                  /super-admin path is rewritten onto /admin, for a platform
                  account and a company user alike. Plan slice 3.13 removes this
                  together with the links that still point at it. */}
              <Route path={`${LEGACY_ADMIN_BASE}/*`} element={<LegacyAdminRedirect />} />
            </Routes>
          </BrowserRouter>
        </PlanProvider>
      </SuperAdminProvider>
    </CompanySettingsProvider>
  );
}

export default App;
