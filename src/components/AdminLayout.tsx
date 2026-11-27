import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { Sun, Moon, ShieldAlert, RefreshCw } from 'lucide-react';
import AdminSidebar from './AdminSidebar';
import SupportSessionBar from './SupportSessionBar';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { TENANT_HOME, decideAdminGate } from '../lib/adminGate';

/**
 * Shell for the platform administration area.
 *
 * Kept entirely separate from AppLayout: the company-facing shell renders no
 * platform navigation at all, and this one renders no company navigation. The
 * profile flag only routes an account here; whether it may use the panel is
 * platform_whoami(), which reads app_private.platform_staff.
 *
 * This is a UI boundary, not a security boundary. What a platform account may
 * actually read and write is enforced by RLS and by the SECURITY DEFINER RPCs.
 */
const AdminLayout: React.FC = () => {
  const { toggleTheme, isDark } = useTheme();
  const { t } = useTranslation();
  const { isSuperAdmin, signOut } = useAuth();
  const { platformAccessStatus, isPlatformStaff, reloadPlatformAccess } = useSuperAdmin();

  // One decision, taken in a pure function the tests cover: the panel opens
  // only for an account platform_whoami() reports an active role for, and an
  // unanswered question is never read as permission.
  const gate = decideAdminGate({ isSuperAdmin, platformAccessStatus, hasPlatformRole: isPlatformStaff });

  if (gate === 'notPlatform') {
    return <Navigate to={TENANT_HOME} replace />;
  }

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Same frame as AppLayout: the canvas and its glow show through, a floating
  // glass sidebar, a glass sheet under a sticky glass topbar. Inline styles and
  // `var(--…)` colours are token classes now.
  if (gate === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center font-ui">
        <div className="text-center">
          <RefreshCw size={22} className="mx-auto mb-3 text-fg-subtle motion-safe:animate-spin" />
          <p className="text-sm text-fg-subtle">{t('admin.access.checking')}</p>
        </div>
      </div>
    );
  }

  if (gate === 'accessUnknown' || gate === 'noRole') {
    const failed = gate === 'accessUnknown';
    return (
      <div className="flex min-h-screen items-center justify-center p-4 font-ui">
        <div className="glass-card w-full max-w-md space-y-4 rounded-surface p-6 text-center">
          <ShieldAlert size={28} className="mx-auto text-caution" />
          <h1 className="text-lg font-semibold text-fg">
            {t(failed ? 'admin.access.errorTitle' : 'admin.access.noneTitle')}
          </h1>
          <p className="text-sm text-fg-muted">
            {t(failed ? 'admin.access.errorBody' : 'admin.access.noneBody')}
          </p>
          <div className="flex justify-center gap-2">
            {failed && (
              <button
                onClick={reloadPlatformAccess}
                className="rounded-control bg-brand-gradient px-4 py-2 text-sm font-semibold text-brand-fg shadow-brand transition-colors hover:bg-brand-gradient-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t('admin.access.retry')}
              </button>
            )}
            <button
              onClick={() => { void signOut(); }}
              className="rounded-control border border-line-strong px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {t('common.logout')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh font-ui text-fg lg:flex">
      <AdminSidebar />

      <div className="min-w-0 flex-1 lg:py-[10px] lg:pe-[10px]">
       <div className="glass-sheet min-h-dvh rounded-none border-0 lg:min-h-[calc(100dvh-20px)] lg:overflow-clip lg:rounded-pane lg:border">
        {/* A session opened from the panel stays visible in the panel: the
            sixty minutes run whether or not anyone is inside the company, and
            "Beenden" has to be reachable from where it was started. */}
        <SupportSessionBar />
        <header className="glass-topbar sticky top-0 z-20 h-[60px] lg:rounded-t-pane">
          <div className="flex h-full items-center justify-between ps-16 pe-4 sm:pe-6 lg:ps-6 lg:pe-5">
            <div className="flex items-center gap-3">
              <button
                onClick={toggleTheme}
                className="rounded-control border border-line bg-sunken p-2 text-fg-muted transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                title={isDark ? t('shell.themeToLight') : t('shell.themeToDark')}
              >
                {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <span
                className="rounded-control border border-caution/30 bg-caution-soft px-2.5 py-1 text-[11px] font-semibold text-caution shadow-hi"
              >
                {t('admin.badge')}
              </span>
            </div>
            <LanguageSwitcher />
          </div>
        </header>

        <main className="page-settle mx-auto w-full max-w-[1440px] px-4 pb-12 pt-5 min-[960px]:px-8 min-[960px]:pb-14 min-[960px]:pt-7">
          <Outlet />
        </main>
       </div>
      </div>
    </div>
  );
};

export default AdminLayout;
