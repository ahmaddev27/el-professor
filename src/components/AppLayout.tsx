import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import UserMenu from './UserMenu';
import TrialBanner from './TrialBanner';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import { Sun, Moon } from 'lucide-react';

interface AppLayoutProps {
  isSupportAdmin: boolean;
}

const AppLayout: React.FC<AppLayoutProps> = ({ isSupportAdmin }) => {
  const { toggleTheme, isDark } = useTheme();
  const { t } = useTranslation();

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <Sidebar isSupportAdmin={isSupportAdmin} />

      <div className="lg:pl-64">
        <TrialBanner />
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
            </div>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              <UserMenu />
            </div>
          </div>
        </header>

        <main className="p-5 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
