import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar, { ADMIN_ITEMS, NAV_ITEMS } from './Sidebar';
import UserMenu from './UserMenu';
import AnnouncementBanner from './AnnouncementBanner';
import SupportSessionBar from './SupportSessionBar';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import { Sun, Moon } from 'lucide-react';
import { Button } from './ui';
import { navCrumbKey, type CrumbSource } from '../lib/navCrumb';

/** Every company destination the topbar can name; Mein Konto is reached from the user menu. */
const CRUMB_SOURCES: CrumbSource[] = [
  ...NAV_ITEMS,
  ...ADMIN_ITEMS,
  { path: '/mein-konto', labelKey: 'account.title' },
];

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
  const crumbKey = navCrumbKey(useLocation().pathname, CRUMB_SOURCES);

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  return (
    <div className="min-h-dvh font-ui text-fg lg:flex">
      <Sidebar isSupportAdmin={isSupportAdmin} />

      <div className="min-w-0 flex-1 lg:py-[10px] lg:pe-[10px]">
       <div className="glass-sheet min-h-dvh rounded-none border-0 lg:min-h-[calc(100dvh-20px)] lg:overflow-clip lg:rounded-pane lg:border">
        {/* Whose data this is comes before anything else. It renders nothing
            for a company user. */}
        <SupportSessionBar />
        {/* The platform's announcements for this company (plan 3.11). */}
        <AnnouncementBanner />
        <header className="glass-topbar sticky top-0 z-20 h-[60px] lg:rounded-t-pane">
          {/* Below `lg` the sidebar's menu button is fixed over this row's
              left edge, so the first control starts clear of it. */}
          {/* Reidey's topbar: the section's name at the start, the actions at
              the end (language, theme, account). */}
          <div className="flex h-full items-center justify-between gap-3 ps-16 pe-4 sm:pe-6 lg:ps-6 lg:pe-5">
            <p className="min-w-0 truncate text-sm font-semibold text-fg">
              {crumbKey ? t(crumbKey) : null}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <LanguageSwitcher variant="ui" />
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
              <UserMenu />
            </div>
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

export default AppLayout;
