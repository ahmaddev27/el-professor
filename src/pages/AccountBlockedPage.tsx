import React from 'react';
import { UserX, LogOut } from 'lucide-react';
import { useAuth, BLOCK_MESSAGE_KEYS, BlockReason } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import AccountStatusPage from '../components/auth/AccountStatusPage';
import { Button } from '../components/ui';

/**
 * Shown when a *restored* session belongs to an account that has since been
 * deactivated or suspended. The sign-in path reports these through
 * signIn()'s blockReason; this page covers the reload and OAuth paths, where
 * signIn() never runs.
 */
const AccountBlockedPage: React.FC<{ reason: BlockReason }> = ({ reason }) => {
  const { signOut } = useAuth();
  const { t } = useTranslation();

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The reason's sentence and the sign-out are unchanged; the frame is the
  // takeovers' shared one, on the design system.

  return (
    <AccountStatusPage
      tone="caution"
      icon={UserX}
      title={t('blocked.title')}
      contactLead={t('blocked.contactHint')}
      action={
        <Button variant="secondary" className="w-full" onClick={signOut}>
          <LogOut aria-hidden />
          {t('common.logout')}
        </Button>
      }
    >
      <p>{t(BLOCK_MESSAGE_KEYS[reason])}</p>
    </AccountStatusPage>
  );
};

export default AccountBlockedPage;
