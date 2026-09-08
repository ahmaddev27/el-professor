import React, { useState } from 'react';
import { Users, Database } from 'lucide-react';
import UserManagement from '../components/UserManagement';
import BackupManagement from '../components/BackupManagement';

const UsersPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'users' | 'backups'>('users');

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Benutzer</h2>

      <div className="flex gap-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <button
          onClick={() => setActiveTab('users')}
          className="flex items-center gap-2 px-4 py-3 font-medium border-b-2 transition-colors"
          style={{
            borderBottomColor: activeTab === 'users' ? 'var(--accent)' : 'transparent',
            color: activeTab === 'users' ? 'var(--accent-text)' : 'var(--text-secondary)',
          }}
          onMouseEnter={e => { if (activeTab !== 'users') (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'; }}
          onMouseLeave={e => { if (activeTab !== 'users') (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
        >
          <Users size={18} />
          Benutzerverwaltung
        </button>
        <button
          onClick={() => setActiveTab('backups')}
          className="flex items-center gap-2 px-4 py-3 font-medium border-b-2 transition-colors"
          style={{
            borderBottomColor: activeTab === 'backups' ? 'var(--accent)' : 'transparent',
            color: activeTab === 'backups' ? 'var(--accent-text)' : 'var(--text-secondary)',
          }}
          onMouseEnter={e => { if (activeTab !== 'backups') (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'; }}
          onMouseLeave={e => { if (activeTab !== 'backups') (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
        >
          <Database size={18} />
          Datensicherung
        </button>
      </div>

      {activeTab === 'users' && <UserManagement />}
      {activeTab === 'backups' && <BackupManagement />}
    </div>
  );
};

export default UsersPage;
