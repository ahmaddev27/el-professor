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

  if (gate === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <RefreshCw size={22} className="animate-spin mx-auto mb-3" style={{ color: 'var(--text-tertiary)' }} />
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('admin.access.checking')}</p>
        </div>
      </div>
    );
  }

  if (gate === 'accessUnknown' || gate === 'noRole') {
    const failed = gate === 'accessUnknown';
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg-base)' }}>
        <div
          className="w-full max-w-md rounded-2xl p-6 space-y-4 text-center"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        >
          <ShieldAlert size={28} className="mx-auto" style={{ color: 'var(--warning)' }} />
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t(failed ? 'admin.access.errorTitle' : 'admin.access.noneTitle')}
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t(failed ? 'admin.access.errorBody' : 'admin.access.noneBody')}
          </p>
          <div className="flex justify-center gap-2">
            {failed && (
              <button
                onClick={reloadPlatformAccess}
                className="px-4 py-2 rounded-xl text-sm font-semibold"
                style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
              >
                {t('admin.access.retry')}
              </button>
            )}
            <button
              onClick={() => { void signOut(); }}
              className="px-4 py-2 rounded-xl text-sm font-medium"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {t('common.logout')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <AdminSidebar />

      <div className="lg:pl-64">
        {/* A session opened from the panel stays visible in the panel: the
            sixty minutes run whether or not anyone is inside the company, and
            "Beenden" has to be reachable from where it was started. */}
        <SupportSessionBar />
        <header
          className="sticky top-0 z-20 border-b"
          style={{
            background: 'var(--bg-surface)',
            borderColor: 'var(--border)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div className="px-6 py-3 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg transition-all duration-200 hover:opacity-80"
                style={{
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                }}
                title={isDark ? t('shell.themeToLight') : t('shell.themeToDark')}
              >
                {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <span
                className="px-2.5 py-1 rounded-lg text-[11px] font-semibold"
                style={{
                  background: 'var(--warning-subtle)',
                  border: '1px solid var(--warning)',
                  color: 'var(--warning)',
                }}
              >
                {t('admin.badge')}
              </span>
            </div>
            <LanguageSwitcher />
          </div>
        </header>

        <main className="p-5 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AdminLayout;
