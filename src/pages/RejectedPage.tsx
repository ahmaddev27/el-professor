import React from 'react';
import { XCircle, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import AccountStatusPage from '../components/auth/AccountStatusPage';
import { Button } from '../components/ui';

const RejectedPage: React.FC = () => {
  const { signOut, rejectionReason } = useAuth();
  const { t } = useTranslation();

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The explanation, the stored reason (only when there is one) and the
  // sign-out are unchanged; the frame is the takeovers' shared one.

  return (
    <AccountStatusPage
      tone="critical"
      icon={XCircle}
      title={t('status.rejected.title')}
      contactLead={t('status.rejected.contact')}
      action={
        <Button variant="secondary" className="w-full" onClick={signOut}>
          <LogOut aria-hidden />
          {t('common.logout')}
        </Button>
      }
    >
      <p>{t('status.rejected.body')}</p>

      {rejectionReason && (
        <div className="rounded-control border border-critical/30 bg-critical-soft p-4 text-left">
          <p className="mb-1.5 text-xs font-semibold text-critical">{t('status.rejected.reason')}</p>
          <p className="text-sm leading-relaxed text-fg">{rejectionReason}</p>
        </div>
      )}
    </AccountStatusPage>
  );
};

export default RejectedPage;
