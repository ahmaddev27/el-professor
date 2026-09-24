import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Settings, ChevronDown, Building2, X as XIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { ADMIN_BASE } from '../lib/adminGate';
import { cn } from './ui';

const UserMenu: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const { user, profile, signOut } = useAuth();
  const { isViewingAsCompany, activeCompany, exitCompany } = useSuperAdmin();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Leaving the company view returns to the administration shell — a super
  // admin who is not inspecting a tenant has no business in the company UI.
  // ADMIN_BASE, not the literal '/super-admin' it said until slice 3.13b: the
  // legacy path still redirects here, but sending the operator through a
  // redirect on every exit is a round trip and a history entry for nothing.
  const handleExitCompany = () => {
    exitCompany();
    navigate(ADMIN_BASE);
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setIsOpen(false);
    } catch (error) {
      console.error('UserMenu: SignOut error:', error);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  //
  // `roleLabels` and `initials` are unchanged; `roleColors` held the look half
  // of the same idea and is token classes now. The menu keeps its own open
  // state and its click-catcher rather than becoming a Radix menu, because that
  // would rewrite the handlers this change must leave alone.

  const roleLabels: Record<string, string> = {
    admin: 'Administrator',
    supervisor: 'Supervisor',
    editor: 'Bearbeiter',
    viewer: 'Betrachter',
  };

  const roleColors: Record<string, string> = {
    admin:      'bg-critical-soft text-critical',
    supervisor: 'bg-caution-soft text-caution',
    editor:     'bg-brand-soft text-brand-text',
    viewer:     'bg-sunken text-fg-muted',
  };

  const getRoleBadge = (role: string) => {
    const colors = roleColors[role] || roleColors.viewer;
    return (
      <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', colors)}>
        {roleLabels[role] || role}
      </span>
    );
  };

  const initials = (profile?.full_name || user?.email || 'U')
    .split(' ')
    .map((w: string) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const menuItemClass = 'flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-sm transition-colors';

  return (
    <div className="flex items-center gap-2">
      {isViewingAsCompany && (
        <div className="flex items-center gap-2 rounded-control border border-caution bg-caution-soft px-3 py-1.5 text-xs font-semibold text-caution">
          <Building2 size={13} className="shrink-0" />
          <span className="hidden max-w-[120px] truncate sm:inline">{activeCompany?.name}</span>
          <button
            onClick={handleExitCompany}
            className="ml-1 shrink-0 rounded transition-opacity hover:opacity-70"
            title={t('shell.exitCompanyView')}
          >
            <XIcon size={13} />
          </button>
        </div>
      )}
      <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 rounded-control border border-line bg-canvas px-3 py-1.5 text-fg transition-colors hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-brand-fg">
          {initials}
        </div>
        <div className="hidden text-left sm:block">
          <div className="text-xs font-semibold leading-tight text-fg">
            {profile?.full_name || user?.email?.split('@')[0]}
          </div>
        </div>
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-fg-subtle transition-transform duration-200', isOpen && 'rotate-180')}
        />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="animate-fade-in absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-surface border border-line bg-overlay shadow-overlay">
            {/* User info */}
            <div className="border-b border-line p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-fg">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-fg">
                    {profile?.full_name || 'Benutzer'}
                  </p>
                  <p className="truncate text-xs text-fg-subtle">
                    {profile?.email}
                  </p>
                  {profile?.role && <div className="mt-1.5">{getRoleBadge(profile.role)}</div>}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-1.5">
              {/* Went nowhere before — it closed the menu and nothing else, so
                  there was no way to change your own password inside the app. */}
              <button
                onClick={() => { setIsOpen(false); navigate('/mein-konto'); }}
                className={cn(menuItemClass, 'text-fg-muted hover:bg-sunken hover:text-fg')}
              >
                <Settings size={14} />
                <span>{t('account.title')}</span>
              </button>
              <button
                onClick={handleSignOut}
                className={cn(menuItemClass, 'text-critical hover:bg-critical-soft')}
              >
                <LogOut size={14} />
                <span>{t('common.logout')}</span>
              </button>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
};

export default UserMenu;
