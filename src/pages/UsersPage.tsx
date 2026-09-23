import React, { useState } from 'react';
import { Users, Database } from 'lucide-react';
import UserManagement from '../components/UserManagement';
import BackupManagement from '../components/BackupManagement';
import { useTranslation } from '../contexts/LanguageContext';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui';

const UsersPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'users' | 'backups'>('users');
  const { t } = useTranslation();

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The tab state is unchanged, and so is what it mounts: only the chosen tab
  // is rendered at all, as before. The page's title and the two tab names,
  // German literals until now, come from the dictionaries.

  return (
    <Tabs value={activeTab} onValueChange={value => setActiveTab(value as 'users' | 'backups')} className="font-ui">
      <PageHeader title={t('nav.users')}>
        <TabsList aria-label={t('nav.users')}>
          <TabsTrigger value="users" onClick={() => setActiveTab('users')}>
            <Users aria-hidden className="size-4" />
            {t('users.tab.manage')}
          </TabsTrigger>
          <TabsTrigger value="backups" onClick={() => setActiveTab('backups')}>
            <Database aria-hidden className="size-4" />
            {t('users.tab.backups')}
          </TabsTrigger>
        </TabsList>
      </PageHeader>

      <TabsContent value="users">{activeTab === 'users' && <UserManagement />}</TabsContent>
      <TabsContent value="backups">{activeTab === 'backups' && <BackupManagement />}</TabsContent>
    </Tabs>
  );
};

export default UsersPage;
