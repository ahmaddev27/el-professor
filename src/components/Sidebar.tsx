import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, FileText, Users, DollarSign, Plus,
  Menu, X, UserCog, Receipt, Wallet, LogOut, Calculator,
  StickyNote, Car, Wrench, Shield, Settings, Bell, CalendarDays, CreditCard, ArrowLeft,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { usePlan, FeatureKey } from '../contexts/PlanContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { LegalLinks } from './legal/LegalLinks';

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
];

const ADMIN_ITEMS: NavItem[] = [
  { path: '/users',    icon: UserCog,    labelKey: 'nav.users',    feature: 'rollen_nutzer' },
  { path: '/roles',    icon: Shield,     labelKey: 'nav.roles',    feature: 'rollen_nutzer' },
  { path: '/billing',  icon: CreditCard, labelKey: 'nav.billing',  feature: 'overview' },
  { path: '/settings', icon: Settings,   labelKey: 'nav.settings', feature: 'overview' },
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
        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 w-full"
        style={({ isActive }) =>
          isActive
            ? { background: 'var(--accent)', color: 'var(--text-inverse)', boxShadow: '0 2px 10px rgba(6,182,212,0.2)' }
            : { color: 'var(--text-secondary)', background: 'transparent' }
        }
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLElement;
          if (!el.getAttribute('aria-current')) {
            el.style.background = 'var(--bg-muted)';
            el.style.color = 'var(--text-primary)';
          }
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLElement;
          if (!el.getAttribute('aria-current')) {
            el.style.background = 'transparent';
            el.style.color = 'var(--text-secondary)';
          }
        }}
      >
        <Icon size={16} className="flex-shrink-0" />
        <span>{t(item.labelKey)}</span>
      </NavLink>
    );
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-4 border-b flex items-center gap-3" style={{ borderColor: 'var(--border)' }}>
        <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center">
          <img src="/professor_logo_white.svg" alt="El-Professor" className="w-8 h-8 object-contain" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>
            {isViewingAsCompany ? activeCompany?.name : (settings?.company_name || 'El-Professor')}
          </p>
          <p className="text-[10px]" style={{ color: isViewingAsCompany ? 'var(--warning)' : 'var(--text-tertiary)' }}>
            {isViewingAsCompany ? t('shell.superAdminView') : t('shell.systemName')}
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {NAV_ITEMS.map(renderNavItem)}

        {/* `isSupportAdmin` is the profile's `admin` role. A platform account
            inside a company carries `viewer` on its profile and still belongs
            here: these four screens are what a support session is opened for,
            and `CompanyAdminRoute` decides the same question for the route
            (3.4b). What may be *written* on them is the scope's business, and
            the database's. */}
        {(isSupportAdmin || isViewingAsCompany) && (
          <>
            <div className="pt-3 pb-1 px-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                {t('nav.section.management')}
              </p>
            </div>
            {ADMIN_ITEMS.map(renderNavItem)}
          </>
        )}

        {/* Platform administration lives in its own shell at /super-admin and is
            deliberately absent from this sidebar. While a super admin is viewing a
            company, this is the way back. */}
        {isSuperAdmin && isViewingAsCompany && (
          <>
            <div className="pt-3 pb-1 px-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                {t('nav.section.superAdmin')}
              </p>
            </div>
            <button
              onClick={() => { exitCompany(); setIsMobileMenuOpen(false); navigate('/super-admin'); }}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 w-full"
              style={{ color: 'var(--warning)', background: 'transparent' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--warning-subtle)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <ArrowLeft size={16} className="flex-shrink-0" />
              <span>{t('nav.backToAdmin')}</span>
            </button>
          </>
        )}
      </nav>

      {/* Logout */}
      <div className="p-2 border-t" style={{ borderColor: 'var(--border)' }}>
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

      {/* Mobile overlay */}
      {isMobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 z-30"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
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

export default Sidebar;
