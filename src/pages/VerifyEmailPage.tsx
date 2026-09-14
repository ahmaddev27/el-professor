import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, LogIn, Mail, Send } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useOtpSessionHandoff } from '../hooks/useOtpSessionHandoff';
import {
  emailFromFragment,
  formatOtpMessage,
  isPlausibleEmail,
  normalizeEmail,
  otpMessage,
  requestOtp,
  type OtpMessage,
  type OtpVerifyFailure,
  type OtpVerifySuccess,
} from '../lib/otpClient';
import type { OtpNotice } from '../lib/otpUi';
import AuthShell from '../components/auth/AuthShell';
import NoticeBox from '../components/auth/NoticeBox';
import OtpChallenge from '../components/auth/OtpChallenge';
import {
  authInputClass,
  authLabelClass,
  authPrimaryButtonClass,
  authQuietLinkClass,
  authSpinnerClass,
} from '../components/auth/authStyles';

type Challenge = { email: string; cooldownSeconds: number; notice: OtpNotice | null };

/**
 * `/auth/verify-email`: a company owner who signed up but never entered the
 * code finishes the registration here.
 *
 * Two ways in. The link in the signup mail carries the address in its fragment,
 * and that mail already holds a code, so the page opens on the code. The
 * sign-in form sends an unconfirmed owner here with the address in router
 * state and no code yet, so the page opens on "send code".
 */
const VerifyEmailPage: React.FC = () => {
  const { t, tPlural } = useTranslation();
  const location = useLocation();
  const completeSignIn = useOtpSessionHandoff();

  const [start] = useState(() => {
    const fromLink = emailFromFragment(location.hash);
    if (isPlausibleEmail(fromLink)) return { email: fromLink, hasCode: true };
    const state = location.state as { email?: unknown } | null;
    return { email: typeof state?.email === 'string' ? state.email : '', hasCode: false };
  });

  const [email, setEmail] = useState(start.email);
  const [challenge, setChallenge] = useState<Challenge | null>(
    start.hasCode ? { email: start.email, cooldownSeconds: 0, notice: null } : null,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<OtpMessage | null>(null);
  const [verifiedWithoutSession, setVerifiedWithoutSession] = useState(false);

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isPlausibleEmail(email)) {
      setError({ key: 'account.error.emailInvalid' });
      return;
    }
    const address = normalizeEmail(email);
    setSending(true);
    setError(null);
    const result = await requestOtp({ purpose: 'signup_verify', email: address });
    setSending(false);
    if (!result.ok) {
      setError(otpMessage(result));
      return;
    }
    setChallenge({ email: address, cooldownSeconds: result.cooldownSeconds, notice: { tone: 'success', message: { key: 'otp.sent' } } });
  };

  const handleVerified = async (result: OtpVerifySuccess): Promise<OtpVerifyFailure | void> => {
    if (!('session' in result)) return { ok: false, reason: 'internal' };
    const signedIn = await completeSignIn(result.session, '/');
    if (!signedIn) return { ok: false, reason: 'session_failed' };
  };

  // The address is confirmed by now; only the automatic sign-in failed, and a
  // new code would be refused for a confirmed account. The password still works.
  const handleFailure = (result: OtpVerifyFailure): boolean => {
    if (result.reason !== 'session_failed') return false;
    setVerifiedWithoutSession(true);
    return true;
  };

  const renderBody = () => {
    if (verifiedWithoutSession) {
      return (
        <div className="space-y-5">
          <NoticeBox tone="success" announce>{t('signup.verify.verifiedLogin')}</NoticeBox>
          <Link to="/login" replace className={authPrimaryButtonClass}>
            <LogIn size={15} aria-hidden="true" />
            <span>{t('auth.signIn')}</span>
          </Link>
        </div>
      );
    }

    if (challenge) {
      return (
        <OtpChallenge
          purpose="signup_verify"
          email={challenge.email}
          initialCooldownSeconds={challenge.cooldownSeconds}
          initialNotice={challenge.notice}
          onVerified={handleVerified}
          onFailure={handleFailure}
          onBack={() => setChallenge(null)}
          backLabel={t('forgot.changeEmail')}
        />
      );
    }

    return (
      <form onSubmit={sendCode} className="space-y-4" noValidate>
        {error && <NoticeBox tone="error" announce>{formatOtpMessage(error, t, tPlural)}</NoticeBox>}
        <div>
          <label htmlFor="verify-email" className={authLabelClass}>{t('auth.email')}</label>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} aria-hidden="true" />
            <input
              id="verify-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              className={authInputClass}
              placeholder={t('auth.emailPlaceholder')}
              required
              autoFocus
            />
          </div>
        </div>
        <button type="submit" disabled={sending || !email.trim()} className={`${authPrimaryButtonClass} mt-2`}>
          {sending ? (
            <span className={authSpinnerClass} aria-hidden="true" />
          ) : (
            <>
              <Send size={15} aria-hidden="true" />
              <span>{t('signup.verify.sendCode')}</span>
            </>
          )}
        </button>
      </form>
    );
  };

  return (
    <AuthShell
      title={t('signup.verify.emailStepTitle')}
      subtitle={t('signup.verify.heading')}
      footer={
        <Link to="/login" className={authQuietLinkClass}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('forgot.backToLogin')}
        </Link>
      }
    >
      {renderBody()}
    </AuthShell>
  );
};

export default VerifyEmailPage;
