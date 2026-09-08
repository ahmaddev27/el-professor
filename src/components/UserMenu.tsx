import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Settings, ChevronDown, Building2, X as XIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';

const UserMenu: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const { user, profile, signOut } = useAuth();
  const { isViewingAsCompany, activeCompany, exitCompany } = useSuperAdmin();
  const navigate = useNavigate();

  // Leaving the company view returns to the administration shell — a super
  // admin who is not inspecting a tenant has no business in the company UI.
  const handleExitCompany = () => {
    exitCompany();
    navigate('/super-admin');
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setIsOpen(false);
    } catch (error) {
      console.error('UserMenu: SignOut error:', error);
    }
  };

  const roleLabels: Record<string, string> = {
    admin: 'Administrator',
    supervisor: 'Supervisor',
    editor: 'Bearbeiter',
    viewer: 'Betrachter',
  };

  const roleColors: Record<string, { bg: string; color: string }> = {
    admin:      { bg: 'var(--danger-subtle)',  color: 'var(--danger)' },
    supervisor: { bg: 'var(--warning-subtle)', color: 'var(--warning)' },
    editor:     { bg: 'var(--accent-subtle)',  color: 'var(--accent-text)' },
    viewer:     { bg: 'var(--bg-muted)',       color: 'var(--text-secondary)' },
  };

  const getRoleBadge = (role: string) => {
    const colors = roleColors[role] || roleColors.viewer;
    return (
      <span
        className="text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ background: colors.bg, color: colors.color }}
      >
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

  return (
    <div className="flex items-center gap-2">
      {isViewingAsCompany && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold"
          style={{
            background: 'var(--warning-subtle)',
            border: '1px solid var(--warning)',
            color: 'var(--warning)',
          }}
        >
          <Building2 size={13} className="flex-shrink-0" />
          <span className="hidden sm:inline truncate max-w-[120px]">{activeCompany?.name}</span>
          <button
            onClick={handleExitCompany}
            className="flex-shrink-0 ml-1 rounded transition-opacity hover:opacity-70"
            title="Unternehmensansicht beenden"
          >
            <XIcon size={13} />
          </button>
        </div>
      )}
      <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl transition-all duration-150"
        style={{
          border: '1px solid var(--border)',
          background: 'var(--bg-subtle)',
          color: 'var(--text-primary)',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-muted)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
      >
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          {initials}
        </div>
        <div className="text-left hidden sm:block">
          <div className="text-xs font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
            {profile?.full_name || user?.email?.split('@')[0]}
          </div>
        </div>
        <ChevronDown
          size={14}
          className={`transition-transform duration-200 flex-shrink-0`}
          style={{
            color: 'var(--text-tertiary)',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div
            className="absolute right-0 mt-2 w-60 rounded-xl z-20 overflow-hidden animate-fade-in"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            {/* User info */}
            <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  {initials}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {profile?.full_name || 'Benutzer'}
                  </p>
                  <p className="text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
                    {profile?.email}
                  </p>
                  {profile?.role && <div className="mt-1.5">{getRoleBadge(profile.role)}</div>}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-1.5">
              <button
                onClick={() => setIsOpen(false)}
                className="w-full px-3 py-2 text-left text-sm rounded-lg flex items-center gap-2.5 transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-muted)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
              >
                <Settings size={14} />
                <span>Einstellungen</span>
              </button>
              <button
                onClick={handleSignOut}
                className="w-full px-3 py-2 text-left text-sm rounded-lg flex items-center gap-2.5 transition-colors"
                style={{ color: 'var(--danger)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--danger-subtle)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <LogOut size={14} />
                <span>Abmelden</span>
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
