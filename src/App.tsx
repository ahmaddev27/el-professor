import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { CompanySettingsProvider } from './contexts/CompanySettingsContext';
import { SuperAdminProvider, useSuperAdmin } from './contexts/SuperAdminContext';
import { PlanProvider, usePlan, FeatureKey } from './contexts/PlanContext';
import { FEATURE_MIN_PLAN } from './contexts/PlanContext';
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
import PendingApprovalPage from './pages/PendingApprovalPage';
import RejectedPage from './pages/RejectedPage';
import CompanySuspendedPage from './pages/CompanySuspendedPage';
import ActivationPage from './pages/ActivationPage';
import AccountBlockedPage from './pages/AccountBlockedPage';
import AdminLayout from './components/AdminLayout';
import { useTranslation } from './contexts/LanguageContext';
import type { TranslationKey } from './i18n';
import { isDesignPreviewPath } from './design-preview/gate';

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
  const { can } = usePlan();
  const { t } = useTranslation();
  if (can(feature)) return <>{children}</>;
  const labelKey = FEATURE_LABEL_KEYS[feature];
  return (
    <LockedFeaturePage
      featureName={labelKey ? t(labelKey) : feature}
      requiredPlan={FEATURE_MIN_PLAN[feature]}
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
 * Personal pages a platform account may still reach. `/mein-konto` shows the
 * caller's own record and no tenant data, so the reason to redirect does not
 * apply to it — and without this the super admin would have no way to change
 * its own password from inside the app.
 */
const PLATFORM_ACCOUNT_PATHS = ['/mein-konto'];

const PlatformAccountGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isSuperAdmin } = useAuth();
  const { effectiveCompanyId } = useSuperAdmin();
  const location = useLocation();

  if (isSuperAdmin && !effectiveCompanyId && !PLATFORM_ACCOUNT_PATHS.includes(location.pathname)) {
    return <Navigate to="/super-admin" replace />;
  }

  return <>{children}</>;
};

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const { user, loading: authLoading, isAdmin, isSuperAdmin, companyApprovalStatus, userBlockReason } = useAuth();

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
    return (
      <div className="min-h-screen bg-[#060a0f] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-400 mx-auto mb-4" />
          <p className="text-white/40 text-sm">Wird geladen...</p>
        </div>
      </div>
    );
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

  // Account revocation gate. Runs before the company gates because it is the
  // narrower block: a deactivated user must be stopped even while their company
  // is perfectly healthy. signIn() already refuses these accounts; this catches
  // restored sessions and sessions installed from a one-time code, where
  // signIn() never runs.
  if (userBlockReason) {
    return <AccountBlockedPage reason={userBlockReason} />;
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
