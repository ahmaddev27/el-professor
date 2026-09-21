import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from 'react-router-dom';
import './fakeFetch';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import { ToastProvider } from '../../src/contexts/ToastContext';
import EnvironmentBanner from '../../src/components/EnvironmentBanner';
import AppLayout from '../../src/components/AppLayout';
import LoginForm from '../../src/components/LoginForm';
import ForgotPasswordPage from '../../src/pages/ForgotPasswordPage';
import VerifyEmailPage from '../../src/pages/VerifyEmailPage';
import SetPasswordPage from '../../src/pages/SetPasswordPage';
import InviteAcceptPage from '../../src/pages/InviteAcceptPage';
import SignupPage from '../../src/pages/SignupPage';
import CompleteRegistrationPage from '../../src/pages/CompleteRegistrationPage';
import AuthCallbackPage from '../../src/pages/AuthCallbackPage';
import AccountBlockedPage from '../../src/pages/AccountBlockedPage';
import PendingApprovalPage from '../../src/pages/PendingApprovalPage';
import RejectedPage from '../../src/pages/RejectedPage';
import CompanySuspendedPage from '../../src/pages/CompanySuspendedPage';
import UsersPage from '../../src/pages/UsersPage';
import RolesPage from '../../src/pages/RolesPage';
import SettingsPage from '../../src/pages/SettingsPage';
import ActivationPage from '../../src/pages/ActivationPage';
import CompanyBillingPage from '../../src/pages/CompanyBillingPage';
import '../../src/index.css';
import { applyStoredPreferences, HARNESS_EMAIL, scenario } from './scenario';

/**
 * The batch-4 screens as App.tsx mounts them: the signed-out screens and the
 * account takeovers as full pages of their own, the company screens inside the
 * production AppLayout. App.tsx itself is not mounted — its gates need the real
 * contexts — so each screen is placed where App would place it, and the staging
 * banner is the real EnvironmentBanner, drawn when the scenario says `env=staging`
 * (see vite.config.ts for how VITE_DEPLOY_ENV reaches it).
 */

applyStoredPreferences();

const ENTRIES: Record<typeof scenario.screen, InitialEntry> = {
  login: '/login',
  forgot: '/auth/forgot-password',
  // Opened from the sign-in form's "confirm your address" button: the address
  // travels in router state and no code has been sent yet.
  'verify-email': { pathname: '/auth/verify-email', state: { email: HARNESS_EMAIL } },
  'set-password': '/auth/set-password',
  // Opened from the invitation mail, whose button carries the address.
  invite: { pathname: '/einladung', hash: '#email=katarzyna.nowak%40example.com' },
  signup: '/signup',
  'complete-registration': '/auth/callback',
  callback: '/auth/callback',
  blocked: '/overview',
  pending: '/overview',
  rejected: '/overview',
  suspended: '/overview',
  users: '/users',
  roles: '/roles',
  settings: '/settings',
  activation: '/abo-aktivieren',
  billing: '/billing',
};

/** Where a screen navigated to, for flows-batch4.mjs; App would show the next screen here. */
function Elsewhere() {
  const location = useLocation();
  return (
    <p data-harness-location={location.pathname} className="p-6 font-ui text-sm text-fg">
      {location.pathname}
    </p>
  );
}

function Screen() {
  switch (scenario.screen) {
    case 'complete-registration':
      return <CompleteRegistrationPage />;
    case 'blocked':
      return <AccountBlockedPage reason="user_deactivated" />;
    case 'pending':
      return <PendingApprovalPage />;
    case 'rejected':
      return <RejectedPage />;
    case 'suspended':
      return <CompanySuspendedPage />;
    default:
      return (
        <Routes>
          <Route path="/login" element={<LoginForm />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
          <Route path="/auth/set-password" element={<SetPasswordPage />} />
          <Route path="/einladung" element={<InviteAcceptPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/" element={<AppLayout isSupportAdmin={scenario.role === 'admin'} />}>
            <Route path="users" element={<UsersPage />} />
            <Route path="roles" element={<RolesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="abo-aktivieren" element={<ActivationPage />} />
            <Route path="aktivierung" element={<ActivationPage />} />
            <Route path="billing" element={<CompanyBillingPage />} />
            <Route path="*" element={<Elsewhere />} />
          </Route>
          <Route path="*" element={<Elsewhere />} />
        </Routes>
      );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <ToastProvider>
          <EnvironmentBanner />
          <MemoryRouter initialEntries={[ENTRIES[scenario.screen]]}>
            <Screen />
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>,
);
