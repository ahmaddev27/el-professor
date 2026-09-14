import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ArrowLeft, Send } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useOtpSessionHandoff } from '../hooks/useOtpSessionHandoff';
import {
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

type Challenge = { email: string; cooldownSeconds: number; notice: OtpNotice };

/**
 * Password reset by one-time code: the address, then the code, then
 * SetPasswordPage.
 *
 * The server answers every request the same way whether or not the account
 * exists (contract 3.2), so this screen never says a code was sent — only that
 * one was if the account exists — and does not repeat the address as the
 * recipient of a mail that may never have gone out.
 */
const ForgotPasswordPage: React.FC = () => {
  const { t, tPlural } = useTranslation();
  const completeSignIn = useOtpSessionHandoff();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<OtpMessage | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isPlausibleEmail(email)) {
      setError({ key: 'account.error.emailInvalid' });
      return;
    }
    const address = normalizeEmail(email);
    setSending(true);
    setError(null);
    const result = await requestOtp({ purpose: 'password_reset', email: address });
    setSending(false);
    if (!result.ok) {
      setError(otpMessage(result));
      return;
    }
    setChallenge({
      email: address,
      cooldownSeconds: result.cooldownSeconds,
      notice: { tone: 'success', message: { key: result.uniform ? 'forgot.codeSentIfExists' : 'otp.sent' } },
    });
  };

  const handleVerified = async (result: OtpVerifySuccess): Promise<OtpVerifyFailure | void> => {
    if (!('session' in result)) return { ok: false, reason: 'internal' };
    const signedIn = await completeSignIn(result.session, '/auth/set-password');
    if (!signedIn) return { ok: false, reason: 'session_failed' };
  };

  return (
    <AuthShell
      title={t('forgot.title')}
      subtitle={challenge ? challenge.email : t('forgot.subtitle')}
      footer={
        <Link to="/login" className={authQuietLinkClass}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('forgot.backToLogin')}
        </Link>
      }
    >
      {challenge ? (
        <OtpChallenge
          purpose="password_reset"
          email={challenge.email}
          initialCooldownSeconds={challenge.cooldownSeconds}
          initialNotice={challenge.notice}
          hint={null}
          onVerified={handleVerified}
          onBack={() => setChallenge(null)}
          backLabel={t('forgot.changeEmail')}
        />
      ) : (
        <form onSubmit={sendCode} className="space-y-4" noValidate>
          {error && <NoticeBox tone="error" announce>{formatOtpMessage(error, t, tPlural)}</NoticeBox>}

          <div>
            <label htmlFor="forgot-email" className={authLabelClass}>
              {t('forgot.emailLabel')}
            </label>
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} aria-hidden="true" />
              <input
                id="forgot-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                className={authInputClass}
                placeholder={t('forgot.emailPlaceholder')}
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
                <span>{t('forgot.sendCode')}</span>
              </>
            )}
          </button>
        </form>
      )}
    </AuthShell>
  );
};

export default ForgotPasswordPage;
