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
import { isDesignPreviewPath } from './design-preview/gate';
import { needsCompanyRegistration } from './lib/googleAccount';

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
 * entering it from /super-admin, which sets effectiveCompanyId, and the same
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
 * is registered a second time at `/super-admin/konto`, under AdminLayout, where
 * it renders identically inside the shell the account actually belongs to.
 *
 * The old path stays a working bookmark by redirecting here rather than falling
 * through to the dashboard, which would silently drop whoever followed it.
 */
const PLATFORM_ACCOUNT_REDIRECTS: Record<string, string> = {
  '/mein-konto': '/super-admin/konto',
};

const PlatformAccountGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isSuperAdmin } = useAuth();
  const { effectiveCompanyId } = useSuperAdmin();
  const location = useLocation();

  // Only a platform account that has not entered a company: a super admin who
  // has entered one keeps using /mein-konto in that company's shell, and a
  // company user never reaches this branch at all.
  if (isSuperAdmin && !effectiveCompanyId) {
    return <Navigate to={PLATFORM_ACCOUNT_REDIRECTS[location.pathname] ?? '/super-admin'} replace />;
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
              <Route path="/" element={
                <PlatformAccountGuard>
                <MustChangePasswordGuard>
                <SubscriptionGuard>
                  <AppLayout isSupportAdmin={isAdmin} />
                </SubscriptionGuard>
                </MustChangePasswordGuard>
                </PlatformAccountGuard>
              }>
                <Route index element={<Navigate to={isSuperAdmin ? "/super-admin" : "/overview"} replace />} />
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
                  navigation. Registered only for super admins, and AdminLayout
                  re-checks, so a direct URL cannot land a tenant user here. */}
              {isSuperAdmin && (
                <Route path="/super-admin" element={<AdminLayout />}>
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
                  <Route path="*" element={<Navigate to="/super-admin" replace />} />
                </Route>
              )}
            </Routes>
          </BrowserRouter>
        </PlanProvider>
      </SuperAdminProvider>
    </CompanySettingsProvider>
  );
}

export default App;
