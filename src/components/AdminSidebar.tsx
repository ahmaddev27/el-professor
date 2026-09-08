import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  BarChart3, Building2, Receipt, Stethoscope,
  Menu, X, LogOut, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

interface AdminNavItem {
  path: string;
  icon: React.ElementType;
  label: string;
  end?: boolean;
}

/**
 * Platform-level navigation. These destinations administer the whole platform —
 * every tenant's company record, subscriptions and payments — so they live in
 * their own shell and are never rendered inside the company-facing sidebar.
 */
const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { path: '/super-admin',                     icon: BarChart3,  label: 'Plattform',        end: true },
  { path: '/super-admin/companies',           icon: Building2,  label: 'Unternehmen' },
  { path: '/super-admin/billing',             icon: Receipt,    label: 'Abos & Zahlungen' },
  { path: '/super-admin/abnahme-diagnose',    icon: Stethoscope, label: 'Abnahme-Diagnose' },
];

const AdminSidebar: React.FC = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { signOut, profile } = useAuth();

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
            Administration
          </p>
          <p className="text-[10px]" style={{ color: 'var(--warning)' }}>
            Plattformverwaltung
          </p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {ADMIN_NAV_ITEMS.map(item => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 w-full"
              style={({ isActive }) =>
                isActive
                  ? { background: 'var(--warning)', color: 'white', boxShadow: '0 2px 10px rgba(245,158,11,0.2)' }
                  : { color: 'var(--text-secondary)', background: 'transparent' }
              }
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLElement;
                if (!el.getAttribute('aria-current')) {
                  el.style.background = 'var(--warning-subtle)';
                  el.style.color = 'var(--warning)';
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
              <span>{item.label}</span>
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
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium w-full transition-all duration-150"
          style={{ color: 'var(--danger)' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--danger-subtle)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          <LogOut size={16} className="flex-shrink-0" />
          <span>Abmelden</span>
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
