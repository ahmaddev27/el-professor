import React from 'react';
import { Clock, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import AccountStatusPage from '../components/auth/AccountStatusPage';
import { Button } from '../components/ui';

interface PendingApprovalPageProps {
  /**
   * What the sign-out button does.
   *
   * The default ends the session where it stands, which is right when App's
   * approval gate rendered this page: the public router then starts at the
   * address the person was already on. A screen that renders this page *inside
   * itself* — CompleteRegistrationPage, after a Google registration — passes a
   * handler that rewrites the address first, because that address is still
   * `/auth/callback` whenever the router swap raced the navigate, and signing
   * out there mounts the callback screen with no session to find.
   */
  onSignOut?: () => void | Promise<void>;
}

const PendingApprovalPage: React.FC<PendingApprovalPageProps> = ({ onSignOut }) => {
  const { signOut, profile } = useAuth();
  const { t } = useTranslation();

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The greeting, the explanation and the sign-out (with the handler a caller
  // passes, or the plain one) are unchanged; the frame is the takeovers' shared
  // one, on the design system.

  return (
    <AccountStatusPage
      tone="caution"
      icon={Clock}
      title={t('status.pending.title')}
      contactLead={t('status.pending.contact')}
      action={
        <Button variant="secondary" className="w-full" onClick={() => { void (onSignOut ?? signOut)(); }}>
          <LogOut aria-hidden />
          {t('common.logout')}
        </Button>
      }
    >
      <p>{t('status.pending.thanks', { name: profile?.full_name ? `, ${profile.full_name}` : '' })}</p>
      <p>{t('status.pending.body')}</p>
    </AccountStatusPage>
  );
};

export default PendingApprovalPage;
