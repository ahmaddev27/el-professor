import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Menu, PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Button } from './Button';
import { Sheet, SheetContent, SheetTitle } from './Dialog';
import { Tooltip } from './Tooltip';
import { cn } from './cn';

/**
 * The application frame: grouped sidebar, top bar, content column.
 *
 * One shell for both the company app and the platform panel; each passes its
 * own navigation. On large screens the sidebar is fixed and can collapse to an
 * icon rail; below that it becomes a drawer opened from the top bar.
 *
 * Not wired into AppLayout or AdminLayout yet. Phase 5 replaces them with this.
 */

export interface AppShellNavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** Match the path exactly, for an index route. */
  end?: boolean;
  badge?: ReactNode;
}

export interface AppShellNavGroup {
  id: string;
  /** Omitted for the first, unlabelled group. */
  label?: string;
  items: AppShellNavItem[];
}

export interface AppShellProps {
  navGroups: AppShellNavGroup[];
  /** Where the logo links to. */
  homeTo: string;
  /** Left side of the top bar: the current company, a breadcrumb. */
  topBarStart?: ReactNode;
  /** Right side of the top bar: theme, language, account. */
  topBarEnd?: ReactNode;
  /** Bottom of the sidebar; receives whether the rail is collapsed. */
  sidebarFooter?: (collapsed: boolean) => ReactNode;
  /** A full-width notice between the top bar and the page. */
  notice?: ReactNode;
  children: ReactNode;
}

const COLLAPSED_STORAGE_KEY = 'ya-shell-collapsed';

/** Tailwind's `lg`, where the fixed sidebar replaces the drawer. */
const DESKTOP_QUERY = '(min-width: 1024px)';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // A remembered sidebar width is a convenience; the shell works without it.
  }
}

function BrandLockup({ collapsed }: { collapsed: boolean }) {
  return (
    <>
      <img src="/brand/mark-on-light.png" alt="" className="h-8 w-auto dark:hidden" />
      <img src="/brand/mark-on-dark.png" alt="" className="hidden h-8 w-auto dark:block" />
      {collapsed ? (
        <span className="sr-only">El-Professor</span>
      ) : (
        <>
          <img src="/brand/wordmark-on-light.png" alt="El-Professor" className="h-[17px] w-auto dark:hidden" />
          <img src="/brand/wordmark-on-dark.png" alt="El-Professor" className="hidden h-[17px] w-auto dark:block" />
        </>
      )}
    </>
  );
}

function NavItemLink({ item, collapsed, onNavigate }: { item: AppShellNavItem; collapsed: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-3 rounded-control text-sm font-medium transition-colors [@media(pointer:coarse)]:h-11',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
          collapsed ? 'justify-center' : 'px-3',
          isActive ? 'bg-brand-soft text-brand-text' : 'text-fg-muted hover:bg-sunken hover:text-fg',
        )
      }
    >
      <Icon aria-hidden className="size-[18px] shrink-0" />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
      {!collapsed && item.badge ? <span className="ml-auto">{item.badge}</span> : null}
    </NavLink>
  );

  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

interface SidebarProps {
  navGroups: AppShellNavGroup[];
  homeTo: string;
  collapsed: boolean;
  footer?: ReactNode;
  collapseToggle?: ReactNode;
  onNavigate?: () => void;
}

function SidebarContents({ navGroups, homeTo, collapsed, footer, collapseToggle, onNavigate }: SidebarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <NavLink
        to={homeTo}
        onClick={onNavigate}
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b border-line',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
          collapsed ? 'justify-center' : 'px-4',
        )}
      >
        <BrandLockup collapsed={collapsed} />
      </NavLink>

      <nav aria-label={t('ui.shell.mainNavigation')} className="flex-1 overflow-y-auto px-2 py-3">
        {navGroups.map((group, index) => (
          <div key={group.id} className={cn(index > 0 && 'mt-5')}>
            {group.label && !collapsed ? (
              <p id={`nav-group-${group.id}`} className="px-3 pb-1.5 text-xs font-semibold text-fg-subtle">
                {group.label}
              </p>
            ) : null}
            {group.label && collapsed ? <div aria-hidden className="mx-3 mb-3 h-px bg-line" /> : null}
            <ul
              className="grid gap-0.5"
              aria-labelledby={group.label && !collapsed ? `nav-group-${group.id}` : undefined}
              aria-label={group.label && collapsed ? group.label : undefined}
            >
              {group.items.map(item => (
                <li key={item.id}>
                  <NavItemLink item={item} collapsed={collapsed} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {footer || collapseToggle ? (
        <div className="shrink-0 border-t border-line p-2">
          {footer}
          {collapseToggle}
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({ navGroups, homeTo, topBarStart, topBarEnd, sidebarFooter, notice, children }: AppShellProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(current => {
      writeCollapsed(!current);
      return !current;
    });
  }, []);

  // The drawer only exists below the lg breakpoint. A tablet turned to
  // landscape with the drawer open would otherwise keep its scrim over a page
  // that already shows the fixed sidebar.
  useEffect(() => {
    if (!drawerOpen) return;
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setDrawerOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, [drawerOpen]);

  const collapseLabel = collapsed ? t('ui.shell.expandSidebar') : t('ui.shell.collapseSidebar');
  const collapseButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleCollapsed}
      aria-label={collapsed ? collapseLabel : undefined}
      className={cn('mt-1 w-full font-medium', collapsed ? 'px-0' : 'justify-start')}
    >
      {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
      {collapsed ? null : <span>{collapseLabel}</span>}
    </Button>
  );

  return (
    <div className="min-h-dvh bg-canvas font-ui text-fg">
      <a
        href="#app-shell-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-control focus:bg-overlay focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-overlay"
      >
        {t('ui.shell.skipToContent')}
      </a>

      {/* Below the staging banner when there is one; see EnvironmentBanner. */}
      <aside
        className={cn(
          'fixed bottom-0 left-0 top-[var(--env-banner-height,0px)] z-40 hidden border-r border-line bg-raised lg:block',
          'motion-safe:transition-[width] motion-safe:duration-200',
          collapsed ? 'w-[4.5rem]' : 'w-64',
        )}
      >
        <SidebarContents
          navGroups={navGroups}
          homeTo={homeTo}
          collapsed={collapsed}
          footer={sidebarFooter?.(collapsed)}
          collapseToggle={collapsed ? <Tooltip content={collapseLabel} side="right">{collapseButton}</Tooltip> : collapseButton}
        />
      </aside>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" aria-describedby={undefined} className="lg:hidden">
          <SheetTitle className="sr-only">{t('ui.shell.mainNavigation')}</SheetTitle>
          <SidebarContents
            navGroups={navGroups}
            homeTo={homeTo}
            collapsed={false}
            footer={sidebarFooter?.(false)}
            onNavigate={() => setDrawerOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <div
        className={cn(
          'flex min-h-dvh flex-col motion-safe:transition-[padding] motion-safe:duration-200',
          collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-64',
        )}
      >
        <header className="sticky top-[var(--env-banner-height,0px)] z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas px-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={t('ui.shell.openNavigation')}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">{topBarStart}</div>
          {topBarEnd ? <div className="flex shrink-0 items-center gap-1">{topBarEnd}</div> : null}
        </header>

        {notice}

        <main id="app-shell-main" tabIndex={-1} className="flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
