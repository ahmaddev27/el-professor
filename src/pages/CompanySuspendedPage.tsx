import React from 'react';
import { ShieldOff, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import AccountStatusPage from '../components/auth/AccountStatusPage';
import { Button } from '../components/ui';

const CompanySuspendedPage: React.FC = () => {
  const { signOut } = useAuth();
  const { t } = useTranslation();

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The explanation and the sign-out are unchanged; the frame is the
  // takeovers' shared one, on the design system.

  return (
    <AccountStatusPage
      tone="caution"
      icon={ShieldOff}
      title={t('status.suspended.title')}
      contactLead={t('status.contact')}
      action={
        <Button variant="secondary" className="w-full" onClick={signOut}>
          <LogOut aria-hidden />
          {t('common.logout')}
        </Button>
      }
    >
      <p>{t('status.suspended.body')}</p>
    </AccountStatusPage>
  );
};

export default CompanySuspendedPage;
