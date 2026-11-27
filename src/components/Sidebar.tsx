import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, FileText, Users, DollarSign, Plus,
  Menu, X, UserCog, Receipt, Wallet, LogOut, Calculator,
  StickyNote, Car, Wrench, Shield, Settings, Bell, CalendarDays, CreditCard, ArrowLeft,
  Database, ListChecks, Download, BookOpen,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { usePlan, FeatureKey } from '../contexts/PlanContext';
import { monthlyPlanInNav } from './navVisibility';
import { moduleEnabledForRoute } from '../lib/companyModules';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { LegalLinks } from './legal/LegalLinks';
import { ADMIN_BASE } from '../lib/adminGate';
import { cn } from './ui';
import { RailTip, RailTipProvider, SidebarToggle, SHELL_SIDEBAR_ID, useSidebarRail } from './ui/sidebarRail';
import { FLEET_IMPORT_PATH } from './partner/FleetImportShortcut';

interface SidebarProps {
  isSupportAdmin: boolean;
}

interface NavItem {
  path: string;
  icon: React.ElementType;
  labelKey: TranslationKey;
  feature: FeatureKey;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/overview',       icon: LayoutDashboard, labelKey: 'nav.overview',       feature: 'overview' },
  { path: '/belege',         icon: FileText,        labelKey: 'nav.belege',         feature: 'belege' },
  { path: '/fahrer',         icon: Users,           labelKey: 'nav.fahrer',         feature: 'fahrer' },
  { path: '/cars',           icon: Car,             labelKey: 'nav.cars',           feature: 'fahrzeuge' },
  { path: '/umsaetze',       icon: Plus,            labelKey: 'nav.umsaetze',       feature: 'umsaetze' },
  { path: '/fixkosten',      icon: Receipt,         labelKey: 'nav.fixkosten',      feature: 'fixkosten' },
  { path: '/bargeldbestand', icon: DollarSign,      labelKey: 'nav.bargeldbestand', feature: 'bargeldbestand' },
  { path: '/werkstatt',      icon: Wrench,          labelKey: 'nav.werkstatt',      feature: 'werkstatt' },
  { path: '/abrechnung',     icon: Calculator,      labelKey: 'nav.abrechnung',     feature: 'abrechnung' },
  { path: '/notes',              icon: StickyNote,  labelKey: 'nav.notes',          feature: 'notizen' },
  { path: '/benachrichtigungen', icon: Bell,        labelKey: 'nav.notifications',  feature: 'benachrichtigungen' },
  { path: '/salaries',           icon: Wallet,      labelKey: 'nav.salaries',       feature: 'gehaelter' },
  { path: '/dokumente',       icon: FileText,       labelKey: 'nav.documents',      feature: 'dokumente' },
  { path: '/fahrtenbuch',     icon: BookOpen,       labelKey: 'doc.fahrtenbuch',    feature: 'dokumente' },
  { path: '/company-planner', icon: CalendarDays,   labelKey: 'nav.planner',        feature: 'dokumente' },
  // `/monatsplan` is listed only where it is meant to be seen — see
  // `monthlyPlanInNav`. The route is registered in every environment regardless.
  ...(monthlyPlanInNav(import.meta.env.VITE_DEPLOY_ENV, import.meta.env.DEV)
    ? [{ path: '/monatsplan', icon: ListChecks, labelKey: 'nav.monthlyPlan' as const, feature: 'dokumente' as const }]
    : []),
];

// `feature: 'overview'` is this file's existing spelling for "on every plan":
// `overview` is `basic`, the lowest rank, so `can()` is true for every plan. The
// Basic plan is sold with a backup, so Datensicherung is listed on those terms
// beside /billing and /settings rather than behind `rollen_nutzer`, which is
// `advanced` and used to hide it from the very customers who had paid for it.
export const ADMIN_ITEMS: NavItem[] = [
  { path: '/users',          icon: UserCog,    labelKey: 'nav.users',         feature: 'rollen_nutzer' },
  { path: '/roles',          icon: Shield,     labelKey: 'nav.roles',         feature: 'rollen_nutzer' },
  { path: FLEET_IMPORT_PATH, icon: Download,   labelKey: 'import.title',      feature: 'overview' },
  { path: '/datensicherung', icon: Database,   labelKey: 'bill.backup.title', feature: 'overview' },
  { path: '/billing',        icon: CreditCard, labelKey: 'nav.billing',       feature: 'overview' },
  { path: '/settings',       icon: Settings,   labelKey: 'nav.settings',      feature: 'overview' },
];

const Sidebar: React.FC<SidebarProps> = ({ isSupportAdmin }) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { signOut, isSuperAdmin } = useAuth();
  const { settings } = useCompanySettings();
  const { isViewingAsCompany, activeCompany, exitCompany } = useSuperAdmin();
  const { can, companyModules } = usePlan();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    setIsMobileMenuOpen(false);
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  //
  // `renderNavItem` keeps its permission gate — `can(item.feature)` and the
  // early return — where it was; only the drawing below it moved. The hover and
  // active colours were hand-painted through `style` and two imperative mouse
  // handlers; they are token classes now, which is the whole of what changed.
  //
  // The section rows are `text-fg-subtle`, the item rows `text-fg-muted`, and
  // the active row is the design system's navigation fill (`bg-brand-soft`,
  // `text-brand-text`) rather than the old filled accent pill.

  // The collapsible rail (owner, 27.11.2026): `rail` is true only on a wide
  // screen with the sidebar collapsed. Every item then hides its label and
  // keeps its name as an aria-label and a tooltip; see ui/sidebarRail.tsx.
  const { collapsed, rail, toggle: toggleCollapsed } = useSidebarRail();
  const railItemClass = rail ? 'justify-center px-0' : '';

  const navItemClass = 'group flex h-9 w-full items-center gap-3 rounded-control border border-transparent px-2.5 text-[13.5px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus [@media(pointer:coarse)]:h-11';

  const sectionLabelClass = 'px-2.5 pb-1 pt-3 text-xs font-medium text-fg-subtle';

  // In the rail a group's name becomes a hairline, as in the spec; a screen
  // reader still hears it.
  const sectionLabel = (text: string) => rail ? (
    <>
      <p className="sr-only">{text}</p>
      <div aria-hidden className="px-3 py-2"><div className="h-px bg-line" /></div>
    </>
  ) : (
    <p className={sectionLabelClass}>{text}</p>
  );

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon;
    /*
      Two gates, as a plain AND — the plan, and the per-company module a
      platform operator may have switched off (`public.company_modules`,
      migration 20261025120000). There is no precedence and no override: the
      toggle may only narrow, so a module the plan forbids stays hidden however
      the toggle is set, and `plan_features` never becomes advisory. A module
      with no stored decision is on, and so is every module when the read failed
      (`src/lib/companyModules.ts` says why fail-open).

      The module term applies to a support session too. `can()` answers true for
      a platform account whatever the plan says — deliberately, so reading the
      customer's real plan cannot lock support out of a screen — but a switched-
      off module is a configuration the operator made themselves and can undo in
      the panel in one click, and a support session that showed a module the
      customer cannot see would have the operator describing a screen that is
      not there. The map is the opened company's, because this provider keys on
      `effectiveCompanyId`.
    */
    const allowed = can(item.feature) && moduleEnabledForRoute(companyModules, item.path);

    // Slice 1 hides the link only. The plan half of this condition is also
    // enforced at the route by `PlanGate`; the module half is not yet — slice 2
    // adds a `ModuleGate` and a page of its own, so until then a switched-off
    // module's route is still reachable by address, exactly as `/monatsplan` is
    // when `navVisibility` hides it.
    if (!allowed) return null;

    return (
      <RailTip key={item.path} rail={rail} label={t(item.labelKey)}>
      <NavLink
        to={item.path}
        onClick={() => setIsMobileMenuOpen(false)}
        aria-label={rail ? t(item.labelKey) : undefined}
        // A string, not NavLink's className function: the tooltip trigger
        // joins class names as strings and would print the function. The
        // active state rides on the aria-current="page" NavLink sets.
        className={cn(navItemClass, railItemClass, 'text-fg-muted hover:bg-raised hover:text-fg aria-[current=page]:border-edge aria-[current=page]:bg-raised aria-[current=page]:text-fg aria-[current=page]:shadow-raised')}
      >
        <Icon size={18} className="shrink-0 group-aria-[current=page]:text-brand" />
        <span className={rail ? 'hidden' : 'min-w-0 truncate'}>{t(item.labelKey)}</span>
      </NavLink>
      </RailTip>
    );
  };

  const sidebarContent = (
    <div className={cn('flex h-full flex-col pb-[10px] pt-[14px] lg:motion-safe:transition-[padding] lg:motion-safe:duration-[280ms] lg:motion-safe:ease-glass', rail ? 'px-2' : 'px-[10px]')}>
      {/* Logo. Below `lg` the menu button is fixed over this row's left edge —
          it covered the mark whenever the drawer was open — so the lockup
          starts clear of it there and keeps its old inset on a desktop. */}
      <div className={rail ? 'flex flex-col items-center gap-2 pb-1.5 pt-1.5' : 'flex items-center gap-3 pb-3 ps-[46px] pe-2 lg:ps-1.5'}>
        {/* The dark-background glyph in both themes: the tile is dark either way. */}
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-mark shadow-mark">
          <img src="/brand/mark-on-dark.png" alt="" className="h-6 w-6 object-contain" />
        </div>
        <div className={rail ? 'hidden' : 'min-w-0 flex-1'}>
          <p className="truncate text-base font-[650] tracking-[-0.02em] text-fg">
            {isViewingAsCompany ? activeCompany?.name : (settings?.company_name || 'El-Professor')}
          </p>
          <p className={cn('text-[10px]', isViewingAsCompany ? 'text-caution' : 'text-fg-subtle')}>
            {isViewingAsCompany ? t('shell.superAdminView') : t('shell.systemName')}
          </p>
        </div>
        <SidebarToggle collapsed={collapsed} onToggle={toggleCollapsed} />
      </div>

      {/* Nav */}
      <nav className={cn('flex-1 space-y-0.5 overflow-y-auto py-2', rail && '[scrollbar-width:none]')}>
        {NAV_ITEMS.map(renderNavItem)}

        {/* `isSupportAdmin` is the profile's `admin` role. A platform account
            inside a company carries `viewer` on its profile and still belongs
            here: these four screens are what a support session is opened for,
            and `CompanyAdminRoute` decides the same question for the route
            (3.4b). What may be *written* on them is the scope's business, and
            the database's. */}
        {(isSupportAdmin || isViewingAsCompany) && (
          <>
            {sectionLabel(t('nav.section.management'))}
            {ADMIN_ITEMS.map(renderNavItem)}
          </>
        )}

        {/* Platform administration lives in its own shell at /admin and is
            deliberately absent from this sidebar. While a super admin is viewing a
            company, this is the way back. (It said /super-admin until slice
            3.13b; that path is now only a redirect for old bookmarks.) */}
        {isSuperAdmin && isViewingAsCompany && (
          <>
            {sectionLabel(t('nav.section.superAdmin'))}
            <RailTip rail={rail} label={t('nav.backToAdmin')}>
            <button
              onClick={() => { exitCompany(); setIsMobileMenuOpen(false); navigate(ADMIN_BASE); }}
              aria-label={rail ? t('nav.backToAdmin') : undefined}
              className={cn(navItemClass, railItemClass, 'text-caution hover:bg-caution-soft')}
            >
              <ArrowLeft size={18} className="shrink-0 rtl:-scale-x-100" />
              <span className={rail ? 'hidden' : 'min-w-0 truncate'}>{t('nav.backToAdmin')}</span>
            </button>
            </RailTip>
          </>
        )}
      </nav>

      {/* Logout */}
      <div className="border-t border-line pt-2">
        <RailTip rail={rail} label={t('common.logout')}>
        <button
          onClick={handleLogout}
          aria-label={rail ? t('common.logout') : undefined}
          className={cn(navItemClass, railItemClass, 'text-critical hover:bg-critical-soft')}
        >
          <LogOut size={18} className="shrink-0" />
          <span className={rail ? 'hidden' : 'min-w-0 truncate'}>{t('common.logout')}</span>
        </button>
        </RailTip>
        {/* Impressum and Datenschutz, owed from every page; a new tab, so
            nothing typed on the current screen is lost. The rail draws them
            as two named icons rather than dropping them. */}
        {rail ? <LegalLinks variant="rail" className="pt-2" /> : <LegalLinks className="px-3 pb-1 pt-2" />}
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile button */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        aria-label={isMobileMenuOpen ? t('ui.shell.closeNavigation') : t('ui.shell.openNavigation')}
        aria-expanded={isMobileMenuOpen}
        aria-controls={SHELL_SIDEBAR_ID}
        className="fixed start-4 top-3 z-50 rounded-control border border-line bg-raised p-2 text-fg-muted shadow-raised transition-colors hover:bg-sunken hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
      >
        {isMobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Mobile overlay — the design system's scrim, as Dialog paints it. */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 glass-scrim motion-safe:animate-ui-fade-in lg:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      {/* `lg:m-[10px]` is the spec's shell gutter: 10 px all round the pane,
          so 10 px between it and the sheet too (the sheet's column pads only
          its other three sides, as the spec's `.main` does). The width and
          padding move over .28 s; the drawer below `lg` slides over .32 s. */}
      <aside
        id={SHELL_SIDEBAR_ID}
        className={cn(
          'glass-drawer fixed start-0 top-0 z-40 h-full w-[286px] transform rounded-none border-y-0 border-s-0 max-lg:motion-safe:transition-transform max-lg:motion-safe:duration-[320ms] max-lg:motion-safe:ease-glass lg:sticky lg:top-[10px] lg:m-[10px] lg:h-[calc(100dvh-20px)] lg:shrink-0 lg:translate-x-0 lg:overflow-x-hidden lg:rounded-pane lg:border lg:bg-sheet lg:shadow-raised lg:motion-safe:transition-[width] lg:motion-safe:duration-[280ms] lg:motion-safe:ease-glass',
          rail ? 'lg:w-[68px]' : 'lg:w-[254px]',
          isMobileMenuOpen ? 'translate-x-0' : 'max-lg:-translate-x-full max-lg:rtl:translate-x-full',
        )}
      >
        <RailTipProvider>{sidebarContent}</RailTipProvider>
      </aside>
    </>
  );
};

export default Sidebar;
