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
import {
  authInputClass,
  authLabelClass,
  authPrimaryButtonClass,
  authSpinnerClass,
} from '../components/auth/authStyles';

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

  const renderBody = () => {
    if (user) {
      return (
        <div className="space-y-5">
          <p className="text-white/70 text-sm leading-relaxed break-words">
            <EmphasizedText
              template={t('invite.accept.signedInAs')}
              placeholder="email"
              value={user.email ?? ''}
              className="text-cyan-300"
            />
          </p>
          <button
            type="button"
            onClick={() => { void signOutAndContinue(); }}
            disabled={signingOut}
            className={authPrimaryButtonClass}
          >
            {signingOut ? <span className={authSpinnerClass} aria-hidden="true" /> : <LogOut size={15} aria-hidden="true" />}
            <span>{t('invite.accept.signOutContinue')}</span>
          </button>
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
      <form onSubmit={confirmEmail} className="space-y-4" noValidate>
        {draftInvalid && <NoticeBox tone="error" announce>{t('account.error.emailInvalid')}</NoticeBox>}
        <div>
          <label htmlFor="invite-email" className={authLabelClass}>{t('invite.accept.emailLabel')}</label>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} aria-hidden="true" />
            <input
              id="invite-email"
              type="email"
              autoComplete="email"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              className={authInputClass}
              placeholder={t('auth.emailPlaceholder')}
              required
              autoFocus
            />
          </div>
        </div>
        <button type="submit" disabled={!draft.trim()} className={`${authPrimaryButtonClass} mt-2`}>
          <span>{t('common.confirm')}</span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
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
        <div className="mt-5 space-y-3">
          {googleError && <NoticeBox tone="error" announce>{googleError}</NoticeBox>}
          <GoogleButton
            from="invite"
            labelKey="auth.google.signIn"
            hintKey="gsignup.inviteHint"
            divider
            onError={key => setGoogleError(t(key))}
          />
        </div>
      )}
    </AuthShell>
  );
};

export default InviteAcceptPage;
