import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, FileText, Users, DollarSign, Plus,
  Menu, X, UserCog, Receipt, Wallet, LogOut, Calculator,
  StickyNote, Car, Wrench, Shield, Settings, Bell, CalendarDays, CreditCard, ArrowLeft,
  Database,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import BrandLogo from './BrandLogo';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { usePlan, FeatureKey } from '../contexts/PlanContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { LegalLinks } from './legal/LegalLinks';
import { ADMIN_BASE } from '../lib/adminGate';
import { cn } from './ui';

interface SidebarProps {
  isSupportAdmin: boolean;
}

interface NavItem {
  path: string;
  icon: React.ElementType;
  labelKey: TranslationKey;
  feature: FeatureKey;
}

const NAV_ITEMS: NavItem[] = [
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
  { path: '/company-planner', icon: CalendarDays,   labelKey: 'nav.planner',        feature: 'dokumente' },
  // ── `/monatsplan` is deliberately NOT listed (owner's decision, 04.10.2026) ──
  //
  // *"في السايدبار بدي نخفي البلان مبدئياً لحد ما نتفق عليها"* — the eight-step
  // Monatsplan is hidden from the navigation until he and the customer have
  // agreed on how it distributes a month.
  //
  // **The route is untouched** (`App.tsx` still registers it behind the same
  // `dokumente` plan gate), so it stays reachable at `/monatsplan` for testing and
  // nothing about the feature, its tables or its documents is disabled. Restoring
  // it is putting this one line back:
  //
  //   { path: '/monatsplan', icon: ListChecks, labelKey: 'nav.monthlyPlan', feature: 'dokumente' },
  //
  // Restoring it also needs `ListChecks` back in the lucide import: `noUnusedLocals`
  // is on, so an icon kept "for later" fails the build. `nav.monthlyPlan` stays in
  // both dictionaries, which costs nothing and keeps the wording decided.
];

// `feature: 'overview'` is this file's existing spelling for "on every plan":
// `overview` is `basic`, the lowest rank, so `can()` is true for every plan. The
// Basic plan is sold with a backup, so Datensicherung is listed on those terms
// beside /billing and /settings rather than behind `rollen_nutzer`, which is
// `advanced` and used to hide it from the very customers who had paid for it.
const ADMIN_ITEMS: NavItem[] = [
  { path: '/users',          icon: UserCog,    labelKey: 'nav.users',         feature: 'rollen_nutzer' },
  { path: '/roles',          icon: Shield,     labelKey: 'nav.roles',         feature: 'rollen_nutzer' },
  { path: '/datensicherung', icon: Database,   labelKey: 'bill.backup.title', feature: 'overview' },
  { path: '/billing',        icon: CreditCard, labelKey: 'nav.billing',       feature: 'overview' },
  { path: '/settings',       icon: Settings,   labelKey: 'nav.settings',      feature: 'overview' },
];

const Sidebar: React.FC<SidebarProps> = ({ isSupportAdmin }) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { signOut, isSuperAdmin } = useAuth();
  const { settings } = useCompanySettings();
  const { isViewingAsCompany, activeCompany, exitCompany } = useSuperAdmin();
  const { can } = usePlan();
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

  const navItemClass = 'flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus [@media(pointer:coarse)]:py-3';

  const sectionLabelClass = 'px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle';

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon;
    const allowed = can(item.feature);

    // Hidden items are not shown at all — access is also blocked at the route level
    if (!allowed) return null;

    return (
      <NavLink
        key={item.path}
        to={item.path}
        onClick={() => setIsMobileMenuOpen(false)}
        className={({ isActive }) =>
          cn(navItemClass, isActive ? 'bg-brand-soft text-brand-text' : 'text-fg-muted hover:bg-sunken hover:text-fg')
        }
      >
        <Icon size={16} className="shrink-0" />
        <span>{t(item.labelKey)}</span>
      </NavLink>
    );
  };

  const SidebarContent = () => (
    <div className="flex h-full flex-col">
      {/* Logo. Below `lg` the menu button is fixed over this row's left edge —
          it covered the mark whenever the drawer was open — so the lockup
          starts clear of it there and keeps its old inset on a desktop. */}
      <div className="flex items-center gap-3 border-b border-line py-4 pl-14 pr-4 lg:pl-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center">
          <BrandLogo className="h-8 w-8 object-contain" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-fg">
            {isViewingAsCompany ? activeCompany?.name : (settings?.company_name || 'El-Professor')}
          </p>
          <p className={cn('text-[10px]', isViewingAsCompany ? 'text-caution' : 'text-fg-subtle')}>
            {isViewingAsCompany ? t('shell.superAdminView') : t('shell.systemName')}
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {NAV_ITEMS.map(renderNavItem)}

        {/* `isSupportAdmin` is the profile's `admin` role. A platform account
            inside a company carries `viewer` on its profile and still belongs
            here: these four screens are what a support session is opened for,
            and `CompanyAdminRoute` decides the same question for the route
            (3.4b). What may be *written* on them is the scope's business, and
            the database's. */}
        {(isSupportAdmin || isViewingAsCompany) && (
          <>
            <p className={sectionLabelClass}>{t('nav.section.management')}</p>
            {ADMIN_ITEMS.map(renderNavItem)}
          </>
        )}

        {/* Platform administration lives in its own shell at /admin and is
            deliberately absent from this sidebar. While a super admin is viewing a
            company, this is the way back. (It said /super-admin until slice
            3.13b; that path is now only a redirect for old bookmarks.) */}
        {isSuperAdmin && isViewingAsCompany && (
          <>
            <p className={sectionLabelClass}>{t('nav.section.superAdmin')}</p>
            <button
              onClick={() => { exitCompany(); setIsMobileMenuOpen(false); navigate(ADMIN_BASE); }}
              className={cn(navItemClass, 'text-caution hover:bg-caution-soft')}
            >
              <ArrowLeft size={16} className="shrink-0" />
              <span>{t('nav.backToAdmin')}</span>
            </button>
          </>
        )}
      </nav>

      {/* Logout */}
      <div className="border-t border-line p-2">
        <button
          onClick={handleLogout}
          className={cn(navItemClass, 'text-critical hover:bg-critical-soft')}
        >
          <LogOut size={16} className="shrink-0" />
          <span>{t('common.logout')}</span>
        </button>
        {/* Impressum and Datenschutz, owed from every page; a new tab, so
            nothing typed on the current screen is lost. */}
        <LegalLinks className="px-3 pb-1 pt-2" />
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile button */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className="fixed left-4 top-3 z-50 rounded-control border border-line bg-raised p-2 text-fg-muted shadow-raised transition-colors hover:bg-sunken hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
      >
        {isMobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Mobile overlay — the design system's scrim, as Dialog paints it. */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-[rgb(5_8_16/0.55)] lg:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed left-0 top-0 z-40 h-full w-64 transform border-r border-line bg-raised shadow-overlay transition-transform duration-300 ease-in-out lg:translate-x-0',
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <SidebarContent />
      </aside>
    </>
  );
};

export default Sidebar;
