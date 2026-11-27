import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  BarChart3, Building2, Receipt, Stethoscope,
  Menu, X, LogOut, UserCog,
  Library, ScrollText, SlidersHorizontal, Users, Layers,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import type { PlatformCapability, PlatformRole } from '../lib/platformAccess';

interface AdminNavItem {
  path: string;
  icon: React.ElementType;
  labelKey: TranslationKey;
  /** Hidden for a role without it; the pages and the database check again. */
  requires: PlatformCapability;
  end?: boolean;
}

/**
 * Platform-level navigation. These destinations administer the whole platform —
 * every tenant's company record, subscriptions and payments — so they live in
 * their own shell and are never rendered inside the company-facing sidebar.
 */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { path: '/admin',                  icon: BarChart3,   labelKey: 'admin.nav.platform',    requires: 'companies.read', end: true },
  { path: '/admin/companies',        icon: Building2,   labelKey: 'admin.nav.companies',   requires: 'companies.read' },
  // Decision D14 (24.09.2026): the invoices, the subscriptions and the payment
  // trail are behind two audited read models that ask for billing.manage, so
  // the entry follows that capability. A support or read_only account keeps
  // /admin/companies, where every company's own subscription state is shown.
  { path: '/admin/billing',          icon: Receipt,     labelKey: 'admin.nav.billing',     requires: 'billing.manage' },
  // The diagnosis reads a company's Fahrtenbuch and planning data.
  // The plan catalogue (prices per car and features per plan) is written by
  // platform_plans_save, which asks for pricing.manage; billing holds it too.
  { path: '/admin/plaene',           icon: Layers,      labelKey: 'admin.nav.plans',       requires: 'pricing.manage' },
  { path: '/admin/abnahme-diagnose', icon: Stethoscope, labelKey: 'admin.nav.diagnostics', requires: 'business.read' },
  // The directories read every company's vehicles, drivers and users through
  // the audited read models, which ask for business.read.
  { path: '/admin/verzeichnisse',    icon: Library,          labelKey: 'admin.nav.directories', requires: 'business.read' },
  // audit.read reads the whole log; all four roles hold it since 15.10.2026 (D3).
  // The entry follows the capability the page is for.
  { path: '/admin/protokoll',        icon: ScrollText,       labelKey: 'admin.nav.audit',       requires: 'audit.read' },
  // Viewing needs settings.read; saving needs pricing.manage or settings.manage,
  // and the page and the database decide that per key.
  { path: '/admin/einstellungen',    icon: SlidersHorizontal, labelKey: 'admin.nav.settings',   requires: 'settings.read' },
  { path: '/admin/team',             icon: Users,            labelKey: 'admin.nav.team',        requires: 'staff.manage' },
];

const ROLE_LABEL_KEYS: Record<PlatformRole, TranslationKey> = {
  owner:     'admin.role.owner',
  support:   'admin.role.support',
  billing:   'admin.role.billing',
  read_only: 'admin.role.read_only',
};

const AdminSidebar: React.FC = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { signOut, profile } = useAuth();
  const { platformAccess, platformCan } = useSuperAdmin();
  const { t } = useTranslation();

  const handleLogout = async () => {
    await signOut();
    setIsMobileMenuOpen(false);
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // One look for every sidebar destination, as Sidebar draws the company one:
  // the active entry is a glass chip (NavLink's aria-current drives it), hover
  // is a class. The two imperative hover painters this file had are gone.
  const navItemClass = 'group flex h-9 w-full items-center gap-3 rounded-control border border-transparent px-2.5 text-[13.5px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg aria-[current=page]:border-edge aria-[current=page]:bg-raised aria-[current=page]:text-fg aria-[current=page]:shadow-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus [@media(pointer:coarse)]:h-11';
  const iconClass = 'shrink-0 group-aria-[current=page]:text-brand';

  const SidebarContent = () => (
    <div className="flex h-full flex-col px-[10px] pb-[10px] pt-[14px]">
      {/* Identity: the panel's own name under the El-Professor mark, so it is
          always obvious which context is being operated in. */}
      <div className="flex items-center gap-3 pb-3 ps-[46px] pe-2 lg:ps-1.5">
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-mark shadow-mark">
          {/* The El-Professor mark, as the owner asked on 28.09.2026. The
              subtitle and the role line below are quiet text since 27.11.2026:
              the owner asked for Reidey's look ("everything like the file"),
              whose brand row carries no warning colour, and found the amber
              lines out of place on the glass. A warning colour is for a state
              that needs attention, like the support-session bar. */}
          <img src="/brand/mark-on-dark.png" alt="" className="h-6 w-6 object-contain" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-[650] tracking-[-0.02em] text-fg">
            {t('admin.title')}
          </p>
          <p className="text-xs text-fg-subtle">
            {t('admin.subtitle')}
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto py-2">
        {ADMIN_NAV_ITEMS.filter(item => platformCan(item.requires)).map(item => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              onClick={() => setIsMobileMenuOpen(false)}
              className={navItemClass}
            >
              <Icon size={18} className={iconClass} />
              <span>{t(item.labelKey)}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="space-y-1 border-t border-line pt-2">
        {profile?.email && (
          <p className="truncate px-2.5 pb-1 text-[10px] text-fg-subtle">
            {profile.email}
          </p>
        )}
        {platformAccess.role && (
          <p className="px-2.5 pb-1 text-[10px] font-semibold text-fg-muted">
            {t(ROLE_LABEL_KEYS[platformAccess.role])}
          </p>
        )}
        {/* Personal, not a platform destination: the account page shows the
            caller's own record, so it carries no capability requirement and
            every platform role — read_only included — reaches it. It points at
            the copy registered under /admin, not at /mein-konto, which lives in
            the company shell and would surround it with tenant navigation this
            account cannot use. */}
        <NavLink
          to="/admin/konto"
          onClick={() => setIsMobileMenuOpen(false)}
          className={navItemClass}
        >
          <UserCog size={18} className={iconClass} />
          <span>{t('admin.nav.account')}</span>
        </NavLink>
        <button
          onClick={handleLogout}
          className="flex h-9 w-full items-center gap-3 rounded-control px-2.5 text-[13.5px] font-medium text-critical transition-colors hover:bg-critical-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus [@media(pointer:coarse)]:h-11"
        >
          <LogOut size={18} className="shrink-0" />
          <span>{t('common.logout')}</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className="fixed start-4 top-3 z-50 rounded-control border border-line bg-raised p-2 text-fg-muted shadow-raised transition-colors hover:bg-sunken hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
      >
        {isMobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {isMobileMenuOpen && (
        <div
          className="glass-scrim fixed inset-0 z-30 motion-safe:animate-ui-fade-in lg:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      <aside
        className={`glass-drawer fixed start-0 top-0 z-40 h-full w-[286px] transform rounded-none border-y-0 border-s-0 motion-safe:transition-transform motion-safe:duration-[320ms] motion-safe:ease-glass lg:sticky lg:top-[10px] lg:ms-[10px] lg:mt-[10px] lg:h-[calc(100dvh-20px)] lg:w-[254px] lg:shrink-0 lg:translate-x-0 lg:rounded-pane lg:border lg:bg-sheet lg:shadow-raised ${
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full'
        }`}
      >
        <SidebarContent />
      </aside>
    </>
  );
};

export default AdminSidebar;
