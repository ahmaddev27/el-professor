import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowRight, LogOut, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useOtpSessionHandoff } from '../hooks/useOtpSessionHandoff';
import { supabase } from '../lib/supabase';
import {
  emailFromFragment,
  isPlausibleEmail,
  normalizeEmail,
  type OtpVerifyFailure,
  type OtpVerifySuccess,
} from '../lib/otpClient';
import AuthShell from '../components/auth/AuthShell';
import EmphasizedText from '../components/auth/EmphasizedText';
import GoogleButton from '../components/auth/GoogleButton';
import NoticeBox from '../components/auth/NoticeBox';
import OtpChallenge from '../components/auth/OtpChallenge';
import { authFieldIconClass, authFieldWithIconClass } from '../components/auth/authStyles';
import { Button, Field, Input } from '../components/ui';

/**
 * `/einladung`: an invited employee enters the code from the invitation mail,
 * then sets a password on SetPasswordPage.
 *
 * The mail's button carries the address in the fragment (`#email=`), which no
 * server logs, and the mail already contains a code — so the code boxes show
 * at once and "new code" is only the fallback. Registered in both routers: a
 * browser still signed in to another account is asked to sign out first,
 * because verifying would silently replace that session.
 */
const InviteAcceptPage: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const completeSignIn = useOtpSessionHandoff();

  const [linkEmail] = useState(() => {
    const fromLink = emailFromFragment(location.hash);
    return isPlausibleEmail(fromLink) ? fromLink : '';
  });
  const [draft, setDraft] = useState(linkEmail);
  const [email, setEmail] = useState(linkEmail);
  const [draftInvalid, setDraftInvalid] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [googleError, setGoogleError] = useState('');

  const signOutAndContinue = async () => {
    setSigningOut(true);
    // Local scope ends only this browser's session, not the other account's
    // sessions elsewhere. AuthContext then clears the user, App swaps to the
    // public router, and this page mounts again there with the same #email.
    await supabase.auth.signOut({ scope: 'local' });
    setSigningOut(false);
  };

  const confirmEmail = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isPlausibleEmail(draft)) {
      setDraftInvalid(true);
      return;
    }
    setDraftInvalid(false);
    setEmail(normalizeEmail(draft));
  };

  const handleVerified = async (result: OtpVerifySuccess): Promise<OtpVerifyFailure | void> => {
    if (!('session' in result)) return { ok: false, reason: 'internal' };
    const signedIn = await completeSignIn(result.session, '/auth/set-password');
    if (!signedIn) return { ok: false, reason: 'session_failed' };
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged. The three states are drawn in the order the
  // old renderBody checked them: another account signed in, the code, the
  // address.

  const renderBody = () => {
    if (user) {
      return (
        <div className="grid gap-5">
          <p className="break-words text-sm leading-relaxed text-fg-muted">
            <EmphasizedText
              template={t('invite.accept.signedInAs')}
              placeholder="email"
              value={user.email ?? ''}
              className="font-medium text-fg"
            />
          </p>
          <Button
            type="button"
            size="lg"
            onClick={() => { void signOutAndContinue(); }}
            disabled={signingOut}
            loading={signingOut}
            className="w-full"
          >
            {!signingOut && <LogOut aria-hidden />}
            <span>{t('invite.accept.signOutContinue')}</span>
          </Button>
        </div>
      );
    }

    if (email) {
      return (
        <OtpChallenge
          purpose="invite_activate"
          email={email}
          onVerified={handleVerified}
          onBack={() => setEmail('')}
          backLabel={t('forgot.changeEmail')}
        />
      );
    }

    return (
      <form onSubmit={confirmEmail} className="grid gap-4" noValidate>
        {draftInvalid && <NoticeBox tone="error" announce>{t('account.error.emailInvalid')}</NoticeBox>}
        <Field label={t('invite.accept.emailLabel')} id="invite-email">
          <div className="relative">
            <Mail aria-hidden className={authFieldIconClass} />
            <Input
              id="invite-email"
              type="email"
              autoComplete="email"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              className={authFieldWithIconClass}
              placeholder={t('auth.emailPlaceholder')}
              required
              autoFocus
            />
          </div>
        </Field>
        <Button type="submit" size="lg" disabled={!draft.trim()} className="mt-1 w-full">
          <span>{t('common.confirm')}</span>
          <ArrowRight aria-hidden />
        </Button>
      </form>
    );
  };

  return (
    <AuthShell title={t('invite.accept.title')} subtitle={t('invite.accept.subtitle')}>
      {renderBody()}
      {/* An invited employee whose address is a Google account can accept the
          invitation by signing in with it: oauth_session_reconcile activates
          the profile, exactly as the mailed code does — and only for the
          address the invitation went to, because that is the account Google
          returns. A different Google account ends up on the registration
          screen, which says so. Nothing renders while the provider is off. */}
      {!user && (
        <>
          {/* Only the button below ever sets this, so with the provider off
              nothing here renders and nothing takes up space: the wrapper that
              used to hold both carried its margin even when empty. */}
          {googleError && (
            <div className="mt-5">
              <NoticeBox tone="error" announce>{googleError}</NoticeBox>
            </div>
          )}
          <GoogleButton
            from="invite"
            labelKey="auth.google.signIn"
            hintKey="gsignup.inviteHint"
            divider
            onError={key => setGoogleError(t(key))}
          />
        </>
      )}
    </AuthShell>
  );
};

export default InviteAcceptPage;
