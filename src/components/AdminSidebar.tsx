import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  BarChart3, Building2, Receipt, Stethoscope,
  Menu, X, LogOut, ShieldCheck, UserCog,
  Library, ScrollText, SlidersHorizontal, Users,
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
const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { path: '/super-admin',                  icon: BarChart3,   labelKey: 'admin.nav.platform',    requires: 'companies.read', end: true },
  { path: '/super-admin/companies',        icon: Building2,   labelKey: 'admin.nav.companies',   requires: 'companies.read' },
  { path: '/super-admin/billing',          icon: Receipt,     labelKey: 'admin.nav.billing',     requires: 'companies.read' },
  // The diagnosis reads a company's Fahrtenbuch and planning data.
  { path: '/super-admin/abnahme-diagnose', icon: Stethoscope, labelKey: 'admin.nav.diagnostics', requires: 'business.read' },
  // The directories read every company's vehicles, drivers and users through
  // the audited read models, which ask for business.read.
  { path: '/super-admin/verzeichnisse',    icon: Library,          labelKey: 'admin.nav.directories', requires: 'business.read' },
  // audit.read reads the whole log. Every other active role reads its own rows,
  // but the entry follows the capability the page is for.
  { path: '/super-admin/protokoll',        icon: ScrollText,       labelKey: 'admin.nav.audit',       requires: 'audit.read' },
  // Viewing needs settings.read; saving needs pricing.manage or settings.manage,
  // and the page and the database decide that per key.
  { path: '/super-admin/einstellungen',    icon: SlidersHorizontal, labelKey: 'admin.nav.settings',   requires: 'settings.read' },
  { path: '/super-admin/team',             icon: Users,            labelKey: 'admin.nav.team',        requires: 'staff.manage' },
];

/**
 * One look for every sidebar destination. The account link sits in the footer
 * rather than in the nav, so sharing these keeps the two from drifting apart.
 */
const NAV_ITEM_CLASS =
  'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 w-full';

const navItemStyle = ({ isActive }: { isActive: boolean }): React.CSSProperties =>
  isActive
    ? { background: 'var(--warning)', color: 'white', boxShadow: '0 2px 10px rgba(245,158,11,0.2)' }
    : { color: 'var(--text-secondary)', background: 'transparent' };

// NavLink marks the active entry with aria-current; its colours must survive hover.
const handleNavItemMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
  const el = e.currentTarget;
  if (!el.getAttribute('aria-current')) {
    el.style.background = 'var(--warning-subtle)';
    el.style.color = 'var(--warning)';
  }
};

const handleNavItemMouseLeave = (e: React.MouseEvent<HTMLAnchorElement>) => {
  const el = e.currentTarget;
  if (!el.getAttribute('aria-current')) {
    el.style.background = 'transparent';
    el.style.color = 'var(--text-secondary)';
  }
};

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

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Identity — deliberately distinct from the company shell so it is always
          obvious which context is being operated in. */}
      <div className="px-4 py-4 border-b flex items-center gap-3" style={{ borderColor: 'var(--border)' }}>
        <div
          className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg"
          style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}
        >
          <ShieldCheck size={16} style={{ color: 'var(--warning)' }} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>
            {t('admin.title')}
          </p>
          <p className="text-[10px]" style={{ color: 'var(--warning)' }}>
            {t('admin.subtitle')}
          </p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {ADMIN_NAV_ITEMS.filter(item => platformCan(item.requires)).map(item => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              onClick={() => setIsMobileMenuOpen(false)}
              className={NAV_ITEM_CLASS}
              style={navItemStyle}
              onMouseEnter={handleNavItemMouseEnter}
              onMouseLeave={handleNavItemMouseLeave}
            >
              <Icon size={16} className="flex-shrink-0" />
              <span>{t(item.labelKey)}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="p-2 border-t space-y-1" style={{ borderColor: 'var(--border)' }}>
        {profile?.email && (
          <p className="px-3 pb-1 text-[10px] truncate" style={{ color: 'var(--text-tertiary)' }}>
            {profile.email}
          </p>
        )}
        {platformAccess.role && (
          <p className="px-3 pb-1 text-[10px] font-semibold" style={{ color: 'var(--warning)' }}>
            {t(ROLE_LABEL_KEYS[platformAccess.role])}
          </p>
        )}
        {/* Personal, not a platform destination: the account page shows the
            caller's own record, so it carries no capability requirement and
            every platform role — read_only included — reaches it. */}
        <NavLink
          to="/mein-konto"
          onClick={() => setIsMobileMenuOpen(false)}
          className={NAV_ITEM_CLASS}
          style={navItemStyle}
          onMouseEnter={handleNavItemMouseEnter}
          onMouseLeave={handleNavItemMouseLeave}
        >
          <UserCog size={16} className="flex-shrink-0" />
          <span>{t('admin.nav.account')}</span>
        </NavLink>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium w-full transition-all duration-150"
          style={{ color: 'var(--danger)' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--danger-subtle)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          <LogOut size={16} className="flex-shrink-0" />
          <span>{t('common.logout')}</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className="lg:hidden fixed top-3 left-4 z-50 p-2 rounded-lg transition-colors"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          color: 'var(--text-secondary)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {isMobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {isMobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 z-30"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      <aside
        className={`fixed top-0 left-0 z-40 h-full w-64 transform transition-transform duration-300 ease-in-out border-r ${
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0`}
        style={{
          background: 'var(--bg-surface)',
          borderColor: 'var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <SidebarContent />
      </aside>
    </>
  );
};

export default AdminSidebar;
