import React from 'react';
import UserManagement from '../components/UserManagement';
import { useTranslation } from '../contexts/LanguageContext';
import { PageHeader } from '../components/ui';

/**
 * Benutzer. Datensicherung was the second tab here until it moved to its own
 * page, `/datensicherung`: this screen is gated on `rollen_nutzer`, which the
 * Basic plan does not include, while Basic *is* sold with a backup — so the tab
 * was unreachable for exactly the customers most likely to want it. One home per
 * feature, so it is not mounted in both places.
 */
const UsersPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="font-ui">
      <PageHeader title={t('nav.users')} />
      <UserManagement />
    </div>
  );
};

export default UsersPage;
