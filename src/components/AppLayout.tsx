import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import UserMenu from './UserMenu';
import TrialBanner from './TrialBanner';
import AnnouncementBanner from './AnnouncementBanner';
import SupportSessionBar from './SupportSessionBar';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import { Sun, Moon } from 'lucide-react';
import { Button } from './ui';

/**
 * The company application frame — phase 5's last conversion.
 *
 * Every converted screen renders inside this, so the page background it paints
 * is the background those screens' headers, tabs and notes were measured
 * against. It is `--canvas` since this change; it was the legacy `--bg-base`
 * before, and the two are the same colour in light and differ by a hair in
 * dark, so no converted screen moves under it.
 *
 * The frame draws and nothing else: the navigation and its permission gate are
 * Sidebar's, the three notices below are their own components', and the staging
 * banner is not a child of this frame at all — EnvironmentBanner is fixed to
 * the viewport and mounted above the router.
 */
interface AppLayoutProps {
  isSupportAdmin: boolean;
}

const AppLayout: React.FC<AppLayoutProps> = ({ isSupportAdmin }) => {
  const { toggleTheme, isDark } = useTheme();
  const { t } = useTranslation();

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  return (
    <div className="min-h-dvh bg-canvas font-ui text-fg">
      <Sidebar isSupportAdmin={isSupportAdmin} />

      <div className="lg:pl-64">
        {/* Above the trial banner on purpose: whose data this is comes before
            anything about that company's own subscription. It renders nothing
            for a company user. */}
        <SupportSessionBar />
        <TrialBanner />
        {/* The platform's announcements for this company (plan 3.11). Below
            the trial banner: the company's own state comes first. */}
        <AnnouncementBanner />
        <header className="sticky top-0 z-20 border-b border-line bg-raised shadow-raised">
          {/* Below `lg` the sidebar's menu button is fixed over this row's
              left edge, so the first control starts clear of it. */}
          <div className="flex items-center justify-between py-3 pl-16 pr-4 sm:pr-6 lg:pl-6">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                title={isDark ? t('shell.themeToLight') : t('shell.themeToDark')}
                aria-label={isDark ? t('shell.themeToLight') : t('shell.themeToDark')}
                className="border border-line bg-sunken"
              >
                {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </Button>
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
