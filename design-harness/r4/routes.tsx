import { Suspense, lazy, useEffect } from 'react';
import { Route } from 'react-router-dom';
import AdminLayout from '../../src/components/AdminLayout';
const SuperAdminDashboard = lazy(() => import('../../src/pages/SuperAdminDashboard'));
const CompaniesPage = lazy(() => import('../../src/pages/CompaniesPage'));
const SubscriptionBillingPage = lazy(() => import('../../src/pages/SubscriptionBillingPage'));
const PlatformTeamPage = lazy(() => import('../../src/pages/PlatformTeamPage'));
const PlatformAuditPage = lazy(() => import('../../src/pages/PlatformAuditPage'));
const PlatformDirectoriesPage = lazy(() => import('../../src/pages/PlatformDirectoriesPage'));
const PlatformSettingsPage = lazy(() => import('../../src/pages/PlatformSettingsPage'));
const PlatformPlansPage = lazy(() => import('../../src/pages/PlatformPlansPage'));
const AbnahmeDiagnosticPage = lazy(() => import('../../src/pages/AbnahmeDiagnosticPage'));
import { supabase } from '../../src/lib/supabase';
import { r4Screen } from './fixtures';

const S = ({ children }: { children: React.ReactNode }) => <Suspense fallback={null}>{children}</Suspense>;

/**
 * The Abnahme page issues no query until a button is pressed, and `settle()` in
 * capture.mjs waits for the first answered one. One harmless read stands in for
 * it; harness-only. A query builder runs only when something calls `then`.
 */
function WithOneRead({ children }: { children: React.ReactNode }) {
  useEffect(() => { void supabase.from('cars').select('id').then(() => undefined); }, []);
  return <>{children}</>;
}

/**
 * Each page loads on its own (`lazy`), so a page another worker has left unparseable
 * mid-edit breaks only its own shots, not the whole batch.
 *
 * The platform panel in the production AdminLayout, registered at `/admin` as
 * App.tsx does. This sits beside the AppLayout route in main.tsx, not inside it:
 * the panel has its own frame.
 */
export const R4_ROUTES = (
  <Route path="/admin" element={<AdminLayout />}>
    <Route index element={<S><SuperAdminDashboard /></S>} />
    <Route path="companies" element={<S><CompaniesPage /></S>} />
    <Route path="billing" element={<S><SubscriptionBillingPage /></S>} />
    <Route path="abnahme-diagnose" element={<S><WithOneRead><AbnahmeDiagnosticPage /></WithOneRead></S>} />
    <Route path="verzeichnisse" element={<S><PlatformDirectoriesPage /></S>} />
    <Route path="protokoll" element={<S><PlatformAuditPage /></S>} />
    <Route path="einstellungen" element={<S><PlatformSettingsPage /></S>} />
    <Route path="plaene" element={<S><PlatformPlansPage /></S>} />
    <Route path="team" element={<S><PlatformTeamPage /></S>} />
  </Route>
);

const ENTRY: Record<string, string> = {
  'r4-dashboard': '/admin',
  'r4-companies': '/admin/companies',
  'r4-billing': '/admin/billing',
  'r4-team': '/admin/team',
  'r4-audit': '/admin/protokoll',
  'r4-directories': '/admin/verzeichnisse',
  'r4-settings': '/admin/einstellungen',
  'r4-plans': '/admin/plaene',
  'r4-abnahme': '/admin/abnahme-diagnose',
};

/** Where the memory router starts on this batch's screens, or undefined on another's. */
export function r4InitialEntry(): string | undefined {
  return r4Screen ? ENTRY[r4Screen] : undefined;
}
