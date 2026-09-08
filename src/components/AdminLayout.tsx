import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { Sun, Moon } from 'lucide-react';
import AdminSidebar from './AdminSidebar';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import { useAuth } from '../contexts/AuthContext';

/**
 * Shell for the platform administration area.
 *
 * Kept entirely separate from AppLayout: the company-facing shell renders no
 * platform navigation at all, and this one renders no company navigation. The
 * guard below is the second line of defence — the routes themselves are only
 * registered for super admins in App.tsx — so that a stale bundle or a direct
 * URL cannot land a tenant user in here.
 *
 * This is a UI boundary, not a security boundary. What a super admin may
 * actually read and write is enforced by RLS and by the SECURITY DEFINER RPCs.
 */
const AdminLayout: React.FC = () => {
  const { toggleTheme, isDark } = useTheme();
  const { t } = useTranslation();
  const { isSuperAdmin } = useAuth();

  if (!isSuperAdmin) {
    return <Navigate to="/overview" replace />;
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <AdminSidebar />

      <div className="lg:pl-64">
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
